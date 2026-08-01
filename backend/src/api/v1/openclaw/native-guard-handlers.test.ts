import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Fastify from "fastify";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import {
  openClawNativeGuardRoutes,
  type NativeGuardRouteDependencies,
} from "./native-guard-handlers";

const CONTROL_TOKEN = "operator-control-token";
const LEASE_CREDENTIAL = "lease-credential";

test("management status rejects a missing control token without coordinator work", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json().error, {
    code: "NATIVE_GUARD_UNAUTHORIZED",
    message: "Native guard authentication failed.",
  });
  assert.equal(fixture.calls.status, 0);

  const wrong = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": `${CONTROL_TOKEN}-wrong` },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(JSON.stringify(wrong.json()).includes(CONTROL_TOKEN), false);
  assert.equal(fixture.calls.status, 0);
  await app.close();
});

test("native routes reject an unapproved present Origin before coordinator work", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: {
      origin: "https://attacker.example",
      "x-agent-guard-control-token": CONTROL_TOKEN,
    },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json().error, {
    code: "NATIVE_GUARD_ORIGIN_FORBIDDEN",
    message: "Native guard request origin is not allowed.",
  });
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(fixture.calls.status, 0);
  await app.close();
});

test("management status preserves public lease identity and removes session keys", async () => {
  const fixture = createFixture();
  fixture.dependencies.coordinator.status = async () => {
    fixture.calls.status += 1;
    return {
      coverage: "active",
      finalizerAssurance: "exclusive_before_hook",
      pluginVersion: "1.0.0",
      openclawVersion: "2026.7.2",
      activeLeaseCount: 1,
      activeLease: {
        leaseId: "lease-1",
        leaseEpoch: 7,
        rootSessionKey: "secret-session-key",
        mode: "supervision",
        policyPackId: "pack-1",
        policyPackDigest: "a".repeat(64),
        expiresAt: "2026-08-02T12:00:00.000Z",
      },
    };
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: {
      origin: "null",
      "x-agent-guard-control-token": CONTROL_TOKEN,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data.activeLease, {
    leaseId: "lease-1",
    leaseEpoch: 7,
    mode: "supervision",
    policyPackId: "pack-1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T12:00:00.000Z",
  });
  assert.equal(response.body.includes("secret-session-key"), false);
  assert.equal(response.body.includes(CONTROL_TOKEN), false);
  assert.equal(fixture.calls.status, 1);
  await app.close();
});

test("lease activation rejects a malformed payload without coordinator work", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/leases",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
    payload: { mode: "supervision", unexpected: true },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json().error, {
    code: "NATIVE_GUARD_INVALID_REQUEST",
    message: "Native guard request payload is invalid.",
  });
  assert.equal(fixture.calls.activate, 0);
  await app.close();
});

test("lease activation passes a validated request and returns sanitized status", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/leases",
    headers: {
      origin: "http://127.0.0.1:5173",
      "x-agent-guard-control-token": CONTROL_TOKEN,
    },
    payload: {
      rootSessionKey: "root-session",
      mode: "supervision",
      policyPackId: "pack-1",
      ttlMs: 60_000,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.activationInputs, [{
    rootSessionKey: "root-session",
    mode: "supervision",
    policyPackId: "pack-1",
    ttlMs: 60_000,
  }]);
  assert.equal(JSON.stringify(response.json()).includes("root-session"), false);
  await app.close();
});

test("lease renewal requires the control token and forwards lease id and TTL", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/leases/lease-1/renew",
    payload: { ttlMs: 45_000 },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(fixture.calls.renew, 0);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/leases/lease-1/renew",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
    payload: { ttlMs: 45_000 },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.renewInputs, [["lease-1", 45_000]]);
  await app.close();
});

