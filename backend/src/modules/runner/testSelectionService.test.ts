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
