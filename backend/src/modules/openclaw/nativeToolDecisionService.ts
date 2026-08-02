import type {
  GatewayRuntimeContext,
  JsonObject,
  NativeGuardAction,
  NativeGuardEvent,
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
  RuntimeActionPayload,
  RuntimeSupervisionRecord,
  SupervisionAction,
  SupervisionPolicy,
  SupervisionPolicyPack,
  SupervisionTargetType,
  ToolCapabilityProfile,
  ToolProviderType,
  ToolSideEffect,
} from "@agent-guard/contracts";
import {
  digestJson,
  inspectBoundedParams,
} from "@agent-guard/native-guard-protocol";
import { createId as defaultCreateId } from "../../shared/ids";
import { findMatchingPolicies } from "../supervisor/policyEngine";
import { recordSupervisionDecision } from "../supervisor/supervisionRecorder";
import type { SupervisionRuntimeAction } from "../supervisor/supervisorTypes";
import type { NativeGuardLeaseService } from "./nativeGuardLeaseService";

const DEFAULT_MAX_SKEW_MS = 30_000;
const DEFAULT_MAX_REQUESTS_PER_LEASE = 1_000;
const DEFAULT_MAX_PENDING_DECISIONS = 1_000;
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;
const DANGEROUS_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const CODE_EXECUTION_NAMES = new Set([
  "exec",
  "process",
  "shell",
  "bash",
  "run_command",
  "powershell",
  "cmd",
  "execute_command",
  "execute_code",
  "code_execution",
  "code_mode_exec",
]);
const FILE_WRITE_NAMES = new Set([
  "write",
  "edit",
  "write_file",
  "edit_file",
  "apply_patch",
  "create_file",
  "patch",
  "file_write",
]);
const API_CALL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "http_request",
  "fetch",
  "curl",
  "browser",
  "browser_navigate",
  "network",
  "call_api",
  "send_request",
  "api_call",
]);

type EventAppender = {
  append(
    event: NativeGuardEvent,
    record?: RuntimeSupervisionRecord,
  ): Promise<boolean>;
};

type CachedDecision = {
  requestDigest: string;
  toolCallId: string;
  result: {
    response: NativeToolDecisionResponse;
    record: RuntimeSupervisionRecord;
  };
};

type LeaseCache = {
  leaseId: string;
  leaseEpoch: number;
  expiresAtMs: number;
  requests: Map<string, CachedDecision>;
  toolCalls: Map<string, string>;
};

type LeaseTombstones = {
  expiresAtMs: number;
  requestIds: Set<string>;
  toolCallIds: Set<string>;
};

type PendingDecision = {
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
  expiresAtMs: number;
  estimatedBytes: number;
  requestId: string;
  toolCallId: string;
  requestDigest: string;
  event: NativeGuardEvent;
  result: {
    response: NativeToolDecisionResponse;
    record: RuntimeSupervisionRecord;
  };
  attempted: boolean;
};

type DecisionResult = {
  response: NativeToolDecisionResponse;
  record: RuntimeSupervisionRecord;
};

type ActiveLeaseSnapshot = NonNullable<
  ReturnType<NativeGuardLeaseService["authenticate"]>
>;

type InFlightDecision = {
  leaseEpoch: number;
  requestDigest: string;
  promise: Promise<DecisionResult>;
};

export type NativeToolDecisionService = {
  decide(
    request: NativeToolDecisionRequest,
    credential: string,
  ): Promise<{
    response: NativeToolDecisionResponse;
    record: RuntimeSupervisionRecord;
  }>;
};

export type NativeToolDecisionServiceOptions = {
  leaseService: NativeGuardLeaseService;
  eventStore: EventAppender;
  now?: () => string | Date;
  createId?: (prefix: string) => string;
  maxSkewMs?: number;
  maxRequestsPerLease?: number;
  maxPendingDecisions?: number;
  maxPendingBytes?: number;
  beforeSign?: (request: Readonly<NativeToolDecisionRequest>) => Promise<void>;
};

export type NormalizedNativeToolAction = {
  targetType: SupervisionTargetType;
  riskTags: string[];
  llmAssisted: false;
};

export class NativeToolDecisionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeToolDecisionError";
  }
}