test("lease revocation requires the control token and forwards a validated lease id", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const unauthorized = await app.inject({
    method: "DELETE",
    url: "/api/v1/openclaw/native-guard/leases/lease-1",
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(fixture.calls.revoke, 0);

  const response = await app.inject({
    method: "DELETE",
    url: "/api/v1/openclaw/native-guard/leases/lease-1",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(fixture.calls.revokeInputs, ["lease-1"]);
  await app.close();
});

test("decision rejects missing, malformed, wrong, and operator bearer without side effects", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);
  const headers = [
    undefined,
    "Basic lease-credential",
    "Bearer wrong-credential",
    `Bearer ${CONTROL_TOKEN}`,
    `Bearer ${LEASE_CREDENTIAL} trailing`,
  ];

  for (const authorization of headers) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-guard/decision",
      headers: authorization ? { authorization } : {},
      payload: decisionRequest(),
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json().error, {
      code: "NATIVE_GUARD_UNAUTHORIZED",
      message: "Native guard authentication failed.",
    });
    assert.equal(response.body.includes(CONTROL_TOKEN), false);
    assert.equal(response.body.includes(LEASE_CREDENTIAL), false);
  }

  assert.equal(fixture.calls.usable, 0);
  assert.equal(fixture.calls.decide, 0);
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("decision rejects malformed and oversized JSON with stable secret-free errors", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);
  const authorization = `Bearer ${LEASE_CREDENTIAL}`;

  const malformed = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization },
    payload: { ...decisionRequest(), schemaVersion: "wrong-schema" },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, "NATIVE_GUARD_INVALID_REQUEST");

  const oversized = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization },
    payload: {
      ...decisionRequest(),
      params: { value: "x".repeat(256 * 1024) },
    },
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(oversized.json().error, {
    code: "NATIVE_GUARD_BODY_TOO_LARGE",
    message: "Native guard request body exceeds the allowed size.",
  });
  assert.equal(oversized.body.includes(LEASE_CREDENTIAL), false);
  assert.equal(fixture.calls.usable, 0);
  assert.equal(fixture.calls.decide, 0);
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("decision fails closed before work when the authenticated lease is not usable", async () => {
  const fixture = createFixture();
  fixture.dependencies.coordinator.isLeaseUsable = () => {
    fixture.calls.usable += 1;
    return false;
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: decisionRequest(),
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json().error, {
    code: "NATIVE_GUARD_LEASE_NOT_USABLE",
    message: "Native guard lease is not active.",
  });
  assert.equal(fixture.calls.authenticate, 1);
  assert.equal(fixture.calls.usable, 1);
  assert.equal(fixture.calls.decide, 0);
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("decision checks usability before and after work and returns only the signed response", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: decisionRequest(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.signature, "signed-decision");
  assert.equal(response.body.includes(LEASE_CREDENTIAL), false);
  assert.equal(response.body.includes("record-secret"), false);
  assert.equal(fixture.calls.usable, 2);
  assert.equal(fixture.calls.decide, 1);
  assert.deepEqual(fixture.calls.decisionCredentials, [LEASE_CREDENTIAL]);
  await app.close();
});

test("decision dependency failures map to a stable secret-free error", async () => {
  const fixture = createFixture();
  fixture.dependencies.decisionService.decide = async () => {
    fixture.calls.decide += 1;
    throw new Error(`backend leaked ${LEASE_CREDENTIAL}`);
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: decisionRequest(),
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json().error, {
    code: "NATIVE_GUARD_DECISION_FAILED",
    message: "Native guard decision could not be completed.",
  });
  assert.equal(response.body.includes(LEASE_CREDENTIAL), false);
  await app.close();
});

test("event batch rejects missing and operator bearer without side effects", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  for (const authorization of [undefined, `Bearer ${CONTROL_TOKEN}`]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-guard/events/batch",
      headers: authorization ? { authorization } : {},
      payload: { events: [nativeEvent()] },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "NATIVE_GUARD_UNAUTHORIZED");
  }

  assert.equal(fixture.calls.usable, 0);
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("event batch rejects more than 100 events before persistence", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);
  const events = Array.from({ length: 101 }, (_, index) => nativeEvent({
    eventId: `event-${index + 1}`,
  }));

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: { events },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "NATIVE_GUARD_INVALID_REQUEST");
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("event batch enforces its own one MiB body limit", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: {
      events: [nativeEvent({
        detail: { message: "x".repeat(1024 * 1024) },
      })],
    },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "NATIVE_GUARD_BODY_TOO_LARGE");
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("event batch gates every append and recursively scrubs the exact bearer", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);
  const events = [
    nativeEvent({
      eventId: "event-1",
      detail: {
        message: `prefix ${LEASE_CREDENTIAL} suffix`,
        value: {
          [LEASE_CREDENTIAL]: [
            `Bearer ${LEASE_CREDENTIAL}`,
            { nested: LEASE_CREDENTIAL },
          ],
        },
      },
    }),
    nativeEvent({ eventId: "event-2" }),
  ];

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: { events },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { accepted: 2 });
  assert.equal(fixture.calls.append, 2);
  assert.equal(fixture.calls.usable, 3);
  const persisted = JSON.stringify(fixture.calls.appendedEvents);
  assert.equal(persisted.includes(LEASE_CREDENTIAL), false);
  assert.equal(persisted.includes("[REDACTED]"), true);
  assert.equal(response.body.includes(LEASE_CREDENTIAL), false);
  await app.close();
});

