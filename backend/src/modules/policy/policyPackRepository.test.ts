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

test("loads stored OpenClaw policy packs and rejects non-OpenClaw packs", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-policy-pack-"));
  const openClawRunGroupId = "run_group.openclaw";
  const httpRunGroupId = "run_group.http-sample";
  const openClawPack = buildPolicyPack("policy_pack.openclaw");
  const httpPack = buildPolicyPack("policy_pack.http-sample");

  try {
    await writeJson(
      path.join(tempRoot, "outputs", "report-index", "report-index.json"),
      {
        version: 1,
        entries: [
          buildReportEntry(openClawPack.policyPackId, openClawRunGroupId),
          buildReportEntry(httpPack.policyPackId, httpRunGroupId),
        ],
      },
    );
    await writeJson(
      path.join(tempRoot, "outputs", "run-index", "run-groups.json"),
      [
        buildRunGroup(openClawRunGroupId, "openclaw"),
        buildRunGroup(httpRunGroupId, "http_sample"),
      ],
    );
    await writeJson(
      path.join(
        tempRoot,
        "outputs",
        "reports",
        openClawRunGroupId,
        "supervision-policy-pack.json",
      ),
      openClawPack,
    );
    await writeJson(
      path.join(
        tempRoot,
        "outputs",
        "reports",
        httpRunGroupId,
        "supervision-policy-pack.json",
      ),
      httpPack,
    );

    const repositoryUrl = new URL("./policyPackRepository.ts", import.meta.url).href;
    const tsconfigPath = fileURLToPath(
      new URL("../../../../tsconfig.json", import.meta.url),
    );
    const childScript = `
      const { loadStoredOpenClawPolicyPack } = await import(${JSON.stringify(repositoryUrl)});
      const openClaw = await loadStoredOpenClawPolicyPack(${JSON.stringify(openClawPack.policyPackId)});
      const httpRejected = await loadStoredOpenClawPolicyPack(${JSON.stringify(httpPack.policyPackId)}) === undefined;
      process.stdout.write(JSON.stringify({ openClaw, httpRejected }));
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
    const result = JSON.parse(stdout) as {
      openClaw: {
        policyPack: SupervisionPolicyPack;
        policyPackDigest: string;
        runGroupId: string;
      };
      httpRejected: boolean;
    };

    assert.deepEqual(
      result.openClaw,
      {
        policyPack: openClawPack,
        policyPackDigest: digestJson(openClawPack),
        runGroupId: openClawRunGroupId,
      },
    );
    assert.equal(result.httpRejected, true);
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
        sourceWeaknessIds: [],
        name: "Repository policy",
        description: "Policy repository fixture.",
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: { relation: "all" },
        reason: "Repository fixture.",
      },
    ],
    defaultAction: "allow",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
