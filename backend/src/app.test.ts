import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeGuardRouteDependencies } from "./api/v1/openclaw/native-guard-handlers";
import {
  buildApp,
  createSandboxCoordinatorFactory,
  requireNativeGuardRuntimeEventStore,
} from "./app";
import { createNativeGuardEventStore } from "./storage/nativeGuardEventStore";
import type { MainAgentSupervisionService } from "./modules/openclaw/mainAgentSupervisionService";

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

function appNativeGuardDependencies() {
  const runtimeEventStore = createNativeGuardEventStore();
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
