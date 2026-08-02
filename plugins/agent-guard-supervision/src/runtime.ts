import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeGuardStatus,
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
} from "@agent-guard/contracts";
import type {
  BeforeResult,
  PluginApi,
  PluginApprovalResolution,
  ToolContext,
  ToolEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createDecisionClient,
  type DecisionClient,
} from "./decisionClient";
import {
  type ActiveLeaseLookup,
  FileMarkerStore,
  LeaseRegistry,
  type LeaseLookup,
  type MarkerStore,
} from "./leaseRegistry";
import { inspectBoundedParams } from "./jsonBounds";
import { classifyToolRisk, type NativeToolRisk } from "./toolRisk";

export type AgentGuardRuntimeOptions = {
  markerStore?: MarkerStore;
  markerDir?: string;
  now?: () => Date;
  admissionTimeoutMs?: number;
  sessionResolver?: PluginApi["runtime"]["agent"]["session"]["getSessionEntry"];
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  fetch?: typeof globalThis.fetch;
  decisionTimeoutMs?: number;
  maxDecisionIdsPerLease?: number;
  emitEvent?: (event: NativeGuardEvent) => Promise<void> | void;
  createId?: (prefix: string) => string;
  decisionClient?: DecisionClient;
  /** Unit/compat seam for a future trusted host capability. Production does not self-attest it. */
  approvalLeaseRecheckAttested?: boolean;
};