export function normalizeNativeToolAction(metadata: {
  toolName?: string;
  toolKind?: string;
  toolInputKind?: string;
  providerId?: string;
}): NormalizedNativeToolAction {
  const values = [
    metadata.toolName,
    metadata.toolKind,
    metadata.toolInputKind,
  ]
    .filter((value): value is string => typeof value === "string")
    .map(canonicalOperationName);

  if (values.some((value) => CODE_EXECUTION_NAMES.has(value))) {
    return { targetType: "code_execution", riskTags: [], llmAssisted: false };
  }
  if (
    values.some((value) => FILE_WRITE_NAMES.has(value))
  ) {
    return { targetType: "file_write", riskTags: [], llmAssisted: false };
  }
  if (values.some((value) => API_CALL_NAMES.has(value))) {
    return { targetType: "api_call", riskTags: [], llmAssisted: false };
  }
  return {
    targetType: "tool_call",
    riskTags: ["unknown_side_effect"],
    llmAssisted: false,
  };
}

export function createNativeToolDecisionService(
  options: NativeToolDecisionServiceOptions,
): NativeToolDecisionService {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? defaultCreateId;
  const maxSkewMs = positiveInteger(
    options.maxSkewMs ?? DEFAULT_MAX_SKEW_MS,
    "maxSkewMs",
  );
  const maxRequestsPerLease = positiveInteger(
    options.maxRequestsPerLease ?? DEFAULT_MAX_REQUESTS_PER_LEASE,
    "maxRequestsPerLease",
  );
  const maxPendingDecisions = positiveInteger(
    options.maxPendingDecisions ?? DEFAULT_MAX_PENDING_DECISIONS,
    "maxPendingDecisions",
  );
  const maxPendingBytes = positiveInteger(
    options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
    "maxPendingBytes",
  );
  const caches = new Map<string, LeaseCache>();
  const tombstones = new Map<string, LeaseTombstones>();
  const pendingDecisions = new Map<string, PendingDecision>();
  const inFlightDecisions = new Map<string, InFlightDecision>();
  let pendingBytes = 0;

  function deletePending(pending: PendingDecision): void {
    const key = pendingKey(pending.leaseId, pending.requestId);
    if (pendingDecisions.get(key) !== pending) return;
    pendingDecisions.delete(key);
    pendingBytes = Math.max(0, pendingBytes - pending.estimatedBytes);
  }

  function cleanPendingDecisions(nowMs: number): void {
    for (const pending of pendingDecisions.values()) {
      if (pending.expiresAtMs <= nowMs) {
        deletePending(pending);
        continue;
      }
      const active = options.leaseService.resolveBySession(pending.sessionKey);
      if (
        !active ||
        active.leaseId !== pending.leaseId ||
        active.leaseEpoch !== pending.leaseEpoch
      ) {
        deletePending(pending);
      }
    }
  }

  async function persistPending(
    pending: PendingDecision,
    cacheKey: string,
    expiresAtMs: number,
    request: NativeToolDecisionRequest,
    credential: string,
    evaluatedLease: ActiveLeaseSnapshot,
  ): Promise<{
    response: NativeToolDecisionResponse;
    record: RuntimeSupervisionRecord;
  }> {
    const wasRetry = pending.attempted;
    pending.attempted = true;
    const appended = await options.eventStore.append(
      structuredClone(pending.event),
      structuredClone(pending.result.record),
    );
    try {
      assertLeaseUnchanged(
        options.leaseService,
        request,
        credential,
        evaluatedLease,
      );
      const signed = pending.result.response;
      if (
        signed.leaseId !== evaluatedLease.leaseId ||
        signed.leaseEpoch !== evaluatedLease.leaseEpoch ||
        signed.policyPackId !== evaluatedLease.policyPackId ||
        signed.policyPackDigest !== evaluatedLease.policyPackDigest
      ) {
        throw leaseChanged();
      }
    } catch (error) {
      deletePending(pending);
      throw error;
    }
    if (!appended && !wasRetry) {
      deletePending(pending);
      throw decisionError(
        "NATIVE_GUARD_EVENT_CONFLICT",
        "Native guard decision event could not be persisted uniquely",
      );
    }

    let cache = caches.get(cacheKey);
    cache ??= {
      leaseId: pending.leaseId,
      leaseEpoch: pending.leaseEpoch,
      expiresAtMs,
      requests: new Map(),
      toolCalls: new Map(),
    };
    caches.set(cacheKey, cache);
    cache.requests.set(pending.requestId, {
      requestDigest: pending.requestDigest,
      toolCallId: pending.toolCallId,
      result: structuredClone(pending.result),
    });
    cache.toolCalls.set(pending.toolCallId, pending.requestId);
    deletePending(pending);
    return structuredClone(pending.result);
  }

  async function executeDecision(
    request: NativeToolDecisionRequest,
    credential: string,
    decisionTime: { iso: string; timeMs: number },
    requestTimeMs: number,
    lease: ActiveLeaseSnapshot,
    requestDigest: string,
  ): Promise<DecisionResult> {
        cleanCaches(caches, decisionTime.timeMs, request.leaseId, request.leaseEpoch);
        const activeTombstones = tombstones.get(request.leaseId);
        if (activeTombstones) {
          activeTombstones.expiresAtMs = Date.parse(lease.expiresAt);
        }
        cleanTombstones(tombstones, decisionTime.timeMs);

        const cacheKey = leaseCacheKey(request.leaseId, request.leaseEpoch);
        const cache = caches.get(cacheKey);
        const prior = cache?.requests.get(request.requestId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) {
            throw decisionError(
              "NATIVE_GUARD_REPLAY_CONFLICT",
              "Native guard request identity conflicts with an earlier request",
            );
          }
          return structuredClone(prior.result);
        }
        const pendingId = pendingKey(request.leaseId, request.requestId);
        const pending = pendingDecisions.get(pendingId);
        if (pending) {
          if (
            pending.leaseEpoch !== request.leaseEpoch ||
            pending.requestDigest !== requestDigest
          ) {
            throw decisionError(
              "NATIVE_GUARD_REPLAY_CONFLICT",
              "Native guard request identity conflicts with a pending decision",
            );
          }
          return persistPending(
            pending,
            cacheKey,
            Date.parse(lease.expiresAt),
            request,
            credential,
            lease,
          );
        }
        if (cache?.toolCalls.has(request.toolCallId)) {
          throw decisionError(
            "NATIVE_GUARD_TOOL_CALL_REPLAY",
            "Native guard tool call was already submitted under another request",
          );
        }
        let leaseTombstones = tombstones.get(request.leaseId);
        if (leaseTombstones?.requestIds.has(request.requestId)) {
          throw decisionError(
            "NATIVE_GUARD_REPLAY_CONFLICT",
            "Native guard request id was already used during this lease",
          );
        }
        if (leaseTombstones?.toolCallIds.has(request.toolCallId)) {
          throw decisionError(
            "NATIVE_GUARD_TOOL_CALL_REPLAY",
            "Native guard tool call id was already used during this lease",
          );
        }
        if (Math.abs(decisionTime.timeMs - requestTimeMs) > maxSkewMs) {
          throw decisionError(
            "NATIVE_GUARD_REQUEST_TIME_INVALID",
            "Native guard request timestamp is outside the accepted window",
          );
        }
        if (
          leaseTombstones &&
          leaseTombstones.requestIds.size >= maxRequestsPerLease
        ) {
          throw decisionError(
            "NATIVE_GUARD_CACHE_LIMIT",
            "Native guard replay cache capacity was reached",
          );
        }

        const normalized = normalizeNativeToolAction(request);
        const gateway = buildGatewayContext(request, normalized);
        const runtimeAction: SupervisionRuntimeAction = {
          runtimeSessionId: request.sessionKey,
          agentId: lease.policyPack.agentId,
          targetType: normalized.targetType,
          targetId: request.toolCallId,
          payload: buildRuntimePayload(request, normalized.targetType),
          inputEventId: request.requestId,
          gateway,
        };
        const matching = findMatchingPolicies(lease.policyPack, runtimeAction);
        const selected = selectDecision(lease.policyPack.defaultAction, matching);
        const policy = selected.policy ?? defaultPolicy(
          lease.policyPack.policyPackId,
          normalized.targetType,
          selected.action,
          selected.reason,
        );
        const recordPolicy =
          policy.action === selected.action
            ? policy
            : { ...policy, action: selected.action };
        const record = recordSupervisionDecision(
          lease.policyPackId,
          recordPolicy,
          runtimeAction,
          { createId, now: () => decisionTime.iso },
        );

        let rewrittenParams: Record<string, unknown> | undefined;
        let rewrittenParamsDigest: string | undefined;
        if (selected.action === "redact") {
          rewrittenParams = redactParameters(
            request.params,
            normalized.targetType,
            matching,
            lease.policyPack,
            runtimeAction,
          );
          try {
            rewrittenParamsDigest = inspectBoundedParams(rewrittenParams).digest;
          } catch {
            throw invalidRequest("Native guard rewritten parameters exceed the allowed bounds");
          }
        }

        const unsigned: Omit<NativeToolDecisionResponse, "signature"> = {
          schemaVersion: "native-guard-1",
          decisionId: createId("native_guard_decision"),
          requestId: request.requestId,
          leaseId: request.leaseId,
          leaseEpoch: request.leaseEpoch,
          policyPackId: lease.policyPackId,
          policyPackDigest: lease.policyPackDigest,
          action: selected.action,
          reasonCode: selected.reasonCode,
          reason: selected.reason,
          evaluatedParamsDigest: request.paramsDigest,
          ...(rewrittenParams
            ? { rewrittenParams, rewrittenParamsDigest }
            : {}),
          decidedAt: decisionTime.iso,
        };

        leaseTombstones ??= {
          expiresAtMs: Date.parse(lease.expiresAt),
          requestIds: new Set(),
          toolCallIds: new Set(),
        };
        leaseTombstones.expiresAtMs = Date.parse(lease.expiresAt);
        leaseTombstones.requestIds.add(request.requestId);
        leaseTombstones.toolCallIds.add(request.toolCallId);
        tombstones.set(request.leaseId, leaseTombstones);

        await options.beforeSign?.(request);
        assertLeaseUnchanged(options.leaseService, request, credential, lease);
        let signature: string;
        try {
          signature = options.leaseService.signDecision(request.leaseId, unsigned);
        } catch {
          throw decisionError(
            "NATIVE_GUARD_LEASE_CHANGED",
            "Native guard lease changed before decision signing",
          );
        }
        const response: NativeToolDecisionResponse = { ...unsigned, signature };
        const event: NativeGuardEvent = {
          schemaVersion: "native-guard-1",
          eventId: createId("native_guard_event"),
          type: "decision",
          leaseId: request.leaseId,
          leaseEpoch: request.leaseEpoch,
          sessionKey: request.sessionKey,
          ...(request.runId ? { runId: request.runId } : {}),
          toolCallId: request.toolCallId,
          decisionId: response.decisionId,
          timestamp: decisionTime.iso,
          detail: {
            requestId: request.requestId,
            action: response.action,
            reasonCode: response.reasonCode,
            policyId: record.policyId,
            targetType: normalized.targetType,
            toolName: request.toolName,
            ...(request.toolKind ? { toolKind: request.toolKind } : {}),
            ...(request.toolInputKind
              ? { toolInputKind: request.toolInputKind }
              : {}),
            ...(request.providerId ? { providerId: request.providerId } : {}),
            riskTags: normalized.riskTags,
            paramsDigest: request.paramsDigest,
            ...(rewrittenParamsDigest ? { rewrittenParamsDigest } : {}),
          },
        };
        const result = { response, record };
        const expiresAtMs = Date.parse(lease.expiresAt);
        const estimatedBytes = Buffer.byteLength(
          JSON.stringify({ event, result }),
          "utf8",
        );
        if (
          pendingDecisions.size >= maxPendingDecisions ||
          estimatedBytes > maxPendingBytes ||
          pendingBytes + estimatedBytes > maxPendingBytes
        ) {
          throw decisionError(
            "NATIVE_GUARD_PENDING_LIMIT",
            "Native guard pending decision capacity was reached",
          );
        }
        const pendingDecision: PendingDecision = {
          leaseId: request.leaseId,
          leaseEpoch: request.leaseEpoch,
          sessionKey: request.sessionKey,
          expiresAtMs,
          estimatedBytes,
          requestId: request.requestId,
          toolCallId: request.toolCallId,
          requestDigest,
          event,
          result,
          attempted: false,
        };
        pendingDecisions.set(pendingId, pendingDecision);
        pendingBytes += estimatedBytes;
        return persistPending(
          pendingDecision,
          cacheKey,
          expiresAtMs,
          request,
          credential,
          lease,
        );
  }

  return {
    async decide(
      request: NativeToolDecisionRequest,
      credential: string,
    ): Promise<DecisionResult> {
      const decisionTime = readNow(now);
      cleanPendingDecisions(decisionTime.timeMs);
      const requestTimeMs = validateRequest(request);
      const lease = authenticateAndBind(options.leaseService, request, credential);
      let requestDigest: string;
      try {
        requestDigest = digestJson(request);
      } catch {
        throw invalidRequest("Native guard request identity is not canonical JSON");
      }

      const flightKey = pendingKey(request.leaseId, request.requestId);
      const existing = inFlightDecisions.get(flightKey);
      if (existing) {
        if (
          existing.leaseEpoch !== request.leaseEpoch ||
          existing.requestDigest !== requestDigest
        ) {
          throw decisionError(
            "NATIVE_GUARD_REPLAY_CONFLICT",
            "Native guard request identity conflicts with an active decision",
          );
        }
        return existing.promise;
      }

      let tracked!: Promise<DecisionResult>;
      tracked = executeDecision(
        request,
        credential,
        decisionTime,
        requestTimeMs,
        lease,
        requestDigest,
      ).finally(() => {
        if (inFlightDecisions.get(flightKey)?.promise === tracked) {
          inFlightDecisions.delete(flightKey);
        }
      });
      inFlightDecisions.set(flightKey, {
        leaseEpoch: request.leaseEpoch,
        requestDigest,
        promise: tracked,
      });
      return tracked;
    },
  };
}

