import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import type { NativeGuardLeaseActivation } from "@agent-guard/contracts";
import type {
  NativeGuardEvidenceProof,
  NativeGuardLifecycleAcknowledgement,
} from "@agent-guard/contracts";
import {
  canonicalJson,
  digestJson,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import type { ActiveLeaseLookup } from "./leaseRegistry";

const BIND_PATH = "/api/v1/openclaw/native-guard/lifecycle/bind-child";
const END_PATH = "/api/v1/openclaw/native-guard/lifecycle/end-session";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ACK_SKEW_MS = 30_000;

export type BindChildLifecycleInput = {
  leaseId: string;
  leaseEpoch: number;
  parentSessionKey: string;
  childSessionKey: string;
};

export type EndSessionLifecycleInput = {
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
};

export interface LifecycleClient {
  bindChild(
    lease: ActiveLeaseLookup,
    input: BindChildLifecycleInput,
    signal: AbortSignal,
    proof?: NativeGuardEvidenceProof,
  ): Promise<void>;
  endSession(
    lease: ActiveLeaseLookup,
    input: EndSessionLifecycleInput,
    signal: AbortSignal,
    proof?: NativeGuardEvidenceProof,
  ): Promise<void>;
}

export type LifecycleClientOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
  createId?: () => string;
};

export function createLifecycleClient(options: LifecycleClientOptions = {}): LifecycleClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => `proof.${randomUUID()}`);
  return {
    bindChild: (lease, input, signal, proof) => requestLifecycle(
      fetchImplementation,
      timeoutMs,
      lease,
      BIND_PATH,
      input,
      "child_bound",
      signal,
      now,
      createId,
      proof,
    ),
    endSession: (lease, input, signal, proof) => requestLifecycle(
      fetchImplementation,
      timeoutMs,
      lease,
      END_PATH,
      input,
      "session_ended",
      signal,
      now,
      createId,
      proof,
    ),
  };
}

async function requestLifecycle(
  fetchImplementation: typeof globalThis.fetch | undefined,
  timeoutMs: number,
  lease: ActiveLeaseLookup,
  path: string,
  input: BindChildLifecycleInput | EndSessionLifecycleInput,
  acknowledgement: "child_bound" | "session_ended",
  parentSignal: AbortSignal,
  now: () => Date,
  createId: () => string,
  providedProof?: NativeGuardEvidenceProof,
): Promise<void> {
  if (
    typeof fetchImplementation !== "function" ||
    input.leaseId !== lease.leaseId ||
    input.leaseEpoch !== lease.leaseEpoch
  ) throw unavailable();
  const url = lifecycleUrl(lease.backendUrl, path);
  const body = canonicalJson(input);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw unavailable();
  const proof = providedProof ?? createLifecycleEvidenceProof(lease, path, input, now(), createId());
  if (!validLifecycleEvidenceProof(lease, path, input, proof)) throw unavailable();
  const encodedProof = Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
  if (encodedProof.length > 4_096) throw unavailable();
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  timer.unref();
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
      !validJsonContentType(response.headers.get("content-type")) ||
      response.headers.has("content-encoding")
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const text = await readBoundedBody(response, controller.signal, declaredLength);
    const envelope = JSON.parse(text) as unknown;
    if (!validAcknowledgement(
      envelope,
      acknowledgement,
      lease,
      proof,
      now(),
    )) throw unavailable();
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  declaredLength: number | undefined,
): Promise<string> {
  if (response.body === null) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  const abort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw unavailable();
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      size += chunk.value.byteLength;
      if (
        size > MAX_RESPONSE_BYTES ||
        (declaredLength !== undefined && size > declaredLength)
      ) throw unavailable();
      chunks.push(chunk.value);
    }
    if (declaredLength !== undefined && size !== declaredLength) throw unavailable();
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function lifecycleUrl(backendUrl: string, path: string): URL {
  const url = new URL(backendUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
    url.pathname !== "/api/v1/openclaw/native-guard/decision" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) throw unavailable();
  url.pathname = path;
  return url;
}

