import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeGuardLeaseSummary,
  NativeGuardStatus,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  signNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import { createNativeGuardRouteDependencies } from "./api/v1/openclaw/native-guard-handlers";
import {
  buildApp,
  createSandboxCoordinatorFactory,
  requireNativeGuardRuntimeEventStore,
} from "./app";
import { createNativeGuardEventStore } from "./storage/nativeGuardEventStore";
import {
  createMainAgentSupervisionService,
  type MainAgentSupervisionService,
} from "./modules/openclaw/mainAgentSupervisionService";
import type { NativeSupervisionAccessService } from "./modules/openclaw/nativeSupervisionAccessService";
import { createNativeGuardCoordinator } from "./modules/openclaw/nativeGuardCoordinator";
import { createNativeGuardLeaseService } from "./modules/openclaw/nativeGuardLeaseService";
import type { OpenClawControlClient } from "./modules/openclaw/openclawControlClient";
import {
  subscribeRealtimeEvents,
  type RealtimeEvent,
} from "./modules/openclaw/realtimeMcpServer";

function attestedCapability() {
  return {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance: "isolated_profile" as const,
    conflictingPluginIds: [],
  };
}

test("default native guard composition exposes one runtime event store to the sandbox factory", () => {
  const runtimeEventStore = createNativeGuardEventStore();
  const dependencies = createNativeGuardRouteDependencies({
    coordinator: {} as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });

  assert.equal(dependencies.runtimeEventStore, runtimeEventStore);
  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "sandbox-token",
    profileEnv: {},
    capabilitySnapshot: attestedCapability(),
  });
  assert.equal(runGuard.eventStore, runtimeEventStore);
});

test("custom native guard composition rejects a missing runtime event store", () => {
  assert.throws(
    () => requireNativeGuardRuntimeEventStore({} as never),
    /runtimeEventStore/,
  );
});

test("sandbox activation gives cold capability inspection the preflight command budget", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "agent-guard-app-capability-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const cliPath = path.join(fixtureRoot, "openclaw.mjs");
  const pluginInventory = [{
    id: "agent-guard-supervision",
    enabled: true,
    status: "loaded",
    hookNames: ["before_tool_call"],
    contracts: { trustedToolPolicies: ["agent-guard-admission"] },
  }];
  await writeFile(cliPath, [
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') {",
    "  process.stdout.write('2026.7.2');",
    "} else {",
    "  await new Promise((resolve) => setTimeout(resolve, 2_100));",
    `  process.stdout.write(${JSON.stringify(JSON.stringify(pluginInventory))});`,
    "}",
  ].join("\n"), "utf8");

  const runtimeEventStore = createNativeGuardEventStore();
  const dependencies = createNativeGuardRouteDependencies({
    coordinator: {
      async activateWithIdentity(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activateWithIdentity"]>[0]) {
        const capability = await input.sandbox?.controlClient.inspectCapabilities(
          input.sandbox.capabilityInput,
        );
        assert.equal(capability?.supportsNativeGuard, true);
        return {
          leaseId: "lease-cold-start",
          leaseEpoch: 1,
          status: { activeLease: { leaseId: "lease-cold-start", leaseEpoch: 1 } },
        } as never;
      },
    } as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "sandbox-token",
    cliPath,
    profileEnv: {},
    capabilitySnapshot: attestedCapability(),
  });

  const lease = await runGuard.activate({
    rootSessionKey: "agent:cold-start",
    runGroupId: "run-cold-start",
  });

  assert.deepEqual(lease, { leaseId: "lease-cold-start", leaseEpoch: 1 });
});

