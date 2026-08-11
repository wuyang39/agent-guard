import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  MainAgentSupervisionServiceError,
  type MainAgentSupervisionService,
  type MainAgentSupervisionStatus,
} from "../../../modules/openclaw/mainAgentSupervisionService";
import {
  NATIVE_SUPERVISION_CONTROL_COOKIE,
  NATIVE_SUPERVISION_EVENTS_COOKIE,
  openClawNativeSupervisionRoutes,
} from "./native-supervision-handlers";
import { createNativeSupervisionAccessService } from "../../../modules/openclaw/nativeSupervisionAccessService";

test("authenticated native supervision routes expose only public service status", async () => {
  const calls: string[] = [];
  const app = await routeApp(serviceFixture({ calls }));

  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
  });
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    payload: { policyPackId: "policy.main" },
  });
  const stopped = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });

  assert.equal(initial.statusCode, 200);
  assert.equal(started.statusCode, 200);
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(calls, ["status", "start:policy.main", "stop"]);
  assert.deepEqual(responseData(started), activeStatus());
  assert.doesNotMatch(started.body, /credential|control.?token|secret/i);
  await app.close();
});

test("start accepts only an exact bounded policyPackId body", async () => {
  const app = await routeApp(serviceFixture());
  for (const payload of [
    undefined,
    {},
    { policyPackId: "" },
    { policyPackId: "x".repeat(257) },
    { policyPackId: "policy.main", agentId: "main" },
    { policyPackId: "policy.main", controlToken: "secret" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-supervision/start",
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "MAIN_AGENT_SUPERVISION_INVALID_REQUEST");
  }
  await app.close();
});

test("stop accepts no body or an exact empty object", async () => {
  const app = await routeApp(serviceFixture());

  const absent = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });
  const empty = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    payload: {},
  });
  const additional = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    payload: { agentId: "main" },
  });

  assert.equal(absent.statusCode, 200);
  assert.equal(empty.statusCode, 200);
  assert.equal(additional.statusCode, 400);
  assert.equal(additional.json().error.code, "MAIN_AGENT_SUPERVISION_INVALID_REQUEST");
  await app.close();
});

test("stable service errors map to their 400, 409, and 503 responses", async () => {
  for (const statusCode of [400, 409, 503] as const) {
    const service = serviceFixture();
    service.start = async () => {
      throw new MainAgentSupervisionServiceError(
        `MAIN_AGENT_SUPERVISION_${String(statusCode)}`,
        statusCode,
        `stable ${String(statusCode)}`,
      );
    };
    const app = await routeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-supervision/start",
      payload: { policyPackId: "policy.main" },
    });

    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(response.json().error, {
      code: `MAIN_AGENT_SUPERVISION_${String(statusCode)}`,
      message: `stable ${String(statusCode)}`,
    });
    await app.close();
  }
});

test("unexpected dependency failures are sanitized as unavailable", async () => {
  const service = serviceFixture();
  service.status = async () => {
    throw new Error("secret gateway token leaked");
  };
  const app = await routeApp(service);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "MAIN_AGENT_SUPERVISION_UNAVAILABLE");
  assert.doesNotMatch(response.body, /secret|gateway token/i);
  await app.close();
});