function validateRequest(request: NativeToolDecisionRequest): number {
  if (request?.schemaVersion !== "native-guard-1") {
    throw invalidRequest("Native guard request schema is invalid");
  }
  for (const [label, value] of [
    ["requestId", request.requestId],
    ["leaseId", request.leaseId],
    ["sessionKey", request.sessionKey],
    ["toolCallId", request.toolCallId],
    ["toolName", request.toolName],
  ] as const) {
    assertRequiredString(value, label);
  }
  for (const [label, value] of [
    ["runId", request.runId],
    ["toolKind", request.toolKind],
    ["toolInputKind", request.toolInputKind],
    ["providerId", request.providerId],
  ] as const) {
    if (value !== undefined) assertRequiredString(value, label);
  }
  if (
    request.derivedPaths !== undefined &&
    (!Array.isArray(request.derivedPaths) ||
      request.derivedPaths.some(
        (derivedPath) =>
          typeof derivedPath !== "string" || derivedPath.trim().length === 0,
      ))
  ) {
    throw invalidRequest("Native guard derived paths are invalid");
  }
  if (!Number.isSafeInteger(request.leaseEpoch) || request.leaseEpoch <= 0) {
    throw invalidRequest("Native guard lease epoch is invalid");
  }
  let actualDigest: string;
  try {
    actualDigest = inspectBoundedParams(request.params).digest;
  } catch {
    throw invalidRequest("Native guard parameters exceed the allowed bounds");
  }
  if (actualDigest !== request.paramsDigest) {
    throw decisionError(
      "NATIVE_GUARD_PARAMS_DIGEST_MISMATCH",
      "Native guard parameter digest does not match",
    );
  }
  return canonicalIsoMs(request.requestedAt, "request timestamp");
}