test("sandbox activation gives cold Gateway control requests the detection command budget", async (t) => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      setTimeout(() => {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          coverage: "ready",
          finalizerAssurance: "isolated_profile",
          activeLeaseCount: 0,
        }));
      }, 2_100);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const runtimeEventStore = createNativeGuardEventStore();
  const dependencies = createNativeGuardRouteDependencies({
    coordinator: {
      async activateWithIdentity(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activateWithIdentity"]>[0]) {
        await input.sandbox!.controlClient.activate(input.sandbox!.gatewayUrl, {
          leaseId: "lease-cold-control",
          leaseEpoch: 1,
        } as never);
        return {
          leaseId: "lease-cold-control",
          leaseEpoch: 1,
          status: { activeLease: { leaseId: "lease-cold-control", leaseEpoch: 1 } },
        } as never;
      },
    } as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
    gatewayToken: "sandbox-token",
    profileEnv: {},
    capabilitySnapshot: attestedCapability(),
  });

  assert.deepEqual(await runGuard.activate({
    rootSessionKey: "agent:cold-control",
    runGroupId: "run-cold-control",
  }), { leaseId: "lease-cold-control", leaseEpoch: 1 });
});

test("sandbox activation reuses the run-scoped attested capability snapshot", async () => {
  let capabilityInspections = 0;
  const runtimeEventStore = createNativeGuardEventStore();
  const dependencies = createNativeGuardRouteDependencies({
    coordinator: {
      async activateWithIdentity(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activateWithIdentity"]>[0]) {
        const first = await input.sandbox!.controlClient.inspectCapabilities(
          input.sandbox!.capabilityInput,
        );
        const second = await input.sandbox!.controlClient.inspectCapabilities(
          input.sandbox!.capabilityInput,
        );
        capabilityInspections += 2;
        assert.notEqual(first, second);
        first.conflictingPluginIds.push("mutated-outside-cache");
        assert.deepEqual(second.conflictingPluginIds, []);
        return {
          leaseId: "lease-cached",
          leaseEpoch: 1,
          status: { activeLease: { leaseId: "lease-cached", leaseEpoch: 1 } },
        } as never;
      },
    } as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "sandbox-token",
    cliPath: "missing-openclaw-cli",
    profileEnv: {},
    capabilitySnapshot: attestedCapability(),
  } as never);

  assert.deepEqual(await runGuard.activate({
    rootSessionKey: "agent:cached-capability",
    runGroupId: "run-cached-capability",
  }), { leaseId: "lease-cached", leaseEpoch: 1 });
  assert.equal(capabilityInspections, 2);
});

test("sandbox activation returns the coordinator's authoritative lease identity", async () => {
  const runtimeEventStore = createNativeGuardEventStore();
  const dependencies = createNativeGuardRouteDependencies({
    coordinator: {
      async activateWithIdentity() {
        return {
          leaseId: "lease-authoritative",
          leaseEpoch: 7,
          status: {
            coverage: "active",
            finalizerAssurance: "isolated_profile",
            activeLeaseCount: 2,
          },
        } as never;
      },
    } as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "sandbox-token",
    profileEnv: {},
    capabilitySnapshot: attestedCapability(),
  });

  assert.deepEqual(await runGuard.activate({
    rootSessionKey: "agent:sandbox:authoritative",
    runGroupId: "run-authoritative",
  }), { leaseId: "lease-authoritative", leaseEpoch: 7 });
});

test("sandbox activation revokes malformed authoritative identities before rejecting", async (t) => {
  for (const { identity: invalid, expectedRevoke } of [
    { identity: { leaseId: "", leaseEpoch: 1 }, expectedRevoke: false },
    { identity: { leaseId: null as unknown as string, leaseEpoch: 1 }, expectedRevoke: false },
    { identity: { leaseId: 42 as unknown as string, leaseEpoch: 1 }, expectedRevoke: false },
    { identity: { leaseId: "lease-zero-epoch", leaseEpoch: 0 }, expectedRevoke: true },
    {
      identity: { leaseId: "lease-fractional-epoch", leaseEpoch: 1.5 },
      expectedRevoke: true,
    },
  ]) {
    await t.test(JSON.stringify(invalid), async () => {
      const revokeLeaseIds: string[] = [];
      const runtimeEventStore = createNativeGuardEventStore();
      const dependencies = createNativeGuardRouteDependencies({
        coordinator: {
          async activateWithIdentity() {
            return {
              ...invalid,
              status: {
                coverage: "active",
                finalizerAssurance: "isolated_profile",
                activeLeaseCount: 1,
              },
            } as never;
          },
          async revoke(leaseId: string) {
            revokeLeaseIds.push(leaseId);
            if (invalid.leaseEpoch === 1.5) throw new Error("cleanup unavailable");
            return {} as never;
          },
        } as never,
        leaseService: {} as never,
        eventStore: runtimeEventStore,
        createDecisionService() {
          return { async decide() { throw new Error("not called"); } };
        },
      });
      const runGuard = createSandboxCoordinatorFactory(dependencies)({
        gatewayUrl: "http://127.0.0.1:18789",
        gatewayToken: "sandbox-token",
        profileEnv: {},
        capabilitySnapshot: attestedCapability(),
      });

      await assert.rejects(
        runGuard.activate({
          rootSessionKey: "agent:sandbox:malformed",
          runGroupId: "run-malformed",
        }),
        { message: "Sandbox guard activation returned an invalid lease identity." },
      );
      assert.deepEqual(revokeLeaseIds, expectedRevoke ? [invalid.leaseId] : []);
    });
  }
});

