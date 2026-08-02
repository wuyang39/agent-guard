import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { NativeGuardLeaseActivation } from "@agent-guard/contracts";
import {
  registerAgentGuardPlugin,
  registerAgentGuardLifecycle,
  registerControlRoutes,
} from "./controlRoutes";
import {
  FileMarkerStore,
  type GuardedMarker,
  type MarkerStore,
} from "./leaseRegistry";
import { AgentGuardRuntime } from "./runtime";

const NOW = "2026-08-02T00:00:00.000Z";
const PUBLIC_KEY = generateKeyPairSync("ed25519").publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

type Route = {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean | void> | boolean | void;
};

class MemoryMarkerStore implements MarkerStore {
  readonly markers = new Map<string, GuardedMarker>();
  readonly writes: GuardedMarker[] = [];
  readonly removes: string[] = [];
  loadCalls = 0;

  constructor(markers: GuardedMarker[] = []) {
    for (const marker of markers) this.markers.set(marker.leaseId, structuredClone(marker));
  }

  async load(): Promise<unknown[]> {
    this.loadCalls += 1;
    return [...this.markers.values()].map((marker) => structuredClone(marker));
  }

  async write(marker: GuardedMarker): Promise<void> {
    this.writes.push(structuredClone(marker));
    this.markers.set(marker.leaseId, structuredClone(marker));
  }

  async remove(leaseId: string): Promise<void> {
    this.removes.push(leaseId);
    this.markers.delete(leaseId);
  }
}

type HookHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<unknown> | unknown;

type Service = {
  id: string;
  start: (context: Record<string, unknown>) => Promise<void> | void;
  stop?: (context: Record<string, unknown>) => Promise<void> | void;
};

type TrustedPolicy = {
  id: string;
  description: string;
  evaluate: (
    event: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
};

type SessionReadParams = {
  agentId?: string;
  sessionKey: string;
  readConsistency?: "latest";
};

type SessionEntry = { spawnedBy?: string; parentSessionKey?: string };
type SessionResolver = (params: SessionReadParams) => SessionEntry | undefined;

function activation(
  overrides: Partial<NativeGuardLeaseActivation> = {},
): NativeGuardLeaseActivation {
  return {
    schemaVersion: "native-guard-1",
    leaseId: "lease.1",
    leaseEpoch: 1,
    rootSessionKey: "agent:guard:run.1",
    mode: "supervision",
    scope: "session_tree",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
    decisionPublicKey: PUBLIC_KEY,
    failurePolicy: {
      lowRisk: "warn",
      highRisk: "deny",
      unknownRisk: "deny",
    },
    issuedAt: NOW,
    expiresAt: "2026-08-02T00:05:00.000Z",
    credential: "credential-that-must-not-be-returned",
    ...overrides,
  };
}

function createHost(options: {
  pluginConfig?: Record<string, unknown>;
  getSessionEntry?: SessionResolver;
} = {}): {
  routes: Route[];
  hooks: Array<{ name: string; handler: HookHandler }>;
  services: Service[];
  policies: TrustedPolicy[];
  sessionReads: SessionReadParams[];
  sessionResolver: SessionResolver;
  api: Parameters<typeof registerControlRoutes>[0] &
    Parameters<typeof registerAgentGuardLifecycle>[0] &
    Parameters<typeof registerAgentGuardPlugin>[0];
} {
  const routes: Route[] = [];
  const hooks: Array<{ name: string; handler: HookHandler }> = [];
  const services: Service[] = [];
  const policies: TrustedPolicy[] = [];
  const sessionReads: SessionReadParams[] = [];
  const sessionResolver: SessionResolver = (params) => {
    sessionReads.push({ ...params });
    return options.getSessionEntry?.(params);
  };
  return {
    routes,
    hooks,
    services,
    policies,
    sessionReads,
    sessionResolver,
    api: {
      pluginConfig: options.pluginConfig,
      registerHttpRoute: (route: Route) => routes.push(route),
      on: (name: string, handler: HookHandler) => hooks.push({ name, handler }),
      registerService: (service: Service) => services.push(service),
      registerTrustedToolPolicy: (policy: TrustedPolicy) => policies.push(policy),
      runtime: {
        agent: {
          session: {
            getSessionEntry: sessionResolver,
          },
        },
      },
    } as Parameters<typeof registerControlRoutes>[0] &
      Parameters<typeof registerAgentGuardLifecycle>[0] &
      Parameters<typeof registerAgentGuardPlugin>[0],
  };
}

type CapturedResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
};

async function invoke(
  route: Route,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string | Buffer;
    chunks?: Buffer[];
    headers?: Record<string, string>;
    request?: IncomingMessage;
    idempotencyKey?: string | null;
  } = {},
): Promise<CapturedResponse> {
  const hasBody = Object.hasOwn(options, "body");
  const rawBody = options.rawBody ?? (hasBody ? JSON.stringify(options.body) : "");
  const chunks = options.chunks ?? (rawBody === "" ? [] : [Buffer.from(rawBody)]);
  const request = options.request ?? Readable.from(chunks) as IncomingMessage;
  request.method = options.method ?? (hasBody ? "POST" : "GET");
  const defaultIdempotencyKey = createHash("sha256")
    .update(`${route.path}\0`)
    .update(rawBody)
    .digest("base64url");
  const idempotencyKey = options.idempotencyKey === undefined
    ? defaultIdempotencyKey
    : options.idempotencyKey;
  request.headers = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
    ...((hasBody || request.method === "POST") && idempotencyKey !== null
      ? { "x-idempotency-key": idempotencyKey }
      : {}),
    ...options.headers,
  };
  const headers: Record<string, string> = {};
  let responseBody = "";
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) responseBody += chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;

  await route.handler(request, response);
  return {
    statusCode: response.statusCode,
    headers,
    body: responseBody === "" ? undefined : JSON.parse(responseBody),
    rawBody: responseBody,
  };
}

test("registers the exact gateway-authenticated lease control surface", async () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  await runtime.start();
  const host = createHost();

  registerControlRoutes(host.api, runtime);

  assert.deepEqual(
    host.routes.map(({ path, auth, match }) => ({ path, auth, match })),
    [
      {
        path: "/agent-guard/native-guard/v1/leases/activate",
        auth: "gateway",
        match: "exact",
      },
      {
        path: "/agent-guard/native-guard/v1/leases/renew",
        auth: "gateway",
        match: "exact",
      },
      {
        path: "/agent-guard/native-guard/v1/leases/revoke",
        auth: "gateway",
        match: "exact",
      },
      {
        path: "/agent-guard/native-guard/v1/status",
        auth: "gateway",
        match: "exact",
      },
    ],
  );
});

