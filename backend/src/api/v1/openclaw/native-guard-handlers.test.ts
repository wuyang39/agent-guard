import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { NativeGuardStatus, SupervisionPolicyPack } from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { createNativeGuardLeaseService } from "../../../modules/openclaw/nativeGuardLeaseService";
import { createNativeToolDecisionService } from "../../../modules/openclaw/nativeToolDecisionService";
import {
  systemRoutes,
  type SystemRouteDependencies,
} from "../system/handlers";
import {
  openClawNativeGuardRoutes,
  scrubExactSecret,
  type NativeGuardRouteDependencies,
} from "./native-guard-handlers";

const require = createRequire(import.meta.url);

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
      params: { value: "x".repeat(320 * 1024) },
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

test("decision accepts params at the exact canonical byte and key limits", async () => {
  const fixture = createFixture();
  const app = await createApp(fixture.dependencies);
  const params = paramsAtCanonicalBounds(256 * 1024, 4_096);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: { ...decisionRequest(), params },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.decide, 1);
  await app.close();
});

test("real Fastify decision path enforces the complete parameter contract", async (t) => {
  const fixture = createRealDecisionFixture();
  const app = await createApp(fixture.dependencies);
  t.after(() => app.close());
  const exactParams = paramsAtCanonicalBounds(256 * 1024, 4_096);
  const exact = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/decision",
    headers: { authorization: `Bearer ${fixture.activation.credential}` },
    payload: fixture.request(exactParams, "exact"),
  });
  assert.equal(exact.statusCode, 200);
  assert.equal(fixture.appended.length, 1);

  for (const [name, params] of [
    ["bytes", paramsAtCanonicalBounds(256 * 1024 + 1, 1)],
    ["depth", paramsAtDepth(33)],
    ["keys", { nested: paramsWithKeys(4_096) }],
    ["prototype", JSON.parse('{"safe":true,"__proto__":{"polluted":true}}')],
  ] as const) {
    await t.test(name, async () => {
      const appendedBefore = fixture.appended.length;
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/openclaw/native-guard/decision",
        headers: { authorization: `Bearer ${fixture.activation.credential}` },
        payload: fixture.request(params, name),
      });
      const rejectedBySchema = name === "prototype";
      assert.equal(response.statusCode, rejectedBySchema ? 400 : 503);
      assert.equal(
        response.json().error.code,
        rejectedBySchema ? "NATIVE_GUARD_INVALID_REQUEST" : "NATIVE_GUARD_DECISION_FAILED",
      );
      assert.equal(fixture.appended.length, appendedBefore);
    });
  }
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
  assert.equal(fixture.calls.usable, 4);
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
      NODE_ENV: "development",
      AGENT_GUARD_BROWSER_DEV: "1",
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
  assert.doesNotMatch(source, /session\.defaultSession/);
  assert.match(source, /session\.fromPartition\(UI_PARTITION/);
  assert.match(source, /session: uiSession/);
  assert.match(source, /withControlTokenHeaders/);
  assert.match(
    source,
    /withControlTokenHeaders\(\s*normalizeElectronRequestDetails\(details\),/,
  );
  assert.match(source, /probeApiOwnership/);
  assert.match(source, /"will-navigate"/);
  assert.match(source, /"will-attach-webview"/);
  assert.match(source, /"will-frame-navigate", \(details\) =>/);
  assert.doesNotMatch(
    source,
    /"will-frame-navigate", \(event, details\) =>/,
  );
  assert.match(source, /delete inheritedEnv\.AGENT_GUARD_CONTROL_TOKEN/);
  assert.match(source, /delete inheritedEnv\.VITE_AGENT_GUARD_CONTROL_TOKEN/);
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

test("system status uses the real adapter check result regardless of CLI path presence", async () => {
  const configuredCalls: Array<string | undefined> = [];
  const configured = systemAgent("C:\\missing\\openclaw.cmd");
  const configuredApp = await createSystemApp({
    getActiveAgentConfig: async () => configured,
    listAgentConfigs: async () => [configured],
    listRunGroups: async () => [],
    checkOpenClawAvailable: async (cliPath) => {
      configuredCalls.push(cliPath);
      return { available: false };
    },
    now: () => 1_000,
  });

  const unavailable = await configuredApp.inject({
    method: "GET",
    url: "/api/v1/system/status",
  });
  assert.equal(unavailable.json().data.health.openclawCli, false);
  assert.equal(unavailable.json().data.features.openclawAdapter, false);
  assert.deepEqual(configuredCalls, ["C:\\missing\\openclaw.cmd"]);
  await configuredApp.close();

  const unconfiguredCalls: Array<string | undefined> = [];
  const unconfigured = systemAgent();
  const unconfiguredApp = await createSystemApp({
    getActiveAgentConfig: async () => unconfigured,
    listAgentConfigs: async () => [unconfigured],
    listRunGroups: async () => [],
    checkOpenClawAvailable: async (cliPath) => {
      unconfiguredCalls.push(cliPath);
      return { available: true, version: "2026.6.1" };
    },
    now: () => 1_000,
  });

  const available = await unconfiguredApp.inject({
    method: "GET",
    url: "/api/v1/system/status",
  });
  assert.equal(available.json().data.health.openclawCli, true);
  assert.equal(available.json().data.features.openclawAdapter, true);
  assert.deepEqual(unconfiguredCalls, [undefined]);
  await unconfiguredApp.close();
});

test("system adapter availability cache honors TTL and bypasses it on CLI path change", async () => {
  const paths = [
    "C:\\openclaw-a.cmd",
    "C:\\openclaw-a.cmd",
    "C:\\openclaw-b.cmd",
    "C:\\openclaw-b.cmd",
  ];
  const times = [1_000, 2_000, 3_000, 33_001];
  const checkCalls: Array<string | undefined> = [];
  const app = await createSystemApp({
    getActiveAgentConfig: async () => systemAgent(paths.shift()),
    listAgentConfigs: async () => [systemAgent()],
    listRunGroups: async () => [],
    checkOpenClawAvailable: async (cliPath) => {
      checkCalls.push(cliPath);
      return { available: true };
    },
    now: () => times.shift() ?? 33_001,
  });

  for (let index = 0; index < 4; index += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/status",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.health.openclawCli, true);
  }

  assert.deepEqual(checkCalls, [
    "C:\\openclaw-a.cmd",
    "C:\\openclaw-b.cmd",
    "C:\\openclaw-b.cmd",
  ]);
  await app.close();
});

test("system status creates a missing output directory before marking it available", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "agent-guard-system-status-"));
  const outputDir = path.join(rootDir, "nested", "outputs");
  const agent = systemAgent();
  const app = await createSystemApp({
    getActiveAgentConfig: async () => agent,
    listAgentConfigs: async () => [agent],
    listRunGroups: async () => [],
    checkOpenClawAvailable: async () => ({ available: false }),
    outputDir,
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/status",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.outputDir, outputDir);
    assert.equal(response.json().data.health.outputStore, true);
    assert.equal((await stat(outputDir)).isDirectory(), true);
  } finally {
    await app.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("event batch rejects an authenticated lease whose event session is not bound", async () => {
  const fixture = createFixture();
  fixture.dependencies.leaseService.resolveBySession = () => {
    fixture.calls.resolveSession += 1;
    return undefined;
  };
  const app = await createApp(fixture.dependencies);

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-guard/events/batch",
    headers: { authorization: `Bearer ${LEASE_CREDENTIAL}` },
    payload: { events: [nativeEvent()] },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "NATIVE_GUARD_UNAUTHORIZED");
  assert.equal(fixture.calls.append, 0);
  await app.close();
});

test("event batch stops after credential rotation while the first append is pending", async () => {
  const fixture = createFixture();
  const appendStarted = deferred<void>();
  const releaseAppend = deferred<void>();
  let credentialCurrent = true;
  fixture.dependencies.leaseService.authenticate = (leaseId, credential) => {
    fixture.calls.authenticate += 1;
    return credentialCurrent && credential === LEASE_CREDENTIAL
      ? leaseSnapshot(leaseId)
      : undefined;
  };
  fixture.dependencies.eventStore.append = async (event) => {
    fixture.calls.append += 1;
    fixture.calls.appendedEvents.push(event);
    if (fixture.calls.append === 1) {
      appendStarted.resolve();
      await releaseAppend.promise;
    }
    return true;
  };
  const app = await createApp(fixture.dependencies);

  const responsePromise = app.inject({
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
  await appendStarted.promise;
  credentialCurrent = false;
  releaseAppend.resolve();
  const response = await responsePromise;

  assert.equal(response.statusCode, 401);
  assert.equal(fixture.calls.append, 1);
  await app.close();
});

test("event batch stops when a later event session becomes unbound", async () => {
  const fixture = createFixture();
  let sessionBound = true;
  fixture.dependencies.leaseService.resolveBySession = (sessionKey) => {
    fixture.calls.resolveSession += 1;
    return sessionBound ? leaseSnapshot("lease-1", 1, sessionKey) : undefined;
  };
  fixture.dependencies.eventStore.append = async (event) => {
    fixture.calls.append += 1;
    fixture.calls.appendedEvents.push(event);
    sessionBound = false;
    return true;
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

  assert.equal(response.statusCode, 401);
  assert.equal(fixture.calls.append, 1);
  await app.close();
});

test("exact secret scrubbing rejects replacement key collisions", () => {
  assert.throws(
    () => scrubExactSecret({
      [LEASE_CREDENTIAL]: "first",
      "[REDACTED]": "second",
    }, LEASE_CREDENTIAL),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NATIVE_GUARD_SECRET_SCRUB_CONFLICT" &&
      !error.message.includes(LEASE_CREDENTIAL),
  );
});

test("Vite control tokens are accepted only in explicit browser-only development", async () => {
  const handlers = await import("./native-guard-handlers");
  const viteToken = "vite-browser-token";
  assert.equal(handlers.resolveNativeGuardControlToken({
    NODE_ENV: "production",
    AGENT_GUARD_BROWSER_DEV: "1",
    VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
  }), undefined);
  assert.equal(handlers.resolveNativeGuardControlToken({
    NODE_ENV: "development",
    VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
  }), undefined);
  assert.equal(handlers.resolveNativeGuardControlToken({
    NODE_ENV: "development",
    AGENT_GUARD_BROWSER_DEV: "1",
    AGENT_GUARD_DESKTOP: "1",
    VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
  }), undefined);
  assert.equal(handlers.resolveNativeGuardControlToken({
    NODE_ENV: "development",
    AGENT_GUARD_BROWSER_DEV: "1",
    VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
  }), viteToken);
  assert.equal(handlers.resolveNativeGuardControlToken({
    NODE_ENV: "production",
    AGENT_GUARD_DESKTOP: "1",
    AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN,
    VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
  }), CONTROL_TOKEN);

  const productionFixture = createFixture();
  productionFixture.dependencies.controlToken =
    handlers.resolveNativeGuardControlToken({
      NODE_ENV: "production",
      AGENT_GUARD_BROWSER_DEV: "1",
      VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
    });
  const productionApp = await createApp(productionFixture.dependencies);
  const rejected = await productionApp.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": viteToken },
  });
  assert.equal(rejected.statusCode, 401);
  assert.equal(productionFixture.calls.status, 0);
  await productionApp.close();

  const browserFixture = createFixture();
  browserFixture.dependencies.controlToken =
    handlers.resolveNativeGuardControlToken({
      NODE_ENV: "development",
      AGENT_GUARD_BROWSER_DEV: "1",
      VITE_AGENT_GUARD_CONTROL_TOKEN: viteToken,
    });
  const browserApp = await createApp(browserFixture.dependencies);
  const accepted = await browserApp.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": viteToken },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(browserFixture.calls.status, 1);
  await browserApp.close();
});

test("native decision backend URLs are restricted to the exact loopback PDP endpoint", async () => {
  const handlers = await import("./native-guard-handlers");
  const invalidUrls = [
    "https://localhost:3100/api/v1/openclaw/native-guard/decision",
    "http://example.test:3100/api/v1/openclaw/native-guard/decision",
    "http://user@localhost:3100/api/v1/openclaw/native-guard/decision",
    "http://localhost:3100/api/v1/openclaw/native-guard/decision?copy=1",
    "http://localhost:3100/api/v1/openclaw/native-guard/decision#fragment",
    "http://localhost:3100/api/v1/openclaw/native-guard/decision/",
    "http://localhost:0/api/v1/openclaw/native-guard/decision",
  ];
  for (const configured of invalidUrls) {
    assert.throws(
      () => handlers.resolveNativeGuardDecisionUrl({
        AGENT_GUARD_NATIVE_GUARD_BACKEND_URL: configured,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "NATIVE_GUARD_BACKEND_URL_INVALID" &&
        !error.message.includes(configured),
    );
  }
  for (const invalidPort of ["0", "65536", "not-a-port"]) {
    assert.throws(
      () => handlers.resolveNativeGuardDecisionUrl({ API_PORT: invalidPort }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "NATIVE_GUARD_BACKEND_URL_INVALID",
    );
  }
  assert.equal(
    handlers.resolveNativeGuardDecisionUrl({ API_PORT: "65535" }),
    "http://127.0.0.1:65535/api/v1/openclaw/native-guard/decision",
  );
  assert.equal(
    handlers.resolveNativeGuardDecisionUrl({
      AGENT_GUARD_NATIVE_GUARD_BACKEND_URL:
        "http://[::1]:3100/api/v1/openclaw/native-guard/decision",
    }),
    "http://[::1]:3100/api/v1/openclaw/native-guard/decision",
  );
});

test("native runtime loads the active OpenClaw identity only for explicit management", async () => {
  const handlers = await import("./native-guard-handlers");
  const activeAgent = nativeAgent(
    "agent.active",
    "C:\\active\\openclaw.cmd",
    "http://127.0.0.1:18790",
  );
  let loaderCalls = 0;
  const coordinatorOptions: Array<Record<string, unknown>> = [];
  const dependencies = handlers.createNativeGuardRouteDependencies({
    env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    loadActiveAgentConfig: async () => {
      loaderCalls += 1;
      return activeAgent;
    },
    createCoordinator(options: unknown) {
      coordinatorOptions.push(options as Record<string, unknown>);
      return coordinatorStub();
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });

  assert.equal(loaderCalls, 0);
  assert.equal(dependencies.coordinator.getLastStatus().coverage, "off");
  assert.equal(dependencies.coordinator.isLeaseUsable("lease-1"), false);
  assert.equal(loaderCalls, 0);

  const app = await buildNativeApp(dependencies);
  const ordinary = await app.inject({
    method: "GET",
    url: "/api/v1/system/status",
  });
  assert.equal(ordinary.statusCode, 200);
  assert.equal(loaderCalls, 0);

  const explicit = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
  });
  assert.equal(explicit.statusCode, 200);
  assert.equal(loaderCalls, 1);
  assert.equal(coordinatorOptions.length, 1);
  assert.equal(coordinatorOptions[0].gatewayUrl, activeAgent.gatewayUrl);
  assert.deepEqual(coordinatorOptions[0].capabilityInput, {
    cliPath: activeAgent.openclawCliPath,
    isolatedProfile: false,
  });
  await app.close();
});

test("native runtime rejects invalid active agents and backend config only when explicitly loaded", async () => {
  const handlers = await import("./native-guard-handlers");
  for (const scenario of [
    {
      agent: { ...nativeAgent("agent.mock", undefined, "http://127.0.0.1:18790"), adapterKind: "mock" as const },
      env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    },
    {
      agent: nativeAgent("agent.openclaw", undefined, "http://127.0.0.1:18790"),
      env: {
        AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN,
        AGENT_GUARD_NATIVE_GUARD_BACKEND_URL:
          "http://example.test/api/v1/openclaw/native-guard/decision",
      },
    },
  ]) {
    let loaderCalls = 0;
    let factoryCalls = 0;
    const dependencies = handlers.createNativeGuardRouteDependencies({
      env: scenario.env,
      loadActiveAgentConfig: async () => {
        loaderCalls += 1;
        return scenario.agent;
      },
      createCoordinator() {
        factoryCalls += 1;
        return coordinatorStub();
      },
      createDecisionService() {
        return { async decide() { throw new Error("not called"); } };
      },
    });
    assert.equal(loaderCalls, 0);
    assert.equal(factoryCalls, 0);

    const app = await createApp(dependencies);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/openclaw/native-guard/status",
      headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, "NATIVE_GUARD_INTERNAL_ERROR");
    assert.equal(response.body.includes("example.test"), false);
    assert.equal(loaderCalls, 1);
    assert.equal(factoryCalls, 0);
    await app.close();
  }
});

test("desktop control token injection requires the exact trusted renderer context", () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  const context = {
    apiBase: "http://127.0.0.1:3100",
    mainWebContentsId: 7,
    currentRendererUrl: "http://127.0.0.1:5173/dashboard",
    trustedViteOrigin: "http://127.0.0.1:5173",
    packagedIndexUrl: "file:///C:/AgentGuard/dist/frontend/index.html",
  };
  const trusted = {
    url: "http://127.0.0.1:3100/api/v1/system/status",
    webContentsId: 7,
    frameId: 0,
    initiator: "http://127.0.0.1:5173",
    requestHeaders: {
      "x-agent-guard-control-token": "attacker-value",
      Accept: "application/json",
    },
  };
  assert.equal(security.shouldInjectControlToken(trusted, context), true);
  assert.deepEqual(
    security.withControlTokenHeaders(trusted, context, CONTROL_TOKEN),
    {
      Accept: "application/json",
      "X-Agent-Guard-Control-Token": CONTROL_TOKEN,
    },
  );

  const untrusted = [
    { ...trusted, webContentsId: 8 },
    { ...trusted, frameId: 1 },
    { ...trusted, initiator: "https://attacker.example" },
    { ...trusted, url: "http://localhost:3100/api/v1/system/status" },
  ];
  for (const details of untrusted) {
    assert.equal(security.shouldInjectControlToken(details, context), false);
    assert.deepEqual(
      security.withControlTokenHeaders(details, context, CONTROL_TOKEN),
      details.requestHeaders,
    );
  }

  const packagedContext = {
    ...context,
    currentRendererUrl: context.packagedIndexUrl,
  };
  assert.equal(security.shouldInjectControlToken({
    ...trusted,
    initiator: "null",
  }, packagedContext), true);
  assert.equal(security.shouldInjectControlToken({
    ...trusted,
    initiator: "file://",
  }, packagedContext), true);
  assert.equal(security.shouldInjectControlToken({
    ...trusted,
    initiator: "null",
  }, {
    ...packagedContext,
    currentRendererUrl: `${context.packagedIndexUrl}#unexpected`,
  }), false);
});

test("desktop normalizes Electron frame metadata before control token checks", () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  assert.equal(typeof security.normalizeElectronRequestDetails, "function");

  const mainFrame = {
    url: "http://127.0.0.1:3100/api/v1/system/status",
    webContentsId: 7,
    frame: {
      parent: null,
      origin: "http://127.0.0.1:5173",
    },
    requestHeaders: { Accept: "application/json" },
  };
  assert.deepEqual(security.normalizeElectronRequestDetails(mainFrame), {
    ...mainFrame,
    frameId: 0,
    initiator: "http://127.0.0.1:5173",
  });

  const childFrame = {
    ...mainFrame,
    frame: {
      parent: {},
      origin: "http://127.0.0.1:5173",
    },
  };
  assert.equal(
    security.normalizeElectronRequestDetails(childFrame).frameId,
    -1,
  );

  const missingFrame = { ...mainFrame, frame: null };
  assert.equal(
    security.normalizeElectronRequestDetails(missingFrame).initiator,
    undefined,
  );
  assert.equal(
    security.normalizeElectronRequestDetails(missingFrame).frameId,
    -1,
  );
});

test("desktop API ownership probes identity before sending the control token", async () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  const apiBase = "http://127.0.0.1:3100";
  const identity = {
    ok: true,
    data: {
      service: "agent-guard-api",
      schemaVersion: "mvp-1",
      apiVersion: "p2-api-freeze-2",
    },
  };

  const wrongCalls: Array<{ url: string; init?: RequestInit }> = [];
  const wrong = await security.probeApiOwnership({
    apiBase,
    controlToken: CONTROL_TOKEN,
    fetchImpl: async (url: string, init?: RequestInit) => {
      wrongCalls.push({ url, init });
      return jsonResponse({
        ...identity,
        data: { ...identity.data, service: "not-agent-guard" },
      });
    },
  });
  assert.equal(wrong.kind, "wrong_service");
  assert.equal(wrongCalls.length, 1);
  assert.equal(JSON.stringify(wrongCalls).includes(CONTROL_TOKEN), false);

  const mismatchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const mismatch = await security.probeApiOwnership({
    apiBase,
    controlToken: CONTROL_TOKEN,
    fetchImpl: async (url: string, init?: RequestInit) => {
      mismatchCalls.push({ url, init });
      return mismatchCalls.length === 1
        ? jsonResponse(identity)
        : jsonResponse({
            ok: false,
            error: { code: "NATIVE_GUARD_UNAUTHORIZED" },
          }, 401);
    },
  });
  assert.equal(mismatch.kind, "token_mismatch");
  assert.equal(mismatchCalls.length, 2);
  assert.equal(JSON.stringify(mismatchCalls[0]).includes(CONTROL_TOKEN), false);
  assert.equal(JSON.stringify(mismatchCalls[1]).includes(CONTROL_TOKEN), true);

  const readyCalls: Array<{ url: string; init?: RequestInit }> = [];
  const ready = await security.probeApiOwnership({
    apiBase,
    controlToken: CONTROL_TOKEN,
    fetchImpl: async (url: string, init?: RequestInit) => {
      readyCalls.push({ url, init });
      return readyCalls.length === 1
        ? jsonResponse(identity)
        : jsonResponse({
            ok: false,
            error: { code: "NATIVE_GUARD_INVALID_REQUEST" },
          }, 400);
    },
  });
  assert.equal(ready.kind, "ready");
  assert.equal(readyCalls.length, 2);
  assert.match(readyCalls[1].url, /\/native-guard\/leases$/);
  assert.equal(readyCalls[1].init?.body, "{}");
});

test("desktop ownership probe cancels an undeclared oversized JSON response", async () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  const chunk = new Uint8Array(32 * 1024).fill(0x20);
  let pulls = 0;
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls <= 5) {
        controller.enqueue(chunk);
        return;
      }
      controller.close();
    },
    cancel() {
      cancellations += 1;
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  const ownership = await security.probeApiOwnership({
    apiBase: "http://127.0.0.1:3100",
    controlToken: CONTROL_TOKEN,
    fetchImpl: async () => response,
  });

  assert.equal(ownership.kind, "wrong_service");
  assert.equal(cancellations, 1);
  assert.ok(pulls < 6);
});

