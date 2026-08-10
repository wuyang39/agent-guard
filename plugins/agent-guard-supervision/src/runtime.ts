import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import type {
  NativeGuardAction,
  NativeGuardEvidenceProof,
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeGuardStatus,
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
} from "@agent-guard/contracts";
import {
  canonicalJson,
  digestJson,
  parseCanonicalOpenClawSessionKey,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import type {
  AfterToolEvent,
  BeforeResult,
  PluginApi,
  PluginApprovalResolution,
  ToolContext,
  ToolEvent,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createEventSpool as defaultCreateEventSpool,
  sanitizeOutcomeDiagnostic,
  sanitizeOutcomeResult,
  type EventSpool,
  type EventSpoolOptions,
  type EventUploadLease,
} from "./eventSpool";
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
  type RootEndedEvidenceLookup,
} from "./leaseRegistry";
import { inspectBoundedParams } from "./jsonBounds";
import {
  createLifecycleEvidenceProof,
  createLifecycleClient,
  type LifecycleClient,
} from "./lifecycleClient";
import { classifyToolRisk, type NativeToolRisk } from "./toolRisk";

const MAX_DERIVED_PATHS = 256;
const MAX_DERIVED_PATH_LENGTH = 4_096;
const MAX_DERIVED_PATH_BYTES = 64 * 1024;

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
  spoolDir?: string;
  createEventSpool?: (options: EventSpoolOptions) => EventSpool;
  lifecycleClient?: LifecycleClient;
  createId?: (prefix: string) => string;
  decisionClient?: DecisionClient;
  monotonicNow?: () => number;
  maxOutcomeCorrelations?: number;
  /** Unit/compat seam for a future trusted host capability. Production does not self-attest it. */
  approvalLeaseRecheckAttested?: boolean;
};

