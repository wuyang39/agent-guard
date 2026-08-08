import type { AgentAdapter } from "../modules/agent/agentAdapter";
import type {
  DetectionSandboxEvidence,
  DetectionSandboxManager,
} from "../modules/openclaw/detectionSandboxManager";
import { Mutex } from "../shared/mutex";
import type { NativeGuardEventStore } from "../storage/nativeGuardEventStore";

export type OpenClawDetectionRuntime = Readonly<{
  generation: number;
  manager: DetectionSandboxManager;
  adapter: AgentAdapter;
  nativeGuardEventStore: NativeGuardEventStore;
  preflightEvidence: DetectionSandboxEvidence;
}>;

export type OpenClawDetectionRuntimeResources = Omit<
  OpenClawDetectionRuntime,
  "generation"
>;

/**
 * Creates a complete runtime and transfers its ownership only on fulfillment.
 * The starter must release every resource allocated by a failed attempt before
 * rejecting because the controller never receives partial runtime resources.
 */
export type StartOpenClawDetectionRuntime = (
  generation: number,
) => Promise<OpenClawDetectionRuntimeResources>;

export type OpenClawDetectionRuntimeController = {
  current(): OpenClawDetectionRuntime | undefined;
  dispose(): Promise<void>;
  ensure(): Promise<OpenClawDetectionRuntime>;
  restart(): Promise<OpenClawDetectionRuntime>;
  run<T>(
    operation: (
      runtime: OpenClawDetectionRuntime,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T>;
};

export class OpenClawDetectionRuntimeDisposedError extends Error {
  constructor() {
    super("OpenClaw detection runtime controller has been disposed");
    this.name = "OpenClawDetectionRuntimeDisposedError";
  }
}

export function createOpenClawDetectionRuntimeController(options: {
  start: StartOpenClawDetectionRuntime;
}): OpenClawDetectionRuntimeController {
  let currentRuntime: OpenClawDetectionRuntime | undefined;
  let managerAwaitingCleanup: DetectionSandboxManager | undefined;
  let publishedGeneration = 0;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let activeOperations = 0;
  const operationsDrained = new Set<() => void>();
  const lifecycle = new Mutex();

  function assertNotDisposed(): void {
    if (disposed) throw new OpenClawDetectionRuntimeDisposedError();
  }

  async function waitForOperationsToDrain(): Promise<void> {
    if (activeOperations === 0) return;
    await new Promise<void>((resolve) => operationsDrained.add(resolve));
  }

  function finishOperation(): void {
    activeOperations -= 1;
    if (activeOperations !== 0) return;
    for (const resolve of operationsDrained) resolve();
    operationsDrained.clear();
  }

  async function cleanupRetiredManager(): Promise<void> {
    if (!managerAwaitingCleanup) return;
    const manager = managerAwaitingCleanup;
    await manager.cleanup();
    if (managerAwaitingCleanup === manager) managerAwaitingCleanup = undefined;
  }

  async function startRuntime(): Promise<OpenClawDetectionRuntime> {
    assertNotDisposed();
    const generation = publishedGeneration + 1;
    const resources = await options.start(generation);
    if (disposed) {
      managerAwaitingCleanup = resources.manager;
      await cleanupRetiredManager();
      throw new OpenClawDetectionRuntimeDisposedError();
    }
    const runtime = Object.freeze({
      ...resources,
      generation,
    });
    currentRuntime = runtime;
    publishedGeneration = generation;
    return runtime;
  }

  async function ensureRuntime(): Promise<OpenClawDetectionRuntime> {
    assertNotDisposed();
    if (currentRuntime && !currentRuntime.manager.signal.aborted) {
      return currentRuntime;
    }
    if (currentRuntime) {
      await waitForOperationsToDrain();
      managerAwaitingCleanup = currentRuntime.manager;
      currentRuntime = undefined;
    }
    await cleanupRetiredManager();
    return startRuntime();
  }

  return {
    current: () => currentRuntime?.manager.signal.aborted
      ? undefined
      : currentRuntime,
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      const attempt = lifecycle.run(async () => {
        await waitForOperationsToDrain();
        const previous = currentRuntime;
        currentRuntime = undefined;
        if (previous) managerAwaitingCleanup = previous.manager;
        await cleanupRetiredManager();
      });
      disposePromise = attempt;
      void attempt.then(undefined, () => {
        if (disposePromise === attempt) disposePromise = undefined;
      });
      return attempt;
    },
    ensure() {
      return lifecycle.run(ensureRuntime);
    },
    restart() {
      return lifecycle.run(async () => {
        assertNotDisposed();
        await waitForOperationsToDrain();
        assertNotDisposed();
        const previous = currentRuntime;
        currentRuntime = undefined;
        if (previous) managerAwaitingCleanup = previous.manager;
        await cleanupRetiredManager();
        return startRuntime();
      });
    },
    async run(operation) {
      const runtime = await lifecycle.run(async () => {
        assertNotDisposed();
        const acquired = await ensureRuntime();
        assertNotDisposed();
        activeOperations += 1;
        return acquired;
      });
      try {
        return await runtime.manager.runWhileGatewayAlive(
          (signal) => operation(runtime, signal),
        );
      } finally {
        finishOperation();
      }
    },
  };
}