test("buildApp registers one injected main supervision service and closes it", async () => {
  const calls: string[] = [];
  const service: MainAgentSupervisionService = {
    async status() {
      calls.push("status");
      return {
        coverage: "ready",
        scope: { kind: "agent", agentId: "main" },
        activeLeaseCount: 0,
        mainLeaseCount: 0,
      };
    },
    async start() {
      throw new Error("not called");
    },
    async stop() {
      throw new Error("not called");
    },
    async close() {
      calls.push("close");
    },
  };
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: appNativeGuardDependencies(),
    mainAgentSupervisionService: service,
    nativeSupervisionAccessService: appNativeSupervisionAccessService(),
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
    headers: appNativeSupervisionHeaders(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.mainLeaseCount, 0);
  assert.deepEqual(calls, ["status"]);

  await app.close();
  assert.deepEqual(calls, ["status", "close"]);
});

test("buildApp exchanges a bootstrap token and authenticates native supervision with credentials", async () => {
  const calls: string[] = [];
  const bootstrapToken = "b".repeat(43);
  const frontendOrigin = "http://127.0.0.1:5199";
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: appNativeGuardDependencies(),
    mainAgentSupervisionService: appSupervisionService(calls),
    nativeSupervisionBootstrapToken: bootstrapToken,
    additionalNativeSupervisionAllowedOrigins: [frontendOrigin],
  });

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
    headers: { origin: frontendOrigin },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error.code, "NATIVE_SUPERVISION_ACCESS_REQUIRED");
  assert.deepEqual(calls, []);

  const paired = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/access/bootstrap",
    headers: { origin: frontendOrigin },
    payload: { token: bootstrapToken },
  });
  assert.equal(paired.statusCode, 204);
  const setCookie = paired.headers["set-cookie"];
  if (typeof setCookie !== "string") throw new TypeError("Expected one Set-Cookie header");
  assert.match(setCookie, /^agent_guard_supervision_session=[A-Za-z0-9_-]{43};/);
  const cookie = setCookie.split(";", 1)[0];

  const authenticated = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
    headers: { origin: frontendOrigin, cookie },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.deepEqual(calls, ["status"]);

  const rejectedPreflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/native-supervision/stop",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(rejectedPreflight.statusCode, 403);
  assert.equal(rejectedPreflight.headers["access-control-allow-origin"], undefined);

  const allowedPreflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/native-supervision/stop",
    headers: {
      origin: frontendOrigin,
      "access-control-request-method": "POST",
    },
  });
  assert.equal(allowedPreflight.statusCode, 204);
  assert.equal(allowedPreflight.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(allowedPreflight.headers["access-control-allow-credentials"], "true");

  const rejectedSsePreflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/realtime/events/stream",
    headers: {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
    },
  });
  assert.equal(rejectedSsePreflight.statusCode, 403);
  assert.equal(rejectedSsePreflight.headers["access-control-allow-origin"], undefined);

  const allowedSsePreflight = await app.inject({
    method: "OPTIONS",
    url: "/api/v1/openclaw/realtime/events/stream",
    headers: {
      origin: frontendOrigin,
      "access-control-request-method": "GET",
    },
  });
  assert.equal(allowedSsePreflight.statusCode, 204);
  assert.equal(allowedSsePreflight.headers["access-control-allow-origin"], frontendOrigin);
  assert.equal(allowedSsePreflight.headers["access-control-allow-credentials"], "true");
  await app.close();
});