const DEFAULT_ADMISSION_TIMEOUT_MS = 4_000;
const HOST_HOOK_TIMEOUT_MS = 5_000;
const DEFAULT_DECISION_TIMEOUT_MS = 2_000;
const EVENT_UPLOAD_PATH = "/api/v1/openclaw/native-guard/events/batch";
const EVENT_UPLOAD_TIMEOUT_MS = 5_000;
const MAX_EVENT_RESPONSE_BYTES = 64 * 1024;
const MAX_OUTCOME_CORRELATIONS = 10_000;
const MAX_GUARD_ELAPSED_MS = 24 * 60 * 60 * 1_000;

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
  readonly #emitEvent: AgentGuardRuntimeOptions["emitEvent"];
  readonly #spoolDir: string;
  readonly #createEventSpool: NonNullable<AgentGuardRuntimeOptions["createEventSpool"]>;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #lifecycleClient: LifecycleClient;
  readonly #createId: NonNullable<AgentGuardRuntimeOptions["createId"]>;
  readonly #approvalLeaseRecheckAttested: boolean;
  readonly #monotonicNow: NonNullable<AgentGuardRuntimeOptions["monotonicNow"]>;
  readonly #maxOutcomeCorrelations: number;
  readonly #pendingOperations = new Set<Promise<unknown>>();
  readonly #lifecycleWorkers = new Map<string, Promise<void>>();
  readonly #outcomeCorrelations = new Map<string, OutcomeCorrelation>();
  #eventSpool: EventSpool | undefined;
  #abortController = new AbortController();
  #startPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #registryStarted = false;
  #failed = false;
  #registrationAttestation: "pending" | "attested" | "unattested" = "pending";
  #state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";

  constructor(options: AgentGuardRuntimeOptions = {}) {
    const markerDirectory = options.markerDir ??
      join(homedir(), ".agent-guard", "native-guard-markers");
    const markerStore = options.markerStore ?? new FileMarkerStore(markerDirectory);
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
    if (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function") {
      throw new TypeError("Native guard monotonic clock is invalid");
    }
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#maxOutcomeCorrelations = positiveBoundedInteger(
      options.maxOutcomeCorrelations ?? MAX_OUTCOME_CORRELATIONS,
      MAX_OUTCOME_CORRELATIONS,
      "outcome correlation limit",
    );
    this.#emitEvent = options.emitEvent;
    this.#spoolDir = options.spoolDir ?? join(markerDirectory, "event-spool");
    this.#createEventSpool = options.createEventSpool ?? defaultCreateEventSpool;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#lifecycleClient = options.lifecycleClient ?? createLifecycleClient({
      fetch: options.fetch,
      timeoutMs: decisionTimeoutMs,
      now: this.#now,
      createId: () => this.#createId("evidence_proof"),
    });
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
      await this.#stopEventSpool(this.#eventSpool);
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
      if (current.state !== "off") {
        if (
          (isMainAgentScopedLookup(current) ||
            await this.#track(this.registry.hasAgentScopedCoverage("main"))) &&
          !canonicalSessionAgentMatch(sessionKey, context.agentId)
        ) return contextBlock();
        return guardedAdmission(current, event, context);
      }
      if (await this.#track(this.registry.hasAgentScopedCoverage("main"))) {
        const canonicalIdentity = canonicalSessionAgentMatch(sessionKey, context.agentId);
        if (!canonicalIdentity) return contextBlock();
        return canonicalIdentity.agentId === "main" ? contextBlock() : undefined;
      }
      if (!(await this.#track(this.registry.hasSessionScopedCoverage()))) return;
    } else if (await this.#track(this.registry.hasAgentScopedCoverage("main"))) {
      return contextBlock();
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
    if (parent.state !== "active") return guardedAdmission(parent, event, context);
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
    if (lookup.state === "identity_mismatch") return contextBlock();
    const identity = guardedIdentity(event, context);
    if (identity === undefined) return contextBlock();
    if (lookup.state === "recovery") return recoveryDecision(event, identity);
    if (lookup.state === "lifecycle_pending") return lifecyclePendingBlock();
    if (lookup.state === "root_ended") return rootEndedBlock();
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
      return this.#outageDecision(
        lookup,
        event,
        identity,
        "unknown",
        signal,
        context.abortSignal,
      );
    }
    const risk = classifyToolRisk({
      toolName: event.toolName,
      toolKind: identity.toolKind,
      toolInputKind: identity.toolInputKind,
      params: event.params,
      derivedPaths: request.derivedPaths,
    });

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
      return this.#outageDecision(
        lookup,
        event,
        identity,
        risk,
        signal,
        context.abortSignal,
      );
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
        if (!this.#rememberOutcomeCorrelation(identity, lookup, {
          requestId: request.requestId,
          decisionId: response.decisionId,
          action: response.action,
          runId: request.runId,
          admittedParamsDigest: request.paramsDigest,
        })) return evidenceCapacityBlock();
        return;
      case "deny":
        return policyBlock(response, lookup, event.params);
      case "redact":
        if (!this.#rememberOutcomeCorrelation(identity, lookup, {
          requestId: request.requestId,
          decisionId: response.decisionId,
          action: response.action,
          runId: request.runId,
          admittedParamsDigest: response.rewrittenParamsDigest,
        })) return evidenceCapacityBlock();
        return { params: response.rewrittenParams! };
      case "ask":
        if (!this.#approvalLeaseRecheckAttested) return approvalUnattestedBlock();
        if (!this.#rememberOutcomeCorrelation(identity, lookup, {
          requestId: request.requestId,
          decisionId: response.decisionId,
          action: response.action,
          runId: request.runId,
          admittedParamsDigest: request.paramsDigest,
        })) return evidenceCapacityBlock();
        return this.#approvalResult(lookup, request, response, signal, context.abortSignal);
    }
  }

  async #outageDecision(
    lease: ActiveLeaseLookup,
    event: ToolEvent,
    identity: GuardedIdentity,
    risk: NativeToolRisk,
    signal: AbortSignal,
    hostSignal: AbortSignal | undefined,
  ): Promise<BeforeResult | void> {
    if (hostSignal?.aborted) return cancelledBlock();
    const action = risk === "low"
      ? lease.failurePolicy.lowRisk === "allow" ? "allow" : "warn"
      : "deny";
    const paramsDigest = safeFinalParamsDigest(event.params);
    if (paramsDigest !== undefined && action !== "allow") {
      await this.#emit(outageEvent(
        this.#createId("native_guard_event"),
        lease,
        identity,
        event.toolName,
        paramsDigest,
        action,
        this.#now(),
      ));
    }
    if (hostSignal?.aborted) return cancelledBlock();
    if (signal.aborted || this.abortSignal.aborted) return stoppedBlock();
    if (!(await this.#leaseIsCurrent(identity.sessionKey, lease))) return leaseChangedBlock();
    if (action === "deny") return outageBlock();
    if (
      paramsDigest === undefined ||
      !this.#rememberOutcomeCorrelation(identity, lease, {
        action,
        runId: identity.runId,
        admittedParamsDigest: paramsDigest,
      })
    ) return evidenceCapacityBlock();
    return;
  }

  async #approvalResult(
    lease: ActiveLeaseLookup,
    request: NativeToolDecisionRequest,
    response: NativeToolDecisionResponse,
    signal: AbortSignal,
    hostSignal: AbortSignal | undefined,
  ): Promise<BeforeResult> {
    const forgetCorrelation = (): void => {
      this.#outcomeCorrelations.delete(outcomeCorrelationKey(
        request.sessionKey,
        request.toolCallId,
      ));
    };
    try {
      await this.#emit(approvalRequestedEvent(
        this.#createId("native_guard_event"),
        lease,
        request,
        response,
        this.#now(),
      ));
    } catch (error) {
      forgetCorrelation();
      throw error;
    }
    if (hostSignal?.aborted) {
      forgetCorrelation();
      return cancelledBlock();
    }
    if (signal.aborted || !(await this.#leaseIsCurrent(request.sessionKey, lease))) {
      forgetCorrelation();
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
      if (resolution !== "allow-once") {
        this.#outcomeCorrelations.delete(outcomeCorrelationKey(
          request.sessionKey,
          request.toolCallId,
        ));
      }
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

  async #activeLeaseIsCurrent(expected: ActiveLeaseLookup): Promise<boolean> {
    try {
      const current = await this.#track(this.registry.lookupActiveLease(expected.leaseId));
      return current !== undefined &&
        current.leaseId === expected.leaseId &&
        current.leaseEpoch === expected.leaseEpoch &&
        current.policyPackId === expected.policyPackId &&
        current.policyPackDigest === expected.policyPackDigest;
    } catch {
      return false;
    }
  }

  afterToolCall(event: AfterToolEvent, context: ToolContext): void {
    if (this.#state !== "running" || this.abortSignal.aborted) return;
    const operation = this.#track(this.#reportOutcome(event, context));
    void operation.catch(() => undefined);
  }

  async #reportOutcome(event: AfterToolEvent, context: ToolContext): Promise<void> {
    if (this.abortSignal.aborted || !safeSessionKey(context.sessionKey)) return;
    const identity = guardedIdentity(event, context);
    if (identity === undefined) return;
    const correlationKey = outcomeCorrelationKey(identity.sessionKey, identity.toolCallId);
    const correlation = this.#outcomeCorrelations.get(correlationKey);
    this.#outcomeCorrelations.delete(correlationKey);

    let lookup: ActiveLeaseLookup | undefined;
    let currentLease: ActiveLeaseLookup | undefined;
    if (correlation === undefined) {
      const current = await this.lookup(context.sessionKey);
      if (current.state !== "active" || this.abortSignal.aborted) return;
      lookup = current;
      currentLease = current;
    } else {
      try {
        currentLease = await this.#track(this.registry.lookupActiveLease(correlation.leaseId));
      } catch {
        currentLease = undefined;
      }
    }

    const duration = outcomeDuration(
      event.durationMs,
      correlation?.startedAtMonotonicMs,
      this.#monotonicNow,
    );
    if (duration === undefined) return;

    let finalParamsDigest: string;
    try {
      finalParamsDigest = inspectBoundedParams(event.params).digest;
    } catch {
      return;
    }
    const exactSecrets = correlation === undefined
      ? [lookup!.credential, lookup!.evidenceCredential]
      : [
          correlation.credential,
          correlation.evidenceCredential,
          ...(currentLease === undefined
            ? []
            : [currentLease.credential, currentLease.evidenceCredential]),
        ];
    const evidence = sanitizeOutcomeResult(event.result, exactSecrets);
    const leaseId = correlation?.leaseId ?? lookup!.leaseId;
    const leaseEpoch = correlation?.leaseEpoch ?? lookup!.leaseEpoch;
    const sessionKey = correlation?.sessionKey ?? identity.sessionKey;
    const runId = correlation?.runId ?? identity.runId;
    const outcome: NativeGuardEvent = {
      schemaVersion: "native-guard-1",
      eventId: this.#createId("native_guard_event"),
      type: "tool_outcome",
      leaseId,
      leaseEpoch,
      sessionKey,
      ...(runId === undefined ? {} : { runId }),
      toolCallId: identity.toolCallId,
      ...(correlation?.decisionId === undefined ? {} : { decisionId: correlation.decisionId }),
      timestamp: this.#now().toISOString(),
      detail: {
        ...(correlation?.requestId === undefined ? {} : { requestId: correlation.requestId }),
        ...(correlation?.action === undefined ? {} : { action: correlation.action }),
        success: event.error === undefined,
        ...(duration.durationMs === undefined ? {} : { durationMs: duration.durationMs }),
        durationSource: duration.durationSource,
        finalParamsDigest,
        resultDigest: evidence.resultDigest,
        resultPreview: evidence.resultPreview,
        ...(event.error === undefined
          ? {}
          : {
              error: sanitizeOutcomeDiagnostic(event.error, exactSecrets),
              errorCode: "TOOL_EXECUTION_FAILED",
            }),
      },
    };
    if (
      this.abortSignal.aborted ||
      (correlation === undefined && !(await this.#leaseIsCurrent(identity.sessionKey, lookup!)))
    ) return;
    await this.#emit(outcome);
  }

  #rememberOutcomeCorrelation(
    identity: GuardedIdentity,
    lease: ActiveLeaseLookup,
    detail: {
      requestId?: string;
      decisionId?: string;
      action: NativeGuardAction;
      runId?: string;
      admittedParamsDigest: string | undefined;
    },
  ): boolean {
    const key = outcomeCorrelationKey(identity.sessionKey, identity.toolCallId);
    if (
      this.#outcomeCorrelations.has(key) ||
      this.#outcomeCorrelations.size >= this.#maxOutcomeCorrelations
    ) return false;
    this.#outcomeCorrelations.set(key, {
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      ...(detail.requestId === undefined ? {} : { requestId: detail.requestId }),
      ...(detail.decisionId === undefined ? {} : { decisionId: detail.decisionId }),
      action: detail.action,
      sessionKey: identity.sessionKey,
      ...(detail.runId === undefined ? {} : { runId: detail.runId }),
      admittedParamsDigest: detail.admittedParamsDigest,
      credential: lease.credential,
      evidenceCredential: lease.evidenceCredential,
      startedAtMonotonicMs: readMonotonic(this.#monotonicNow),
    });
    return true;
  }

  async #emit(event: NativeGuardEvent): Promise<void> {
    if (this.#emitEvent !== undefined) {
      await this.#track(Promise.resolve().then(() => this.#emitEvent?.(event)));
      return;
    }
    const spool = this.#ensureEventSpool();
    await this.#track(spool.enqueue(event));
  }

  async #uploadEvents(
    identity: EventUploadLease,
    events: readonly NativeGuardEvent[],
    signal: AbortSignal,
  ): Promise<void> {
    const lookup = await this.#track(this.registry.lookupEvidenceLease(identity.leaseId));
    if (!sameActiveUploadLease(lookup, identity)) {
      this.#eventSpool?.cancelLease(identity.leaseId, identity.leaseEpoch);
      throw new Error("Native guard event lease is no longer active");
    }
    await uploadEventBatch(
      this.#fetch,
      lookup,
      events,
      signal,
      this.#now,
      () => this.#createId("evidence_proof"),
    );
    const current = await this.#track(this.registry.lookupEvidenceLease(identity.leaseId));
    if (!sameActiveUploadLease(current, identity)) {
      this.#eventSpool?.cancelLease(identity.leaseId, identity.leaseEpoch);
      throw new Error("Native guard event lease changed during upload");
    }
  }

  async activate(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
    this.#assertRunning();
    const spoolWasAbsent = this.#eventSpool === undefined;
    const spool = this.#emitEvent === undefined ? this.#ensureEventSpool() : undefined;
    try {
      if (spool !== undefined) await this.#track(spool.acquire());
      await this.#track(this.registry.activate(input));
    } catch (error) {
      if (spoolWasAbsent && spool !== undefined) {
        let stopped = false;
        try {
          await spool.stop();
          stopped = true;
        } catch {
          // Keep the spool reference when release is incomplete so a later
          // runtime stop can retry the private owner quarantine.
        }
        if (stopped && this.#eventSpool === spool) this.#eventSpool = undefined;
      }
      throw error;
    }
    const active = await this.#track(this.registry.lookupActiveLease(input.leaseId));
    if (active !== undefined) await this.#resumeLifecycle(active);
    return this.status();
  }

  #ensureEventSpool(): EventSpool {
    return this.#eventSpool ??= this.#createEventSpool({
      directory: this.#spoolDir,
      upload: (identity, events, signal) => this.#uploadEvents(identity, events, signal),
      scheduleTimeout: this.#scheduleTimeout,
      cancelTimeout: this.#cancelTimeout,
    });
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    this.#assertRegistrationAttested();
    this.#assertRunning();
    await this.#track(this.registry.renew(input));
    const active = await this.#track(this.registry.lookupActiveLease(input.leaseId));
    if (active !== undefined) await this.#resumeLifecycle(active);
    this.#eventSpool?.leaseRenewed(input.leaseId);
    return this.status();
  }

  async revoke(leaseId: string): Promise<boolean> {
    this.#assertRunning();
    const revoked = await this.#track(this.registry.revoke(leaseId));
    this.#eventSpool?.cancelLease(leaseId);
    for (const [key, value] of this.#outcomeCorrelations) {
      if (value.leaseId === leaseId) this.#outcomeCorrelations.delete(key);
    }
    return revoked;
  }

  async bindChild(
    leaseId: string,
    parentSessionKey: string,
    childSessionKey: string,
  ): Promise<boolean> {
    this.#assertRunning();
    const prepared = await this.#track(
      this.registry.prepareChildBinding(leaseId, parentSessionKey, childSessionKey),
    );
    if (!prepared) return false;
    await this.#drainLifecycle(leaseId);
    return true;
  }

  async endSession(sessionKey: string): Promise<boolean> {
    this.#assertRunning();
    const current = await this.lookup(sessionKey);
    if (current.state === "off" || current.state === "identity_mismatch") return false;
    if (current.state === "root_ended") return false;
    if (current.state === "recovery") return this.#track(this.registry.endSession(sessionKey));
    const lease = await this.#track(this.registry.lookupActiveLease(current.leaseId));
    if (lease === undefined) throw new Error("Native guard lifecycle lease is unavailable");
    const intent = await this.#track(this.registry.prepareSessionEnd(sessionKey));
    if (intent === undefined || intent.kind !== "end_session") return false;
    await this.#drainLifecycle(lease.leaseId);
    return true;
  }

  async #resumeLifecycle(lease: ActiveLeaseLookup): Promise<void> {
    if ((await this.#track(this.registry.pendingLifecycle(lease.leaseId))) === undefined) return;
    await this.#drainLifecycle(lease.leaseId);
  }

  async #drainLifecycle(leaseId: string): Promise<void> {
    while (true) {
      let worker = this.#lifecycleWorkers.get(leaseId);
      if (worker === undefined) {
        worker = this.#runLifecycleWorker(leaseId);
        this.#lifecycleWorkers.set(leaseId, worker);
        void worker.finally(() => {
          if (this.#lifecycleWorkers.get(leaseId) === worker) {
            this.#lifecycleWorkers.delete(leaseId);
          }
        }).catch(() => undefined);
      }
      await this.#track(worker);
      if ((await this.#track(this.registry.pendingLifecycle(leaseId))) === undefined) return;
    }
  }

  async #runLifecycleWorker(leaseId: string): Promise<void> {
    while (!this.abortSignal.aborted) {
      const intent = await this.#track(this.registry.pendingLifecycle(leaseId));
      if (intent === undefined) return;
      const lease = await this.#track(this.registry.lookupActiveLease(leaseId));
      if (lease === undefined) throw new Error("Native guard lifecycle lease is unavailable");
      let durableIntent = intent;
      if (durableIntent.evidenceRequest === undefined) {
        const path = durableIntent.kind === "bind_child"
          ? "/api/v1/openclaw/native-guard/lifecycle/bind-child"
          : "/api/v1/openclaw/native-guard/lifecycle/end-session";
        const body = durableIntent.kind === "bind_child"
          ? {
              leaseId,
              leaseEpoch: lease.leaseEpoch,
              parentSessionKey: durableIntent.parentSessionKey,
              childSessionKey: durableIntent.childSessionKey,
            }
          : {
              leaseId,
              leaseEpoch: lease.leaseEpoch,
              sessionKey: durableIntent.sessionKey,
            };
        const proof = createLifecycleEvidenceProof(
          lease,
          path,
          body,
          this.#now(),
          this.#createId("evidence_proof"),
        );
        durableIntent = await this.#track(this.registry.attachLifecycleEvidenceRequest(
          leaseId,
          durableIntent,
          proof,
        ));
      }
      if (durableIntent.kind === "bind_child") {
        await this.#track(this.#lifecycleClient.bindChild(lease, {
          leaseId,
          leaseEpoch: lease.leaseEpoch,
          parentSessionKey: durableIntent.parentSessionKey,
          childSessionKey: durableIntent.childSessionKey,
        }, this.abortSignal, durableIntent.evidenceRequest));
        if (!(await this.#activeLeaseIsCurrent(lease))) {
          throw new Error("Native guard lifecycle lease changed during binding");
        }
        if (!(await this.#track(this.registry.completeChildBinding(
          leaseId,
          durableIntent.parentSessionKey,
          durableIntent.childSessionKey,
        )))) throw new Error("Native guard lifecycle binding commit failed");
        continue;
      }
      await this.#track(this.#lifecycleClient.endSession(lease, {
        leaseId,
        leaseEpoch: lease.leaseEpoch,
        sessionKey: durableIntent.sessionKey,
      }, this.abortSignal, durableIntent.evidenceRequest));
      if (!(await this.#track(this.registry.completeSessionEnd(
        leaseId,
        durableIntent.sessionKey,
      )))) throw new Error("Native guard lifecycle end commit failed");
    }
    throw new Error("Native guard lifecycle synchronization was aborted");
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") {
      if (this.#stopPromise !== undefined) await this.#stopPromise;
      await this.#stopEventSpool(this.#eventSpool);
      return;
    }
    if (this.#state === "idle") {
      this.#abortController.abort();
      await this.#stopEventSpool(this.#eventSpool);
      this.#outcomeCorrelations.clear();
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
    this.#outcomeCorrelations.clear();
    const stopping = this.#finishStop(this.#eventSpool);
    this.#stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.#stopPromise === stopping) this.#stopPromise = undefined;
    }
  }

  async #finishStop(spool: EventSpool | undefined): Promise<void> {
    const pending = [...this.#pendingOperations];
    let timer: unknown;
    const flushed = pending.length === 0
      ? Promise.resolve("flushed" as const)
      : Promise.allSettled(pending).then(() => "flushed" as const);
    const timedOut = new Promise<"timed-out">((resolve) => {
      timer = this.#scheduleTimeout(() => resolve("timed-out"), 4_000);
    });
    let spoolFailed = false;
    let spoolError: unknown;
    try {
      await this.#stopEventSpool(spool);
    } catch (error) {
      spoolFailed = true;
      spoolError = error;
    }
    if (pending.length > 0) {
      const result = await Promise.race([flushed, timedOut]);
      if (result === "flushed" && timer !== undefined) this.#cancelTimeout(timer);
    } else if (timer !== undefined) {
      this.#cancelTimeout(timer);
    }
    this.#markerStore.preventWrites();
    this.#state = "stopped";
    if (spoolFailed) throw spoolError;
  }

  async #stopEventSpool(spool: EventSpool | undefined): Promise<void> {
    if (spool === undefined) return;
    await spool.stop();
    if (this.#eventSpool === spool) this.#eventSpool = undefined;
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

function positiveBoundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`Native guard ${label} is invalid`);
  }
  return value;
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