test("activate, renew, status, and revoke return raw credential-free status", async () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const routes = new Map(host.routes.map((route) => [route.path, route]));

  const activate = await invoke(
    routes.get("/agent-guard/native-guard/v1/leases/activate")!,
    { body: activation() },
  );
  assert.equal(activate.statusCode, 200);
  assert.equal((activate.body as { coverage: string }).coverage, "active");
  assert.equal((await runtime.registry.lookup("agent:guard:run.1")).state, "active");
  assert.equal(activate.headers["cache-control"], "no-store");
  assert.equal(activate.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(activate.rawBody.includes("credential"), false);

  const renewed = await invoke(
    routes.get("/agent-guard/native-guard/v1/leases/renew")!,
    {
      body: activation({
        leaseEpoch: 2,
        expiresAt: "2026-08-02T00:06:00.000Z",
        credential: "rotated-credential-that-must-not-be-returned",
      }),
    },
  );
  assert.equal((renewed.body as { activeLease: { leaseEpoch: number } }).activeLease.leaseEpoch, 2);
  assert.equal(renewed.rawBody.includes("rotated-credential"), false);

  const status = await invoke(
    routes.get("/agent-guard/native-guard/v1/status")!,
    { method: "GET" },
  );
  assert.deepEqual(status.body, renewed.body);

  const revoked = await invoke(
    routes.get("/agent-guard/native-guard/v1/leases/revoke")!,
    { body: { leaseId: "lease.1" } },
  );
  assert.equal((revoked.body as { coverage: string }).coverage, "off");
  assert.equal((await runtime.registry.lookup("agent:guard:run.1")).state, "off");
});

test("rejects wrong methods and missing or invalid JSON content types", async (t) => {
  for (const [name, options, expectedStatus, expectedCode] of [
    ["wrong method", { method: "GET" }, 405, "METHOD_NOT_ALLOWED"],
    ["missing content type", { body: activation(), headers: { "content-type": "" } }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    ["wrong content type", { body: activation(), headers: { "content-type": "text/plain" } }, 415, "UNSUPPORTED_MEDIA_TYPE"],
  ] as const) {
    await t.test(name, async () => {
      const { route } = await routeFixture("/agent-guard/native-guard/v1/leases/activate");
      const response = await invoke(route, options);
      assert.equal(response.statusCode, expectedStatus);
      assert.deepEqual(response.body, {
        error: {
          code: expectedCode,
          message: expectedCode === "METHOD_NOT_ALLOWED"
            ? "Native guard control method is not allowed."
            : "Native guard control request must be JSON.",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
    });
  }
});

test("rejects declared, streamed, and deceptive request lengths before activation", async (t) => {
  const cases: Array<{
    name: string;
    rawBody: string | Buffer;
    chunks?: Buffer[];
    headers?: Record<string, string>;
    expectedStatus: number;
    expectedCode: string;
  }> = [
    {
      name: "declared oversize",
      rawBody: "{}",
      headers: { "content-length": "65537" },
      expectedStatus: 413,
      expectedCode: "REQUEST_TOO_LARGE",
    },
    {
      name: "streamed oversize",
      rawBody: "",
      chunks: [Buffer.alloc(40_000, 0x20), Buffer.alloc(25_537, 0x20)],
      expectedStatus: 413,
      expectedCode: "REQUEST_TOO_LARGE",
    },
    {
      name: "declared shorter than stream",
      rawBody: JSON.stringify(activation()),
      headers: { "content-length": "2" },
      expectedStatus: 400,
      expectedCode: "INVALID_REQUEST",
    },
    {
      name: "truncated declared body",
      rawBody: "{}",
      headers: { "content-length": "10" },
      expectedStatus: 400,
      expectedCode: "INVALID_REQUEST",
    },
    {
      name: "malformed content length",
      rawBody: "{}",
      headers: { "content-length": "1e2" },
      expectedStatus: 400,
      expectedCode: "INVALID_REQUEST",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { route, runtime, store } = await routeFixture(
        "/agent-guard/native-guard/v1/leases/activate",
      );
      const response = await invoke(route, {
        method: "POST",
        rawBody: entry.rawBody,
        chunks: entry.chunks,
        headers: { "content-type": "application/json", ...entry.headers },
      });
      assert.equal(response.statusCode, entry.expectedStatus);
      assert.equal((response.body as { error: { code: string } }).error.code, entry.expectedCode);
      assert.deepEqual(await runtime.lookup("agent:guard:run.1"), { state: "off" });
      assert.equal(store.writes.length, 0);
    });
  }
});

test("maps empty, invalid, and truncated JSON to stable request errors", async (t) => {
  for (const [name, rawBody] of [
    ["empty", ""],
    ["invalid", "not-json"],
    ["truncated", "{\"leaseId\":"],
  ] as const) {
    await t.test(name, async () => {
      const { route } = await routeFixture("/agent-guard/native-guard/v1/leases/activate");
      const response = await invoke(route, {
        method: "POST",
        rawBody,
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "INVALID_REQUEST",
          message: "Native guard control request is invalid.",
        },
      });
    });
  }
});

test("maps invalid activation schemas, endpoints, and times without echoing input", async (t) => {
  for (const [name, body] of [
    ["schema mismatch", activation({ schemaVersion: "other" as "native-guard-1" })],
    ["non-loopback backend", activation({ backendUrl: "https://example.com/credential-secret" })],
    ["expired activation", activation({ expiresAt: NOW })],
  ] as const) {
    await t.test(name, async () => {
      const { route } = await routeFixture("/agent-guard/native-guard/v1/leases/activate");
      const response = await invoke(route, { body });
      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, "INVALID_ACTIVATION");
      assert.equal(response.rawBody.includes("credential"), false);
      assert.equal(response.rawBody.includes("example.com"), false);
    });
  }
});

test("renew with a different root session returns a stable conflict", async () => {
  const fixture = await routeFixture("/agent-guard/native-guard/v1/leases/renew");
  await fixture.runtime.registry.activate(activation());

  const response = await invoke(fixture.route, {
    body: activation({
      leaseEpoch: 2,
      rootSessionKey: "agent:guard:other-root",
      credential: "rotated-secret",
    }),
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    error: {
      code: "LEASE_CONFLICT",
      message: "Native guard lease state conflicts with the request.",
    },
  });
  assert.equal(response.rawBody.includes("rotated-secret"), false);
});

test("client abort settles the handler without activating or echoing the request", async () => {
  const { route, runtime, store } = await routeFixture(
    "/agent-guard/native-guard/v1/leases/activate",
  );
  const request = new Readable({ read() {} }) as IncomingMessage;
  queueMicrotask(() => request.emit("aborted"));

  const response = await Promise.race([
    invoke(route, {
      method: "POST",
      request,
      headers: { "content-type": "application/json" },
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("aborted request handler remained pending")), 50);
    }),
  ]);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "REQUEST_ABORTED");
  assert.deepEqual(await runtime.lookup("agent:guard:run.1"), { state: "off" });
  assert.equal(store.writes.length, 0);
});

