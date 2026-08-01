import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import type {
  SupervisionPolicyPack,
  SupervisionRuntimeAction,
} from "@agent-guard/contracts";
import { findMatchingPolicies } from "./policyEngine";

const execFileAsync = promisify(execFile);

test("ambiguous alternation regex policies complete within a hard limit", async () => {
  const policyPack = buildRegexPolicyPack("(a|aa)+$");
  const action = buildToolCallAction(`${"a".repeat(38)}!`);
  const childScript = `
    const { findMatchingPolicies } = await import(${JSON.stringify(new URL("./policyEngine.ts", import.meta.url).href)});
    const result = findMatchingPolicies(${JSON.stringify(policyPack)}, ${JSON.stringify(action)});
    process.stdout.write(JSON.stringify(result));
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
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 2_500,
      windowsHide: true,
    },
  );

  assert.deepEqual(JSON.parse(stdout), []);
});

test("unsafe nested-quantifier regex policies do not match", () => {
  assert.deepEqual(
    findMatchingPolicies(
      buildRegexPolicyPack("(a+)+$"),
      buildToolCallAction("a".repeat(2_000)),
    ),
    [],
  );
});

test("empty regex patterns do not match", () => {
  assert.deepEqual(
    findMatchingPolicies(buildRegexPolicyPack(""), buildToolCallAction("value")),
    [],
  );
});

test("regex patterns longer than 256 characters do not match", () => {
  const pattern = "a".repeat(257);

  assert.deepEqual(
    findMatchingPolicies(buildRegexPolicyPack(pattern), buildToolCallAction(pattern)),
    [],
  );
});

test("regex matching only inspects the first 65,536 input characters", () => {
  assert.deepEqual(
    findMatchingPolicies(
      buildRegexPolicyPack("blocked$"),
      buildToolCallAction(`${"a".repeat(65_536)}blocked`),
    ),
    [],
  );
});

test("regex character classes retain meaning when case-insensitive", () => {
  for (const caseSensitive of [undefined, false]) {
    const policyPack = buildRegexPolicyPack("\\D+$", { caseSensitive });

    assert.equal(
      findMatchingPolicies(policyPack, buildToolCallAction("abc")).length,
      1,
    );
    assert.deepEqual(
      findMatchingPolicies(policyPack, buildToolCallAction("123")),
      [],
    );
  }
});

test("regex case sensitivity is controlled by the matcher option", () => {
  assert.equal(
    findMatchingPolicies(
      buildRegexPolicyPack("abc"),
      buildToolCallAction("ABC"),
    ).length,
    1,
  );
  assert.equal(
    findMatchingPolicies(
      buildRegexPolicyPack("abc", { caseSensitive: false }),
      buildToolCallAction("ABC"),
    ).length,
    1,
  );
  assert.deepEqual(
    findMatchingPolicies(
      buildRegexPolicyPack("abc", { caseSensitive: true }),
      buildToolCallAction("ABC"),
    ),
    [],
  );
});

test("regex matcher normalization only transforms the actual value", () => {
  const cases: Array<{
    pattern: string;
    actual: string;
    normalize: "lowercase" | "trim" | "url_decode";
  }> = [
    { pattern: "[A-Z]+$", actual: "ABC", normalize: "lowercase" },
    { pattern: " abc ", actual: " abc ", normalize: "trim" },
    { pattern: "%5Cd+$", actual: "123", normalize: "url_decode" },
  ];

  for (const { pattern, actual, normalize } of cases) {
    assert.deepEqual(
      findMatchingPolicies(
        buildRegexPolicyPack(pattern, { caseSensitive: true, normalize }),
        buildToolCallAction(actual),
      ),
      [],
    );
  }
});

test("regex syntax unsupported by the linear engine fails closed", () => {
  assert.deepEqual(
    findMatchingPolicies(
      buildRegexPolicyPack("(?=a)a", { caseSensitive: true }),
      buildToolCallAction("a"),
    ),
    [],
  );
});

function buildRegexPolicyPack(
  pattern: string,
  matcherOptions: {
    caseSensitive?: boolean;
    normalize?: "none" | "lowercase" | "trim" | "url_decode";
  } = {},
): SupervisionPolicyPack {
  const policyPack: SupervisionPolicyPack = {
    schemaVersion: "mvp-1",
    policyPackId: "policy_pack.regex-safety",
    agentId: "agent.regex-safety",
    sourceDetectionReportId: "detection.regex-safety",
    sourceRiskProfileId: "risk_profile.regex-safety",
    policies: [
      {
        policyId: "policy.regex-safety",
        sourceWeaknessIds: [],
        name: "Reject unsafe regex",
        description: "Exercises policy regex safety checks.",
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: {
          relation: "all",
          matchers: [
            {
              fieldPath: "payload.parameters.value",
              operator: "regex",
              value: pattern,
              ...matcherOptions,
            },
          ],
        },
        reason: "Unsafe regular expressions must not execute.",
      },
    ],
    defaultAction: "allow",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  return policyPack;
}

function buildToolCallAction(value: string): SupervisionRuntimeAction {
  return {
    runtimeSessionId: "session.regex-safety",
    agentId: "agent.regex-safety",
    targetType: "tool_call",
    payload: {
      toolId: "tool.regex-safety",
      parameters: { value },
    },
  };
}