function canonicalSessionAgentMatch(
  sessionKey: unknown,
  agentId: unknown,
): ReturnType<typeof parseCanonicalOpenClawSessionKey> {
  if (typeof sessionKey !== "string" || typeof agentId !== "string") return undefined;
  const parsed = parseCanonicalOpenClawSessionKey(sessionKey);
  return parsed?.agentId === agentId ? parsed : undefined;
}

function isMainAgentScopedLookup(
  lookup: Exclude<LeaseLookup, { state: "off" }>,
): boolean {
  return "scope" in lookup &&
    typeof lookup.scope === "object" &&
    lookup.scope !== null &&
    lookup.scope.kind === "agent" &&
    lookup.scope.agentId === "main";
}

type GuardedIdentity = {
  sessionKey: string;
  toolCallId: string;
  runId?: string;
  toolKind?: ToolEvent["toolKind"];
  toolInputKind?: ToolEvent["toolInputKind"];
};

type OutcomeCorrelation = {
  leaseId: string;
  leaseEpoch: number;
  requestId?: string;
  decisionId?: string;
  action: NativeGuardAction;
  sessionKey: string;
  runId?: string;
  credential: string;
  evidenceCredential: string;
  admittedParamsDigest?: string;
  startedAtMonotonicMs?: number;
};

