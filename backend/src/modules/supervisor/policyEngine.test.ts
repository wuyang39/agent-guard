import assert from "node:assert/strict";
import test from "node:test";
import type {
  SupervisionPolicyPack,
  SupervisionRuntimeAction,
} from "@agent-guard/contracts";
import { findMatchingPolicies } from "./policyEngine";

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

function buildRegexPolicyPack(pattern: string): SupervisionPolicyPack {
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
