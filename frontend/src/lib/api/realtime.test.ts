import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBaseUrl } from "./core";
import { realtimeApi } from "./realtime";
import type { MainAgentSupervisionStatus, RunCaseFailureView } from "./types";

const activeMainSupervision = {
  coverage: "active",
  scope: { kind: "agent", agentId: "main" },
  policyPackId: "policy.frontend.main",
  leaseId: "lease.frontend.main",
  leaseEpoch: 8,
  expiresAt: "2026-08-10T08:30:00.000Z",
  gatewayInstanceId: "gateway.frontend",
  activeLeaseCount: 2,
  mainLeaseCount: 1,
} satisfies MainAgentSupervisionStatus;

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

test("native supervision API reads status with GET", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return {
      async json() {
        return { ok: true, data: activeMainSupervision };
      },
    };
  }) as unknown as typeof fetch;

  const status = await realtimeApi.nativeSupervisionStatus();

  assert.equal(requestUrl, `${apiBaseUrl}/api/v1/openclaw/native-supervision`);
  assert.equal(requestInit, undefined);
  assert.deepEqual(status, activeMainSupervision);
});

test("native supervision API starts main coverage with the selected policy pack", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return {
      async json() {
        return { ok: true, data: activeMainSupervision };
      },
    };
  }) as unknown as typeof fetch;

  await realtimeApi.startNativeSupervision("policy.frontend.main");

  assert.equal(requestUrl, `${apiBaseUrl}/api/v1/openclaw/native-supervision/start`);
  assert.equal(requestInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    policyPackId: "policy.frontend.main",
  });
});

test("native supervision API stops main coverage without a request body", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return {
      async json() {
        return {
          ok: true,
          data: { ...activeMainSupervision, coverage: "off", mainLeaseCount: 0 },
        };
      },
    };
  }) as unknown as typeof fetch;

  await realtimeApi.stopNativeSupervision();

  assert.equal(requestUrl, `${apiBaseUrl}/api/v1/openclaw/native-supervision/stop`);
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.body, undefined);
});
