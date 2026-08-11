import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";

const execFileAsync = promisify(execFile);

type StoredFixture = {
  policyPackId: string;
  runGroupId: string;
  adapterKind: "openclaw" | "http_sample";
  fileContent?: string;
};

type LoadedPolicyPack = {
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
};

test("loads only complete stored OpenClaw policy packs and fails closed", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-policy-pack-"));
  const validPack = buildPolicyPack("policy_pack.valid");
  const invalidFactories: Array<[
    string,
    (pack: SupervisionPolicyPack) => unknown,
  ]> = [
    ["top_level_array", () => []],
    ["schema_version", (pack) => ({ ...pack, schemaVersion: "future" })],
    ["agent_id", (pack) => ({ ...pack, agentId: 42 })],
    ["source_detection_id", (pack) => ({ ...pack, sourceDetectionReportId: null })],
    ["source_risk_profile_id", (pack) => ({ ...pack, sourceRiskProfileId: [] })],
    ["missing_policies", (pack) => omitProperty(pack, "policies")],
    ["empty_policies", (pack) => ({ ...pack, policies: [] })],
    ["empty_policy", (pack) => ({ ...pack, policies: [{}] })],
    ["default_action", (pack) => ({ ...pack, defaultAction: "execute" })],
    ["created_at", (pack) => ({ ...pack, createdAt: 1 })],
    ["expires_at", (pack) => ({ ...pack, expiresAt: false })],
    ["policy_id", (pack) => withPolicy(pack, { policyId: 1 })],
    ["source_policy_template_id", (pack) => withPolicy(pack, { sourcePolicyTemplateId: 1 })],
    ["source_weakness_ids", (pack) => withPolicy(pack, { sourceWeaknessIds: [1] })],
    ["policy_name", (pack) => withPolicy(pack, { name: null })],
    ["policy_description", (pack) => withPolicy(pack, { description: {} })],
    ["target_type", (pack) => withPolicy(pack, { targetType: "process_launch" })],
    ["policy_action", (pack) => withPolicy(pack, { action: "execute" })],
    ["risk_level", (pack) => withPolicy(pack, { riskLevel: "urgent" })],
    ["missing_match", (pack) => withPolicy(pack, { match: null })],
    ["policy_reason", (pack) => withPolicy(pack, { reason: 1 })],
    ["match_relation", (pack) => withMatch(pack, { relation: "none" })],
    ["event_types", (pack) => withMatch(pack, { eventTypes: ["unknown_event"] })],
    ["attack_entry_types", (pack) => withMatch(pack, { attackEntryTypes: ["unknown_entry"] })],
    ["risk_tag_ids", (pack) => withMatch(pack, { riskTagIds: [1] })],
    ["matchers", (pack) => withMatch(pack, { matchers: {} })],
    ["empty_matcher", (pack) => withMatch(pack, { matchers: [{}] })],
    ["matcher_field_path", (pack) => withMatcher(pack, { fieldPath: 1 })],
    ["matcher_operator", (pack) => withMatcher(pack, { operator: "glob" })],
    ["matcher_case_sensitive", (pack) => withMatcher(pack, { caseSensitive: "false" })],
    ["matcher_normalize", (pack) => withMatcher(pack, { normalize: "unicode" })],
    ["canonicalization", (pack) => withPolicy(pack, { name: "\ud800" })],
  ];
  const invalidFixtures = invalidFactories.map(([label, corrupt]) => {
    const policyPackId = `policy_pack.invalid.${label}`;
    return {
      policyPackId,
      runGroupId: `run_group.invalid.${label}`,
      adapterKind: "openclaw" as const,
      fileContent: JSON.stringify(corrupt(buildPolicyPack(policyPackId))),
    };
  });
  const fixtures: StoredFixture[] = [
    {
      policyPackId: validPack.policyPackId,
      runGroupId: "run_group.valid",
      adapterKind: "openclaw",
      fileContent: JSON.stringify(validPack),
    },
    {
      policyPackId: "policy_pack.http_sample",
      runGroupId: "run_group.http_sample",
      adapterKind: "http_sample",
      fileContent: JSON.stringify(buildPolicyPack("policy_pack.http_sample")),
    },
    {
      policyPackId: "policy_pack.malformed_json",
      runGroupId: "run_group.malformed_json",
      adapterKind: "openclaw",
      fileContent: "{not-json",
    },
    {
      policyPackId: "policy_pack.id_mismatch",
      runGroupId: "run_group.id_mismatch",
      adapterKind: "openclaw",
      fileContent: JSON.stringify(buildPolicyPack("policy_pack.different")),
    },
    {
      policyPackId: "policy_pack.missing_file",
      runGroupId: "run_group.missing_file",
      adapterKind: "openclaw",
    },
    {
      policyPackId: "policy_pack.path_traversal",
      runGroupId: "../outside",
      adapterKind: "openclaw",
    },
    ...invalidFixtures,
  ];

  try {
    await writeJson(
      path.join(tempRoot, "outputs", "report-index", "report-index.json"),
      {
        version: 1,
        entries: fixtures.map((fixture) =>
          buildReportEntry(fixture.policyPackId, fixture.runGroupId),
        ),
      },
    );
    await writeJson(
      path.join(tempRoot, "outputs", "run-index", "run-groups.json"),
      fixtures.map((fixture) =>
        buildRunGroup(fixture.runGroupId, fixture.adapterKind),
      ),
    );
    await Promise.all(
      fixtures
        .filter(
          (fixture): fixture is StoredFixture & { fileContent: string } =>
            fixture.fileContent !== undefined &&
            !fixture.runGroupId.includes(".."),
        )
        .map((fixture) =>
          writeText(
            path.join(
              tempRoot,
              "outputs",
              "reports",
              fixture.runGroupId,
              "supervision-policy-pack.json",
            ),
            fixture.fileContent,
          ),
        ),
    );

    const results = await loadFixturesInChild(
      tempRoot,
      fixtures.map((fixture) => fixture.policyPackId),
    );

    assert.deepEqual(results[validPack.policyPackId], {
      policyPack: validPack,
      policyPackDigest: digestJson(validPack),
      runGroupId: "run_group.valid",
    });

    const rejectedIds = fixtures
      .map((fixture) => fixture.policyPackId)
      .filter((policyPackId) => policyPackId !== validPack.policyPackId);
    assert.deepEqual(
      Object.fromEntries(rejectedIds.map((policyPackId) => [policyPackId, results[policyPackId]])),
      Object.fromEntries(rejectedIds.map((policyPackId) => [policyPackId, null])),
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

function buildPolicyPack(policyPackId: string): SupervisionPolicyPack {
  return {
    schemaVersion: "mvp-1",
    policyPackId,
    agentId: "agent.policy-repository",
    sourceDetectionReportId: "detection.policy-repository",
    sourceRiskProfileId: "risk_profile.policy-repository",
    policies: [
      {
        policyId: `${policyPackId}.policy`,
        sourcePolicyTemplateId: "policy_template.repository",
        sourceWeaknessIds: ["weakness.repository"],
        name: "Repository policy",
        description: "Policy repository fixture.",
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: {
          relation: "all",
          eventTypes: ["tool_call"],
          attackEntryTypes: ["malicious_user_prompt"],
          riskTagIds: ["risk.repository"],
          matchers: [
            {
              fieldPath: "payload.parameters.value",
              operator: "regex",
              value: "\\D+$",
              caseSensitive: false,
              normalize: "none",
            },
          ],
        },
        reason: "Repository fixture.",
      },
    ],
    defaultAction: "allow",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
  };
}

function withPolicy(
  pack: SupervisionPolicyPack,
  overrides: Record<string, unknown>,
): unknown {
  return {
    ...pack,
    policies: [{ ...pack.policies[0], ...overrides }],
  };
}

function withMatch(
  pack: SupervisionPolicyPack,
  overrides: Record<string, unknown>,
): unknown {
  const policy = pack.policies[0];
  return withPolicy(pack, {
    match: { ...policy.match, ...overrides },
  });
}

function withMatcher(
  pack: SupervisionPolicyPack,
  overrides: Record<string, unknown>,
): unknown {
  const matcher = pack.policies[0].match.matchers?.[0];
  return withMatch(pack, {
    matchers: [{ ...matcher, ...overrides }],
  });
}

function omitProperty(value: object, key: string): object {
  const clone = { ...value } as Record<string, unknown>;
  delete clone[key];
  return clone;
}

function buildReportEntry(reportId: string, runGroupId: string): object {
  return {
    reportId,
    reportType: "policy_pack",
    runGroupId,
    artifactIds: [],
    generatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function buildRunGroup(
  runGroupId: string,
  adapterKind: "openclaw" | "http_sample",
): object {
  return {
    runGroupId,
    adapterKind,
    policyContextSource: "stored_detection",
  };
}

async function loadFixturesInChild(
  tempRoot: string,
  policyPackIds: string[],
): Promise<Record<string, LoadedPolicyPack | null | { threw: string }>> {
  const repositoryUrl = new URL("./policyPackRepository.ts", import.meta.url).href;
  const tsconfigPath = fileURLToPath(
    new URL("../../../../tsconfig.json", import.meta.url),
  );
  const childScript = `
    const { loadStoredOpenClawPolicyPack } = await import(${JSON.stringify(repositoryUrl)});
    const results = {};
    for (const policyPackId of ${JSON.stringify(policyPackIds)}) {
      try {
        results[policyPackId] = await loadStoredOpenClawPolicyPack(policyPackId) ?? null;
      } catch (error) {
        results[policyPackId] = { threw: error instanceof Error ? error.name : "unknown" };
      }
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      childScript,
    ],
    {
      cwd: tempRoot,
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
      windowsHide: true,
    },
  );

  return JSON.parse(stdout) as Record<
    string,
    LoadedPolicyPack | null | { threw: string }
  >;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, JSON.stringify(value, null, 2));
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}
