import assert from "node:assert/strict";
import test from "node:test";
import { drainOpenClawRuntimeEvidence } from "./openclawAdapter";

test("guarded runtime evidence drain fails when the event store is unavailable", async () => {
  const store = {
    async listByRun() {
      throw new Error("OPENCLAW_GATEWAY_TOKEN=super-secret store unavailable");
    },
    async listRecordsByRun() {
      return [];
    },
  } as never;

  await assert.rejects(
    drainOpenClawRuntimeEvidence(store, "run-1", true),
    (error: Error) => {
      assert.match(error.message, /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
});

test("optional runtime evidence drain retains fail-open compatibility", async () => {
  const store = {
    async listByRun() {
      throw new Error("store unavailable");
    },
    async listRecordsByRun() {
      return [];
    },
  } as never;

  assert.deepEqual(
    await drainOpenClawRuntimeEvidence(store, "run-1", false),
    { nativeGuardEvents: [], supervisionRecords: [] },
  );
});
