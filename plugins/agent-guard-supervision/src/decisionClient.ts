import { createPublicKey } from "node:crypto";
import type {
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
} from "@agent-guard/contracts";
import {
  canonicalJson,
  digestJson,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import type { ActiveLeaseLookup } from "./leaseRegistry";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 384 * 1024;
const DEFAULT_MAX_DECISION_IDS_PER_LEASE = 1_000;
const DEFAULT_MAX_DECISION_SKEW_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIONS = new Set(["allow", "warn", "deny", "ask", "redact"]);

export type DecisionClientInput = {
  lease: ActiveLeaseLookup;
  request: NativeToolDecisionRequest;
  signal: AbortSignal;
};

export interface DecisionClient {
  decide(input: DecisionClientInput): Promise<NativeToolDecisionResponse>;
}

export type DecisionClientOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxDecisionIdsPerLease?: number;
  maxDecisionSkewMs?: number;
};

export class NativeGuardDecisionClientError extends Error {
  constructor() {
    super("Native guard policy decision is unavailable");
    this.name = "NativeGuardDecisionClientError";
  }
}

export function createDecisionClient(options: DecisionClientOptions = {}): DecisionClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = boundedPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 4_999);
  const maxRequestBytes = boundedPositiveInteger(
    options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    4 * 1024 * 1024,
  );
  const maxResponseBytes = boundedPositiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    4 * 1024 * 1024,
  );
  const maxDecisionIdsPerLease = boundedPositiveInteger(
    options.maxDecisionIdsPerLease ?? DEFAULT_MAX_DECISION_IDS_PER_LEASE,
    100_000,
  );
  const maxDecisionSkewMs = boundedPositiveInteger(
    options.maxDecisionSkewMs ?? DEFAULT_MAX_DECISION_SKEW_MS,
    5 * 60_000,
  );
  const replayWindows = new Map<string, { expiresAtMs: number; decisionIds: Set<string> }>();

  return {
    async decide(input) {
      try {
        if (typeof fetchImplementation !== "function") throw unavailable();
        const requestBody = canonicalJson(input.request);
        if (Buffer.byteLength(requestBody, "utf8") > maxRequestBytes) throw unavailable();
        const envelope = await withDeadline(input.signal, timeoutMs, async (signal) => {
          const response = await fetchDecision(
            fetchImplementation,
            input.lease.backendUrl,
            requestBody,
            input.lease.credential,
            signal,
          );
          return readDecisionEnvelope(response, signal, maxResponseBytes);
        });
        const decision = parseDecision(envelope, input, now(), maxDecisionSkewMs);
        rememberDecisionId(
          replayWindows,
          decision.decisionId,
          input.lease,
          now().getTime(),
          maxDecisionIdsPerLease,
        );
        return decision;
      } catch {
        throw unavailable();
      }
    },
  };
}

async function withDeadline<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const result = await operation(controller.signal);
    if (controller.signal.aborted || parentSignal.aborted) throw unavailable();
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

