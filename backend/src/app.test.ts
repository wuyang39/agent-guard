import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeGuardEvent } from "@agent-guard/contracts";
import { createNativeGuardRouteDependencies } from "./api/v1/openclaw/native-guard-handlers";
import {
  buildApp,
  createSandboxCoordinatorFactory,
  requireNativeGuardRuntimeEventStore,
} from "./app";
import { createNativeGuardEventStore } from "./storage/nativeGuardEventStore";
import type { MainAgentSupervisionService } from "./modules/openclaw/mainAgentSupervisionService";
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
      async activate(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activate"]>[0]) {
        const capability = await input.sandbox?.controlClient.inspectCapabilities(
          input.sandbox.capabilityInput,
        );
        assert.equal(capability?.supportsNativeGuard, true);
        return { activeLease: { leaseId: "lease-cold-start", leaseEpoch: 1 } } as never;
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
      async activate(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activate"]>[0]) {
        await input.sandbox!.controlClient.activate(input.sandbox!.gatewayUrl, {
          leaseId: "lease-cold-control",
          leaseEpoch: 1,
        } as never);
        return { activeLease: { leaseId: "lease-cold-control", leaseEpoch: 1 } } as never;
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
      async activate(input: Parameters<ReturnType<typeof createNativeGuardRouteDependencies>["coordinator"]["activate"]>[0]) {
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
        return { activeLease: { leaseId: "lease-cached", leaseEpoch: 1 } } as never;
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
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.mainLeaseCount, 0);
  assert.deepEqual(calls, ["status"]);

  await app.close();
  assert.deepEqual(calls, ["status", "close"]);
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
    assert.equal(response.json().error.code, "NATIVE_GUARD_ORIGIN_FORBIDDEN");
  }
  assert.deepEqual(calls, []);

  const allowed = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    headers: { origin: "http://allowed.example" },
    payload: { policyPackId: "policy.main" },
  });
  const localCli = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(localCli.statusCode, 200);
  assert.deepEqual(calls, ["start:policy.main", "stop"]);
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
  assert.equal(stopped.json().error.code, "NATIVE_GUARD_ORIGIN_FORBIDDEN");
  assert.equal(started.json().error.code, "NATIVE_GUARD_ORIGIN_FORBIDDEN");
  assert.deepEqual(calls, []);
  await app.close();
});

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
