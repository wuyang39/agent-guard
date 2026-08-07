import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { P2RunGroup } from "../api/types";
import * as fileRunStoreModule from "./fileRunStore";

test("legacy native guard coverage from the current output shape gains safe defaults", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("./test-fixtures/legacy-native-guard-run-group.json", import.meta.url),
    "utf8",
  )) as P2RunGroup;
  const legacyCoverage = fixture.nativeGuardCoverage as unknown as Record<string, unknown>;
  assert.equal(Object.hasOwn(legacyCoverage, "sessions"), false);
  assert.equal(Object.hasOwn(legacyCoverage, "mismatchCount"), false);

  const candidate = (fileRunStoreModule as unknown as {
    normalizeStoredRunGroup?: (runGroup: P2RunGroup) => P2RunGroup;
  }).normalizeStoredRunGroup;
  assert.equal(typeof candidate, "function");

  const normalized = candidate!(fixture);
  assert.deepEqual(normalized.nativeGuardCoverage, {
    ...fixture.nativeGuardCoverage,
    mismatchCount: 0,
    sessions: [],
  });
  assert.equal(Object.hasOwn(legacyCoverage, "sessions"), false);
});