async function fetchDecision(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  body: string,
  credential: string,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchImplementation(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (signal.aborted || response.redirected) throw unavailable();
  return response;
}

async function readDecisionEnvelope(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<unknown> {
  if (response.status !== 200) throw unavailable();
  if (!validJsonContentType(response.headers.get("content-type"))) throw unavailable();
  if (response.headers.has("content-encoding")) throw unavailable();
  const declaredLength = parseContentLength(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxResponseBytes) throw unavailable();
  if (response.body === null) throw unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  let removeAbortListener = (): void => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(unavailable());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), abortPromise]);
      if (chunk.done) {
        completed = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > maxResponseBytes || (declaredLength !== undefined && size > declaredLength)) {
        throw unavailable();
      }
      chunks.push(chunk.value);
    }
  } finally {
    removeAbortListener();
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted || (declaredLength !== undefined && size !== declaredLength)) throw unavailable();
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function parseDecision(
  envelopeValue: unknown,
  input: DecisionClientInput,
  now: Date,
  maxDecisionSkewMs: number,
): NativeToolDecisionResponse {
  if (!isRecord(envelopeValue) || !hasExactKeys(envelopeValue, ["data", "ok", "requestId"])) {
    throw unavailable();
  }
  canonicalJson(envelopeValue);
  if (envelopeValue.ok !== true || !safeString(envelopeValue.requestId, 256)) throw unavailable();
  const value = envelopeValue.data;
  if (!isRecord(value)) throw unavailable();
  canonicalJson(value);
  const required = [
    "action",
    "decidedAt",
    "decisionId",
    "evaluatedParamsDigest",
    "leaseEpoch",
    "leaseId",
    "policyPackDigest",
    "policyPackId",
    "reason",
    "reasonCode",
    "requestId",
    "schemaVersion",
    "signature",
  ];
  const optional = ["rewrittenParams", "rewrittenParamsDigest"];
  if (!hasExactKeys(value, required, optional)) throw unavailable();
  if (
    value.schemaVersion !== "native-guard-1" ||
    !safeId(value.decisionId) ||
    !safeId(value.requestId) ||
    !safeId(value.leaseId) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) <= 0 ||
    !safeId(value.policyPackId) ||
    !isDigest(value.policyPackDigest) ||
    typeof value.action !== "string" ||
    !ACTIONS.has(value.action) ||
    typeof value.reasonCode !== "string" ||
    !REASON_CODE.test(value.reasonCode) ||
    !safeString(value.reason, 1_024) ||
    !isDigest(value.evaluatedParamsDigest) ||
    !isCanonicalTimestamp(value.decidedAt) ||
    !safeString(value.signature, 128)
  ) {
    throw unavailable();
  }
  if (
    value.requestId !== input.request.requestId ||
    value.leaseId !== input.lease.leaseId ||
    value.leaseEpoch !== input.lease.leaseEpoch ||
    value.policyPackId !== input.lease.policyPackId ||
    value.policyPackDigest !== input.lease.policyPackDigest ||
    value.evaluatedParamsDigest !== input.request.paramsDigest ||
    Math.abs(now.getTime() - Date.parse(value.decidedAt as string)) > maxDecisionSkewMs
  ) {
    throw unavailable();
  }

  if (value.action === "redact") {
    if (!isRecord(value.rewrittenParams) || !isDigest(value.rewrittenParamsDigest)) throw unavailable();
    if (digestJson(value.rewrittenParams) !== value.rewrittenParamsDigest) throw unavailable();
  } else if (value.rewrittenParams !== undefined || value.rewrittenParamsDigest !== undefined) {
    throw unavailable();
  }

  const { signature, ...unsigned } = value;
  const publicKey = createPublicKey(input.lease.decisionPublicKey);
  if (!verifyNativeGuardPayload(unsigned, signature as string, publicKey)) throw unavailable();
  return value as NativeToolDecisionResponse;
}

function rememberDecisionId(
  replayWindows: Map<string, { expiresAtMs: number; decisionIds: Set<string> }>,
  decisionId: string,
  lease: ActiveLeaseLookup,
  nowMs: number,
  capacity: number,
): void {
  for (const [leaseId, window] of replayWindows) {
    if (window.expiresAtMs <= nowMs) replayWindows.delete(leaseId);
  }
  let window = replayWindows.get(lease.leaseId);
  if (window === undefined) {
    window = { expiresAtMs: Date.parse(lease.expiresAt), decisionIds: new Set() };
    replayWindows.set(lease.leaseId, window);
  } else {
    window.expiresAtMs = Math.max(window.expiresAtMs, Date.parse(lease.expiresAt));
  }
  if (window.decisionIds.has(decisionId) || window.decisionIds.size >= capacity) throw unavailable();
  window.decisionIds.add(decisionId);
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw unavailable();
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw unavailable();
  return length;
}

function validJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !value.includes("..");
}

function safeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    CANONICAL_TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function boundedPositiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError("Native guard decision client limit is invalid");
  }
  return value;
}

function unavailable(): NativeGuardDecisionClientError {
  return new NativeGuardDecisionClientError();
}