test("buildApp keeps host main supervision and sandbox detection isolated through revoke", async (t) => {
  const now = Date.parse("2026-08-10T00:00:00.000Z");
  const policyPack = appMainPolicyPack();
  const loadPolicyPack = async (policyPackId: string) => policyPackId === policyPack.policyPackId
    ? {
        policyPack,
        policyPackDigest: digestJson(policyPack),
        runGroupId: "run-group.app-coexistence",
      }
    : undefined;
  const leaseService = createNativeGuardLeaseService({ now: () => now });
  const eventStore = createNativeGuardEventStore();
  const host = createAppGatewayClient(
    "gateway.host.app.test",
    "http://127.0.0.1:18789",
    "exclusive_before_hook",
  );
  const sandbox = await createAppSandboxGateway();
  const coordinator = createNativeGuardCoordinator({
    leaseService,
    controlClient: host.controlClient,
    loadStoredOpenClawPolicyPack: loadPolicyPack,
    gatewayUrl: host.gatewayUrl,
    backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
    capabilityInput: { isolatedProfile: false },
    gatewayAttestationPublicKey: host.attestationPublicKey,
  });
  const dependencies = createNativeGuardRouteDependencies({
    coordinator,
    leaseService,
    eventStore,
    warmupHostCapability: false,
  });
  const scheduledTimers = new Set<object>();
  const mainService = createMainAgentSupervisionService({
    coordinator,
    loadStoredOpenClawPolicyPack: loadPolicyPack,
    ttlMs: 3_000,
    now: () => now,
    scheduleTimeout() {
      const timer = {};
      scheduledTimers.add(timer);
      return timer;
    },
    cancelTimeout(timer) {
      scheduledTimers.delete(timer as object);
    },
  });
  let appForCleanup: Awaited<ReturnType<typeof buildApp>> | undefined;
  let sandboxLeaseId: string | undefined;
  t.after(async () => {
    if (sandboxLeaseId && coordinator.isLeaseUsable(sandboxLeaseId)) {
      await coordinator.revoke(sandboxLeaseId).catch(() => undefined);
    }
    await appForCleanup?.close().catch(() => undefined);
    await sandbox.close();
    assert.equal(scheduledTimers.size, 0);
  });
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: dependencies,
    mainAgentSupervisionService: mainService,
    nativeSupervisionAccessService: appNativeSupervisionAccessService(),
  });
  appForCleanup = app;

  const started = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    payload: { policyPackId: policyPack.policyPackId },
    headers: appNativeSupervisionHeaders(),
  });
  assert.equal(started.statusCode, 200);
  const main = started.json().data;
  assert.deepEqual(main.scope, { kind: "agent", agentId: "main" });
  assert.equal(main.gatewayInstanceId, host.gatewayInstanceId);

  const runGuard = createSandboxCoordinatorFactory(dependencies)({
    gatewayUrl: sandbox.gatewayUrl,
    gatewayToken: sandbox.gatewayToken,
    profileEnv: {},
    capabilitySnapshot: {
      ...attestedCapability(),
      gatewayInstanceId: sandbox.gatewayInstanceId,
    },
  });
  const sandboxLease = await runGuard.activate({
    rootSessionKey: "agent:sandbox:run-app-coexistence",
    runGroupId: "run-group.app-coexistence",
  });
  sandboxLeaseId = sandboxLease.leaseId;

  const aggregate = await coordinator.status();
  const mainSummary = aggregate.activeLeases?.find((lease) => lease.leaseId === main.leaseId);
  const sandboxSummary = aggregate.activeLeases?.find(
    (lease) => lease.leaseId === sandboxLease.leaseId,
  );
  assert.equal(aggregate.activeLeaseCount, 2);
  assert.notEqual(main.leaseId, sandboxLease.leaseId);
  assert.deepEqual(mainSummary?.scope, { kind: "agent", agentId: "main" });
  assert.equal(mainSummary?.gatewayInstanceId, host.gatewayInstanceId);
  assert.deepEqual(sandboxSummary?.scope, {
    kind: "session",
    sessionKey: "agent:sandbox:run-app-coexistence",
  });
  assert.equal(sandboxSummary?.gatewayInstanceId, sandbox.gatewayInstanceId);
  assert.notEqual(mainSummary?.gatewayInstanceId, sandboxSummary?.gatewayInstanceId);
  assert.equal(coordinator.isLeaseUsable(main.leaseId), true);
  assert.equal(coordinator.isLeaseUsable(sandboxLease.leaseId), true);

  await runGuard.revoke(sandboxLease.leaseId);
  sandboxLeaseId = undefined;
  assert.deepEqual(sandbox.revokeLeaseIds, [sandboxLease.leaseId]);
  assert.deepEqual(host.revokeLeaseIds, []);
  assert.equal(coordinator.isLeaseUsable(sandboxLease.leaseId), false);
  assert.equal(coordinator.isLeaseUsable(main.leaseId), true);
  const afterSandboxRevoke = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
    headers: appNativeSupervisionHeaders(),
  });
  assert.equal(afterSandboxRevoke.statusCode, 200);
  assert.equal(afterSandboxRevoke.json().data.coverage, "active");
  assert.equal(afterSandboxRevoke.json().data.activeLeaseCount, 1);
  assert.equal(afterSandboxRevoke.json().data.mainLeaseCount, 1);

  const stopped = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    headers: appNativeSupervisionHeaders(),
  });
  assert.equal(stopped.statusCode, 200);
  assert.equal(stopped.json().data.mainLeaseCount, 0);
  assert.equal(stopped.json().data.activeLeaseCount, 0);
  assert.deepEqual(host.revokeLeaseIds, [main.leaseId]);
  assert.equal(coordinator.isLeaseUsable(main.leaseId), false);
  assert.equal(host.currentStatus().activeLeaseCount, 0);
  assert.equal(["ready", "off"].includes(host.currentStatus().coverage), true);
});