const DEFAULT_ADMISSION_TIMEOUT_MS = 4_000;
const HOST_HOOK_TIMEOUT_MS = 5_000;
const DEFAULT_DECISION_TIMEOUT_MS = 2_000;

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
  readonly #now: NonNullable<AgentGuardRuntimeOptions["now"]>;
  readonly #admissionTimeoutMs: number;
  readonly #scheduleTimeout: NonNullable<AgentGuardRuntimeOptions["scheduleTimeout"]>;
  readonly #cancelTimeout: NonNullable<AgentGuardRuntimeOptions["cancelTimeout"]>;
  readonly #decisionClient: DecisionClient;
  readonly #emitEvent: NonNullable<AgentGuardRuntimeOptions["emitEvent"]>;
  readonly #createId: NonNullable<AgentGuardRuntimeOptions["createId"]>;
  readonly #approvalLeaseRecheckAttested: boolean;
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
    this.#now = options.now ?? (() => new Date());
    this.#admissionTimeoutMs = parseAdmissionTimeout(options.admissionTimeoutMs);
    const decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(decisionTimeoutMs) ||
      decisionTimeoutMs <= 0 ||
      decisionTimeoutMs >= this.#admissionTimeoutMs
    ) {
      throw new RangeError("Native guard decision timeout is invalid");
    }
    this.registry = new LeaseRegistry({ markerStore: this.#markerStore, now: this.#now });
    this.#scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#cancelTimeout = options.cancelTimeout ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#decisionClient = options.decisionClient ?? createDecisionClient({
      fetch: options.fetch,
      now: this.#now,
      timeoutMs: decisionTimeoutMs,
      maxDecisionIdsPerLease: options.maxDecisionIdsPerLease,
    });
    this.#emitEvent = options.emitEvent ?? (() => undefined);
    this.#createId = options.createId ?? ((prefix) => `${prefix}.${randomUUID()}`);
    this.#approvalLeaseRecheckAttested = options.approvalLeaseRecheckAttested === true;
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
    if (status.coverage === "active" && !this.#approvalLeaseRecheckAttested) {
      return {
        ...status,
        coverage: "conditional",
        reasonCode: "NATIVE_APPROVAL_UNATTESTED",
      };
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
    const operationController = new AbortController();
    const abortForStop = (): void => operationController.abort();
    this.abortSignal.addEventListener("abort", abortForStop, { once: true });
    if (this.abortSignal.aborted) operationController.abort();
    try {
      const admission = (async (): Promise<BeforeResult | void> => {
        try {
          await this.start();
          if (operationController.signal.aborted) return stoppedBlock();
          const trusted = await this.trustedAdmission(event, context);
          if (trusted !== undefined) return trusted;
          if (operationController.signal.aborted) return stoppedBlock();
          return await this.#finalDecision(event, context, operationController);
        } catch {
          return failClosedBlock();
        }
      })();
      const timedOut = new Promise<BeforeResult>((resolve) => {
        timer = this.#scheduleTimeout(
          () => {
            operationController.abort();
            resolve(failClosedBlock());
          },
          this.#admissionTimeoutMs,
        );
      });
      return await Promise.race([admission, timedOut]);
    } catch {
      return failClosedBlock();
    } finally {
      this.abortSignal.removeEventListener("abort", abortForStop);
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
    event: ToolEvent,
    context: ToolContext,
  ): Promise<BeforeResult | void> {
    const sessionKey = context.sessionKey;
    if (sessionKey !== undefined) {
      const current = await this.lookup(sessionKey);
      if (current.state !== "off") return guardedAdmission(current, event, context);
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
    if (parent.state === "recovery") return guardedAdmission(parent, event, context);
    try {
      if (await this.bindChild(parent.leaseId, parentSessionKey, sessionKey)) {
        return guardedAdmission(parent, event, context);
      }
    } catch {
      return inheritanceBlock();
    }
    try {
      const concurrent = await this.lookup(sessionKey);
      if (concurrent.state === "active" && concurrent.leaseId === parent.leaseId) {
        return guardedAdmission(concurrent, event, context);
      }
    } catch {
      return inheritanceBlock();
    }
    return inheritanceBlock();
  }

  async #finalDecision(
    event: ToolEvent,
    context: ToolContext,
    operationController: AbortController,
  ): Promise<BeforeResult | void> {
    if (!safeSessionKey(context.sessionKey)) {
      const status = await this.#internalStatus();
      return status.coverage === "off" ? undefined : contextBlock();
    }
    const lookup = await this.lookup(context.sessionKey);
    if (lookup.state === "off") return;
    const identity = guardedIdentity(event, context);
    if (identity === undefined) return contextBlock();
    if (lookup.state === "recovery") return recoveryDecision(event);
    const unlinkHostAbort = linkAbortSignal(context.abortSignal, operationController);
    try {
      if (context.abortSignal?.aborted) return cancelledBlock();
      return await this.#activeDecision(
        event,
        context,
        identity,
        lookup,
        operationController.signal,
      );
    } finally {
      unlinkHostAbort();
    }
  }

  async #activeDecision(
    event: ToolEvent,
    context: ToolContext,
    identity: GuardedIdentity,
    lookup: ActiveLeaseLookup,
    signal: AbortSignal,
  ): Promise<BeforeResult | void> {
    let request: NativeToolDecisionRequest;
    try {
      request = buildDecisionRequest(
        lookup,
        event,
        identity,
        this.#createId("native_guard_request"),
        this.#now(),
      );
    } catch {
      return this.#outageDecision(lookup, event, identity, "unknown", signal);
    }
    const risk = classifyToolRisk(event);

    let response: NativeToolDecisionResponse;
    try {
      response = await this.#track(this.#decisionClient.decide({
        lease: lookup,
        request,
        signal,
      }));
    } catch {
      if (context.abortSignal?.aborted) return cancelledBlock();
      if (signal.aborted || this.abortSignal.aborted) return stoppedBlock();
      if (!(await this.#leaseIsCurrent(identity.sessionKey, lookup))) return leaseChangedBlock();
      return this.#outageDecision(lookup, event, identity, risk, signal);
    }
    if (context.abortSignal?.aborted) return cancelledBlock();
    if (signal.aborted || this.abortSignal.aborted) return stoppedBlock();
    if (!(await this.#leaseIsCurrent(identity.sessionKey, lookup))) return leaseChangedBlock();

    await this.#emit(decisionEvent(
      this.#createId("native_guard_event"),
      lookup,
      request,
      response,
      this.#now(),
    ));
    if (context.abortSignal?.aborted) return cancelledBlock();
    if (signal.aborted || this.abortSignal.aborted) return stoppedBlock();
    if (!(await this.#leaseIsCurrent(identity.sessionKey, lookup))) return leaseChangedBlock();

    switch (response.action) {
      case "allow":
      case "warn":
        return;
      case "deny":
        return policyBlock(response, lookup, event.params);
      case "redact":
        return { params: response.rewrittenParams! };
      case "ask":
        if (!this.#approvalLeaseRecheckAttested) return approvalUnattestedBlock();
        return this.#approvalResult(lookup, request, response, signal, context.abortSignal);
    }
  }

  async #outageDecision(
    lease: ActiveLeaseLookup,
    event: ToolEvent,
    identity: GuardedIdentity,
    risk: NativeToolRisk,
    signal: AbortSignal,
  ): Promise<BeforeResult | void> {
    if (risk === "low" && lease.failurePolicy.lowRisk === "allow") return;
    const action = risk === "low" ? "warn" : "deny";
    await this.#emit(outageEvent(
      this.#createId("native_guard_event"),
      lease,
      identity,
      event.toolName,
      action,
      this.#now(),
    ));
    if (signal.aborted || this.abortSignal.aborted) return stoppedBlock();
    if (!(await this.#leaseIsCurrent(identity.sessionKey, lease))) return leaseChangedBlock();
    return action === "warn" ? undefined : outageBlock();
  }

  async #approvalResult(
    lease: ActiveLeaseLookup,
    request: NativeToolDecisionRequest,
    response: NativeToolDecisionResponse,
    signal: AbortSignal,
    hostSignal: AbortSignal | undefined,
  ): Promise<BeforeResult> {
    await this.#emit(approvalRequestedEvent(
      this.#createId("native_guard_event"),
      lease,
      request,
      response,
      this.#now(),
    ));
    if (hostSignal?.aborted) return cancelledBlock();
    if (signal.aborted || !(await this.#leaseIsCurrent(request.sessionKey, lease))) {
      return leaseChangedBlock();
    }
    return {
      requireApproval: {
        title: "Agent Guard approval required",
        description: "Agent Guard policy requires one-time approval for this tool call.",
        severity: "warning",
        timeoutMs: 60_000,
        timeoutBehavior: "deny",
        timeoutReason: "[Agent Guard:NATIVE_APPROVAL_TIMEOUT] Native tool approval timed out.",
        allowedDecisions: ["allow-once", "deny"],
        onResolution: async (resolution) => {
          await this.#recordApprovalResolution(lease, request, response, resolution);
        },
      },
    };
  }

  async #recordApprovalResolution(
    lease: ActiveLeaseLookup,
    request: NativeToolDecisionRequest,
    response: NativeToolDecisionResponse,
    hostResolution: PluginApprovalResolution,
  ): Promise<void> {
    try {
      if (this.abortSignal.aborted) return;
      const current = await this.#leaseIsCurrent(request.sessionKey, lease);
      const permitted = hostResolution === "allow-once" || hostResolution === "deny";
      const resolution = current && permitted ? hostResolution : "deny";
      await this.#emit(approvalResolvedEvent(
        this.#createId("native_guard_event"),
        lease,
        request,
        response,
        resolution,
        current && permitted ? undefined : "NATIVE_GUARD_LEASE_CHANGED",
        this.#now(),
      ));
    } catch {
      // The pinned host cannot await or veto this callback; never leak an async rejection.
    }
  }

  async #leaseIsCurrent(sessionKey: string, expected: ActiveLeaseLookup): Promise<boolean> {
    try {
      const current = await this.lookup(sessionKey);
      return current.state === "active" &&
        current.leaseId === expected.leaseId &&
        current.leaseEpoch === expected.leaseEpoch &&
        current.policyPackId === expected.policyPackId &&
        current.policyPackDigest === expected.policyPackDigest;
    } catch {
      return false;
    }
  }

  async #emit(event: NativeGuardEvent): Promise<void> {
    await this.#track(Promise.resolve().then(() => this.#emitEvent(event)));
  }

  async activate(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
    this.#assertRunning();
    await this.#track(this.registry.activate(input));
    return this.status();
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
    this.#assertRunning();
    await this.#track(this.registry.renew(input));
    return this.status();
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

type GuardedIdentity = {
  sessionKey: string;
  toolCallId: string;
  runId?: string;
};

function guardedAdmission(
  lookup: Exclude<LeaseLookup, { state: "off" }>,
  event: ToolEvent,
  context: ToolContext,
): BeforeResult | void {
  if (guardedIdentity(event, context) === undefined) return contextBlock();
  if (lookup.state === "recovery") return recoveryDecision(event);
}

function guardedIdentity(event: ToolEvent, context: ToolContext): GuardedIdentity | undefined {
  if (
    !safeSessionKey(context.sessionKey) ||
    !safeWireString(event.toolName, 256) ||
    event.toolName !== context.toolName ||
    !safeWireString(event.toolCallId, 256) ||
    !safeWireString(context.toolCallId, 256) ||
    event.toolCallId !== context.toolCallId ||
    (event.runId !== undefined && !safeWireString(event.runId, 256)) ||
    (context.runId !== undefined && !safeWireString(context.runId, 256)) ||
    (event.runId !== undefined && context.runId !== undefined && event.runId !== context.runId) ||
    (event.toolKind !== undefined && context.toolKind !== undefined && event.toolKind !== context.toolKind) ||
    (event.toolInputKind !== undefined &&
      context.toolInputKind !== undefined &&
      event.toolInputKind !== context.toolInputKind)
  ) {
    return undefined;
  }
  return {
    sessionKey: context.sessionKey,
    toolCallId: event.toolCallId,
    ...((event.runId ?? context.runId) === undefined
      ? {}
      : { runId: event.runId ?? context.runId }),
  };
}

function recoveryDecision(event: ToolEvent): BeforeResult | void {
  return classifyToolRisk(event) === "low" ? undefined : recoveryBlock();
}

function buildDecisionRequest(
  lease: ActiveLeaseLookup,
  event: ToolEvent,
  identity: GuardedIdentity,
  requestId: string,
  requestedAt: Date,
): NativeToolDecisionRequest {
  if (!safeWireString(requestId, 256)) throw new TypeError("Native guard request identity is invalid");
  const inspectedParams = inspectBoundedParams(event.params);
  return {
    schemaVersion: "native-guard-1",
    requestId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    sessionKey: identity.sessionKey,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    toolCallId: identity.toolCallId,
    toolName: event.toolName,
    ...(event.toolKind === undefined ? {} : { toolKind: event.toolKind }),
    ...(event.toolInputKind === undefined ? {} : { toolInputKind: event.toolInputKind }),
    params: event.params,
    paramsDigest: inspectedParams.digest,
    ...(event.derivedPaths === undefined ? {} : { derivedPaths: [...event.derivedPaths] }),
    requestedAt: requestedAt.toISOString(),
  };
}

function decisionEvent(
  eventId: string,
  lease: ActiveLeaseLookup,
  request: NativeToolDecisionRequest,
  response: NativeToolDecisionResponse,
  timestamp: Date,
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId,
    type: "decision",
    leaseId: lease.leaseId,
    sessionKey: request.sessionKey,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    toolCallId: request.toolCallId,
    decisionId: response.decisionId,
    timestamp: timestamp.toISOString(),
    detail: {
      requestId: request.requestId,
      action: response.action,
      reasonCode: safeReasonCode(response.reasonCode, lease, request.params),
      policyPackId: response.policyPackId,
      policyPackDigest: response.policyPackDigest,
      toolName: request.toolName,
      paramsDigest: request.paramsDigest,
      ...(response.rewrittenParamsDigest === undefined
        ? {}
        : { rewrittenParamsDigest: response.rewrittenParamsDigest }),
    },
  };
}

