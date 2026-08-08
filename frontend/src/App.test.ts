import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SELECTION_CASE_COUNT } from "./selectionDefaults";

test("competition workflow defaults to five selected cases", () => {
  assert.equal(DEFAULT_SELECTION_CASE_COUNT, 5);
});