test("control mutations reject every Content-Encoding without registry work", async (t) => {
  for (const contentEncoding of ["identity", "gzip", "br"]) {
    await t.test(contentEncoding, async () => {
      const { route, store } = await routeFixture(
        "/agent-guard/native-guard/v1/leases/activate",
      );
      const response = await invoke(route, {
        body: activation(),
        headers: { "content-encoding": contentEncoding },
      });
      assert.equal(response.statusCode, 415);
      assert.deepEqual(response.body, {
        error: {
          code: "UNSUPPORTED_CONTENT_ENCODING",
          message: "Native guard control request encoding is unsupported.",
        },
      });
      assert.equal(store.writes.length, 0);
    });
  }
});

test("Content-Encoding rejection precedes idempotency key validation", async (t) => {
  for (const idempotencyKey of [null, "short"]) {
    await t.test(idempotencyKey ?? "missing", async () => {
      const { route, store } = await routeFixture(
        "/agent-guard/native-guard/v1/leases/activate",
      );
      const response = await invoke(route, {
        body: activation(),
        headers: { "content-encoding": "identity" },
        idempotencyKey,
      });
      assert.equal(response.statusCode, 415);
      assert.deepEqual(response.body, {
        error: {
          code: "UNSUPPORTED_CONTENT_ENCODING",
          message: "Native guard control request encoding is unsupported.",
        },
      });
      assert.equal(store.writes.length, 0);
    });
  }
});

test("slow partial body times out at two seconds and cleans all reader resources", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const timers = fakeTimers();
  const host = createHost();
  registerControlRoutes(host.api, runtime, {
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"))!;
  const request = new Readable({ read() {} }) as IncomingMessage;
  const pending = invoke(route, {
    method: "POST",
    request,
    headers: { "content-type": "application/json" },
  });
  request.push(Buffer.from("{\"schemaVersion\":"));
  await Promise.resolve();

  assert.deepEqual(timers.delays(), [2_000]);
  timers.fireDelay(2_000);
  const response = await pending;

  assert.equal(response.statusCode, 408);
  assert.equal((response.body as { error: { code: string } }).error.code, "REQUEST_TIMEOUT");
  assert.equal(response.headers.connection, "close");
  assert.equal(store.writes.length, 0);
  assert.equal(timers.activeCount(), 0);
  assertReaderClean(request, runtime.abortSignal);
});

test("close before end settles as an incomplete request without activation", async () => {
  const { route, runtime, store } = await routeFixture(
    "/agent-guard/native-guard/v1/leases/activate",
  );
  const request = new Readable({ read() {} }) as IncomingMessage;
  queueMicrotask(() => request.emit("close"));

  const response = await Promise.race([
    invoke(route, {
      method: "POST",
      request,
      headers: { "content-type": "application/json" },
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("closed request handler remained pending")), 50);
    }),
  ]);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "REQUEST_INCOMPLETE");
  assert.equal(store.writes.length, 0);
  assertReaderClean(request, runtime.abortSignal);
});

test("runtime stop aborts a pending body read and clears its timeout", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const timers = fakeTimers();
  const host = createHost();
  registerControlRoutes(host.api, runtime, {
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"))!;
  const request = new Readable({ read() {} }) as IncomingMessage;
  const pending = invoke(route, {
    method: "POST",
    request,
    headers: { "content-type": "application/json" },
  });
  await Promise.resolve();

  await runtime.stop();
  const response = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("stopped body reader remained pending")), 50);
    }),
  ]);

  assert.equal(response.statusCode, 400);
  assert.equal((response.body as { error: { code: string } }).error.code, "REQUEST_ABORTED");
  assert.equal(store.writes.length, 0);
  assert.equal(timers.activeCount(), 0);
  assertReaderClean(request, runtime.abortSignal);
});

test("body reader timeout configuration stays below the service stop budget", () => {
  for (const bodyTimeoutMs of [0, -1, 4_000, 5_000, 1.5]) {
    const runtime = new AgentGuardRuntime({
      markerStore: new MemoryMarkerStore(),
      now: () => new Date(NOW),
    });
    const host = createHost();
    assert.throws(
      () => registerControlRoutes(host.api, runtime, { bodyTimeoutMs }),
      /body timeout/i,
    );
    assert.equal(host.routes.length, 0);
  }
});