test("allowed origins include conservative local defaults and exact configured origins", async () => {
  const auth = await import("../../../modules/openclaw/nativeGuardAuth");
  const allowed = auth.resolveNativeGuardAllowedOrigins({
    AGENT_GUARD_ALLOWED_ORIGINS: [
      "https://console.example",
      "http://127.0.0.1:5173",
      "*",
      "https://console.example/path",
    ].join(","),
  });

  assert.deepEqual(allowed, [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "null",
    "https://console.example",
  ]);
});

test("native preflight never reflects an unapproved Origin", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const rejected = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);

  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(allowed.statusCode, 204);
  assert.equal(
    allowed.headers["access-control-allow-origin"],
    "http://localhost:5173",
  );
  assert.match(
    String(allowed.headers["access-control-allow-headers"]),
    /X-Agent-Guard-Control-Token/i,
  );
  await app.close();
});

test("guarded event appender rechecks lease usability at the persistence boundary", async () => {
  const handlers = await import("./native-guard-handlers");
  let usable = false;
  let appended = 0;
  const appender = handlers.createLeaseUsabilityEventAppender(
    { isLeaseUsable: () => usable },
    {
      async append() {
        appended += 1;
        return true;
      },
    },
  );

  await assert.rejects(
    () => appender.append(nativeEvent() as never),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NATIVE_GUARD_LEASE_NOT_USABLE" &&
      !error.message.includes(LEASE_CREDENTIAL),
  );
  assert.equal(appended, 0);

  usable = true;
  assert.equal(await appender.append(nativeEvent() as never), true);
  assert.equal(appended, 1);
});

test("production dependency factory wires guarded persistence and before-sign checks without work", async () => {
  const handlers = await import("./native-guard-handlers");
  let usable = false;
  let statusCalls = 0;
  let appendCalls = 0;
  let capturedOptions: Record<string, unknown> | undefined;
  const coordinator = {
    isLeaseUsable: () => usable,
    getLastStatus: () => {
      statusCalls += 1;
      throw new Error("factory must not inspect status");
    },
  };
  const eventStore = {
    async append() {
      appendCalls += 1;
      return true;
    },
  };

  const dependencies = handlers.createNativeGuardRouteDependencies({
    env: {
      VITE_AGENT_GUARD_CONTROL_TOKEN: "explicit-browser-token",
      AGENT_GUARD_ALLOWED_ORIGINS: "https://console.example",
    },
    coordinator: coordinator as never,
    leaseService: {} as never,
    eventStore: eventStore as never,
    createDecisionService(options: unknown) {
      capturedOptions = options as Record<string, unknown>;
      return { async decide() { throw new Error("not called"); } };
    },
  });

  assert.equal(statusCalls, 0);
  assert.equal(appendCalls, 0);
  assert.equal(dependencies.controlToken, "explicit-browser-token");
  assert.equal(dependencies.allowedOrigins.includes("https://console.example"), true);

  const guardedStore = capturedOptions?.eventStore as {
    append(event: unknown): Promise<boolean>;
  };
  await assert.rejects(() => guardedStore.append(nativeEvent()));
  assert.equal(appendCalls, 0);

  const beforeSign = capturedOptions?.beforeSign as (
    request: ReturnType<typeof decisionRequest>,
  ) => Promise<void>;
  await assert.rejects(() => beforeSign(decisionRequest()));

  usable = true;
  assert.equal(await guardedStore.append(nativeEvent()), true);
  await beforeSign(decisionRequest());
  assert.equal(appendCalls, 1);
});