test("bootstrap validates the exact body and exchanges once for a scoped control cookie", async () => {
  let nowMs = 1_000;
  const bootstrap = "b".repeat(43);
  const accessService = createNativeSupervisionAccessService({
    bootstrapToken: bootstrap,
    now: () => nowMs,
    controlTtlMs: 5_500,
    createToken: sequenceTokenFactory("c", "e"),
  });
  const app = Fastify({ logger: false });
  await app.register(openClawNativeSupervisionRoutes, {
    service: serviceFixture(),
    accessService,
    allowedOrigins: ["http://127.0.0.1:5173"],
    now: () => nowMs,
  });

  for (const payload of [
    undefined,
    {},
    { token: "short" },
    { token: bootstrap, extra: true },
  ]) {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-supervision/access/bootstrap",
      headers: { origin: "http://127.0.0.1:5173" },
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
    assert.equal(invalid.json().error.code, "NATIVE_SUPERVISION_INVALID_REQUEST");
    assert.equal(invalid.headers["set-cookie"], undefined);
  }

  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/access/bootstrap",
    headers: { origin: "http://127.0.0.1:5173" },
    payload: { token: "x".repeat(43) },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, "NATIVE_SUPERVISION_BOOTSTRAP_INVALID");
  assert.equal(wrong.headers["set-cookie"], undefined);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/access/bootstrap",
    headers: {
      origin: "http://127.0.0.1:5173",
      "x-forwarded-proto": "https",
    },
    payload: { token: bootstrap },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  const setCookie = singleSetCookie(response.headers["set-cookie"]);
  assert.match(setCookie, new RegExp(`^${NATIVE_SUPERVISION_CONTROL_COOKIE}=[A-Za-z0-9_-]{43};`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/v1\/openclaw\/native-supervision/);
  assert.match(setCookie, /Max-Age=5(?:;|$)/);
  assert.doesNotMatch(setCookie, /; Secure(?:;|$)/);

  nowMs += 100;
  const reused = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/access/bootstrap",
    headers: { origin: "http://127.0.0.1:5173" },
    payload: { token: bootstrap },
  });
  assert.equal(reused.statusCode, 401);
  assert.equal(reused.json().error.code, "NATIVE_SUPERVISION_BOOTSTRAP_INVALID");
  assert.equal(reused.headers["set-cookie"], undefined);
  await app.close();
});

test("native supervision rejects missing, null, and malicious origins before auth or service work", async () => {
  const calls: string[] = [];
  const accessCalls: string[] = [];
  const accessService = {
    exchangeBootstrap() { accessCalls.push("bootstrap"); return undefined; },
    issueEventCapability() { accessCalls.push("events"); return undefined; },
    authenticateControl() { accessCalls.push("control"); return true; },
    authenticateEvents() { accessCalls.push("event-auth"); return true; },
  };
  const app = Fastify({ logger: false });
  await app.register(openClawNativeSupervisionRoutes, {
    service: serviceFixture({ calls }),
    accessService,
    allowedOrigins: ["http://allowed.example"],
  });

  for (const origin of [undefined, "null", "http://allowed.example.evil", "https://allowed.example"]) {
    for (const request of protectedRequests()) {
      const response = await app.inject({
        ...request,
        headers: origin === undefined ? {} : { origin },
      });
      assert.equal(response.statusCode, 403, `${request.method} ${request.url} ${origin}`);
      assert.equal(response.json().error.code, "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN");
    }
  }
  assert.deepEqual(accessCalls, []);
  assert.deepEqual(calls, []);
  await app.close();
});

