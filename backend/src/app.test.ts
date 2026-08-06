import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createNativeGuardRouteDependencies } from "./api/v1/openclaw/native-guard-handlers";
import {
  createSandboxCoordinatorFactory,
  requireNativeGuardRuntimeEventStore,
} from "./app";
import { createNativeGuardEventStore } from "./storage/nativeGuardEventStore";

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
  });

  const lease = await runGuard.activate({
    rootSessionKey: "agent:cold-start",
    runGroupId: "run-cold-start",
  });

  assert.deepEqual(lease, { leaseId: "lease-cold-start", leaseEpoch: 1 });
});
