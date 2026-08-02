import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { NativeGuardLeaseActivation } from "@agent-guard/contracts";
import {
  registerAgentGuardLifecycle,
  registerControlRoutes,
} from "./controlRoutes";
import { type GuardedMarker, type MarkerStore } from "./leaseRegistry";
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

function createHost(): {
  routes: Route[];
  hooks: Array<{ name: string; handler: HookHandler }>;
  services: Service[];
  api: Parameters<typeof registerControlRoutes>[0] & Parameters<typeof registerAgentGuardLifecycle>[0];
} {
  const routes: Route[] = [];
  const hooks: Array<{ name: string; handler: HookHandler }> = [];
  const services: Service[] = [];
  return {
    routes,
    hooks,
    services,
    api: {
      registerHttpRoute: (route: Route) => routes.push(route),
      on: (name: string, handler: HookHandler) => hooks.push({ name, handler }),
      registerService: (service: Service) => services.push(service),
    } as Parameters<typeof registerControlRoutes>[0] & Parameters<typeof registerAgentGuardLifecycle>[0],
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
  } = {},
): Promise<CapturedResponse> {
  const hasBody = Object.hasOwn(options, "body");
  const rawBody = options.rawBody ?? (hasBody ? JSON.stringify(options.body) : "");
  const chunks = options.chunks ?? (rawBody === "" ? [] : [Buffer.from(rawBody)]);
  const request = options.request ?? Readable.from(chunks) as IncomingMessage;
  request.method = options.method ?? (hasBody ? "POST" : "GET");
  request.headers = {
    ...(hasBody ? { "content-type": "application/json" } : {}),
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
      headers: { "content-type": "application/json" },
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

test("service startup failure propagates and leaves runtime OFF", async () => {
  const store = new MemoryMarkerStore();
  store.load = async () => {
    store.loadCalls += 1;
    throw new Error("marker startup failed");
  };
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });
  const host = createHost();
  registerAgentGuardLifecycle(host.api, runtime);

  await assert.rejects(
    () => Promise.resolve(host.services[0].start({})),
    /marker startup failed/,
  );

  assert.deepEqual(await runtime.lookup("agent:guard:run.1"), { state: "off" });
  assert.equal(store.writes.length, 0);
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
  });

  assert.equal((await runtime.lookup("agent:guard:child.1")).state, "active");
  assert.deepEqual(store.writes.at(-1)?.childSessionKeys, ["agent:guard:child.1"]);
  const writesAfterBinding = store.writes.length;

  await spawned(spawnedEvent("agent:guard:unknown-child"), {
    requesterSessionKey: "agent:guard:unknown-parent",
  });
  await spawned(spawnedEvent("agent:guard:no-requester"), {});
  await spawned(spawnedEvent("agent:guard:child.1"), {
    requesterSessionKey: "agent:guard:run.1",
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
  assert.deepEqual(timers.delays(), [5_000]);
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

test("five-second stop timeout prevents queued marker operations from writing later", async () => {
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
  assert.deepEqual(timers.delays(), [5_000]);
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
  assert.deepEqual(timers.delays(), [5_000]);
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
    { requesterSessionKey: "agent:guard:run.1" },
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

test("plugin entry wires controls and lifecycle, and root script runs both plugin suites in order", async () => {
  const indexSource = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /register:\s*\(api\)\s*=>\s*registerAgentGuardPlugin\(api,\s*runtime\)/);
  assert.doesNotMatch(indexSource, /register:\s*\(\)\s*=>\s*undefined/);

  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const command = rootPackage.scripts?.["test:native-guard:plugin"] ?? "";
  const registryIndex = command.indexOf("leaseRegistry.test.ts");
  const routesIndex = command.indexOf("controlRoutes.test.ts");
  assert.ok(registryIndex >= 0);
  assert.ok(routesIndex > registryIndex);
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

function fakeTimers(): {
  schedule: (callback: () => void, delay: number) => object;
  cancel: (handle: unknown) => void;
  delays: () => number[];
  activeCount: () => number;
  fireAll: () => void;
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
  };
}