test("native supervision requires a valid control cookie before schema or service work", async () => {
  const calls: string[] = [];
  const accessService = createNativeSupervisionAccessService({ bootstrapToken: "b".repeat(43) });
  const app = Fastify({ logger: false });
  await app.register(openClawNativeSupervisionRoutes, {
    service: serviceFixture({ calls }),
    accessService,
    allowedOrigins: ["http://allowed.example"],
  });

  for (const cookie of [undefined, `${NATIVE_SUPERVISION_CONTROL_COOKIE}=${"x".repeat(43)}`]) {
    for (const request of protectedRequests().filter(({ url }) => !url.endsWith("/access/bootstrap"))) {
      const response = await app.inject({
        ...request,
        headers: {
          origin: "http://allowed.example",
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
      assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
      assert.equal(response.json().error.code, "NATIVE_SUPERVISION_ACCESS_REQUIRED");
    }
  }
  assert.deepEqual(calls, []);
  await app.close();
});

test("event capability issuance is read-only and uses an independently scoped cookie", async () => {
  const nowMs = 5_000;
  const bootstrap = "b".repeat(43);
  const accessService = createNativeSupervisionAccessService({
    bootstrapToken: bootstrap,
    now: () => nowMs,
    eventTtlMs: 2_900,
    createToken: sequenceTokenFactory("c", "e"),
  });
  const control = accessService.exchangeBootstrap(bootstrap)!;
  const app = Fastify({ logger: false });
  await app.register(openClawNativeSupervisionRoutes, {
    service: serviceFixture(),
    accessService,
    allowedOrigins: ["https://allowed.example"],
    now: () => nowMs,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/access/events",
    headers: {
      origin: "https://allowed.example",
      cookie: `${NATIVE_SUPERVISION_CONTROL_COOKIE}=${control.token}`,
    },
  });
  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  const setCookie = singleSetCookie(response.headers["set-cookie"]);
  assert.match(setCookie, new RegExp(`^${NATIVE_SUPERVISION_EVENTS_COOKIE}=([A-Za-z0-9_-]{43});`));
  assert.match(setCookie, /Path=\/api\/v1\/openclaw\/realtime\/events\/stream/);
  assert.match(setCookie, /Max-Age=2(?:;|$)/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const eventToken = setCookie.match(new RegExp(`^${NATIVE_SUPERVISION_EVENTS_COOKIE}=([^;]+)`))?.[1];
  assert.ok(eventToken);
  assert.equal(accessService.authenticateControl(eventToken), false);
  assert.equal(accessService.authenticateEvents(control.token), false);

  const eventCookieCannotControl = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    headers: {
      origin: "https://allowed.example",
      cookie: `${NATIVE_SUPERVISION_EVENTS_COOKIE}=${eventToken}`,
    },
  });
  assert.equal(eventCookieCannotControl.statusCode, 401);
  assert.equal(eventCookieCannotControl.json().error.code, "NATIVE_SUPERVISION_ACCESS_REQUIRED");
  await app.close();
});

async function routeApp(service: MainAgentSupervisionService) {
  const app = Fastify({ logger: false });
  const accessService = createNativeSupervisionAccessService({ bootstrapToken: "b".repeat(43) });
  app.addHook("onRequest", async (request) => {
    request.headers.origin ??= "http://127.0.0.1:5173";
    request.headers.cookie ??= `${NATIVE_SUPERVISION_CONTROL_COOKIE}=${"c".repeat(43)}`;
  });
  await app.register(openClawNativeSupervisionRoutes, {
    service,
    accessService: { ...accessService, authenticateControl: () => true },
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  return app;
}

function protectedRequests() {
  return [
    { method: "GET" as const, url: "/api/v1/openclaw/native-supervision" },
    {
      method: "POST" as const,
      url: "/api/v1/openclaw/native-supervision/start",
      payload: { policyPackId: "policy.main" },
    },
    { method: "POST" as const, url: "/api/v1/openclaw/native-supervision/stop" },
    { method: "POST" as const, url: "/api/v1/openclaw/native-supervision/access/events" },
    {
      method: "POST" as const,
      url: "/api/v1/openclaw/native-supervision/access/bootstrap",
      payload: { token: "b".repeat(43) },
    },
  ];
}

function sequenceTokenFactory(...prefixes: string[]): () => string {
  let index = 0;
  return () => `${prefixes[index++ % prefixes.length]}${"1".repeat(42)}`;
}

function singleSetCookie(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new TypeError("Expected one Set-Cookie header");
  return value;
}

function serviceFixture(options: { calls?: string[] } = {}): MainAgentSupervisionService {
  return {
    async status() {
      options.calls?.push("status");
      return idleStatus();
    },
    async start(policyPackId) {
      options.calls?.push(`start:${policyPackId}`);
      return activeStatus();
    },
    async stop() {
      options.calls?.push("stop");
      return idleStatus();
    },
    async close() {},
  };
}

function idleStatus(): MainAgentSupervisionStatus {
  return {
    coverage: "ready",
    scope: { kind: "agent", agentId: "main" },
    activeLeaseCount: 0,
    mainLeaseCount: 0,
  };
}

function activeStatus(): MainAgentSupervisionStatus {
  return {
    coverage: "active",
    scope: { kind: "agent", agentId: "main" },
    policyPackId: "policy.main",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-10T00:05:00.000Z",
    gatewayInstanceId: "gateway.instance.test",
    activeLeaseCount: 1,
    mainLeaseCount: 1,
  };
}

function responseData(response: { json(): unknown }): unknown {
  return (response.json() as { data: unknown }).data;
}
