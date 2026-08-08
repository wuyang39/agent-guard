import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter } from "../modules/agent/agentAdapter";
import type {
  DetectionSandboxEvidence,
  DetectionSandboxManager,
} from "../modules/openclaw/detectionSandboxManager";
import type { NativeGuardEventStore } from "../storage/nativeGuardEventStore";
import {
  createOpenClawDetectionRuntimeController,
  type OpenClawDetectionRuntimeResources,
} from "./openclawDetectionRuntime";

test("lazily starts one runtime and reuses it for repeated runs", async () => {
  const manager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(manager);
    },
  });

  assert.equal(startCalls, 0);
  const firstGeneration = await controller.run(async (runtime) => runtime.generation);
  const secondGeneration = await controller.run(async (runtime) => runtime.generation);

  assert.equal(firstGeneration, 1);
  assert.equal(secondGeneration, 1);
  assert.equal(startCalls, 1);
  assert.equal(controller.current()?.manager, manager);
});

test("ensure publishes one frozen runtime for orchestration diagnostics", async () => {
  const manager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(manager);
    },
  });

  const first = await controller.ensure();
  const second = await controller.ensure();

  assert.equal(first, second);
  assert.equal(controller.current(), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(startCalls, 1);
});

test("controller generation cannot be overridden by started resources", async () => {
  const manager = new FakeDetectionSandboxManager();
  const resourcesWithGeneration = {
    ...runtimeResources(manager),
    generation: 99,
  };
  const controller = createOpenClawDetectionRuntimeController({
    start: async () => resourcesWithGeneration,
  });

  assert.equal((await controller.ensure()).generation, 1);
});

test("wraps each run with the captured manager and passes its signal", async () => {
  const manager = new FakeDetectionSandboxManager();
  const controller = createOpenClawDetectionRuntimeController({
    start: async () => runtimeResources(manager),
  });
  let receivedSignal: AbortSignal | undefined;

  await controller.run(async (_runtime, signal) => {
    receivedSignal = signal;
  });

  assert.equal(manager.runWhileGatewayAliveCalls, 1);
  assert.equal(receivedSignal, manager.signal);
});

test("restart cleans the old manager before publishing and using a replacement", async () => {
  const lifecycle: string[] = [];
  const firstManager = new FakeDetectionSandboxManager(async () => {
    lifecycle.push("cleanup:1");
  });
  const secondManager = new FakeDetectionSandboxManager();
  const managers = [firstManager, secondManager];
  const controller = createOpenClawDetectionRuntimeController({
    async start(generation) {
      lifecycle.push(`start:${generation}`);
      return runtimeResources(managers[generation - 1]!);
    },
  });

  assert.equal(await controller.run(async (runtime) => runtime.generation), 1);
  const replacement = await controller.restart();
  const runGeneration = await controller.run(
    async (runtime) => runtime.generation,
  );

  assert.deepEqual(lifecycle, ["start:1", "cleanup:1", "start:2"]);
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(replacement.generation, 2);
  assert.equal(replacement.manager, secondManager);
  assert.equal(controller.current(), replacement);
  assert.equal(runGeneration, 2);
});

test("recovers from a failed start without publishing or skipping a generation", async () => {
  const manager = new FakeDetectionSandboxManager();
  const requestedGenerations: number[] = [];
  const controller = createOpenClawDetectionRuntimeController({
    async start(generation) {
      requestedGenerations.push(generation);
      if (requestedGenerations.length === 1) throw new Error("start failed");
      return runtimeResources(manager);
    },
  });

  await assert.rejects(
    controller.run(async () => undefined),
    /start failed/,
  );
  assert.equal(controller.current(), undefined);

  assert.equal(await controller.run(async (runtime) => runtime.generation), 1);
  assert.deepEqual(requestedGenerations, [1, 1]);
  assert.equal(controller.current()?.manager, manager);
});

test("recovers from a failed replacement start after the old manager is clean", async () => {
  const firstManager = new FakeDetectionSandboxManager();
  const secondManager = new FakeDetectionSandboxManager();
  const requestedGenerations: number[] = [];
  const controller = createOpenClawDetectionRuntimeController({
    async start(generation) {
      requestedGenerations.push(generation);
      if (requestedGenerations.length === 2) {
        throw new Error("replacement failed");
      }
      return runtimeResources(
        requestedGenerations.length === 1 ? firstManager : secondManager,
      );
    },
  });
  await controller.run(async () => undefined);

  await assert.rejects(controller.restart(), /replacement failed/);

  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(controller.current(), undefined);
  assert.equal((await controller.ensure()).generation, 2);
  assert.deepEqual(requestedGenerations, [1, 2, 2]);
  assert.equal(controller.current()?.manager, secondManager);
});