test("streamed oversize returns stable JSON over a real HTTP connection", async (t) => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"));
  assert.ok(route);
  const server = createServer((request, response) => {
    void route.handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/agent-guard/native-guard/v1/leases/activate`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": "o".repeat(43),
      },
      body: " ".repeat(65_537),
    },
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: {
      code: "REQUEST_TOO_LARGE",
      message: "Native guard control request is too large.",
    },
  });
});

async function routeFixture(path: string): Promise<{
  route: Route;
  runtime: AgentGuardRuntime;
  store: MemoryMarkerStore;
}> {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const route = host.routes.find((candidate) => candidate.path === path);
  assert.ok(route);
  return { route, runtime, store };
}

test("registers one service and one handler for each session-tree lifecycle event", () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  const host = createHost();

  registerAgentGuardLifecycle(host.api, runtime);

  assert.deepEqual(host.services.map((service) => service.id), ["agent-guard-runtime"]);
  assert.equal(typeof host.services[0].start, "function");
  assert.equal(typeof host.services[0].stop, "function");
  assert.deepEqual(
    host.hooks.map((hook) => hook.name),
    ["subagent_spawned", "subagent_ended", "session_end"],
  );
  assert.deepEqual(host.policies.map((policy) => policy.id), ["agent-guard-admission"]);
});

test("trusted policy forwards the complete event and context to the extensible runtime entry point", async () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  assert.equal(typeof runtime.trustedAdmission, "function");
  const host = createHost();
  const event = {
    toolName: "exec",
    params: { command: "echo guarded" },
    runId: "run.forwarded",
    toolCallId: "call.forwarded",
    derivedPaths: ["C:\\guarded.txt"],
  };
  const context = {
    agentId: "main",
    sessionKey: "agent:guard:forwarded",
    sessionId: "session.forwarded",
    runId: "run.forwarded",
    toolName: "exec",
    toolCallId: "call.forwarded",
    channelId: "channel.forwarded",
  };
  const delegated = {
    block: true,
    blockReason: "delegated admission",
  };
  let forwardedEvent: unknown;
  let forwardedContext: unknown;
  Object.defineProperty(runtime, "trustedAdmission", {
    configurable: true,
    value: async (receivedEvent: unknown, receivedContext: unknown) => {
      forwardedEvent = receivedEvent;
      forwardedContext = receivedContext;
      return delegated;
    },
  });

  registerAgentGuardLifecycle(host.api, runtime);

  assert.equal(host.policies.length, 1);
  assert.equal(host.policies[0].id, "agent-guard-admission");
  assert.equal(await host.policies[0].evaluate(event, context), delegated);
  assert.equal(forwardedEvent, event);
  assert.equal(forwardedContext, context);
});

test("service start keeps clean OFF free of marker writes and recovers an existing marker", async () => {
  const cleanStore = new MemoryMarkerStore();
  const cleanRuntime = new AgentGuardRuntime({
    markerStore: cleanStore,
    now: () => new Date(NOW),
  });
  const cleanHost = createHost();
  registerAgentGuardLifecycle(cleanHost.api, cleanRuntime);

  assert.deepEqual(await cleanRuntime.lookup("agent:guard:missing"), { state: "off" });
  assert.equal(cleanStore.loadCalls, 0);
  await cleanHost.services[0].start({});
  assert.deepEqual(await cleanRuntime.status(), {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  });
  assert.equal(cleanStore.loadCalls, 1);
  assert.equal(cleanStore.writes.length, 0);
  assert.equal(cleanStore.removes.length, 0);
  assert.equal(cleanRuntime.abortSignal.aborted, false);

  const recoveryStore = new MemoryMarkerStore([marker()]);
  const recoveryRuntime = new AgentGuardRuntime({
    markerStore: recoveryStore,
    now: () => new Date(NOW),
  });
  const recoveryHost = createHost();
  registerAgentGuardLifecycle(recoveryHost.api, recoveryRuntime);
  assert.deepEqual(await recoveryRuntime.lookup("agent:guard:run.1"), { state: "off" });

  await recoveryHost.services[0].start({});

  assert.equal((await recoveryRuntime.lookup("agent:guard:run.1")).state, "recovery");
  assert.equal(recoveryStore.loadCalls, 1);
  assert.equal(recoveryStore.writes.length, 0);
});

test("service startup failure remains misconfigured after host cleanup and retries safely", async () => {
  const store = new MemoryMarkerStore();
  store.load = async () => {
    store.loadCalls += 1;
    throw new Error("marker startup failed with credential-secret");
  };
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);

  await assert.rejects(() => Promise.resolve(host.services[0].start({})), (error: unknown) =>
    error instanceof Error &&
    /marker recovery failed/.test(error.message) &&
    !error.message.includes("credential-secret"));
  await host.services[0].stop?.({});

  assert.deepEqual(await runtime.status(), {
    coverage: "misconfigured",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
    reasonCode: "MARKER_RECOVERY_FAILED",
  });
  await assert.rejects(runtime.lookup("agent:guard:run.1"), /marker recovery failed/);
  await assert.rejects(runtime.activate(activation()), /marker recovery failed/);
  assert.equal(store.writes.length, 0);

  store.load = async () => {
    store.loadCalls += 1;
    return [];
  };
  await runtime.start();
  assert.deepEqual(await runtime.status(), {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  });
});

test("admission stays zero-effect OFF and passes ordinary roots beside active or recovery guards", async () => {
  const cleanHost = createHost({
    getSessionEntry: ({ sessionKey }) => sessionKey.endsWith(".empty") ? {} : undefined,
  });
  const cleanRuntime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
    sessionResolver: cleanHost.sessionResolver,
  });
  registerAgentGuardLifecycle(cleanHost.api, cleanRuntime);
  await cleanHost.services[0].start({});
  assert.equal(await evaluatePolicy(cleanHost, "agent:guard:off"), undefined);
  assert.equal(cleanHost.sessionReads.length, 0);

  await cleanRuntime.activate(activation());
  assert.equal(await evaluatePolicy(cleanHost, "agent:guard:run.1"), undefined);
  assert.equal(await evaluatePolicy(cleanHost, "agent:ordinary.undefined"), undefined);
  assert.equal(await evaluatePolicy(cleanHost, "agent:ordinary.empty"), undefined);
  assert.deepEqual(cleanHost.sessionReads.map((entry) => entry.sessionKey), [
    "agent:ordinary.undefined",
    "agent:ordinary.empty",
  ]);

  const recoveryHost = createHost({
    getSessionEntry: ({ sessionKey }) => sessionKey.endsWith(".empty") ? {} : undefined,
  });
  const recoveryRuntime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore([marker()]),
    now: () => new Date(NOW),
    sessionResolver: recoveryHost.sessionResolver,
  });
  registerAgentGuardLifecycle(recoveryHost.api, recoveryRuntime);
  await recoveryHost.services[0].start({});
  assert.deepEqual(await evaluatePolicy(recoveryHost, "agent:guard:run.1"), {
    block: true,
    blockReason: "Native guard recovery requires reactivation.",
  });
  assert.equal(await evaluatePolicy(recoveryHost, "agent:ordinary.undefined"), undefined);
  assert.equal(await evaluatePolicy(recoveryHost, "agent:ordinary.empty"), undefined);
  assert.deepEqual(recoveryHost.sessionReads.map((entry) => entry.sessionKey), [
    "agent:ordinary.undefined",
    "agent:ordinary.empty",
  ]);
});

test("first child admission waits for its durable lazy binding before passing", async () => {
  const parent = "agent:guard:run.1";
  const child = "agent:guard:child.1";
  const store = new BlockingMarkerStore();
  const host = createHost({
    getSessionEntry: ({ sessionKey }) => sessionKey === child
      ? { spawnedBy: parent, parentSessionKey: parent }
      : undefined,
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    sessionResolver: host.sessionResolver,
  });
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  store.blockWrites();
  let settled = false;

  const admission = Promise.resolve(evaluatePolicy(host, child)).then((result) => {
    settled = true;
    return result;
  });
  await store.writeStarted;

  assert.equal(settled, false);
  assert.deepEqual(host.sessionReads, [{
    agentId: "main",
    sessionKey: child,
    readConsistency: "latest",
  }]);
  store.releaseWrites();
  assert.equal(await admission, undefined);
  assert.equal((await runtime.lookup(child)).state, "active");
});

test("concurrent first-child admissions pass only after one binding wins and the loser rechecks", async () => {
  const parent = "agent:guard:run.1";
  const child = "agent:guard:child.1";
  const store = new BlockingMarkerStore();
  const host = createHost({
    getSessionEntry: () => ({ spawnedBy: parent, parentSessionKey: parent }),
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    sessionResolver: host.sessionResolver,
  });
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  store.blockWrites();

  const admissions = [evaluatePolicy(host, child), evaluatePolicy(host, child)];
  await store.writeStarted;
  store.releaseWrites();

  assert.deepEqual(await Promise.all(admissions), [undefined, undefined]);
  assert.deepEqual(store.writes.at(-1)?.childSessionKeys, [child]);
  assert.equal(store.writes.filter((entry) => entry.childSessionKeys.includes(child)).length, 1);
});

test("admission passes a child from an unrelated OFF tree without marker writes", async () => {
  const parent = "agent:unrelated:parent";
  const child = "agent:unrelated:child";
  const store = new MemoryMarkerStore();
  const host = createHost({
    getSessionEntry: () => ({ spawnedBy: parent, parentSessionKey: parent }),
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    sessionResolver: host.sessionResolver,
  });
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  const writes = store.writes.length;

  assert.equal(await evaluatePolicy(host, child), undefined);
  assert.equal(store.writes.length, writes);
  assert.deepEqual(await runtime.lookup(child), { state: "off" });
});

test("admission blocks a child whose proven parent remains in recovery", async () => {
  const parent = "agent:guard:run.1";
  const child = "agent:guard:child.1";
  const store = new MemoryMarkerStore([marker()]);
  const host = createHost({
    getSessionEntry: () => ({ spawnedBy: parent, parentSessionKey: parent }),
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    sessionResolver: host.sessionResolver,
  });
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  const writes = store.writes.length;

  assert.deepEqual(await evaluatePolicy(host, child), {
    block: true,
    blockReason: "Native guard recovery requires reactivation.",
  });
  assert.equal(store.writes.length, writes);
});

test("admission blocks partial, invalid, or contradictory host lineage", async (t) => {
  const parent = "agent:guard:run.1";
  for (const [name, entry] of [
    ["missing spawnedBy", { parentSessionKey: parent }],
    ["missing parentSessionKey", { spawnedBy: parent }],
    ["conflict", { spawnedBy: parent, parentSessionKey: "agent:guard:other" }],
    ["invalid", { spawnedBy: "../unsafe", parentSessionKey: "../unsafe" }],
  ] as const) {
    await t.test(name, async () => {
      const store = new MemoryMarkerStore();
      const host = createHost({ getSessionEntry: () => entry });
      const runtime = new AgentGuardRuntime({
        markerStore: store,
        now: () => new Date(NOW),
        sessionResolver: host.sessionResolver,
      });
      registerAgentGuardLifecycle(host.api, runtime);
      await host.services[0].start({});
      await runtime.activate(activation());
      const writes = store.writes.length;

      assert.deepEqual(await evaluatePolicy(host, "agent:guard:child.1"), {
        block: true,
        blockReason: "Native guard session inheritance could not be proven.",
      });
      assert.equal(store.writes.length, writes);
    });
  }
});

test("admission contains resolver, parent lookup, and active binding failures", async () => {
  const missingResolverRuntime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  const missingResolverHost = createHost();
  registerAgentGuardLifecycle(missingResolverHost.api, missingResolverRuntime);
  await missingResolverHost.services[0].start({});
  await missingResolverRuntime.activate(activation());
  assert.deepEqual(await evaluatePolicy(missingResolverHost, "agent:guard:child.1"), {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  });

  const readFailureHost = createHost({
    getSessionEntry: () => {
      throw new Error("host session read failed");
    },
  });
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
    sessionResolver: readFailureHost.sessionResolver,
  });
  registerAgentGuardLifecycle(readFailureHost.api, runtime);
  await readFailureHost.services[0].start({});
  await runtime.activate(activation());
  assert.deepEqual(await evaluatePolicy(readFailureHost, "agent:guard:child.1"), {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  });

  const failingStore = new MemoryMarkerStore();
  const bindingFailureHost = createHost({
    getSessionEntry: () => ({
      spawnedBy: "agent:guard:run.1",
      parentSessionKey: "agent:guard:run.1",
    }),
  });
  const failingRuntime = new AgentGuardRuntime({
    markerStore: failingStore,
    now: () => new Date(NOW),
    sessionResolver: bindingFailureHost.sessionResolver,
  });
  registerAgentGuardLifecycle(bindingFailureHost.api, failingRuntime);
  await bindingFailureHost.services[0].start({});
  await failingRuntime.activate(activation());
  failingStore.write = async () => {
    throw new Error("marker binding failed");
  };
  assert.deepEqual(await evaluatePolicy(bindingFailureHost, "agent:guard:child.1"), {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  });

  const parentLookupHost = createHost({
    getSessionEntry: () => ({
      spawnedBy: "agent:guard:run.1",
      parentSessionKey: "agent:guard:run.1",
    }),
  });
  const parentLookupRuntime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
    sessionResolver: parentLookupHost.sessionResolver,
  });
  registerAgentGuardLifecycle(parentLookupHost.api, parentLookupRuntime);
  await parentLookupHost.services[0].start({});
  await parentLookupRuntime.activate(activation());
  const lookup = parentLookupRuntime.lookup.bind(parentLookupRuntime);
  Object.defineProperty(parentLookupRuntime, "lookup", {
    value: async (sessionKey: string) => sessionKey === "agent:guard:run.1"
      ? Promise.reject(new Error("parent lookup leaked secret"))
      : lookup(sessionKey),
  });
  assert.deepEqual(await evaluatePolicy(parentLookupHost, "agent:guard:child.1"), {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  });

  const inconsistentHost = createHost({
    getSessionEntry: () => ({
      spawnedBy: "agent:guard:run.1",
      parentSessionKey: "agent:guard:run.1",
    }),
  });
  const inconsistentRuntime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
    sessionResolver: inconsistentHost.sessionResolver,
  });
  registerAgentGuardLifecycle(inconsistentHost.api, inconsistentRuntime);
  await inconsistentHost.services[0].start({});
  await inconsistentRuntime.activate(activation());
  Object.defineProperty(inconsistentRuntime, "bindChild", { value: async () => false });
  assert.deepEqual(await evaluatePolicy(inconsistentHost, "agent:guard:child.1"), {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  });
});

test("spawn hook rejects contradictory child identities before binding", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  const writes = store.writes.length;

  await hook(host, "subagent_spawned")(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
    childSessionKey: "agent:guard:other-child",
  });

  assert.equal(store.writes.length, writes);
  assert.deepEqual(await runtime.lookup("agent:guard:child.1"), { state: "off" });
});

test("shutdown and restart session drains preserve markers for recovery", async () => {
  for (const reason of ["shutdown", "restart"] as const) {
    const store = new MemoryMarkerStore();
    const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
    const host = createHost();
    registerAgentGuardLifecycle(host.api, runtime);
    await host.services[0].start({});
    await runtime.activate(activation());

    await hook(host, "session_end")({ sessionKey: "agent:guard:run.1", reason }, {});
    await host.services[0].stop?.({});

    assert.equal(store.removes.length, 0, reason);
    const restarted = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
    await restarted.start();
    assert.equal((await restarted.lookup("agent:guard:run.1")).state, "recovery", reason);
  }
});

test("spawn binds only a child whose requester proves an active parent lease", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  const spawned = hook(host, "subagent_spawned");

  await spawned(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
    childSessionKey: "agent:guard:child.1",
  });

  assert.equal((await runtime.lookup("agent:guard:child.1")).state, "active");
  assert.deepEqual(store.writes.at(-1)?.childSessionKeys, ["agent:guard:child.1"]);
  const writesAfterBinding = store.writes.length;

  await spawned(spawnedEvent("agent:guard:unknown-child"), {
    requesterSessionKey: "agent:guard:unknown-parent",
    childSessionKey: "agent:guard:unknown-child",
  });
  await spawned(spawnedEvent("agent:guard:no-requester"), {});
  await spawned(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
    childSessionKey: "agent:guard:child.1",
  });

  assert.equal(store.writes.length, writesAfterBinding);
  assert.deepEqual(await runtime.lookup("agent:guard:unknown-child"), { state: "off" });
  assert.deepEqual(await runtime.lookup("agent:guard:no-requester"), { state: "off" });
});

test("spawn never binds from a recovery marker", async () => {
  const store = new MemoryMarkerStore([marker()]);
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});

  await hook(host, "subagent_spawned")(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
    childSessionKey: "agent:guard:child.1",
  });

  assert.equal((await runtime.lookup("agent:guard:run.1")).state, "recovery");
  assert.deepEqual(await runtime.lookup("agent:guard:child.1"), { state: "off" });
  assert.equal(store.writes.length, 0);
});

test("subagent and session end hooks remove trees idempotently with event identity precedence", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  await hook(host, "subagent_spawned")(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
    childSessionKey: "agent:guard:child.1",
  });

  const ended = hook(host, "subagent_ended");
  await ended({
    targetSessionKey: "agent:guard:child.1",
    targetKind: "subagent",
    reason: "completed",
  }, {});
  const writesAfterEnd = store.writes.length;
  await ended({
    targetSessionKey: "agent:guard:child.1",
    targetKind: "subagent",
    reason: "duplicate",
  }, {});
  assert.equal(store.writes.length, writesAfterEnd);
  assert.deepEqual(await runtime.lookup("agent:guard:child.1"), { state: "off" });

  await hook(host, "session_end")(
    { sessionKey: "agent:guard:run.1" },
    { sessionKey: "agent:guard:wrong-context" },
  );
  assert.deepEqual(await runtime.lookup("agent:guard:run.1"), { state: "off" });
  assert.deepEqual(store.removes, ["lease.1"]);
});

test("service stop aborts immediately, flushes marker writes, and rejects later writes", async () => {
  const store = new BlockingMarkerStore();
  const timers = fakeTimers();
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  store.blockWrites();
  const activating = runtime.activate(activation());
  await store.writeStarted;

  const stopping = host.services[0].stop!({});

  assert.equal(runtime.abortSignal.aborted, true);
  assert.deepEqual(timers.delays(), [4_000]);
  assert.equal(store.writes.length, 0);
  store.releaseWrites();
  await activating;
  await stopping;
  await assert.rejects(runtime.bindChild(
    "lease.1",
    "agent:guard:run.1",
    "agent:guard:late-child",
  ), /stopped/i);
  assert.equal(store.writes.length, 1);
  assert.equal(timers.activeCount(), 0);
});

test("four-second stop timeout prevents queued marker operations from writing later", async () => {
  const store = new BlockingMarkerStore();
  const timers = fakeTimers();
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  await runtime.start();
  store.blockWrites();
  const first = runtime.activate(activation());
  await store.writeStarted;
  const queued = runtime.activate(activation({
    leaseId: "lease.2",
    rootSessionKey: "agent:guard:run.2",
    credential: "credential.2",
  }));

  const stopping = runtime.stop();
  assert.deepEqual(timers.delays(), [4_000]);
  timers.fireAll();
  await stopping;
  assert.equal(runtime.abortSignal.aborted, true);
  await assert.rejects(runtime.activate(activation({ leaseId: "lease.3" })), /stopped/i);

  store.releaseWrites();
  await first;
  await assert.rejects(queued, /stopped/i);
  assert.deepEqual(store.writes.map((entry) => entry.leaseId), ["lease.1"]);
});

test("stop during startup waits for marker recovery and cannot return to running", async () => {
  const store = new BlockingLoadMarkerStore();
  const timers = fakeTimers();
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  const starting = runtime.start();
  await store.loadStarted;

  const stopping = runtime.stop();

  assert.equal(runtime.abortSignal.aborted, true);
  assert.deepEqual(timers.delays(), [4_000]);
  store.releaseLoad();
  await starting;
  await stopping;
  assert.deepEqual(await runtime.status(), {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  });
  await assert.rejects(runtime.activate(activation()), /stopped/i);
  assert.equal(timers.activeCount(), 0);
});

test("internal stop deadline completes before the host five-second deadline", async () => {
  const store = new BlockingMarkerStore();
  const timers = fakeTimers();
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    scheduleTimeout: timers.schedule,
    cancelTimeout: timers.cancel,
  });
  await runtime.start();
  store.blockWrites();
  const activating = runtime.activate(activation());
  await store.writeStarted;
  let hostTimedOut = false;

  const stopping = runtime.stop();
  timers.schedule(() => {
    hostTimedOut = true;
  }, 5_000);

  assert.deepEqual(timers.delays(), [4_000, 5_000]);
  timers.fireDelay(4_000);
  await stopping;
  assert.equal(hostTimedOut, false);
  timers.fireDelay(5_000);
  assert.equal(hostTimedOut, true);
  store.releaseWrites();
  await activating;
});

test("spawn hook does not resolve before the child marker write completes", async () => {
  const store = new BlockingMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);
  await host.services[0].start({});
  await runtime.activate(activation());
  store.blockWrites();
  let settled = false;

  const binding = Promise.resolve(hook(host, "subagent_spawned")(
    spawnedEvent("agent:guard:child.1"),
    {
      requesterSessionKey: "agent:guard:run.1",
      childSessionKey: "agent:guard:child.1",
    },
  )).then(() => {
    settled = true;
  });
  await store.writeStarted;

  assert.equal(settled, false);
  store.releaseWrites();
  await binding;
  assert.equal(settled, true);
  assert.equal((await runtime.lookup("agent:guard:child.1")).state, "active");
});

test("status projects an allowlist and never returns secrets, policy contents, or the session tree", async () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  Object.defineProperty(runtime, "status", {
    value: async () => ({
      coverage: "active",
      finalizerAssurance: "unverified",
      activeLeaseCount: 1,
      credential: "status-credential-secret",
      decisionPrivateKey: "-----BEGIN PRIVATE KEY-----",
      detail: "policies: allow every tool",
      activeLease: {
        leaseId: "lease.1",
        leaseEpoch: 1,
        rootSessionKey: "agent:guard:run.1",
        mode: "supervision",
        policyPackId: "policy.1",
        policyPackDigest: "a".repeat(64),
        expiresAt: "2026-08-02T00:05:00.000Z",
        credential: "nested-credential-secret",
        decisionPublicKey: PUBLIC_KEY,
        backendUrl: "http://127.0.0.1/private",
        childSessionKeys: ["agent:guard:child.1"],
      },
    }),
  });
  const host = createHost();
  registerControlRoutes(host.api, runtime);

  const response = await invoke(
    host.routes.find((route) => route.path.endsWith("/status"))!,
    { method: "GET" },
  );

  assert.deepEqual(response.body, {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLease: {
      leaseId: "lease.1",
      leaseEpoch: 1,
      rootSessionKey: "agent:guard:run.1",
      mode: "supervision",
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    },
  });
  assert.doesNotMatch(
    response.rawBody,
    /credential|private key|decisionPublicKey|backendUrl|childSessionKeys|policies/i,
  );
});

test("unexpected route failures use a fixed credential-free error", async () => {
  const store = new MemoryMarkerStore();
  store.write = async () => {
    throw new Error("write exposed credential-secret and -----BEGIN PRIVATE KEY-----");
  };
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);

  const response = await invoke(
    host.routes.find((route) => route.path.endsWith("/activate"))!,
    { body: activation() },
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    error: {
      code: "NATIVE_GUARD_INTERNAL",
      message: "Native guard control operation failed.",
    },
  });
  assert.doesNotMatch(response.rawBody, /credential-secret|private key/i);
});

test("revoke rejects schema mismatches and invalid lease identities", async (t) => {
  for (const body of [
    {},
    { leaseId: "lease.1", credential: "must-not-echo" },
    { leaseId: "" },
    { leaseId: 1 },
  ]) {
    await t.test(JSON.stringify(body), async () => {
      const { route } = await routeFixture("/agent-guard/native-guard/v1/leases/revoke");
      const response = await invoke(route, { body });
      assert.equal(response.statusCode, 400);
      assert.equal((response.body as { error: { code: string } }).error.code, "INVALID_REQUEST");
      assert.equal(response.rawBody.includes("must-not-echo"), false);
    });
  }
});

test("mutations require a strict base64url idempotency key before registry work", async (t) => {
  for (const key of [null, "", "short", "+".repeat(43), "A".repeat(44)]) {
    await t.test(String(key), async () => {
      const { route, store } = await routeFixture(
        "/agent-guard/native-guard/v1/leases/activate",
      );
      const response = await invoke(route, { body: activation(), idempotencyKey: key });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, {
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "Native guard idempotency key is invalid.",
        },
      });
      assert.equal(store.writes.length, 0);
    });
  }
});

test("successful mutation replay returns the first projected response without executing again", async () => {
  const { route, runtime, store } = await routeFixture(
    "/agent-guard/native-guard/v1/leases/activate",
  );
  const key = "R".repeat(43);
  const first = await invoke(route, { body: activation(), idempotencyKey: key });
  await runtime.revoke("lease.1");

  const replay = await invoke(route, { body: activation(), idempotencyKey: key });

  assert.equal(first.statusCode, 200);
  assert.deepEqual(replay, first);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(await runtime.lookup("agent:guard:run.1"), { state: "off" });
});

test("one idempotency key cannot cross request digests or route operations", async () => {
  const store = new MemoryMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const routes = new Map(host.routes.map((route) => [route.path, route]));
  const key = "C".repeat(43);
  await invoke(routes.get("/agent-guard/native-guard/v1/leases/activate")!, {
    body: activation(),
    idempotencyKey: key,
  });

  for (const [route, body] of [
    [
      routes.get("/agent-guard/native-guard/v1/leases/activate")!,
      activation({ leaseId: "lease.2", rootSessionKey: "agent:guard:run.2" }),
    ],
    [
      routes.get("/agent-guard/native-guard/v1/leases/renew")!,
      activation({ leaseEpoch: 2, credential: "rotated.2" }),
    ],
  ] as const) {
    const response = await invoke(route, { body, idempotencyKey: key });
    assert.equal(response.statusCode, 409);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      "IDEMPOTENCY_CONFLICT",
    );
  }
  assert.equal(store.writes.length, 1);
});

test("concurrent identical mutation requests singleflight one marker transaction", async () => {
  const store = new BlockingMarkerStore();
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"))!;
  const key = "S".repeat(43);
  store.blockWrites();

  const requests = [
    invoke(route, { body: activation(), idempotencyKey: key }),
    invoke(route, { body: activation(), idempotencyKey: key }),
  ];
  await store.writeStarted;
  store.releaseWrites();
  const responses = await Promise.all(requests);

  assert.deepEqual(responses[1].body, responses[0].body);
  assert.deepEqual(store.writes.map((entry) => entry.leaseId), ["lease.1"]);
});

test("concurrent 5xx shares one failed transaction then permits a safe retry", async () => {
  const store = new MemoryMarkerStore();
  const write = store.write.bind(store);
  let writeCalls = 0;
  store.write = async (value) => {
    writeCalls += 1;
    if (writeCalls === 1) throw new Error("transient marker failure");
    await write(value);
  };
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  await runtime.start();
  const host = createHost();
  registerControlRoutes(host.api, runtime);
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"))!;
  const key = "F".repeat(43);

  const failed = await Promise.all([
    invoke(route, { body: activation(), idempotencyKey: key }),
    invoke(route, { body: activation(), idempotencyKey: key }),
  ]);

  assert.deepEqual(failed.map((response) => response.statusCode), [500, 500]);
  assert.equal(writeCalls, 1);
  const retry = await invoke(route, { body: activation(), idempotencyKey: key });
  assert.equal(retry.statusCode, 200);
  assert.equal(writeCalls, 2);
});

test("idempotency cache evicts the oldest settled entry at its configured bound", async () => {
  const runtime = new AgentGuardRuntime({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  let calls = 0;
  Object.defineProperty(runtime, "activate", {
    value: async () => {
      calls += 1;
      return {
        coverage: "off",
        finalizerAssurance: "unverified",
        activeLeaseCount: 0,
      };
    },
  });
  const host = createHost();
  registerControlRoutes(host.api, runtime, { idempotencyCapacity: 2 });
  const route = host.routes.find((candidate) => candidate.path.endsWith("/activate"))!;
  const bodies = ["lease.1", "lease.2", "lease.3"].map((leaseId, index) => activation({
    leaseId,
    rootSessionKey: `agent:guard:run.${String(index + 1)}`,
  }));
  const keys = ["1".repeat(43), "2".repeat(43), "3".repeat(43)];
  for (let index = 0; index < bodies.length; index += 1) {
    await invoke(route, { body: bodies[index], idempotencyKey: keys[index] });
  }
  assert.equal(calls, 3);

  await invoke(route, { body: bodies[1], idempotencyKey: keys[1] });
  assert.equal(calls, 3);
  await invoke(route, { body: bodies[0], idempotencyKey: keys[0] });
  assert.equal(calls, 4);
});

test("plugin entry wires controls and lifecycle, and root script runs both plugin suites in order", async () => {
  const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /register:\s*\(api\)\s*=>\s*registerAgentGuardPlugin\(api\)/);
  assert.doesNotMatch(indexSource, /register:\s*\(\)\s*=>\s*undefined/);
  assert.doesNotMatch(indexSource, /export const runtime|new AgentGuardRuntime/);

  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const command = rootPackage.scripts?.["test:native-guard:plugin"] ?? "";
  const registryIndex = command.indexOf("leaseRegistry.test.ts");
  const routesIndex = command.indexOf("controlRoutes.test.ts");
  assert.ok(registryIndex >= 0);
  assert.ok(routesIndex > registryIndex);
});

test("plugin registration consumes markerDir and creates a fresh runtime per host", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-guard-control-registration-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const markerDir = join(parent, "custom-markers");
  await new FileMarkerStore(markerDir).write(marker({ expiresAt: "2099-01-01T00:00:00.000Z" }));
  const customHost = createHost({ pluginConfig: { markerDir } });

  const customRuntime = registerAgentGuardPlugin(customHost.api);
  await customHost.services[0].start({});

  assert.equal((await customRuntime.lookup("agent:guard:run.1")).state, "recovery");
  const otherHost = createHost();
  const otherRuntime = registerAgentGuardPlugin(otherHost.api);
  assert.notEqual(otherRuntime, customRuntime);
  assert.equal(otherHost.services.length, 1);
  assert.equal(otherHost.policies.length, 1);
});

test("invalid markerDir fails registration before any host capability is installed", () => {
  for (const markerDir of ["", "   ", "x".repeat(4_097), 42, "bad\0path"]) {
    const host = createHost({ pluginConfig: { markerDir } });
    assert.throws(() => registerAgentGuardPlugin(host.api), /markerDir/);
    assert.equal(host.routes.length, 0);
    assert.equal(host.services.length, 0);
    assert.equal(host.hooks.length, 0);
    assert.equal(host.policies.length, 0);
  }
});

test("trusted policy registration failures propagate instead of silently degrading", () => {
  const host = createHost();
  host.api.registerTrustedToolPolicy = () => {
    throw new Error("duplicate trusted policy");
  };

  assert.throws(() => registerAgentGuardPlugin(host.api), /duplicate trusted policy/);
});

class BlockingMarkerStore extends MemoryMarkerStore {
  writeStarted: Promise<void> = Promise.resolve();
  #announceWrite: (() => void) | undefined;
  #releaseWrite: (() => void) | undefined;
  #writeGate: Promise<void> | undefined;

  blockWrites(): void {
    this.writeStarted = new Promise<void>((resolve) => {
      this.#announceWrite = resolve;
    });
    this.#writeGate = new Promise<void>((resolve) => {
      this.#releaseWrite = resolve;
    });
  }

  releaseWrites(): void {
    this.#releaseWrite?.();
  }

  override async write(value: GuardedMarker): Promise<void> {
    this.#announceWrite?.();
    await this.#writeGate;
    await super.write(value);
  }
}

class BlockingLoadMarkerStore extends MemoryMarkerStore {
  readonly loadStarted: Promise<void>;
  #announceLoad!: () => void;
  #releaseLoad!: () => void;
  readonly #loadGate: Promise<void>;

  constructor() {
    super();
    this.loadStarted = new Promise<void>((resolve) => {
      this.#announceLoad = resolve;
    });
    this.#loadGate = new Promise<void>((resolve) => {
      this.#releaseLoad = resolve;
    });
  }

  releaseLoad(): void {
    this.#releaseLoad();
  }

  override async load(): Promise<unknown[]> {
    this.#announceLoad();
    await this.#loadGate;
    return super.load();
  }
}

function marker(overrides: Partial<GuardedMarker> = {}): GuardedMarker {
  return {
    leaseId: "lease.1",
    rootSessionKey: "agent:guard:run.1",
    childSessionKeys: [],
    mode: "supervision",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T00:05:00.000Z",
    ...overrides,
  };
}

function spawnedEvent(childSessionKey: string): Record<string, unknown> {
  return {
    childSessionKey,
    agentId: "main",
    mode: "run",
    threadRequested: false,
    runId: `run:${childSessionKey}`,
  };
}

function hook(host: ReturnType<typeof createHost>, name: string): HookHandler {
  const registration = host.hooks.find((candidate) => candidate.name === name);
  assert.ok(registration);
  return registration.handler;
}

async function evaluatePolicy(
  host: ReturnType<typeof createHost>,
  sessionKey?: string,
): Promise<unknown> {
  assert.equal(host.policies.length, 1);
  return host.policies[0].evaluate(
    { toolName: "exec", params: { command: "echo guarded" } },
    { agentId: "main", sessionKey, toolName: "exec" },
  );
}

function assertReaderClean(request: IncomingMessage, signal: AbortSignal): void {
  for (const event of ["data", "end", "close", "aborted", "error"]) {
    assert.equal(getEventListeners(request, event).length, 0, event);
  }
  assert.equal(getEventListeners(signal, "abort").length, 0, "abort signal");
}

function fakeTimers(): {
  schedule: (callback: () => void, delay: number) => object;
  cancel: (handle: unknown) => void;
  delays: () => number[];
  activeCount: () => number;
  fireAll: () => void;
  fireDelay: (delay: number) => void;
} {
  const entries = new Map<object, { callback: () => void; delay: number }>();
  const seenDelays: number[] = [];
  return {
    schedule(callback, delay) {
      const handle = {};
      entries.set(handle, { callback, delay });
      seenDelays.push(delay);
      return handle;
    },
    cancel(handle) {
      if (typeof handle === "object" && handle !== null) entries.delete(handle);
    },
    delays: () => [...seenDelays],
    activeCount: () => entries.size,
    fireAll() {
      for (const [handle, entry] of [...entries]) {
        entries.delete(handle);
        entry.callback();
      }
    },
    fireDelay(delay) {
      for (const [handle, entry] of [...entries]) {
        if (entry.delay !== delay) continue;
        entries.delete(handle);
        entry.callback();
      }
    },
  };
}
