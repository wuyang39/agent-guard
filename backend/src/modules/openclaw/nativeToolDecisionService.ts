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
  SupervisionTargetType,
  ToolCapabilityProfile,
  ToolProviderType,
  ToolSideEffect,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { createId as defaultCreateId } from "../../shared/ids";
import { Mutex } from "../../shared/mutex";
import { findMatchingPolicies } from "../supervisor/policyEngine";
import { recordSupervisionDecision } from "../supervisor/supervisionRecorder";
import type { SupervisionRuntimeAction } from "../supervisor/supervisorTypes";
import type { NativeGuardLeaseService } from "./nativeGuardLeaseService";

const DEFAULT_MAX_SKEW_MS = 30_000;
const DEFAULT_MAX_REQUESTS_PER_LEASE = 1_000;
const DANGEROUS_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
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
  beforeSign?: () => Promise<void>;
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
    metadata.providerId,
  ].filter((value): value is string => typeof value === "string");

  if (values.some((value) => hasMetadataTerm(value, ["exec", "process"]))) {
    return { targetType: "code_execution", riskTags: [], llmAssisted: false };
  }
  if (
    values.some((value) =>
      hasMetadataTerm(value, ["write", "edit", "apply_patch"]),
    )
  ) {
    return { targetType: "file_write", riskTags: [], llmAssisted: false };
  }
  if (values.some((value) => hasMetadataTerm(value, ["network", "browser"]))) {
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
  const caches = new Map<string, LeaseCache>();
  const mutex = new Mutex();

  return {
    async decide(
      request: NativeToolDecisionRequest,
      credential: string,
    ): Promise<{
      response: NativeToolDecisionResponse;
      record: RuntimeSupervisionRecord;
    }> {
      return mutex.run(async () => {
        const decisionTime = readNow(now);
        const requestTimeMs = validateRequest(request);
        const lease = authenticateAndBind(options.leaseService, request, credential);
        cleanCaches(caches, decisionTime.timeMs, request.leaseId, request.leaseEpoch);

        const cacheKey = leaseCacheKey(request.leaseId, request.leaseEpoch);
        let cache = caches.get(cacheKey);
        let requestDigest: string;
        try {
          requestDigest = digestJson(request);
        } catch {
          throw invalidRequest("Native guard request identity is not canonical JSON");
        }
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
        if (cache?.toolCalls.has(request.toolCallId)) {
          throw decisionError(
            "NATIVE_GUARD_TOOL_CALL_REPLAY",
            "Native guard tool call was already submitted under another request",
          );
        }
        if (Math.abs(decisionTime.timeMs - requestTimeMs) > maxSkewMs) {
          throw decisionError(
            "NATIVE_GUARD_REQUEST_TIME_INVALID",
            "Native guard request timestamp is outside the accepted window",
          );
        }
        if (cache && cache.requests.size >= maxRequestsPerLease) {
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
          );
          rewrittenParamsDigest = digestJson(rewrittenParams);
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

        await options.beforeSign?.();
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
        if (!(await options.eventStore.append(event, record))) {
          throw decisionError(
            "NATIVE_GUARD_EVENT_CONFLICT",
            "Native guard decision event could not be persisted uniquely",
          );
        }

        cache ??= {
          leaseId: request.leaseId,
          leaseEpoch: request.leaseEpoch,
          expiresAtMs: Date.parse(lease.expiresAt),
          requests: new Map(),
          toolCalls: new Map(),
        };
        caches.set(cacheKey, cache);
        const result = { response, record };
        cache.requests.set(request.requestId, {
          requestDigest,
          toolCallId: request.toolCallId,
          result: structuredClone(result),
        });
        cache.toolCalls.set(request.toolCallId, request.requestId);
        return result;
      });
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
  if (!isPlainObject(request.params)) {
    throw invalidRequest("Native guard parameters must be a JSON object");
  }
  let actualDigest: string;
  try {
    actualDigest = digestJson(request.params);
  } catch {
    throw invalidRequest("Native guard parameters are not canonical JSON");
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
): Record<string, unknown> {
  const rewritten = structuredClone(params);
  let rewriteCount = 0;
  for (const policy of matchingPolicies) {
    if (policy.action !== "redact") continue;
    for (const matcher of policy.match.matchers ?? []) {
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
  if (direct.length !== 1 || Object.hasOwn(params, direct[0])) return direct;
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
        ? ["content"]
        : targetType === "code_execution" && payloadField === "codePreview"
          ? ["code", "command"]
          : [];
  return candidates.find((candidate) => Object.hasOwn(params, candidate));
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
      };
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

function hasMetadataTerm(value: string, terms: string[]): boolean {
  const normalized = value.toLowerCase();
  return terms.some((term) => {
    if (term === "apply_patch" && normalized.includes("apply_patch")) return true;
    return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(normalized);
  });
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
