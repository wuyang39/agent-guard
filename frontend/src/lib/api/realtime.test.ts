import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBaseUrl } from "./core";
import { realtimeApi } from "./realtime";
import type { RunCaseFailureView } from "./types";

const sandboxProfileSeedFailure = {
  caseId: "case.profile-seed",
  phase: "detecting",
  reason: "The host profile seed changed before sandbox preflight.",
  category: "sandbox_profile_seed_failed",
  attempts: 1,
  retryable: false,
  skipped: true,
  occurredAt: "2026-08-07T00:00:00.000Z",
} satisfies RunCaseFailureView;

const nativeGuardEvidenceFailure = {
  ...sandboxProfileSeedFailure,
  category: "native_guard_evidence_unavailable",
} satisfies RunCaseFailureView;

const nativeGuardRevokeFailure = {
  ...sandboxProfileSeedFailure,
  category: "native_guard_revoke_failed",
} satisfies RunCaseFailureView;

test("run failure views accept the sandbox profile seed category", () => {
  assert.equal(sandboxProfileSeedFailure.category, "sandbox_profile_seed_failed");
});

test("run failure views accept native guard evidence and revoke categories", () => {
  assert.equal(nativeGuardEvidenceFailure.category, "native_guard_evidence_unavailable");
  assert.equal(nativeGuardRevokeFailure.category, "native_guard_revoke_failed");
});

test("live supervision stream defaults to realtime-only replay mode", () => {
  assert.equal(
    realtimeApi.liveSupervisionUrl(),
    `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=0`,
  );
});

test("live supervision stream can explicitly include replay history", () => {
  assert.equal(
    realtimeApi.liveSupervisionUrl({ includeHistory: true }),
    `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=1`,
  );
});

test("ask stream can be scoped to a realtime session", () => {
  assert.equal(
    realtimeApi.supervisionAskStreamUrl({ sessionId: "session.demo/1" }),
    `${apiBaseUrl}/api/v1/supervision/ask/stream?sessionId=session.demo%2F1`,
  );
});