test("buildApp registers native routes without permissive CORS bypass", async () => {
  const { buildApp } = await import("../../../app");
  const fixture = createFixture();
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: fixture.dependencies,
  });

  const rejected = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/native-guard/status",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);

  const status = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: {
      origin: "http://localhost:5173",
      "x-agent-guard-control-token": CONTROL_TOKEN,
    },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.headers["access-control-allow-origin"], "http://localhost:5173");
  await app.close();
});

test("system status uses cached sanitized native guard state and feature flags", async () => {
  const { buildApp } = await import("../../../app");
  const fixture = createFixture();
  fixture.dependencies.coordinator.getLastStatus = () => {
    fixture.calls.cachedStatus += 1;
    return {
      coverage: "active",
      finalizerAssurance: "exclusive_before_hook",
      openclawVersion: "2026.7.2",
      activeLeaseCount: 1,
      activeLease: {
        leaseId: "lease-1",
        leaseEpoch: 9,
        rootSessionKey: "must-not-leak",
        mode: "detection",
        policyPackId: "pack-1",
        policyPackDigest: "c".repeat(64),
        expiresAt: "2026-08-02T12:00:00.000Z",
      },
    };
  };
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: fixture.dependencies,
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/system/status",
  });

  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(fixture.calls.status, 0);
  assert.equal(fixture.calls.cachedStatus, 1);
  assert.equal(data.health.nativeGuard.activeLease.leaseEpoch, 9);
  assert.equal(data.health.nativeGuard.activeLease.policyPackDigest, "c".repeat(64));
  assert.equal(response.body.includes("must-not-leak"), false);
  assert.equal(data.features.openclawNativeGuard, true);
  assert.equal(data.features.openclawNativeGuardReady, true);
  assert.equal(data.features.openclawDetectionDocker, false);
  await app.close();
});