function authenticateAndBind(
  leaseService: NativeGuardLeaseService,
  request: NativeToolDecisionRequest,
  credential: string,
) {
  if (typeof credential !== "string" || credential.length === 0) {
    throw authenticationFailed();
  }
  const lease = leaseService.authenticate(request.leaseId, credential);
  if (!lease) throw authenticationFailed();
  if (lease.leaseEpoch !== request.leaseEpoch) {
    throw decisionError(
      "NATIVE_GUARD_LEASE_EPOCH_MISMATCH",
      "Native guard lease epoch does not match",
    );
  }
  const sessionLease = leaseService.resolveBySession(request.sessionKey);
  if (
    !sessionLease ||
    sessionLease.leaseId !== lease.leaseId ||
    sessionLease.leaseEpoch !== lease.leaseEpoch
  ) {
    throw decisionError(
      "NATIVE_GUARD_SESSION_MISMATCH",
      "Native guard session is not bound to the authenticated lease",
    );
  }
  return lease;
}

function assertLeaseUnchanged(
  leaseService: NativeGuardLeaseService,
  request: NativeToolDecisionRequest,
  credential: string,
  evaluated: ReturnType<NativeGuardLeaseService["authenticate"]> & {},
): void {
  const current = leaseService.authenticate(request.leaseId, credential);
  const session = leaseService.resolveBySession(request.sessionKey);
  if (
    !current ||
    !session ||
    current.leaseId !== evaluated.leaseId ||
    current.leaseEpoch !== evaluated.leaseEpoch ||
    current.policyPackId !== evaluated.policyPackId ||
    current.policyPackDigest !== evaluated.policyPackDigest ||
    session.leaseId !== evaluated.leaseId ||
    session.leaseEpoch !== evaluated.leaseEpoch
  ) {
    throw decisionError(
      "NATIVE_GUARD_LEASE_CHANGED",
      "Native guard lease changed before decision signing",
    );
  }
}

