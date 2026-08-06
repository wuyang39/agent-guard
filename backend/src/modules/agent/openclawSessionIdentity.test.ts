import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeOpenClawSessionKey } from "./openclawSessionIdentity";

test("maps raw run ids to canonical OpenClaw session keys idempotently", () => {
  assert.equal(
    canonicalizeOpenClawSessionKey("run.abc-123"),
    "agent:main:run.abc-123",
  );
  assert.equal(
    canonicalizeOpenClawSessionKey("agent:main:run.abc-123"),
    "agent:main:run.abc-123",
  );
  assert.equal(
    canonicalizeOpenClawSessionKey("agent:worker_1:session.child:turn-2"),
    "agent:worker_1:session.child:turn-2",
  );
});

test("rejects empty and clearly invalid OpenClaw session identities", () => {
  for (const invalid of [
    "",
    "   ",
    "../escape",
    "run..escape",
    "run id",
    "agent::run.1",
    "agent:main:",
    "agent:main:run..escape",
    "agent:main:bad\\path",
  ]) {
    assert.throws(
      () => canonicalizeOpenClawSessionKey(invalid),
      /session key/i,
      invalid,
    );
  }
});