test("buildApp streams durable native guard events until the app closes", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "agent-guard-app-realtime-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const runtimeEventStore = createNativeGuardEventStore({ rootDir });
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: appNativeGuardDependencies(runtimeEventStore),
    mainAgentSupervisionService: appSupervisionService([]),
  });
  const received: RealtimeEvent[] = [];
  const unsubscribe = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === "agent:main:dashboard:app-lifecycle") {
      received.push(event);
    }
  });
  t.after(unsubscribe);
  const unsubscribeFailure = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === "agent:main:dashboard:app-lifecycle") {
      throw new Error("simulated SSE subscriber failure");
    }
  });
  t.after(unsubscribeFailure);

  assert.equal(await runtimeEventStore.append(appNativeDecision({
    eventId: "event.app-open",
    toolCallId: "call.app-open",
  })), true);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.type, "native_tool_hook");
  assert.equal(received[0]?.toolId, "call.app-open");
  assert.equal(received[0]?.detail?.source, "native_guard");
  assert.deepEqual(
    (await runtimeEventStore.listBySession(
      "agent:main:dashboard:app-lifecycle",
    )).map(({ eventId }) => eventId),
    ["event.app-open"],
  );

  await app.close();
  assert.equal(await runtimeEventStore.append(appNativeDecision({
    eventId: "event.app-closed",
    toolCallId: "call.app-closed",
  })), true);
  assert.equal(received.length, 1);
});