function selectDecision(
  defaultAction: SupervisionAction,
  policies: SupervisionPolicy[],
): {
  action: NativeGuardAction;
  reasonCode: string;
  reason: string;
  policy?: SupervisionPolicy;
} {
  if (policies.length === 0) {
    const action = nativeAction(defaultAction);
    return {
      action,
      reasonCode:
        defaultAction === "isolate" ? "default_isolate_deny" : `default_${action}`,
      reason:
        defaultAction === "isolate"
          ? "The native guard default isolate action was conservatively denied."
          : `No native tool policy matched; applied default action ${action}.`,
    };
  }
  const policy = policies.reduce((highest, candidate) =>
    actionPriority(candidate.action) > actionPriority(highest.action)
      ? candidate
      : highest,
  );
  const action = nativeAction(policy.action);
  return {
    action,
    reasonCode:
      policy.action === "isolate" ? "policy_isolate_deny" : `policy_${action}`,
    reason:
      policy.action === "isolate"
        ? `${policy.reason} Native isolate is unavailable, so the call was denied.`
        : policy.reason,
    policy,
  };
}

function nativeAction(action: SupervisionAction): NativeGuardAction {
  return action === "isolate" ? "deny" : action;
}

function actionPriority(action: SupervisionAction): number {
  switch (action) {
    case "deny":
    case "isolate":
      return 5;
    case "ask":
      return 4;
    case "redact":
      return 3;
    case "warn":
      return 2;
    case "allow":
      return 1;
  }
}

