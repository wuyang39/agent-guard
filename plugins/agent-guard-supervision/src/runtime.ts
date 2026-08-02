import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import {
  FileMarkerStore,
  LeaseRegistry,
  type LeaseLookup,
  type MarkerStore,
} from "./leaseRegistry";

export type AgentGuardRuntimeOptions = {
  markerStore?: MarkerStore;
  markerDir?: string;
  now?: () => Date;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
};

const OFF_STATUS: Readonly<NativeGuardStatus> = Object.freeze({
  coverage: "off",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
});

const FAILED_STATUS: Readonly<NativeGuardStatus> = Object.freeze({
  coverage: "misconfigured",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
  reasonCode: "MARKER_RECOVERY_FAILED",
});

export class AgentGuardRuntime {
  readonly registry: LeaseRegistry;
  readonly #markerStore: LifecycleMarkerStore;
  readonly #scheduleTimeout: NonNullable<AgentGuardRuntimeOptions["scheduleTimeout"]>;
  readonly #cancelTimeout: NonNullable<AgentGuardRuntimeOptions["cancelTimeout"]>;
  readonly #pendingOperations = new Set<Promise<unknown>>();
  #abortController = new AbortController();
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #registryStarted = false;
  #failed = false;
  #state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";

  constructor(options: AgentGuardRuntimeOptions = {}) {
    const markerStore = options.markerStore ?? new FileMarkerStore(
      options.markerDir ?? join(homedir(), ".agent-guard", "native-guard-markers"),
    );
    this.#markerStore = new LifecycleMarkerStore(markerStore);
    this.registry = new LeaseRegistry({ markerStore: this.#markerStore, now: options.now });
    this.#scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancelTimeout = options.cancelTimeout ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get abortSignal(): AbortSignal {
    return this.#abortController.signal;
  }

  async start(): Promise<void> {
    if (this.#state === "running") return;
    if (this.#state === "stopping") {
      throw new Error("Native guard runtime is stopping");
    }
    if (this.#state === "stopped" && this.#pendingOperations.size > 0) {
      throw new Error("Native guard runtime has stopped with pending operations");
    }
    if (this.#state === "stopped") {
      this.#abortController = new AbortController();
      this.#markerStore.allowWrites();
      this.#stopPromise = undefined;
    }
    if (this.#registryStarted) {
      this.#state = "running";
      return;
    }
    this.#state = "starting";
    if (this.#startPromise === undefined) {
      const starting = this.registry.start().then(() => {
        this.#registryStarted = true;
        this.#failed = false;
        if (this.#state === "starting") this.#state = "running";
      }).catch(() => {
        this.#startPromise = undefined;
        this.#failed = true;
        if (this.#state === "starting") this.#state = "idle";
        throw markerRecoveryError();
      });
      this.#startPromise = this.#track(starting);
    }
    await this.#startPromise;
  }

  async lookup(sessionKey: string): Promise<LeaseLookup> {
    if (this.#failed) throw markerRecoveryError();
    if (this.#state !== "running") return { state: "off" };
    return this.#track(this.registry.lookup(sessionKey));
  }

  async status(): Promise<NativeGuardStatus> {
    if (this.#failed) return { ...FAILED_STATUS };
    if (this.#state !== "running") return { ...OFF_STATUS };
    return this.#track(this.registry.status());
  }

  async activate(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRunning();
    return this.#track(this.registry.activate(input));
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRunning();
    return this.#track(this.registry.renew(input));
  }

  async revoke(leaseId: string): Promise<boolean> {
    this.#assertRunning();
    return this.#track(this.registry.revoke(leaseId));
  }

  async bindChild(
    leaseId: string,
    parentSessionKey: string,
    childSessionKey: string,
  ): Promise<boolean> {
    this.#assertRunning();
    return this.#track(this.registry.bindChild(leaseId, parentSessionKey, childSessionKey));
  }

  async endSession(sessionKey: string): Promise<boolean> {
    this.#assertRunning();
    return this.#track(this.registry.endSession(sessionKey));
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") {
      await this.#stopPromise;
      return;
    }
    if (this.#state === "idle") {
      this.#abortController.abort();
      this.#markerStore.preventWrites();
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopping") {
      await this.#stopPromise;
      return;
    }
    this.#state = "stopping";
    this.#abortController.abort();
    this.#stopPromise = this.#finishStop();
    await this.#stopPromise;
  }

  async #finishStop(): Promise<void> {
    const pending = [...this.#pendingOperations];
    if (pending.length > 0) {
      let timer: unknown;
      const flushed = Promise.allSettled(pending).then(() => "flushed" as const);
      const timedOut = new Promise<"timed-out">((resolve) => {
        timer = this.#scheduleTimeout(() => resolve("timed-out"), 4_000);
      });
      const result = await Promise.race([flushed, timedOut]);
      if (result === "flushed" && timer !== undefined) this.#cancelTimeout(timer);
    }
    this.#markerStore.preventWrites();
    this.#state = "stopped";
  }

  #track<T>(operation: Promise<T>): Promise<T> {
    this.#pendingOperations.add(operation);
    void operation.then(
      () => this.#pendingOperations.delete(operation),
      () => this.#pendingOperations.delete(operation),
    );
    return operation;
  }

  #assertRunning(): void {
    if (this.#failed) throw markerRecoveryError();
    if (this.#state === "running") return;
    if (this.#state === "stopping" || this.#state === "stopped") {
      throw new Error("Native guard runtime has stopped");
    }
    throw new Error("Native guard runtime has not started");
  }
}

function markerRecoveryError(): Error {
  return new Error("Native guard marker recovery failed");
}

class LifecycleMarkerStore implements MarkerStore {
  #writesAllowed = true;

  constructor(readonly delegate: MarkerStore) {}

  load(): Promise<unknown[]> {
    return this.delegate.load();
  }

  write(marker: Parameters<MarkerStore["write"]>[0]): Promise<void> {
    this.#assertWritesAllowed();
    return this.delegate.write(marker);
  }

  remove(leaseId: string): Promise<void> {
    this.#assertWritesAllowed();
    return this.delegate.remove(leaseId);
  }

  allowWrites(): void {
    this.#writesAllowed = true;
  }

  preventWrites(): void {
    this.#writesAllowed = false;
  }

  #assertWritesAllowed(): void {
    if (!this.#writesAllowed) throw new Error("Native guard runtime has stopped");
  }
}