test("desktop ownership probe cancels a non-JSON response body", async () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    cancel() {
      cancellations += 1;
    },
  }), {
    status: 200,
    headers: { "content-type": "text/plain" },
  });

  const ownership = await security.probeApiOwnership({
    apiBase: "http://127.0.0.1:3100",
    controlToken: CONTROL_TOKEN,
    fetchImpl: async () => response,
  });

  assert.equal(ownership.kind, "wrong_service");
  assert.equal(cancellations, 1);
});

test("desktop ownership probe cancels invalid declared response lengths", async () => {
  const security = require("../../../../../desktop/control-plane-security.cjs");
  for (const contentLength of ["invalid", "-1", "65537"]) {
    let cancellations = 0;
    const response = new Response(new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": contentLength,
      },
    });

    const ownership = await security.probeApiOwnership({
      apiBase: "http://127.0.0.1:3100",
      controlToken: CONTROL_TOKEN,
      fetchImpl: async () => response,
    });

    assert.equal(ownership.kind, "wrong_service");
    assert.equal(cancellations, 1, contentLength);
  }
});

test("lazy native runtime refreshes an idle identity and rejects changes with an active lease", async () => {
  const handlers = await import("./native-guard-handlers");
  const first = nativeAgent(
    "agent.first",
    "C:\\first\\openclaw.cmd",
    "http://127.0.0.1:18790",
  );
  const second = nativeAgent(
    "agent.second",
    "C:\\second\\openclaw.cmd",
    "http://127.0.0.1:18791",
  );

  const idleAgents = [first, second];
  const idleGateways: string[] = [];
  const idleDependencies = handlers.createNativeGuardRouteDependencies({
    env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    loadActiveAgentConfig: async () => idleAgents.shift() ?? second,
    createCoordinator(options) {
      idleGateways.push(options.gatewayUrl);
      return coordinatorStub();
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const idleApp = await createApp(idleDependencies);
  for (let index = 0; index < 2; index += 1) {
    const response = await idleApp.inject({
      method: "GET",
      url: "/api/v1/openclaw/native-guard/status",
      headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(idleGateways, [first.gatewayUrl, second.gatewayUrl]);
  await idleApp.close();

  const activeAgents = [first, second];
  let activeFactoryCalls = 0;
  const activeDependencies = handlers.createNativeGuardRouteDependencies({
    env: {
      AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN,
      OPENCLAW_CLI: "C:\\override\\openclaw.cmd",
      OPENCLAW_GATEWAY_URL: "http://127.0.0.1:19999",
    },
    loadActiveAgentConfig: async () => activeAgents.shift() ?? second,
    createCoordinator(options) {
      activeFactoryCalls += 1;
      assert.equal(options.gatewayUrl, "http://127.0.0.1:19999");
      assert.equal(
        options.capabilityInput.cliPath,
        "C:\\override\\openclaw.cmd",
      );
      return coordinatorStub({
        coverage: "active",
        finalizerAssurance: "exclusive_before_hook",
        activeLeaseCount: 1,
      });
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const activeApp = await createApp(activeDependencies);
  const firstStatus = await activeApp.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
  });
  assert.equal(firstStatus.statusCode, 200);
  const changedStatus = await activeApp.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-guard/status",
    headers: { "x-agent-guard-control-token": CONTROL_TOKEN },
  });
  assert.equal(changedStatus.statusCode, 500);
  assert.equal(changedStatus.json().error.code, "NATIVE_GUARD_INTERNAL_ERROR");
  assert.equal(activeFactoryCalls, 1);
  await activeApp.close();
});

test("lazy native runtime reserves its identity while management is in flight", async () => {
  const handlers = await import("./native-guard-handlers");
  const first = nativeAgent(
    "agent.first",
    "C:\\first\\openclaw.cmd",
    "http://127.0.0.1:18790",
  );
  const second = nativeAgent(
    "agent.second",
    "C:\\second\\openclaw.cmd",
    "http://127.0.0.1:18791",
  );
  const agents = [first, second];
  const activateStarted = deferred<void>();
  const releaseActivate = deferred<void>();
  let factoryCalls = 0;
  let lastStatus: NativeGuardStatus = {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  };
  const dependencies = handlers.createNativeGuardRouteDependencies({
    env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    loadActiveAgentConfig: async () => agents.shift() ?? second,
    createCoordinator() {
      factoryCalls += 1;
      return {
        ...(coordinatorStub(lastStatus) as object),
        async activate() {
          activateStarted.resolve();
          await releaseActivate.promise;
          lastStatus = {
            coverage: "active",
            finalizerAssurance: "exclusive_before_hook",
            activeLeaseCount: 1,
          };
          return structuredClone(lastStatus);
        },
        getLastStatus() {
          return structuredClone(lastStatus);
        },
      } as never;
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });

  const activation = dependencies.coordinator.activate({} as never);
  await activateStarted.promise;
  await assert.rejects(
    () => dependencies.coordinator.status(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NATIVE_GUARD_ACTIVE_AGENT_CHANGED",
  );
  assert.equal(factoryCalls, 1);

  releaseActivate.resolve();
  const activated = await activation;
  assert.equal(activated.coverage, "active");
  assert.equal(dependencies.coordinator.getLastStatus().coverage, "active");
  assert.equal(factoryCalls, 1);
});

test("lazy native runtime releases its identity reservation after failure", async () => {
  const handlers = await import("./native-guard-handlers");
  const first = nativeAgent(
    "agent.first",
    "C:\\first\\openclaw.cmd",
    "http://127.0.0.1:18790",
  );
  const second = nativeAgent(
    "agent.second",
    "C:\\second\\openclaw.cmd",
    "http://127.0.0.1:18791",
  );
  const agents = [first, second, second];
  const activateStarted = deferred<void>();
  const releaseActivate = deferred<void>();
  let factoryCalls = 0;
  const dependencies = handlers.createNativeGuardRouteDependencies({
    env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    loadActiveAgentConfig: async () => agents.shift() ?? second,
    createCoordinator() {
      factoryCalls += 1;
      if (factoryCalls > 1) return coordinatorStub();
      return {
        ...(coordinatorStub({
          coverage: "off",
          finalizerAssurance: "unverified",
          activeLeaseCount: 0,
        }) as object),
        async activate() {
          activateStarted.resolve();
          await releaseActivate.promise;
          throw new Error("activation failed");
        },
      } as never;
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });

  const activation = dependencies.coordinator.activate({} as never);
  await activateStarted.promise;
  await assert.rejects(
    () => dependencies.coordinator.status(),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "NATIVE_GUARD_ACTIVE_AGENT_CHANGED",
  );
  assert.equal(factoryCalls, 1);

  releaseActivate.resolve();
  await assert.rejects(() => activation, /activation failed/);
  const refreshed = await dependencies.coordinator.status();
  assert.equal(refreshed.coverage, "ready");
  assert.equal(factoryCalls, 2);
});

test("lazy native runtime delegates same-identity revoke during a pending renew", async () => {
  const handlers = await import("./native-guard-handlers");
  const activeAgent = nativeAgent(
    "agent.active",
    "C:\\active\\openclaw.cmd",
    "http://127.0.0.1:18790",
  );
  const renewStarted = deferred<void>();
  const releaseRenew = deferred<void>();
  const revokeStarted = deferred<void>();
  let factoryCalls = 0;
  const status: NativeGuardStatus = {
    coverage: "active",
    finalizerAssurance: "exclusive_before_hook",
    activeLeaseCount: 1,
  };
  const dependencies = handlers.createNativeGuardRouteDependencies({
    env: { AGENT_GUARD_CONTROL_TOKEN: CONTROL_TOKEN },
    loadActiveAgentConfig: async () => activeAgent,
    createCoordinator() {
      factoryCalls += 1;
      return {
        ...(coordinatorStub(status) as object),
        async renew() {
          renewStarted.resolve();
          await releaseRenew.promise;
          return structuredClone(status);
        },
        async revoke() {
          revokeStarted.resolve();
          return structuredClone(status);
        },
      } as never;
    },
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });

  const renewal = dependencies.coordinator.renew("lease-1");
  await renewStarted.promise;
  const revocation = dependencies.coordinator.revoke("lease-1");
  const revokeDelegated = await Promise.race([
    revokeStarted.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(revokeDelegated, true);
  assert.equal(factoryCalls, 1);

  releaseRenew.resolve();
  await Promise.all([renewal, revocation]);
});

async function createApp(dependencies: NativeGuardRouteDependencies) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(openClawNativeGuardRoutes, dependencies);
  return app;
}

async function createSystemApp(dependencies: SystemRouteDependencies) {
  const app = Fastify({ logger: false });
  await app.register(systemRoutes, dependencies);
  return app;
}

async function buildNativeApp(dependencies: NativeGuardRouteDependencies) {
  const { buildApp } = await import("../../../app");
  return buildApp({ logger: false, nativeGuardDependencies: dependencies });
}

function systemAgent(openclawCliPath?: string) {
  return {
    adapterKind: "openclaw" as const,
    agentId: "agent.system-test",
    name: "System Test Agent",
    openclawCliPath,
  };
}

function nativeAgent(
  agentId: string,
  openclawCliPath: string | undefined,
  gatewayUrl: string,
) {
  return {
    adapterKind: "openclaw" as const,
    agentId,
    name: `Native Agent ${agentId}`,
    openclawCliPath,
    gatewayUrl,
  };
}

function coordinatorStub(status: NativeGuardStatus = {
  coverage: "ready",
  finalizerAssurance: "exclusive_before_hook",
  activeLeaseCount: 0,
}) {
  return {
    async activate() { return structuredClone(status); },
    async renew() { return structuredClone(status); },
    async revoke() { return structuredClone(status); },
    async status() { return structuredClone(status); },
    isLeaseUsable() { return false; },
    isLeaseRevoking() { return false; },
    getLastStatus() { return structuredClone(status); },
  } as never;
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
    resolveSession: 0,
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
      authenticate(leaseId, credential) {
        calls.authenticate += 1;
        return credential === LEASE_CREDENTIAL
          ? leaseSnapshot(leaseId)
          : undefined;
      },
      resolveBySession(sessionKey) {
        calls.resolveSession += 1;
        return leaseSnapshot("lease-1", 1, sessionKey);
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

function createRealDecisionFixture() {
  const policyPack: SupervisionPolicyPack = {
    schemaVersion: "mvp-1",
    policyPackId: "policy.fastify.bounds",
    agentId: "agent.fastify",
    sourceDetectionReportId: "detection.fastify",
    sourceRiskProfileId: "risk.fastify",
    policies: [],
    defaultAction: "allow",
    createdAt: "2026-08-02T09:00:00.000Z",
    expiresAt: "2026-08-02T11:00:00.000Z",
  };
  const leaseService = createNativeGuardLeaseService({
    now: () => Date.parse("2026-08-02T10:00:00.000Z"),
  });
  const activation = leaseService.create({
    rootSessionKey: "session.fastify",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
  }).activation;
  const appended: unknown[] = [];
  const fixture = createFixture();
  fixture.dependencies.leaseService = leaseService;
  fixture.dependencies.decisionService = createNativeToolDecisionService({
    leaseService,
    eventStore: {
      async append(event) {
        appended.push(event);
        return true;
      },
    },
    now: () => "2026-08-02T10:00:00.000Z",
    createId: (() => {
      let id = 0;
      return (prefix: string) => `${prefix}.${++id}`;
    })(),
  });
  return {
    activation,
    appended,
    dependencies: fixture.dependencies,
    request(params: Record<string, unknown>, suffix: string) {
      return {
        ...decisionRequest(),
        requestId: `request.${suffix}`,
        leaseId: activation.leaseId,
        leaseEpoch: activation.leaseEpoch,
        sessionKey: activation.rootSessionKey,
        toolCallId: `call.${suffix}`,
        params,
        paramsDigest: digestJson(params),
        requestedAt: "2026-08-02T10:00:00.000Z",
      };
    },
  };
}

function paramsAtCanonicalBounds(bytes: number, keys: number): Record<string, unknown> {
  const params = Object.fromEntries(
    Array.from({ length: keys }, (_value, index) => [`key${index}`, ""]),
  );
  const baseBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
  assert.ok(bytes >= baseBytes);
  params.key0 = "x".repeat(bytes - baseBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(params), "utf8"), bytes);
  return params;
}

function paramsWithKeys(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_value, index) => [`key${index}`, index]));
}

function paramsAtDepth(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
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

function leaseSnapshot(
  leaseId = "lease-1",
  leaseEpoch = 1,
  sessionKey = "session-1",
) {
  return {
    leaseId,
    leaseEpoch,
    rootSessionKey: sessionKey,
    state: "active",
  } as never;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