test("desktop keeps its generated control token outside page JavaScript", async () => {
  const source = await readFile(
    new URL("../../../../../desktop/main.cjs", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /const \{ randomBytes \} = require\("node:crypto"\);/,
  );
  assert.match(
    source,
    /const CONTROL_TOKEN = process\.env\.AGENT_GUARD_CONTROL_TOKEN \|\| randomBytes\(32\)\.toString\("base64url"\);/,
  );
  assert.match(source, /AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN/);
  assert.match(source, /webRequest\.onBeforeSendHeaders/);
  assert.match(source, /urls: \[`\$\{API_BASE\}\/\*`\]/);
  assert.doesNotMatch(
    source,
    /VITE_AGENT_GUARD_CONTROL_TOKEN\s*:\s*CONTROL_TOKEN/,
  );
});

test("decision refuses a result when its lease becomes unusable during work", async () => {
  const fixture = createFixture();
  let usable = true;
  fixture.dependencies.coordinator.isLeaseUsable = () => {
    fixture.calls.usable += 1;
    return usable;
  };
  fixture.dependencies.decisionService.decide = async () => {
    fixture.calls.decide += 1;
    usable = false;
    return { response: decisionResponse(), record: {} as never };
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: decisionRequest(),
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "NATIVE_GUARD_LEASE_NOT_USABLE");
  assert.equal(response.body.includes("signed-decision"), false);
  await app.close();
});

test("event batch stops before the next append when its lease becomes unusable", async () => {
  const fixture = createFixture();
  let checks = 0;
  fixture.dependencies.coordinator.isLeaseUsable = () => {
    fixture.calls.usable += 1;
    checks += 1;
    return checks === 1;
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: {
      events: [
        nativeEvent({ eventId: "event-1" }),
        nativeEvent({ eventId: "event-2" }),
      ],
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(fixture.calls.append, 1);
  await app.close();
});

test("event batch rejects mixed lease ids before authentication or persistence", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: {
      events: [
        nativeEvent({ eventId: "event-1" }),
        nativeEvent({ eventId: "event-2", leaseId: "lease-2" }),
      ],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(fixture.calls.authenticate, 0);
  assert.equal(fixture.calls.usable, 0);
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("native status projection allowlists fields instead of forwarding dependency data", async () => {
  const fixture = createFixture();
  fixture.dependencies.coordinator.status = async () => ({
    coverage: "unsupported",
    finalizerAssurance: "unverified",
    openclawVersion: "2026.6.1",
    activeLeaseCount: 0,
    reasonCode: "NATIVE_GUARD_UNSUPPORTED",
    detail: `dependency included ${CONTROL_TOKEN}`,
    credential: CONTROL_TOKEN,
    policyPack: { content: "must not leak" },
  } as never);
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, {
    coverage: "unsupported",
    finalizerAssurance: "unverified",
    openclawVersion: "2026.6.1",
    activeLeaseCount: 0,
    reasonCode: "NATIVE_GUARD_UNSUPPORTED",
  });
  assert.equal(response.body.includes(CONTROL_TOKEN), false);
  assert.equal(response.body.includes("must not leak"), false);
  await app.close();
});

async function createApp(dependencies: NativeGuardRouteDependencies) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(openClawNativeGuardRoutes, dependencies);
  return app;
}

function createFixture() {
  const calls = {
    status: 0,
    cachedStatus: 0,
    activate: 0,
    activationInputs: [] as unknown[],
    renew: 0,
    renewInputs: [] as unknown[],
    revoke: 0,
    revokeInputs: [] as string[],
    authenticate: 0,
    usable: 0,
    decide: 0,
    decisionCredentials: [] as string[],
    append: 0,
    appendedEvents: [] as unknown[],
  };
  const readyStatus: NativeGuardStatus = {
    coverage: "ready",
    finalizerAssurance: "exclusive_before_hook",
    activeLeaseCount: 0,
  };
  const dependencies: NativeGuardRouteDependencies = {
    controlToken: CONTROL_TOKEN,
    allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173", "null"],
    coordinator: {
      async activate(input) {
        calls.activate += 1;
        calls.activationInputs.push(input);
        return readyStatus;
      },
      async renew(leaseId, ttlMs) {
        calls.renew += 1;
        calls.renewInputs.push([leaseId, ttlMs]);
        return readyStatus;
      },
      async revoke(leaseId) {
        calls.revoke += 1;
        calls.revokeInputs.push(leaseId);
        return readyStatus;
      },
      async status() {
        calls.status += 1;
        return readyStatus;
      },
      isLeaseUsable() {
        calls.usable += 1;
        return true;
      },
      getLastStatus() {
        calls.cachedStatus += 1;
        return readyStatus;
      },
    },
    leaseService: {
      authenticate(_leaseId, credential) {
        calls.authenticate += 1;
        return credential === LEASE_CREDENTIAL ? ({} as never) : undefined;
      },
    },
    decisionService: {
      async decide(_request, credential) {
        calls.decide += 1;
        calls.decisionCredentials.push(credential);
        return {
          response: decisionResponse(),
          record: { secret: "record-secret" } as never,
        };
      },
    },
    eventStore: {
      async append(event) {
        calls.append += 1;
        calls.appendedEvents.push(event);
        return true;
      },
    },
  };
  return { calls, dependencies };
}

function decisionRequest() {
  return {
    schemaVersion: "native-guard-1",
    requestId: "request-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    sessionKey: "session-1",
    toolCallId: "tool-call-1",
    toolName: "read_file",
    params: { path: "README.md" },
    paramsDigest: "a".repeat(64),
    requestedAt: "2026-08-02T10:00:00.000Z",
  };
}

function decisionResponse() {
  return {
    schemaVersion: "native-guard-1" as const,
    decisionId: "decision-1",
    requestId: "request-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    policyPackId: "pack-1",
    policyPackDigest: "b".repeat(64),
    action: "allow" as const,
    reasonCode: "POLICY_ALLOW",
    reason: "Allowed by policy.",
    evaluatedParamsDigest: "a".repeat(64),
    decidedAt: "2026-08-02T10:00:00.001Z",
    signature: "signed-decision",
  };
}

function nativeEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "native-guard-1",
    eventId: "event-1",
    type: "tool_outcome",
    leaseId: "lease-1",
    sessionKey: "session-1",
    runId: "run-1",
    toolCallId: "tool-call-1",
    decisionId: "decision-1",
    timestamp: "2026-08-02T10:00:00.002Z",
    detail: { reasonCode: "TOOL_COMPLETED", message: "completed" },
    ...overrides,
  };
}
