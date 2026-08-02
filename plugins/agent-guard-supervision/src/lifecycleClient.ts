import type { NativeGuardLeaseActivation } from "@agent-guard/contracts";
import type { ActiveLeaseLookup } from "./leaseRegistry";

const BIND_PATH = "/api/v1/openclaw/native-guard/lifecycle/bind-child";
const END_PATH = "/api/v1/openclaw/native-guard/lifecycle/end-session";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

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
  ): Promise<void>;
  endSession(
    lease: ActiveLeaseLookup,
    input: EndSessionLifecycleInput,
    signal: AbortSignal,
  ): Promise<void>;
}

export type LifecycleClientOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export function createLifecycleClient(options: LifecycleClientOptions = {}): LifecycleClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return {
    bindChild: (lease, input, signal) => requestLifecycle(
      fetchImplementation,
      timeoutMs,
      lease,
      BIND_PATH,
      input,
      "bound",
      signal,
    ),
    endSession: (lease, input, signal) => requestLifecycle(
      fetchImplementation,
      timeoutMs,
      lease,
      END_PATH,
      input,
      "ended",
      signal,
    ),
  };
}

async function requestLifecycle(
  fetchImplementation: typeof globalThis.fetch | undefined,
  timeoutMs: number,
  lease: ActiveLeaseLookup,
  path: string,
  input: BindChildLifecycleInput | EndSessionLifecycleInput,
  acknowledgement: "bound" | "ended",
  parentSignal: AbortSignal,
): Promise<void> {
  if (
    typeof fetchImplementation !== "function" ||
    input.leaseId !== lease.leaseId ||
    input.leaseEpoch !== lease.leaseEpoch
  ) throw unavailable();
  const url = lifecycleUrl(lease.backendUrl, path);
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw unavailable();
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
    if (!validAcknowledgement(envelope, acknowledgement)) throw unavailable();
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

function validAcknowledgement(value: unknown, field: "bound" | "ended"): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.ok !== true || typeof envelope.data !== "object" || envelope.data === null) {
    return false;
  }
  return (envelope.data as Record<string, unknown>)[field] === true;
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
  "leaseId" | "leaseEpoch" | "backendUrl" | "evidenceCredential"
>;