test("does not replace a runtime until failed cleanup succeeds on retry", async () => {
  let cleanupAttempts = 0;
  const firstManager = new FakeDetectionSandboxManager(async () => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) throw new Error("cleanup failed");
  });
  const secondManager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(startCalls === 1 ? firstManager : secondManager);
    },
  });

  await controller.run(async () => undefined);
  await assert.rejects(controller.restart(), /cleanup failed/);

  assert.equal(controller.current(), undefined);
  assert.equal(startCalls, 1);
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(await controller.run(async (runtime) => runtime.generation), 2);
  assert.equal(firstManager.cleanupCalls, 2);
  assert.equal(startCalls, 2);
  assert.equal(controller.current()?.manager, secondManager);
});

test("deduplicates concurrent lazy starts", async () => {
  const manager = new FakeDetectionSandboxManager();
  const startEntered = deferred<void>();
  const releaseStart = deferred<void>();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      startEntered.resolve();
      await releaseStart.promise;
      return runtimeResources(manager);
    },
  });

  const first = controller.run(async (runtime) => runtime.generation);
  await startEntered.promise;
  const second = controller.run(async (runtime) => runtime.generation);
  await Promise.resolve();

  assert.equal(startCalls, 1);
  releaseStart.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(manager.runWhileGatewayAliveCalls, 2);
});

test("dispose cleans the current manager once and is idempotent", async () => {
  const manager = new FakeDetectionSandboxManager();
  const controller = createOpenClawDetectionRuntimeController({
    start: async () => runtimeResources(manager),
  });
  await controller.run(async () => undefined);

  await Promise.all([controller.dispose(), controller.dispose()]);
  await controller.dispose();

  assert.equal(manager.cleanupCalls, 1);
  assert.equal(controller.current(), undefined);
});

test("failed disposal can retry cleanup while concurrent retry callers share one attempt", async () => {
  const retryCleanupEntered = deferred<void>();
  const releaseRetryCleanup = deferred<void>();
  let cleanupAttempt = 0;
  const manager = new FakeDetectionSandboxManager(async () => {
    cleanupAttempt += 1;
    if (cleanupAttempt === 1) throw new Error("dispose cleanup failed");
    retryCleanupEntered.resolve();
    await releaseRetryCleanup.promise;
  });
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(manager);
    },
  });
  await controller.run(async () => undefined);

  const failedDisposal = controller.dispose();
  await assert.rejects(failedDisposal, /dispose cleanup failed/);
  assert.equal(manager.cleanupCalls, 1);
  assert.equal(controller.current(), undefined);

  const firstRetry = controller.dispose();
  assert.notEqual(firstRetry, failedDisposal);
  await retryCleanupEntered.promise;
  const secondRetry = controller.dispose();
  assert.equal(firstRetry, secondRetry);
  releaseRetryCleanup.resolve();
  await Promise.all([firstRetry, secondRetry]);
  await controller.dispose();

  assert.equal(manager.cleanupCalls, 2);
  assert.equal(startCalls, 1);
  await assert.rejects(controller.ensure(), /disposed/i);
  await assert.rejects(controller.restart(), /disposed/i);
});

test("run, ensure, and restart reject after disposal without starting a runtime", async () => {
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(new FakeDetectionSandboxManager());
    },
  });

  await controller.dispose();

  await assert.rejects(
    controller.run(async () => undefined),
    /disposed/i,
  );
  await assert.rejects(controller.ensure(), /disposed/i);
  await assert.rejects(controller.restart(), /disposed/i);
  assert.equal(startCalls, 0);
});

test("restart waits for a captured run before cleaning and replacing its runtime", async () => {
  const firstManager = new FakeDetectionSandboxManager();
  const secondManager = new FakeDetectionSandboxManager();
  const operationEntered = deferred<void>();
  const releaseOperation = deferred<void>();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(startCalls === 1 ? firstManager : secondManager);
    },
  });
  const run = controller.run(async (runtime) => {
    operationEntered.resolve();
    await releaseOperation.promise;
    return runtime.generation;
  });
  await operationEntered.promise;

  const restart = controller.restart();
  await Promise.resolve();

  assert.equal(firstManager.cleanupCalls, 0);
  assert.equal(startCalls, 1);
  releaseOperation.resolve();
  assert.equal(await run, 1);
  assert.equal((await restart).generation, 2);
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(controller.current()?.manager, secondManager);
});

test("concurrent restart and dispose do not double-clean or start a replacement", async () => {
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  const manager = new FakeDetectionSandboxManager(async () => {
    cleanupEntered.resolve();
    await releaseCleanup.promise;
  });
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(manager);
    },
  });
  await controller.run(async () => undefined);

  const restart = controller.restart();
  await cleanupEntered.promise;
  const disposal = controller.dispose();
  await Promise.resolve();

  try {
    assert.equal(manager.cleanupCalls, 1);
    assert.equal(startCalls, 1);
  } finally {
    releaseCleanup.resolve();
  }

  await assert.rejects(restart, /disposed/i);
  await disposal;
  assert.equal(manager.cleanupCalls, 1);
  assert.equal(startCalls, 1);
  assert.equal(controller.current(), undefined);
});