function redactParameters(
  params: Record<string, unknown>,
  targetType: SupervisionTargetType,
  matchingPolicies: SupervisionPolicy[],
  policyPack: SupervisionPolicyPack,
  runtimeAction: SupervisionRuntimeAction,
): Record<string, unknown> {
  const rewritten = structuredClone(params);
  let rewriteCount = 0;
  for (const policy of matchingPolicies) {
    if (policy.action !== "redact") continue;
    for (const matcher of policy.match.matchers ?? []) {
      if (!didMatcherMatch(policyPack, policy, matcher, runtimeAction)) continue;
      const segments = resolveRedactionPath(
        matcher.fieldPath,
        targetType,
        rewritten,
      );
      if (!segments) continue;
      if (
        segments.length === 0 ||
        segments.some(
          (segment) => !segment || DANGEROUS_PATH_SEGMENTS.has(segment),
        )
      ) {
        throw redactionFailed();
      }
      let current: unknown = rewritten;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!isContainer(current) || !Object.hasOwn(current, segment)) {
          current = undefined;
          break;
        }
        current = current[segment];
      }
      const leaf = segments.at(-1)!;
      if (
        isContainer(current) &&
        Object.hasOwn(current, leaf) &&
        typeof current[leaf] === "string" &&
        current[leaf] !== "[REDACTED]"
      ) {
        current[leaf] = "[REDACTED]";
        rewriteCount += 1;
      }
    }
  }
  if (rewriteCount === 0) throw redactionFailed();
  return rewritten;
}

