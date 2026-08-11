import assert from "node:assert/strict";
import { test } from "node:test";
import { apiBaseUrl } from "./core";
import {
  createNativeSupervisionBrowserAccessClient,
  createRealtimeApi,
  exchangeNativeSupervisionBootstrap,
  primeNativeSupervisionBrowserAccess,
  realtimeApi,
} from "./realtime";
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
  assert.equal(requestInit?.credentials, "include");
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
  assert.equal(requestInit?.credentials, "include");
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
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestInit?.body, undefined);
});

test("browser access removes the bootstrap fragment before one singleflight exchange", async () => {
  const order: string[] = [];
  const environment = {
    location: {
      hash: `#agent-guard-bootstrap=${"b".repeat(43)}`,
      pathname: "/supervision",
      search: "?view=live",
    },
    history: {
      state: { navigation: 1 },
      replaceState(state: unknown, _unused: string, url?: string | URL | null) {
        assert.deepEqual(state, { navigation: 1 });
        order.push(`replace:${String(url)}`);
        environment.location.hash = "";
      },
    },
  };
  let releaseExchange: (() => void) | undefined;
  const access = createNativeSupervisionBrowserAccessClient({
    getEnvironment: () => environment,
    exchangeBootstrap(token) {
      order.push(`exchange:${token.length}`);
      return new Promise<void>((resolve) => {
        releaseExchange = resolve;
      });
    },
    async mintEventCapability() {},
  });

  const first = access.ensureAccess();
  const second = access.ensureAccess();

  assert.equal(first, second);
  assert.deepEqual(order, ["replace:/supervision?view=live"]);
  await Promise.resolve();
  assert.deepEqual(order, ["replace:/supervision?view=live", "exchange:43"]);
  releaseExchange?.();
  await first;
});

test("browser access without the named fragment relies on the existing cookie", async () => {
  let exchangeCount = 0;
  const access = createNativeSupervisionBrowserAccessClient({
    getEnvironment: () => ({
      location: { hash: "#unrelated=value", pathname: "/", search: "" },
      history: { state: null, replaceState() { throw new Error("must not rewrite unrelated hash"); } },
    }),
    async exchangeBootstrap() {
      exchangeCount += 1;
    },
    async mintEventCapability() {},
  });

  await access.ensureAccess();

  assert.equal(exchangeCount, 0);
});

test("application startup primes browser pairing before the supervision page mounts", async () => {
  const order: string[] = [];
  const environment = {
    location: {
      hash: `#agent-guard-bootstrap=${"p".repeat(43)}`,
      pathname: "/",
      search: "",
    },
    history: {
      state: null,
      replaceState() {
        order.push("replace");
        environment.location.hash = "";
      },
    },
  };
  const access = createNativeSupervisionBrowserAccessClient({
    getEnvironment: () => environment,
    async exchangeBootstrap() {
      order.push("exchange");
    },
    async mintEventCapability() {},
  });

  primeNativeSupervisionBrowserAccess(access);

  assert.deepEqual(order, ["replace"]);
  await Promise.resolve();
  assert.deepEqual(order, ["replace", "exchange"]);
});

test("bootstrap exchange posts the fragment token with browser credentials", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestInit = init;
    return { status: 204 };
  }) as unknown as typeof fetch;

  await exchangeNativeSupervisionBootstrap("b".repeat(43));

  assert.equal(
    requestUrl,
    `${apiBaseUrl}/api/v1/openclaw/native-supervision/access/bootstrap`,
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.credentials, "include");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    token: "b".repeat(43),
  });
});

test("native supervision controls ensure browser access and event minting is separate", async () => {
  const order: string[] = [];
  const api = createRealtimeApi({
    access: {
      async ensureAccess() {
        order.push("ensure");
      },
      async issueEventCapability() {
        order.push("mint");
      },
    },
    async request<T>(path: string) {
      order.push(path);
      return activeMainSupervision as T;
    },
  });

  await api.nativeSupervisionStatus();
  await api.startNativeSupervision("policy.frontend.main");
  await api.stopNativeSupervision();
  await api.issueNativeSupervisionEventCapability();

  assert.deepEqual(order, [
    "ensure",
    "/api/v1/openclaw/native-supervision",
    "ensure",
    "/api/v1/openclaw/native-supervision/start",
    "ensure",
    "/api/v1/openclaw/native-supervision/stop",
    "mint",
  ]);
});

test("event capability mint accepts a credentialed 204 response without parsing JSON", async (t) => {
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
      status: 204,
      async json() {
        throw new Error("204 response must not be parsed");
      },
    };
  }) as unknown as typeof fetch;

  await realtimeApi.issueNativeSupervisionEventCapability();

  assert.equal(
    requestUrl,
    `${apiBaseUrl}/api/v1/openclaw/native-supervision/access/events`,
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.credentials, "include");
});