test("dispose during replacement start cleans the unpublished replacement", async () => {
  const firstManager = new FakeDetectionSandboxManager();
  const replacementManager = new FakeDetectionSandboxManager();
  const replacementStartEntered = deferred<void>();
  const releaseReplacementStart = deferred<void>();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      if (startCalls === 1) return runtimeResources(firstManager);
      replacementStartEntered.resolve();
      await releaseReplacementStart.promise;
      return runtimeResources(replacementManager);
    },
  });
  await controller.run(async () => undefined);

  const restart = controller.restart();
  const restartRejected = assert.rejects(restart, /disposed/i);
  await replacementStartEntered.promise;
  const disposal = controller.dispose();
  releaseReplacementStart.resolve();

  await restartRejected;
  await disposal;
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(replacementManager.cleanupCalls, 1);
  assert.equal(startCalls, 2);
  assert.equal(controller.current(), undefined);
});

test("dispose waits for a concurrent initial start to clean its resources", async () => {
  const manager = new FakeDetectionSandboxManager();
  const startEntered = deferred<void>();
  const releaseStart = deferred<void>();
  let operationCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startEntered.resolve();
      await releaseStart.promise;
      return runtimeResources(manager);
    },
  });
  const run = controller.run(async () => {
    operationCalls += 1;
  });
  const runRejected = assert.rejects(run, /disposed/i);
  await startEntered.promise;

  let disposalSettled = false;
  const disposal = controller.dispose().then(() => {
    disposalSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(disposalSettled, false);
  releaseStart.resolve();
  await Promise.all([runRejected, disposal]);
  assert.equal(manager.cleanupCalls, 1);
  assert.equal(operationCalls, 0);
  assert.equal(controller.current(), undefined);
});

test("a run submitted after restart captures only the replacement runtime", async () => {
  const firstManager = new FakeDetectionSandboxManager();
  const secondManager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(startCalls === 1 ? firstManager : secondManager);
    },
  });
  await controller.run(async () => undefined);

  const restart = controller.restart();
  const racedRun = controller.run(async (runtime) => runtime.generation);

  assert.equal((await restart).generation, 2);
  assert.equal(await racedRun, 2);
  assert.equal(firstManager.runWhileGatewayAliveCalls, 1);
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(secondManager.runWhileGatewayAliveCalls, 1);
});

test("does not reuse a runtime whose manager signal is aborted", async () => {
  const firstManager = new FakeDetectionSandboxManager();
  const secondManager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(startCalls === 1 ? firstManager : secondManager);
    },
  });
  await controller.run(async () => undefined);
  firstManager.abortController.abort();

  const generation = await controller.run(
    async (runtime) => runtime.generation,
  );

  assert.equal(generation, 2);
  assert.equal(firstManager.cleanupCalls, 1);
  assert.equal(controller.current()?.manager, secondManager);
});

test("current omits an aborted runtime without mutating its ownership", async () => {
  const manager = new FakeDetectionSandboxManager();
  let startCalls = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      startCalls += 1;
      return runtimeResources(manager);
    },
  });
  const runtime = await controller.ensure();
  assert.equal(controller.current(), runtime);

  manager.abortController.abort();

  assert.equal(controller.current(), undefined);
  assert.equal(manager.cleanupCalls, 0);
  assert.equal(startCalls, 1);
});

class FakeDetectionSandboxManager {
  readonly abortController = new AbortController();
  cleanupCalls = 0;
  runWhileGatewayAliveCalls = 0;

  constructor(
    private readonly cleanupImplementation: () => Promise<void> = async () => {},
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  runWhileGatewayAlive<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.runWhileGatewayAliveCalls += 1;
    return operation(this.signal);
  }

  async cleanup(): Promise<void> {
    this.cleanupCalls += 1;
    await this.cleanupImplementation();
  }
}

function runtimeResources(
  manager: FakeDetectionSandboxManager,
): OpenClawDetectionRuntimeResources {
  return {
    manager: manager as unknown as DetectionSandboxManager,
    adapter: {} as AgentAdapter,
    nativeGuardEventStore: {} as NativeGuardEventStore,
    preflightEvidence: {
      runGroupId: "run-group.runtime",
      image: "openclaw@sha256:test",
      imageId: "sha256:test",
      openclawVersion: "1.0.0",
      profileRoot: "profile",
      configPath: "config",
      configDigest: "digest",
      networkMode: "none",
      status: "preflight_passed",
    } satisfies DetectionSandboxEvidence,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