test("buildApp shares one native event bridge across apps using the same store", async (t) => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "agent-guard-shared-realtime-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const runtimeEventStore = createNativeGuardEventStore({ rootDir });
  const firstApp = await buildApp({
    logger: false,
    nativeGuardDependencies: appNativeGuardDependencies(runtimeEventStore),
    mainAgentSupervisionService: appSupervisionService([]),
  });
  const secondApp = await buildApp({
    logger: false,
    nativeGuardDependencies: appNativeGuardDependencies(runtimeEventStore),
    mainAgentSupervisionService: appSupervisionService([]),
  });
  t.after(async () => {
    await Promise.allSettled([firstApp.close(), secondApp.close()]);
  });
  const received: string[] = [];
  const unsubscribe = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === "agent:main:dashboard:shared-apps") {
      received.push(event.toolId ?? "missing");
    }
  });
  t.after(unsubscribe);

  assert.equal(await runtimeEventStore.append(appNativeDecision({
    eventId: "event.shared-both-open",
    sessionKey: "agent:main:dashboard:shared-apps",
    toolCallId: "call.shared-both-open",
  })), true);
  assert.deepEqual(received, ["call.shared-both-open"]);

  await firstApp.close();
  assert.equal(await runtimeEventStore.append(appNativeDecision({
    eventId: "event.shared-one-open",
    sessionKey: "agent:main:dashboard:shared-apps",
    toolCallId: "call.shared-one-open",
  })), true);
  assert.deepEqual(received, ["call.shared-both-open", "call.shared-one-open"]);

  await secondApp.close();
  assert.equal(await runtimeEventStore.append(appNativeDecision({
    eventId: "event.shared-all-closed",
    sessionKey: "agent:main:dashboard:shared-apps",
    toolCallId: "call.shared-all-closed",
  })), true);
  assert.deepEqual(received, ["call.shared-both-open", "call.shared-one-open"]);
});

test("buildApp blocks unapproved browser origins before native supervision mutations", async () => {
  const calls: string[] = [];
  const service = appSupervisionService(calls);
  const dependencies = appNativeGuardDependencies();
  dependencies.allowedOrigins = ["http://allowed.example"];
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: dependencies,
    mainAgentSupervisionService: service,
    nativeSupervisionAccessService: appNativeSupervisionAccessService(),
  });

  for (const request of [
    {
      method: "POST" as const,
      url: "/api/v1/openclaw/native-supervision/stop",
      headers: { origin: "http://malicious.example" },
    },
    {
      method: "POST" as const,
      url: "/api/v1/openclaw/native-supervision/start",
      headers: { origin: "null" },
      payload: { policyPackId: "policy.main" },
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN");
  }
  assert.deepEqual(calls, []);

  const allowed = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    headers: appNativeSupervisionHeaders("http://allowed.example"),
    payload: { policyPackId: "policy.main" },
  });
  const missingOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(missingOrigin.statusCode, 403);
  assert.deepEqual(calls, ["start:policy.main"]);
  await app.close();
});

test("native supervision rejects null Origin even when legacy native routes allow it", async () => {
  const calls: string[] = [];
  const dependencies = appNativeGuardDependencies();
  assert.equal(dependencies.allowedOrigins.includes("null"), true);
  const app = await buildApp({
    logger: false,
    nativeGuardDependencies: dependencies,
    mainAgentSupervisionService: appSupervisionService(calls),
    nativeSupervisionAccessService: appNativeSupervisionAccessService(),
  });

  const stopped = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    headers: { origin: "null" },
  });
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    headers: { origin: "http://malicious.example" },
    payload: { policyPackId: "policy.main" },
  });

  assert.equal(stopped.statusCode, 403);
  assert.equal(started.statusCode, 403);
  assert.equal(stopped.json().error.code, "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN");
  assert.equal(started.json().error.code, "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN");
  assert.deepEqual(calls, []);
  await app.close();
});

function appNativeSupervisionAccessService(): NativeSupervisionAccessService {
  return {
    exchangeBootstrap: () => undefined,
    issueEventCapability: () => undefined,
    authenticateControl: (token) => token === "c".repeat(43),
    authenticateEvents: () => false,
  };
}

function appNativeSupervisionHeaders(origin = "http://127.0.0.1:5173") {
  return {
    origin,
    cookie: `agent_guard_supervision_session=${"c".repeat(43)}`,
  };
}

