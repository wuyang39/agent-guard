import assert from "node:assert/strict";
import { test } from "node:test";
import { mockDefenseDetail } from "../api/mockData";
import { deriveDefenseEvidenceSummary } from "./defense";

test("defense evidence summary reports true runtime records", () => {
  const summary = deriveDefenseEvidenceSummary(mockDefenseDetail);

  assert.equal(summary.realSupervisionRecordCount, 1);
  assert.equal(summary.runtimeSessionCount, 1);
  assert.equal(summary.usesSyntheticFallback, false);
  assert.equal(summary.canProveDefenseEffect, true);
});

test("synthetic fallback evidence cannot prove real defense effect", () => {
  const summary = deriveDefenseEvidenceSummary({
    ...mockDefenseDetail,
    evidenceSummary: undefined,
    policyContextSource: "synthetic_fallback",
  });

  assert.equal(summary.realSupervisionRecordCount, 0);
  assert.equal(summary.usesSyntheticFallback, true);
  assert.equal(summary.canProveDefenseEffect, false);
});
