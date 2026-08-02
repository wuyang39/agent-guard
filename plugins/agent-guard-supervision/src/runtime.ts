import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import type {
  BeforeResult,
  PluginApi,
  ToolContext,
  ToolEvent,
} from "openclaw/plugin-sdk/plugin-entry";
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
  admissionTimeoutMs?: number;
  sessionResolver?: PluginApi["runtime"]["agent"]["session"]["getSessionEntry"];
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
};

const DEFAULT_ADMISSION_TIMEOUT_MS = 4_000;
const HOST_HOOK_TIMEOUT_MS = 5_000;

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

const UNATTESTED_STATUS: Readonly<NativeGuardStatus> = Object.freeze({
  coverage: "unsupported",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
  reasonCode: "TRUSTED_POLICY_UNATTESTED",
});

export class AgentGuardRegistrationError extends Error {
  constructor() {
    super("Native guard trusted contributions are unattested");
  }
}

export class AgentGuardRuntime {
  readonly registry: LeaseRegistry;
  readonly #markerStore: LifecycleMarkerStore;
  readonly #sessionResolver: AgentGuardRuntimeOptions["sessionResolver"];
  readonly #admissionTimeoutMs: number;
  readonly #scheduleTimeout: NonNullable<AgentGuardRuntimeOptions["scheduleTimeout"]>;
  readonly #cancelTimeout: NonNullable<AgentGuardRuntimeOptions["cancelTimeout"]>;
  readonly #pendingOperations = new Set<Promise<unknown>>();
  #abortController = new AbortController();
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #registryStarted = false;
  #failed = false;
  #registrationAttestation: "pending" | "attested" | "unattested" = "pending";
  #state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";

  constructor(options: AgentGuardRuntimeOptions = {}) {
    const markerStore = options.markerStore ?? new FileMarkerStore(
      options.markerDir ?? join(homedir(), ".agent-guard", "native-guard-markers"),
    );
    this.#markerStore = new LifecycleMarkerStore(markerStore);
    this.#sessionResolver = options.sessionResolver;
    this.#admissionTimeoutMs = parseAdmissionTimeout(options.admissionTimeoutMs);
    this.registry = new LeaseRegistry({ markerStore: this.#markerStore, now: options.now });
    this.#scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancelTimeout = options.cancelTimeout ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get abortSignal(): AbortSignal {
    return this.#abortController.signal;
  }

  finalizeRegistrationAttestation(attested: boolean): void {
    if (this.#registrationAttestation !== "pending") {
      throw new Error("Native guard registration attestation is already finalized");
    }
    this.#registrationAttestation = attested ? "attested" : "unattested";
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
    const status = await this.#internalStatus();
    if (
      this.#registrationAttestation === "unattested" &&
      status.coverage !== "misconfigured"
    ) {
      return { ...UNATTESTED_STATUS };
    }
    return status;
  }

  async #internalStatus(): Promise<NativeGuardStatus> {
    if (this.#failed) return { ...FAILED_STATUS };
    if (this.#state !== "running") return { ...OFF_STATUS };
    return this.#track(this.registry.status());
  }

  async beforeToolCall(
    event: ToolEvent,
    context: ToolContext,
  ): Promise<BeforeResult | void> {
    let timer: unknown;
    try {
      const admission = (async (): Promise<BeforeResult | void> => {
        try {
          await this.start();
          return await this.trustedAdmission(event, context);
        } catch {
          return failClosedBlock();
        }
      })();
      const timedOut = new Promise<BeforeResult>((resolve) => {
        timer = this.#scheduleTimeout(
          () => resolve(failClosedBlock()),
          this.#admissionTimeoutMs,
        );
      });
      return await Promise.race([admission, timedOut]);
    } catch {
      return failClosedBlock();
    } finally {
      if (timer !== undefined) {
        try {
          this.#cancelTimeout(timer);
        } catch {
          // Timer cleanup failure cannot escape a final fail-closed hook.
        }
      }
    }
  }

  async trustedAdmission(
    _event: ToolEvent,
    context: ToolContext,
  ): Promise<BeforeResult | void> {
    const sessionKey = context.sessionKey;
    if (sessionKey !== undefined) {
      const current = await this.lookup(sessionKey);
      if (current.state === "active") return;
      if (current.state === "recovery") return recoveryBlock();
    }

    const status = await this.#internalStatus();
    if (status.coverage === "off") return;
    if (status.coverage === "misconfigured") throw markerRecoveryError();
    if (!safeSessionKey(sessionKey)) return inheritanceBlock();

    const sessionResolver = this.#sessionResolver;
    if (sessionResolver === undefined) return inheritanceBlock();
    let entry: ReturnType<NonNullable<AgentGuardRuntimeOptions["sessionResolver"]>>;
    try {
      entry = sessionResolver({
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        sessionKey,
        readConsistency: "latest",
      });
    } catch {
      return inheritanceBlock();
    }
    if (entry?.spawnedBy === undefined && entry?.parentSessionKey === undefined) return;
    if (
      !safeSessionKey(entry?.spawnedBy) ||
      !safeSessionKey(entry.parentSessionKey) ||
      entry.spawnedBy !== entry.parentSessionKey
    ) {
      return inheritanceBlock();
    }

    const parentSessionKey = entry.parentSessionKey;
    let parent: LeaseLookup;
    try {
      parent = await this.lookup(parentSessionKey);
    } catch {
      return inheritanceBlock();
    }
    if (parent.state === "off") return;
    if (parent.state === "recovery") return recoveryBlock();
    try {
      if (await this.bindChild(parent.leaseId, parentSessionKey, sessionKey)) return;
    } catch {
      return inheritanceBlock();
    }
    try {
      const concurrent = await this.lookup(sessionKey);
      if (concurrent.state === "active" && concurrent.leaseId === parent.leaseId) return;
    } catch {
      return inheritanceBlock();
    }
    return inheritanceBlock();
  }

  async activate(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
    this.#assertRunning();
    return this.#track(this.registry.activate(input));
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
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

  #assertRegistrationAttested(): void {
    if (this.#registrationAttestation !== "attested") {
      throw new AgentGuardRegistrationError();
    }
  }
}

function parseAdmissionTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs >= HOST_HOOK_TIMEOUT_MS) {
    throw new RangeError("Native guard admission timeout is invalid");
  }
  return timeoutMs;
}

function markerRecoveryError(): Error {
  return new Error("Native guard marker recovery failed");
}

function safeSessionKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\/\x00-\x1f\x7f]/.test(value) &&
    !value.includes("..");
}

function recoveryBlock(): BeforeResult {
  return { block: true, blockReason: "Native guard recovery requires reactivation." };
}

function inheritanceBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "Native guard session inheritance could not be proven.",
  };
}

function failClosedBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "Native guard admission failed closed.",
  };
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