export function createLifecycleEvidenceProof(
  lease: ActiveLeaseLookup,
  path: string,
  body: BindChildLifecycleInput | EndSessionLifecycleInput,
  now: Date,
  proofId: string,
): NativeGuardEvidenceProof {
  if (!validProofId(proofId) || !validDate(now)) throw unavailable();
  const unsigned = {
    schemaVersion: "native-guard-1" as const,
    signatureContext: "native_guard.evidence_request.v1" as const,
    proofId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    method: "POST" as const,
    path,
    bodyDigest: digestJson(body),
    issuedAt: now.toISOString(),
    keyId: lease.evidenceSigningKeyId,
  };
  const privateKey = createPrivateKey(lease.evidenceSigningPrivateKey);
  return {
    ...unsigned,
    signature: signNativeGuardPayload(unsigned, privateKey),
  };
}

function validLifecycleEvidenceProof(
  lease: ActiveLeaseLookup,
  path: string,
  body: BindChildLifecycleInput | EndSessionLifecycleInput,
  proof: NativeGuardEvidenceProof,
): boolean {
  if (
    proof.schemaVersion !== "native-guard-1" ||
    proof.signatureContext !== "native_guard.evidence_request.v1" ||
    !validProofId(proof.proofId) ||
    proof.leaseId !== lease.leaseId ||
    proof.leaseEpoch !== lease.leaseEpoch ||
    proof.method !== "POST" ||
    proof.path !== path ||
    proof.bodyDigest !== digestJson(body) ||
    !validCanonicalTimestamp(proof.issuedAt) ||
    proof.keyId !== lease.evidenceSigningKeyId
  ) return false;
  try {
    const privateKey = createPrivateKey(lease.evidenceSigningPrivateKey);
    return verifyNativeGuardPayload(
      Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "signature")),
      proof.signature,
      createPublicKey(privateKey),
    );
  } catch {
    return false;
  }
}

function validAcknowledgement(
  value: unknown,
  ackType: "child_bound" | "session_ended",
  lease: ActiveLeaseLookup,
  proof: NativeGuardEvidenceProof,
  now: Date,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["data", "ok", "requestId"])) return false;
  if (value.ok !== true || typeof value.requestId !== "string" || !isRecord(value.data)) return false;
  const acknowledgement = value.data;
  if (!hasExactKeys(acknowledgement, [
    "ackId",
    "ackType",
    "acknowledgedAt",
    "bodyDigest",
    "leaseEpoch",
    "leaseId",
    "proofId",
    "schemaVersion",
    "signature",
    "signatureContext",
  ])) return false;
  const acknowledgedAt = typeof acknowledgement.acknowledgedAt === "string"
    ? Date.parse(acknowledgement.acknowledgedAt)
    : Number.NaN;
  const proofIssuedAt = Date.parse(proof.issuedAt);
  const leaseIssuedAt = Date.parse(lease.issuedAt);
  const leaseExpiresAt = Date.parse(lease.expiresAt);
  const nowMs = now.getTime();
  if (
    acknowledgement.schemaVersion !== "native-guard-1" ||
    acknowledgement.signatureContext !== "native_guard.evidence_ack.v1" ||
    !validProofId(acknowledgement.ackId) ||
    acknowledgement.ackType !== ackType ||
    acknowledgement.proofId !== proof.proofId ||
    acknowledgement.leaseId !== lease.leaseId ||
    acknowledgement.leaseEpoch !== lease.leaseEpoch ||
    acknowledgement.bodyDigest !== proof.bodyDigest ||
    typeof acknowledgement.acknowledgedAt !== "string" ||
    !validCanonicalTimestamp(acknowledgement.acknowledgedAt) ||
    !validDate(now) ||
    !Number.isFinite(proofIssuedAt) ||
    !Number.isFinite(leaseIssuedAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= leaseIssuedAt ||
    nowMs >= leaseExpiresAt ||
    proofIssuedAt < leaseIssuedAt - MAX_ACK_SKEW_MS ||
    proofIssuedAt >= leaseExpiresAt ||
    acknowledgedAt < leaseIssuedAt ||
    acknowledgedAt < proofIssuedAt - MAX_ACK_SKEW_MS ||
    acknowledgedAt > leaseExpiresAt ||
    acknowledgedAt > nowMs + MAX_ACK_SKEW_MS ||
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

function validJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw unavailable();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw unavailable();
  return parsed;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value >= 5_000) throw unavailable();
  return value;
}

function unavailable(): Error {
  return new Error("Native guard lifecycle synchronization failed");
}

export type LifecycleLease = Pick<
  NativeGuardLeaseActivation,
  | "leaseId"
  | "leaseEpoch"
  | "backendUrl"
  | "decisionPublicKey"
  | "evidenceCredential"
  | "evidenceSigningKeyId"
  | "evidenceSigningPrivateKey"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function validProofId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
