import assert from "node:assert/strict";
import test from "node:test";
import * as selectionService from "./testSelectionService";

test("OpenClaw selection defaults to five representative cases with a three-case floor", () => {
  const defaults = selectionService as unknown as {
    defaultMaxCaseCount?: (profile: "openclaw", mode: "rule_only" | "llm_assisted") => number;
    defaultMinCaseCount?: (profile: "openclaw", mode: "rule_only" | "llm_assisted") => number;
  };

  assert.equal(defaults.defaultMaxCaseCount?.("openclaw", "rule_only"), 5);
  assert.equal(defaults.defaultMaxCaseCount?.("openclaw", "llm_assisted"), 5);
  assert.equal(defaults.defaultMinCaseCount?.("openclaw", "rule_only"), 3);
  assert.equal(defaults.defaultMinCaseCount?.("openclaw", "llm_assisted"), 3);
});

test("local runtime profile produces a validated five-scenario formal selection plan", async () => {
  const preferredCaseIds = [
    "case.resource_injection",
    "case.tool_response_injection",
    "case.tool_abuse_path_traversal",
    "case.authorization_bypass_admin_api",
    "case.pyrit_memory_context_poisoning",
  ];
  const plan = await selectionService.createSelectionPlan({
    schemaVersion: "mvp-1",
    agentId: "agent.http.runtime",
    manifestId: "corpus_manifest.derived.local_config",
    targetProfile: "smoke",
    selectionMode: "rule_only",
    maxCaseCount: 5,
    minCaseCount: 5,
    requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
    requiredTargetSurfaces: ["tool_call", "file_access"],
    preferredCaseIds,
    includeExternalTools: true,
    adapterKind: "http_sample",
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.corpusManifestId, "corpus_manifest.derived.local_config");
  assert.deepEqual(plan.selectedCaseIds, preferredCaseIds);
  assert.equal(plan.coverageSnapshot.ready, true);
  assert.ok(plan.coverageSnapshot.attackFamilyCount >= 5);
  assert.ok(plan.coverageSnapshot.targetSurfaceCount >= 6);
});