function didMatcherMatch(
  policyPack: SupervisionPolicyPack,
  policy: SupervisionPolicy,
  matcher: NonNullable<SupervisionPolicy["match"]["matchers"]>[number],
  runtimeAction: SupervisionRuntimeAction,
): boolean {
  const singleMatcherPolicy: SupervisionPolicy = {
    ...policy,
    match: { ...policy.match, relation: "all", matchers: [matcher] },
  };
  return findMatchingPolicies(
    { ...policyPack, policies: [singleMatcherPolicy] },
    runtimeAction,
  ).length === 1;
}

function resolveRedactionPath(
  fieldPath: string,
  targetType: SupervisionTargetType,
  params: Record<string, unknown>,
): string[] | undefined {
  const parameterPrefix = "payload.parameters.";
  if (fieldPath.startsWith(parameterPrefix)) {
    return fieldPath.slice(parameterPrefix.length).split(".");
  }
  const payloadPrefix = "payload.";
  if (targetType === "tool_call" || !fieldPath.startsWith(payloadPrefix)) {
    return undefined;
  }

  const direct = fieldPath.slice(payloadPrefix.length).split(".");
  if (direct.length !== 1 || typeof params[direct[0]] === "string") {
    return direct;
  }
  const alias = redactionAlias(targetType, direct[0], params);
  return alias ? [alias] : direct;
}

function redactionAlias(
  targetType: SupervisionTargetType,
  payloadField: string,
  params: Record<string, unknown>,
): string | undefined {
  const candidates =
    targetType === "api_call" && payloadField === "data"
      ? ["body"]
      : targetType === "file_write" && payloadField === "contentPreview"
        ? ["content", "patch"]
        : targetType === "code_execution" && payloadField === "codePreview"
          ? ["code", "command"]
          : [];
  return candidates.find((candidate) => typeof params[candidate] === "string");
}

function buildRuntimePayload(
  request: NativeToolDecisionRequest,
  targetType: SupervisionTargetType,
): RuntimeActionPayload {
  const params = request.params as JsonObject;
  switch (targetType) {
    case "code_execution":
      return {
        language: stringParam(request.params.language) ?? request.toolInputKind ?? "unknown",
        codePreview:
          stringParam(request.params.code) ??
          stringParam(request.params.command) ??
          "",
      };
    case "file_write":
      return {
        path: stringParam(request.params.path) ?? "",
        contentPreview:
          stringParam(request.params.content) ?? stringParam(request.params.patch),
      };
    case "api_call":
      return {
        method: stringParam(request.params.method) ?? "UNKNOWN",
        url: stringParam(request.params.url) ?? "",
        data:
          stringParam(request.params.data) ?? stringParam(request.params.body),
        toolName: request.toolName,
        parameters: params,
      } as RuntimeActionPayload;
    default:
      return {
        toolId: request.toolName,
        toolName: request.toolName,
        parameters: params,
      };
  }
}

function buildGatewayContext(
  request: NativeToolDecisionRequest,
  normalized: NormalizedNativeToolAction,
): GatewayRuntimeContext {
  const providerId = request.providerId ?? "unknown";
  const sideEffect = sideEffectFor(normalized.targetType);
  const profile: ToolCapabilityProfile = {
    schemaVersion: "mvp-1",
    originalToolName: request.toolName,
    canonicalToolId: `${providerId}:${request.toolName}`,
    providerType: providerTypeFor(providerId),
    surfaces: [surfaceFor(normalized.targetType)],
    operations: [operationFor(normalized.targetType)],
    capabilityTags: [],
    riskTags: normalized.riskTags,
    sideEffect,
    dataClasses: [],
    authScopes: [],
    networkReachability:
      normalized.targetType === "api_call" ? "unknown" : "none",
    sensitiveFields: [],
    confidence: normalized.riskTags.length > 0 ? "low" : "high",
    profileSource: "rule",
    llmAssisted: false,
  };
  return {
    providerId,
    providerName: providerId,
    providerType: profile.providerType,
    originalToolName: request.toolName,
    exposedToolName: request.toolName,
    canonicalToolId: profile.canonicalToolId,
    capabilityProfileSnapshot: profile,
    decisionSource: "policy",
  };
}