function outageEvent(
  eventId: string,
  lease: ActiveLeaseLookup,
  identity: GuardedIdentity,
  toolName: string,
  action: "warn" | "deny",
  timestamp: Date,
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId,
    type: "decision",
    leaseId: lease.leaseId,
    sessionKey: identity.sessionKey,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    toolCallId: identity.toolCallId,
    timestamp: timestamp.toISOString(),
    detail: {
      action,
      reasonCode: "NATIVE_GUARD_PDP_UNAVAILABLE",
      toolName,
    },
  };
}

function approvalRequestedEvent(
  eventId: string,
  lease: ActiveLeaseLookup,
  request: NativeToolDecisionRequest,
  response: NativeToolDecisionResponse,
  timestamp: Date,
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId,
    type: "approval_requested",
    leaseId: lease.leaseId,
    sessionKey: request.sessionKey,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    toolCallId: request.toolCallId,
    decisionId: response.decisionId,
    timestamp: timestamp.toISOString(),
    detail: {
      allowedDecisions: ["allow-once", "deny"],
      paramsDigest: request.paramsDigest,
      timeoutBehavior: "deny",
    },
  };
}

function approvalResolvedEvent(
  eventId: string,
  lease: ActiveLeaseLookup,
  request: NativeToolDecisionRequest,
  response: NativeToolDecisionResponse,
  resolution: "allow-once" | "deny",
  reasonCode: string | undefined,
  timestamp: Date,
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId,
    type: "approval_resolved",
    leaseId: lease.leaseId,
    sessionKey: request.sessionKey,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    toolCallId: request.toolCallId,
    decisionId: response.decisionId,
    timestamp: timestamp.toISOString(),
    detail: {
      resolution,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    },
  };
}

function recoveryBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_RECOVERY] Native guard recovery blocks this tool.",
  };
}

function contextBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_CONTEXT_INVALID] Native guard tool context is incomplete.",
  };
}

function outageBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_PDP_UNAVAILABLE] Native guard policy decision unavailable.",
  };
}

function leaseChangedBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_LEASE_CHANGED] Native guard lease changed during decision.",
  };
}

function stoppedBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_STOPPED] Native guard runtime stopped during decision.",
  };
}

function cancelledBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_CANCELLED] Native guard tool call was cancelled.",
  };
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  destination: AbortController,
): () => void {
  if (source === undefined) return () => undefined;
  const abort = (): void => destination.abort();
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}

function approvalUnattestedBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_APPROVAL_UNATTESTED] Native tool approval cannot be enforced by this host.",
  };
}

function policyBlock(
  response: NativeToolDecisionResponse,
  lease: ActiveLeaseLookup,
  params: Record<string, unknown>,
): BeforeResult {
  const reason = safePolicyReason(response.reason, lease, params)
    ? response.reason
    : "Denied by Agent Guard policy.";
  return {
    block: true,
    blockReason: `[Agent Guard:NATIVE_POLICY_DENY] ${reason}`,
  };
}

function safeReasonCode(
  reasonCode: string,
  lease: ActiveLeaseLookup,
  params: Record<string, unknown>,
): string {
  return containsSensitiveText(reasonCode, lease, params)
    ? "policy_deny"
    : reasonCode;
}

function safePolicyReason(
  reason: string,
  lease: ActiveLeaseLookup,
  params: Record<string, unknown>,
): boolean {
  return !containsSensitiveText(reason, lease, params);
}

function containsSensitiveText(
  text: string,
  lease: ActiveLeaseLookup,
  params: Record<string, unknown>,
): boolean {
  if ([lease.credential, lease.backendUrl, lease.decisionPublicKey]
    .some((value) => value.length > 0 && text.includes(value))) {
    return true;
  }
  return parametersContainText(params, text, new Set<object>(), 0);
}

function parametersContainText(
  value: unknown,
  text: string,
  ancestors: Set<object>,
  depth: number,
): boolean {
  if (depth > 64) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const rendered = String(value);
    return rendered.length > 0 && text.includes(rendered);
  }
  if (typeof value !== "object" || value === null) return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (parametersContainText(entry, text, ancestors, depth + 1)) return true;
      }
      return false;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > 0 && text.includes(key)) return true;
      if (parametersContainText(entry, text, ancestors, depth + 1)) {
        return true;
      }
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function safeWireString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\x00-\x1f\x7f]/.test(value);
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