function appSupervisionService(calls: string[]): MainAgentSupervisionService {
  const ready = {
    coverage: "ready" as const,
    scope: { kind: "agent" as const, agentId: "main" as const },
    activeLeaseCount: 0,
    mainLeaseCount: 0 as const,
  };
  return {
    async status() { calls.push("status"); return ready; },
    async start(policyPackId) { calls.push(`start:${policyPackId}`); return ready; },
    async stop() { calls.push("stop"); return ready; },
    async close() {},
  };
}

function appNativeGuardDependencies(
  runtimeEventStore = createNativeGuardEventStore(),
) {
  return createNativeGuardRouteDependencies({
    coordinator: {
      async status() {
        return {
          coverage: "ready",
          finalizerAssurance: "exclusive_before_hook",
          activeLeaseCount: 0,
          activeLeases: [],
        };
      },
      getLastStatus() {
        return {
          coverage: "ready",
          finalizerAssurance: "exclusive_before_hook",
          activeLeaseCount: 0,
          activeLeases: [],
        };
      },
      isLeaseEvidenceUsable() { return false; },
    } as never,
    leaseService: {} as never,
    eventStore: runtimeEventStore,
    createDecisionService() {
      return { async decide() { throw new Error("not called"); } };
    },
  });
}

function createAppGatewayClient(
  gatewayInstanceId: string,
  gatewayUrl: string,
  finalizerAssurance: "isolated_profile" | "exclusive_before_hook",
) {
  const attestationKeys = generateKeyPairSync("ed25519");
  let activeLeases: NativeGuardLeaseSummary[] = [];
  const revokeLeaseIds: string[] = [];
  const capability = {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance,
    conflictingPluginIds: [],
    gatewayInstanceId,
  };
  const currentStatus = (): NativeGuardStatus => ({
    coverage: activeLeases.length > 0 ? "active" : "ready",
    finalizerAssurance,
    openclawVersion: capability.openclawVersion,
    gatewayInstanceId,
    activeLeaseCount: activeLeases.length,
    activeLeases: activeLeases.map((lease) => structuredClone(lease)),
    ...(activeLeases.length === 1
      ? { activeLease: structuredClone(activeLeases[0]) }
      : {}),
    conflictingPluginIds: [],
  });
  const summary = (activation: NativeGuardLeaseActivation): NativeGuardLeaseSummary => ({
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    rootSessionKey: activation.rootSessionKey,
    scope: typeof activation.scope === "string"
      ? activation.scope
      : { ...activation.scope },
    gatewayInstanceId,
    mode: activation.mode,
    policyPackId: activation.policyPackId,
    policyPackDigest: activation.policyPackDigest,
    expiresAt: activation.expiresAt,
  });
  const controlClient: OpenClawControlClient = {
    async inspectCapabilities() {
      return structuredClone(capability);
    },
    async attestGateway(input) {
      const unsigned = {
        contractVersion: "native-guard-gateway-1",
        signatureContext: "native_guard.gateway_attestation.v1",
        challenge: input.challenge,
        gatewayUrl: input.gatewayUrl,
        gatewayInstanceId,
        openclawVersion: capability.openclawVersion,
        nativeGuard: {
          contractVersion: "native-guard-1",
          registrarStatus: "live",
          finalBeforeToolCall: {
            pluginId: "agent-guard-supervision",
            exclusive: true,
          },
          trustedToolPolicy: {
            policyId: "agent-guard-admission",
            exclusive: true,
          },
          recoveryService: {
            serviceId: "agent-guard-runtime",
            live: true,
          },
          postApprovalLeaseRecheck: true,
          paramsProvenance: "json-only",
        },
      } as const;
      return {
        ...unsigned,
        signature: signNativeGuardPayload(unsigned, attestationKeys.privateKey),
      };
    },
    async status() {
      return currentStatus();
    },
    async activate(_url, activation) {
      activeLeases = [
        summary(activation),
        ...activeLeases.filter((lease) => lease.leaseId !== activation.leaseId),
      ];
      return currentStatus();
    },
    async renew(_url, activation) {
      activeLeases = [
        summary(activation),
        ...activeLeases.filter((lease) => lease.leaseId !== activation.leaseId),
      ];
      return currentStatus();
    },
    async revoke(_url, leaseId) {
      revokeLeaseIds.push(leaseId);
      activeLeases = activeLeases.filter((lease) => lease.leaseId !== leaseId);
      return currentStatus();
    },
  };
  return {
    gatewayInstanceId,
    gatewayUrl,
    attestationPublicKey: attestationKeys.publicKey,
    controlClient,
    currentStatus,
    revokeLeaseIds,
  };
}