function defaultPolicy(
  policyPackId: string,
  targetType: SupervisionTargetType,
  action: NativeGuardAction,
  reason: string,
): SupervisionPolicy {
  return {
    policyId: `${policyPackId}.default`,
    sourceWeaknessIds: [],
    name: "Native guard default action",
    description: reason,
    targetType,
    action,
    riskLevel: action === "deny" ? "high" : "low",
    match: { relation: "all", matchers: [] },
    reason,
  };
}

function cleanCaches(
  caches: Map<string, LeaseCache>,
  nowMs: number,
  activeLeaseId: string,
  activeEpoch: number,
): void {
  for (const [key, cache] of caches) {
    if (
      cache.expiresAtMs <= nowMs ||
      (cache.leaseId === activeLeaseId && cache.leaseEpoch !== activeEpoch)
    ) {
      caches.delete(key);
    }
  }
}

function cleanTombstones(
  tombstones: Map<string, LeaseTombstones>,
  nowMs: number,
): void {
  for (const [leaseId, state] of tombstones) {
    if (state.expiresAtMs <= nowMs) tombstones.delete(leaseId);
  }
}

function readNow(now: () => string | Date): { iso: string; timeMs: number } {
  const value = now();
  const iso = value instanceof Date ? value.toISOString() : value;
  return { iso, timeMs: canonicalIsoMs(iso, "decision clock") };
}

function canonicalIsoMs(value: string, label: string): number {
  if (typeof value !== "string") throw invalidRequest(`Native guard ${label} is invalid`);
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString() !== value) {
    throw invalidRequest(`Native guard ${label} must be a canonical ISO timestamp`);
  }
  return timeMs;
}

function assertRequiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`Native guard ${label} must be non-empty`);
  }
}

function canonicalOperationName(value: string): string {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("__");
  return separator >= 0 ? normalized.slice(separator + 2) : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) || Array.isArray(value);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function providerTypeFor(providerId: string): ToolProviderType {
  const normalized = providerId.toLowerCase();
  if (normalized.includes("openclaw")) return "openclaw";
  if (normalized.includes("agent_guard") || normalized.includes("agw")) {
    return "agent_guard";
  }
  return providerId === "unknown" ? "unknown" : "custom";
}

function sideEffectFor(targetType: SupervisionTargetType): ToolSideEffect {
  if (targetType === "api_call") return "external";
  if (targetType === "file_write" || targetType === "code_execution") return "write";
  return "unknown";
}

function surfaceFor(
  targetType: SupervisionTargetType,
): ToolCapabilityProfile["surfaces"][number] {
  if (targetType === "api_call") return "network";
  if (targetType === "code_execution") return "code";
  return "tool";
}

function operationFor(
  targetType: SupervisionTargetType,
): ToolCapabilityProfile["operations"][number] {
  if (targetType === "code_execution") return "execute";
  if (targetType === "file_write") return "write";
  return "unknown";
}

function leaseCacheKey(leaseId: string, epoch: number): string {
  return `${leaseId}:${epoch}`;
}

function pendingKey(leaseId: string, requestId: string): string {
  return `${leaseId}:${requestId}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Native guard ${label} must be a positive integer`);
  }
  return value;
}

function authenticationFailed(): NativeToolDecisionError {
  return decisionError(
    "NATIVE_GUARD_AUTHENTICATION_FAILED",
    "Native guard authentication failed",
  );
}

function leaseChanged(): NativeToolDecisionError {
  return decisionError(
    "NATIVE_GUARD_LEASE_CHANGED",
    "Native guard lease changed before decision completion",
  );
}

function invalidRequest(message: string): NativeToolDecisionError {
  return decisionError("NATIVE_GUARD_INVALID_REQUEST", message);
}

function redactionFailed(): NativeToolDecisionError {
  return decisionError(
    "NATIVE_GUARD_REDACTION_FAILED",
    "Native guard redaction could not safely rewrite matched parameters",
  );
}

function decisionError(code: string, message: string): NativeToolDecisionError {
  return new NativeToolDecisionError(code, message);
}