type OutcomeDuration = {
  durationMs?: number;
  durationSource: "host" | "guard_elapsed" | "unavailable";
};

function outcomeDuration(
  hostDurationMs: number | undefined,
  startedAtMonotonicMs: number | undefined,
  monotonicNow: () => number,
): OutcomeDuration | undefined {
  if (hostDurationMs !== undefined) {
    return Number.isFinite(hostDurationMs) && hostDurationMs >= 0
      ? { durationMs: hostDurationMs, durationSource: "host" }
      : undefined;
  }
  if (startedAtMonotonicMs === undefined) return { durationSource: "unavailable" };
  const completedAt = readMonotonic(monotonicNow);
  if (completedAt === undefined) return { durationSource: "unavailable" };
  return {
    durationMs: Math.min(MAX_GUARD_ELAPSED_MS, Math.max(0, completedAt - startedAtMonotonicMs)),
    durationSource: "guard_elapsed",
  };
}

function readMonotonic(monotonicNow: () => number): number | undefined {
  try {
    const value = monotonicNow();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function outcomeCorrelationKey(sessionKey: string, toolCallId: string): string {
  return `${sessionKey}\0${toolCallId}`;
}

function guardedAdmission(
  lookup: Exclude<LeaseLookup, { state: "off" }>,
  event: ToolEvent,
  context: ToolContext,
): BeforeResult | void {
  const identity = guardedIdentity(event, context);
  if (identity === undefined) return contextBlock();
  if (lookup.state === "identity_mismatch") return contextBlock();
  if (lookup.state === "lifecycle_pending") return lifecyclePendingBlock();
  if (lookup.state === "recovery") return recoveryDecision(event, identity);
  if (lookup.state === "root_ended") return rootEndedBlock();
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
    ...((event.toolKind ?? context.toolKind) === undefined
      ? {}
      : { toolKind: event.toolKind ?? context.toolKind }),
    ...((event.toolInputKind ?? context.toolInputKind) === undefined
      ? {}
      : { toolInputKind: event.toolInputKind ?? context.toolInputKind }),
  };
}

function recoveryDecision(event: ToolEvent, identity: GuardedIdentity): BeforeResult | void {
  return classifyToolRisk({
    toolName: event.toolName,
    toolKind: identity.toolKind,
    toolInputKind: identity.toolInputKind,
    params: event.params,
    derivedPaths: event.derivedPaths,
  }) === "low" ? undefined : recoveryBlock();
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
  const derivedPaths = snapshotDerivedPaths(event.derivedPaths);
  return {
    schemaVersion: "native-guard-1",
    requestId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    sessionKey: identity.sessionKey,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    toolCallId: identity.toolCallId,
    toolName: event.toolName,
    ...(identity.toolKind === undefined ? {} : { toolKind: identity.toolKind }),
    ...(identity.toolInputKind === undefined ? {} : { toolInputKind: identity.toolInputKind }),
    params: event.params,
    paramsDigest: inspectedParams.digest,
    ...(derivedPaths === undefined ? {} : { derivedPaths }),
    requestedAt: requestedAt.toISOString(),
  };
}

function safeFinalParamsDigest(params: Record<string, unknown>): string | undefined {
  try {
    return inspectBoundedParams(params).digest;
  } catch {
    return undefined;
  }
}

function snapshotDerivedPaths(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    utilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_DERIVED_PATHS
  ) {
    throw new TypeError("Native guard derived paths are invalid");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError("Native guard derived paths are invalid");
  }
  const snapshot: string[] = [];
  let canonicalBytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true ||
      !safeWireString(descriptor.value, MAX_DERIVED_PATH_LENGTH)
    ) {
      throw new TypeError("Native guard derived paths are invalid");
    }
    const pathBytes = Buffer.byteLength(canonicalJson(descriptor.value), "utf8");
    const separatorBytes = index === 0 ? 0 : 1;
    if (pathBytes + separatorBytes > MAX_DERIVED_PATH_BYTES - canonicalBytes) {
      throw new TypeError("Native guard derived paths are invalid");
    }
    canonicalBytes += pathBytes + separatorBytes;
    snapshot.push(descriptor.value);
  }
  return snapshot;
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
    leaseEpoch: lease.leaseEpoch,
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
      targetType: "tool_call",
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
  paramsDigest: string,
  action: "warn" | "deny",
  timestamp: Date,
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId,
    type: "decision",
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    sessionKey: identity.sessionKey,
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    toolCallId: identity.toolCallId,
    decisionId: eventId,
    timestamp: timestamp.toISOString(),
    detail: {
      requestId: eventId,
      action,
      reasonCode: "NATIVE_GUARD_PDP_UNAVAILABLE",
      targetType: "tool_call",
      toolName,
      paramsDigest,
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
    leaseEpoch: lease.leaseEpoch,
    sessionKey: request.sessionKey,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    toolCallId: request.toolCallId,
    decisionId: response.decisionId,
    timestamp: timestamp.toISOString(),
    detail: {
      requestId: request.requestId,
      approvalId: response.decisionId,
      action: "ask",
      status: "requested",
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
    leaseEpoch: lease.leaseEpoch,
    sessionKey: request.sessionKey,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    toolCallId: request.toolCallId,
    decisionId: response.decisionId,
    timestamp: timestamp.toISOString(),
    detail: {
      requestId: request.requestId,
      approvalId: response.decisionId,
      action: "ask",
      status: resolution,
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

function lifecyclePendingBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_LIFECYCLE_PENDING] Native guard lifecycle synchronization is pending.",
  };
}

function rootEndedBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_ROOT_ENDED] Native guard root session has ended.",
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

function evidenceCapacityBlock(): BeforeResult {
  return {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_EVIDENCE_CAPACITY] Native guard outcome correlation capacity is exhausted.",
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

function sameActiveUploadLease(
  lookup: ActiveLeaseLookup | RootEndedEvidenceLookup | undefined,
  expected: EventUploadLease,
): lookup is ActiveLeaseLookup | RootEndedEvidenceLookup {
  return (lookup?.state === "active" || lookup?.state === "root_ended") &&
    lookup.leaseId === expected.leaseId &&
    lookup.leaseEpoch >= expected.leaseEpoch;
}

async function uploadEventBatch(
  fetchImplementation: typeof globalThis.fetch | undefined,
  lease: ActiveLeaseLookup | RootEndedEvidenceLookup,
  events: readonly NativeGuardEvent[],
  parentSignal: AbortSignal,
  now: () => Date,
  createId: () => string,
): Promise<void> {
  if (typeof fetchImplementation !== "function" || events.length === 0 || events.length > 100) {
    throw new Error("Native guard event upload is unavailable");
  }
  const url = new URL(lease.backendUrl);
  url.pathname = EVENT_UPLOAD_PATH;
  url.search = "";
  url.hash = "";
  const payload = { events };
  const body = canonicalJson(payload);
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
    throw new Error("Native guard event upload is oversized");
  }
  const proof = createEventEvidenceProof(lease, payload, now(), createId());
  const encodedProof = Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
  if (encodedProof.length > 4_096) throw new Error("Native guard event upload is unavailable");

  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  const timeout = setTimeout(() => controller.abort(), EVENT_UPLOAD_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetchImplementation(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${lease.evidenceCredential}`,
        "Content-Type": "application/json; charset=utf-8",
        "X-Agent-Guard-Evidence-Proof": encodedProof,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (
      controller.signal.aborted ||
      response.redirected ||
      response.status !== 200 ||
      !validEventResponseContentType(response.headers.get("content-type")) ||
      response.headers.has("content-encoding")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Native guard event upload failed");
    }
    const declaredLength = parseEventContentLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_EVENT_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Native guard event upload response is oversized");
    }
    const responseBody = await readBoundedEventResponse(
      response,
      controller.signal,
      MAX_EVENT_RESPONSE_BYTES,
      declaredLength,
    );
    const envelope = JSON.parse(responseBody) as unknown;
    if (!validUploadEnvelope(envelope, events, lease, proof, now())) {
      throw new Error("Native guard event upload response is invalid");
    }
  } finally {
    clearTimeout(timeout);
    unlink();
  }
}

async function readBoundedEventResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  declaredLength: number | undefined,
): Promise<string> {
  if (response.body === null) throw new Error("Native guard event upload response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("Native guard event upload was aborted");
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes || (declaredLength !== undefined && size > declaredLength)) {
        throw new Error("Native guard event upload response is oversized");
      }
      chunks.push(chunk.value);
    }
    if (declaredLength !== undefined && size !== declaredLength) {
      throw new Error("Native guard event upload response is incomplete");
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function createEventEvidenceProof(
  lease: ActiveLeaseLookup | RootEndedEvidenceLookup,
  payload: { events: readonly NativeGuardEvent[] },
  now: Date,
  proofId: string,
): NativeGuardEvidenceProof {
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proofId)
  ) throw new Error("Native guard event upload is unavailable");
  const unsigned = {
    schemaVersion: "native-guard-1" as const,
    signatureContext: "native_guard.evidence_request.v1" as const,
    proofId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    method: "POST" as const,
    path: EVENT_UPLOAD_PATH,
    bodyDigest: digestJson(payload),
    issuedAt: now.toISOString(),
    keyId: lease.evidenceSigningKeyId,
  };
  return {
    ...unsigned,
    signature: signNativeGuardPayload(
      unsigned,
      createPrivateKey(lease.evidenceSigningPrivateKey),
    ),
  };
}

function validUploadEnvelope(
  value: unknown,
  events: readonly NativeGuardEvent[],
  lease: ActiveLeaseLookup | RootEndedEvidenceLookup,
  proof: NativeGuardEvidenceProof,
  now: Date,
): boolean {
  if (!plainRuntimeRecord(value) || !exactRuntimeKeys(value, ["data", "ok", "requestId"])) {
    return false;
  }
  if (value.ok !== true || typeof value.requestId !== "string" || !plainRuntimeRecord(value.data)) {
    return false;
  }
  const acknowledgement = value.data;
  if (!exactRuntimeKeys(acknowledgement, [
    "accepted",
    "ackId",
    "ackType",
    "acknowledgedAt",
    "bodyDigest",
    "eventIdsDigest",
    "leaseEpoch",
    "leaseId",
    "proofId",
    "schemaVersion",
    "signature",
    "signatureContext",
  ])) return false;
  if (
    acknowledgement.schemaVersion !== "native-guard-1" ||
    acknowledgement.signatureContext !== "native_guard.evidence_ack.v1" ||
    typeof acknowledgement.ackId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(acknowledgement.ackId) ||
    acknowledgement.ackType !== "events_accepted" ||
    acknowledgement.proofId !== proof.proofId ||
    acknowledgement.leaseId !== lease.leaseId ||
    acknowledgement.leaseEpoch !== lease.leaseEpoch ||
    acknowledgement.bodyDigest !== proof.bodyDigest ||
    acknowledgement.accepted !== events.length ||
    acknowledgement.eventIdsDigest !== digestJson(events.map(({ eventId }) => eventId)) ||
    typeof acknowledgement.acknowledgedAt !== "string" ||
    !canonicalRuntimeTimestamp(acknowledgement.acknowledgedAt) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    Math.abs(now.getTime() - Date.parse(acknowledgement.acknowledgedAt)) > 30_000 ||
    typeof acknowledgement.signature !== "string"
  ) return false;
  const { signature, ...unsigned } = acknowledgement;
  try {
    return verifyNativeGuardPayload(
      unsigned,
      signature,
      createPublicKey(lease.decisionPublicKey),
    );
  } catch {
    return false;
  }
}

function plainRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !utilTypes.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactRuntimeKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function canonicalRuntimeTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validEventResponseContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

function parseEventContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Native guard event content length is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Native guard event content length is invalid");
  return parsed;
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