async function createAppSandboxGateway() {
  const gatewayToken = "sandbox-app-token";
  const gatewayInstanceId = "gateway.sandbox.app.test";
  let activeLeases: NativeGuardLeaseSummary[] = [];
  const revokeLeaseIds: string[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${gatewayToken}`) {
        response.statusCode = 401;
        response.end("unauthorized");
        return;
      }
      if (request.url === "/agent-guard/native-guard/v1/leases/activate") {
        const activation = await readAppGatewayJson(request) as NativeGuardLeaseActivation;
        activeLeases = [{
          leaseId: activation.leaseId,
          leaseEpoch: activation.leaseEpoch,
          rootSessionKey: activation.rootSessionKey,
          scope: typeof activation.scope === "string"
            ? activation.scope
            : { ...activation.scope },
          gatewayInstanceId,
          mode: activation.mode,
          policyPackId: activation.policyPackId,
          policyPackDigest: activation.policyPackDigest,
          expiresAt: activation.expiresAt,
        }];
      } else if (request.url === "/agent-guard/native-guard/v1/leases/revoke") {
        const { leaseId } = await readAppGatewayJson(request) as { leaseId: string };
        revokeLeaseIds.push(leaseId);
        activeLeases = activeLeases.filter((lease) => lease.leaseId !== leaseId);
      } else if (request.url !== "/agent-guard/native-guard/v1/status") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const status: NativeGuardStatus = {
        coverage: activeLeases.length > 0 ? "active" : "ready",
        finalizerAssurance: "isolated_profile",
        openclawVersion: "2026.7.2",
        gatewayInstanceId,
        activeLeaseCount: activeLeases.length,
        activeLeases: activeLeases.map((lease) => structuredClone(lease)),
        ...(activeLeases.length === 1
          ? { activeLease: structuredClone(activeLeases[0]) }
          : {}),
        conflictingPluginIds: [],
      };
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status));
    } catch {
      response.statusCode = 400;
      response.end("invalid request");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    gatewayToken,
    gatewayInstanceId,
    gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
    revokeLeaseIds,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readAppGatewayJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function appMainPolicyPack(): SupervisionPolicyPack {
  return {
    schemaVersion: "p3-a-1",
    policyPackId: "policy.main.app-coexistence",
    agentId: "main",
    sourceDetectionReportId: "detection.app-coexistence",
    sourceRiskProfileId: "risk.app-coexistence",
    policies: [{
      policyId: "deny-app-coexistence",
      sourceWeaknessIds: [],
      name: "App coexistence deny",
      description: "App coexistence deny",
      targetType: "tool_call",
      action: "deny",
      riskLevel: "high",
      match: { relation: "all" },
      reason: "Denied by the app coexistence fixture.",
    }],
    defaultAction: "deny",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function appNativeDecision(
  overrides: Partial<NativeGuardEvent> = {},
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId: "event.app",
    type: "decision",
    leaseId: "lease.app",
    leaseEpoch: 1,
    sessionKey: "agent:main:dashboard:app-lifecycle",
    runId: "run.app",
    toolCallId: "call.app",
    decisionId: "decision.app",
    timestamp: "2026-08-10T00:00:00.000Z",
    detail: {
      requestId: "request.app",
      action: "deny",
      reasonCode: "policy_deny",
      targetType: "tool_call",
      toolName: "exec",
      paramsDigest: "a".repeat(64),
    },
    ...overrides,
  };
}
