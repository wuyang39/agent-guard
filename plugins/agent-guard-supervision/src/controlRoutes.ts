import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import type { PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { AgentGuardRegistrationError, AgentGuardRuntime } from "./runtime";

const ACTIVATE_PATH = "/agent-guard/native-guard/v1/leases/activate";
const RENEW_PATH = "/agent-guard/native-guard/v1/leases/renew";
const REVOKE_PATH = "/agent-guard/native-guard/v1/leases/revoke";
const STATUS_PATH = "/agent-guard/native-guard/v1/status";
const MAX_BODY_BYTES = 64 * 1024;
const SAFE_LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_IDEMPOTENCY_CAPACITY = 256;
const DEFAULT_BODY_TIMEOUT_MS = 2_000;
const SERVICE_STOP_TIMEOUT_MS = 4_000;

type ErrorCode =
  | "INVALID_ACTIVATION"
  | "INVALID_IDEMPOTENCY_KEY"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_CAPACITY"
  | "IDEMPOTENCY_CONFLICT"
  | "LEASE_CONFLICT"
  | "METHOD_NOT_ALLOWED"
  | "NATIVE_GUARD_INTERNAL"
  | "REQUEST_ABORTED"
  | "REQUEST_INCOMPLETE"
  | "REQUEST_TIMEOUT"
  | "REQUEST_TOO_LARGE"
  | "TRUSTED_POLICY_UNATTESTED"
  | "UNSUPPORTED_CONTENT_ENCODING"
  | "UNSUPPORTED_MEDIA_TYPE";

class ControlRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
    readonly closeConnection = false,
  ) {
    super(message);
  }
}

export type ControlRouteApi = Pick<PluginApi, "registerHttpRoute">;
export type ControlRouteOptions = {
  bodyTimeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  idempotencyCapacity?: number;
};
export type LifecycleApi = Pick<
  PluginApi,
  "on" | "registerService" | "registerTrustedToolPolicy"
>;
export type AgentGuardPluginApi = ControlRouteApi & LifecycleApi & Pick<
  PluginApi,
  "pluginConfig" | "runtime"
>;

export function registerAgentGuardPlugin(
  api: AgentGuardPluginApi,
): AgentGuardRuntime {
  const markerDir = parseMarkerDir(api.pluginConfig);
  const spoolDir = parseSpoolDir(api.pluginConfig);
  const runtime = new AgentGuardRuntime({
    ...(markerDir === undefined ? {} : { markerDir }),
    ...(spoolDir === undefined ? {} : { spoolDir }),
    sessionResolver: (params) => api.runtime.agent.session.getSessionEntry(params),
  });
  // Only a future explicit `true` means the host guarantees this contribution is live.
  try {
    const contributions = [
      isLiveContribution(api.on(
        "before_tool_call",
        (event, context) => runtime.beforeToolCall(event, context),
        { priority: -1_000_000, timeoutMs: 5_000 },
      )),
      isLiveContribution(api.on(
        "after_tool_call",
        (event, context) => runtime.afterToolCall(event, context),
        { priority: -1_000_000, timeoutMs: 1_000 },
      )),
      ...registerAgentGuardLifecycle(api, runtime),
      ...registerControlRoutes(api, runtime),
    ];
    runtime.finalizeRegistrationAttestation(contributions.every(Boolean));
    return runtime;
  } catch (error) {
    runtime.finalizeRegistrationAttestation(false);
    void runtime.stop();
    throw error;
  }
}

function isLiveContribution(result: void | true): boolean {
  return result === true;
}

function parseMarkerDir(config: Record<string, unknown> | undefined): string | undefined {
  return parseConfiguredDirectory(config, "markerDir");
}

function parseSpoolDir(config: Record<string, unknown> | undefined): string | undefined {
  return parseConfiguredDirectory(config, "spoolDir");
}

function parseConfiguredDirectory(
  config: Record<string, unknown> | undefined,
  field: "markerDir" | "spoolDir",
): string | undefined {
  if (config === undefined || !Object.hasOwn(config, field)) return undefined;
  const value = config[field];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new TypeError(`Native guard ${field} config is invalid`);
  }
  return value;
}

export function registerAgentGuardLifecycle(
  api: LifecycleApi,
  runtime: AgentGuardRuntime,
): boolean[] {
  const contributions = [isLiveContribution(api.registerTrustedToolPolicy({
    id: "agent-guard-admission",
    description: "Enforces Agent Guard lease and recovery admission before tool execution.",
    evaluate: (event, context) => runtime.trustedAdmission(event, context),
  }))];
  contributions.push(isLiveContribution(api.registerService({
    id: "agent-guard-runtime",
    start: async () => runtime.start(),
    stop: async () => runtime.stop(),
  })));
  contributions.push(isLiveContribution(api.on("subagent_spawned", async (event, context) => {
    const parentSessionKey = context.requesterSessionKey;
    if (
      parentSessionKey === undefined ||
      context.childSessionKey === undefined ||
      event.childSessionKey !== context.childSessionKey
    ) {
      return;
    }
    const parent = await runtime.lookup(parentSessionKey);
    if (parent.state !== "active") return;
    await runtime.bindChild(parent.leaseId, parentSessionKey, event.childSessionKey);
  })));
  contributions.push(isLiveContribution(api.on("subagent_ended", async (event) => {
    await runtime.endSession(event.targetSessionKey);
  })));
  contributions.push(isLiveContribution(api.on("session_end", async (event, context) => {
    if (
      event.reason === "shutdown" ||
      event.reason === "restart" ||
      event.reason === "compaction"
    ) {
      return;
    }
    const sessionKey = event.sessionKey ?? context.sessionKey;
    if (sessionKey !== undefined) await runtime.endSession(sessionKey);
  })));
  return contributions;
}

export function registerControlRoutes(
  api: ControlRouteApi,
  runtime: AgentGuardRuntime,
  options: ControlRouteOptions = {},
): boolean[] {
  const idempotency = new IdempotencyCache(
    options.idempotencyCapacity ?? DEFAULT_IDEMPOTENCY_CAPACITY,
  );
  const bodyReader: BodyReaderOptions = {
    bodyTimeoutMs: parseBodyTimeout(options.bodyTimeoutMs),
    scheduleTimeout: options.scheduleTimeout ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs)),
    cancelTimeout: options.cancelTimeout ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>)),
    getAbortSignal: () => runtime.abortSignal,
  };
  const quarantinedSockets = new WeakSet<IncomingMessage["socket"]>();
  const contributions = [isLiveContribution(api.registerHttpRoute({
    path: ACTIVATE_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      if (rejectQuarantinedSocket(request, quarantinedSockets)) return;
      await handleMutationRoute(
        request,
        response,
        "activate",
        "activation",
        idempotency,
        bodyReader,
        async (body) => runtime.activate(body as NativeGuardLeaseActivation),
      );
    },
  }))];
  contributions.push(isLiveContribution(api.registerHttpRoute({
    path: RENEW_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      if (rejectQuarantinedSocket(request, quarantinedSockets)) return;
      await handleMutationRoute(
        request,
        response,
        "renew",
        "activation",
        idempotency,
        bodyReader,
        async (body) => runtime.renew(body as NativeGuardLeaseActivation),
      );
    },
  })));
  contributions.push(isLiveContribution(api.registerHttpRoute({
    path: REVOKE_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      if (rejectQuarantinedSocket(request, quarantinedSockets)) return;
      await handleMutationRoute(
        request,
        response,
        "revoke",
        "request",
        idempotency,
        bodyReader,
        async (value) => {
          const body = parseRevoke(value);
          await runtime.revoke(body.leaseId);
          return runtime.status();
        },
      );
    },
  })));
  contributions.push(isLiveContribution(api.registerHttpRoute({
    path: STATUS_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      if (rejectQuarantinedSocket(request, quarantinedSockets)) return;
      await handleRoute(request, response, "GET", "request", () => {
        assertUnframedGet(request, quarantinedSockets);
        return runtime.status().then((status) => sendStatus(response, status));
      });
    },
  })));
  return contributions;
}

type RouteResponse = {
  statusCode: number;
  body: unknown;
  closeConnection?: boolean;
};

async function handleMutationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  operationName: "activate" | "renew" | "revoke",
  invalidKind: "activation" | "request",
  idempotency: IdempotencyCache,
  bodyReader: BodyReaderOptions,
  operation: (body: unknown) => Promise<NativeGuardStatus>,
): Promise<void> {
  await handleRoute(request, response, "POST", invalidKind, async () => {
    assertNoContentEncoding(request);
    const key = parseIdempotencyKey(request.headers["x-idempotency-key"]);
    const parsed = await readJson(request, bodyReader, operationName);
    const result = await idempotency.execute(key, parsed.digest, async () => {
      try {
        return {
          statusCode: 200,
          body: projectStatus(await operation(parsed.value)),
        };
      } catch (error) {
        const mapped = mapRouteError(error, invalidKind);
        return {
          statusCode: mapped.statusCode,
          body: { error: { code: mapped.code, message: mapped.message } },
          closeConnection: mapped.closeConnection,
        };
      }
    });
    sendRouteResponse(request, response, result);
  });
}

async function readJson(
  request: IncomingMessage,
  bodyReader: BodyReaderOptions,
  operationName = "request",
): Promise<{ value: unknown; digest: string }> {
  assertJsonContentType(request);
  const declaredLength = parseContentLength(request.headers["content-length"]);
  if (declaredLength !== undefined && declaredLength > MAX_BODY_BYTES) {
    throw routeError(
      413,
      "REQUEST_TOO_LARGE",
      "Native guard control request is too large.",
      true,
    );
  }
  const contents = await readBoundedBody(request, declaredLength, bodyReader);
  if (contents.length === 0) {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return {
      value: JSON.parse(text) as unknown,
      digest: createHash("sha256")
        .update(operationName)
        .update("\0")
        .update(contents)
        .digest("hex"),
    };
  } catch {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
}

function parseBodyTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_BODY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs >= SERVICE_STOP_TIMEOUT_MS
  ) {
    throw new RangeError("Native guard body timeout is invalid");
  }
  return timeoutMs;
}

async function handleRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: "GET" | "POST",
  invalidKind: "activation" | "request",
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    if (request.method !== method) {
      response.setHeader("Allow", method);
      throw routeError(
        405,
        "METHOD_NOT_ALLOWED",
        "Native guard control method is not allowed.",
        true,
      );
    }
    await operation();
  } catch (error) {
    const mapped = mapRouteError(error, invalidKind);
    if (response.destroyed || response.writableEnded) return;
    if (mapped.closeConnection) {
      response.setHeader("Connection", "close");
      if (!request.destroyed) request.resume();
    }
    sendJson(response, mapped.statusCode, {
      error: { code: mapped.code, message: mapped.message },
    });
  }
}

function assertJsonContentType(request: IncomingMessage): void {
  const value = request.headers["content-type"];
  if (
    typeof value !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim())
  ) {
    throw routeError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Native guard control request must be JSON.",
      true,
    );
  }
}

function assertNoContentEncoding(request: IncomingMessage): void {
  if (request.headers["content-encoding"] === undefined) return;
  throw routeError(
    415,
    "UNSUPPORTED_CONTENT_ENCODING",
    "Native guard control request encoding is unsupported.",
    true,
  );
}

function assertUnframedGet(
  request: IncomingMessage,
  quarantinedSockets: WeakSet<IncomingMessage["socket"]>,
): void {
  if (
    request.headers["content-length"] === undefined &&
    request.headers["transfer-encoding"] === undefined &&
    request.headers["content-encoding"] === undefined
  ) {
    return;
  }
  const socket = request.socket as IncomingMessage["socket"] | undefined;
  if (socket !== undefined) quarantinedSockets.add(socket);
  throw routeError(
    400,
    "INVALID_REQUEST",
    "Native guard control request is invalid.",
    true,
  );
}

function rejectQuarantinedSocket(
  request: IncomingMessage,
  quarantinedSockets: WeakSet<IncomingMessage["socket"]>,
): boolean {
  const socket = request.socket as IncomingMessage["socket"] | undefined;
  if (socket === undefined || !quarantinedSockets.has(socket)) return false;
  if (!socket.destroyed) socket.destroy();
  return true;
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.", true);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.", true);
  }
  return length;
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw routeError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Native guard idempotency key is invalid.",
      true,
    );
  }
  return value;
}

type BodyReaderOptions = {
  bodyTimeoutMs: number;
  scheduleTimeout: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout: (handle: unknown) => void;
  getAbortSignal: () => AbortSignal;
};

function readBoundedBody(
  request: IncomingMessage,
  declaredLength: number | undefined,
  options: BodyReaderOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const abortSignal = options.getAbortSignal();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: unknown;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("close", onClose);
      request.off("aborted", onAborted);
      request.off("error", onError);
      abortSignal.removeEventListener("abort", onRuntimeAbort);
      if (timer !== undefined) {
        options.cancelTimeout(timer);
        timer = undefined;
      }
    };
    const fail = (error: ControlRouteError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_BODY_BYTES) {
        fail(
          routeError(
            413,
            "REQUEST_TOO_LARGE",
            "Native guard control request is too large.",
            true,
          ),
        );
        return;
      }
      if (declaredLength !== undefined && size > declaredLength) {
        fail(
          routeError(
            400,
            "INVALID_REQUEST",
            "Native guard control request is invalid.",
            true,
          ),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      if (declaredLength !== undefined && size !== declaredLength) {
        fail(routeError(400, "INVALID_REQUEST", "Native guard control request is invalid."));
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = (): void => {
      fail(routeError(400, "REQUEST_ABORTED", "Native guard control request was aborted."));
    };
    const onError = (): void => {
      fail(routeError(400, "REQUEST_ABORTED", "Native guard control request was aborted."));
    };
    const onClose = (): void => {
      fail(routeError(400, "REQUEST_INCOMPLETE", "Native guard control request is incomplete."));
    };
    const onRuntimeAbort = (): void => {
      fail(routeError(400, "REQUEST_ABORTED", "Native guard control request was aborted."));
    };
    const onTimeout = (): void => {
      fail(
        routeError(
          408,
          "REQUEST_TIMEOUT",
          "Native guard control request timed out.",
          true,
        ),
      );
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("close", onClose);
    request.once("aborted", onAborted);
    request.once("error", onError);
    abortSignal.addEventListener("abort", onRuntimeAbort, { once: true });
    if (abortSignal.aborted) {
      onRuntimeAbort();
      return;
    }
    timer = options.scheduleTimeout(onTimeout, options.bodyTimeoutMs);
    if (settled && timer !== undefined) {
      options.cancelTimeout(timer);
      timer = undefined;
    }
  });
}

function parseRevoke(value: unknown): { leaseId: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("leaseId" in value) ||
    !validLeaseId(value.leaseId)
  ) {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
  return { leaseId: value.leaseId };
}

function validLeaseId(value: unknown): value is string {
  return typeof value === "string" &&
    SAFE_LEASE_ID.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value);
}

function sendStatus(response: ServerResponse, status: NativeGuardStatus): void {
  sendJson(response, 200, projectStatus(status));
}

function sendRouteResponse(
  request: IncomingMessage,
  response: ServerResponse,
  result: RouteResponse,
): void {
  if (result.closeConnection) {
    response.setHeader("Connection", "close");
    if (!request.destroyed) request.resume();
  }
  sendJson(response, result.statusCode, result.body);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function projectStatus(status: NativeGuardStatus): NativeGuardStatus {
  return {
    coverage: status.coverage,
    finalizerAssurance: status.finalizerAssurance,
    activeLeaseCount: status.activeLeaseCount,
    ...(status.pluginVersion === undefined ? {} : { pluginVersion: status.pluginVersion }),
    ...(status.openclawVersion === undefined ? {} : { openclawVersion: status.openclawVersion }),
    ...(status.conflictingPluginIds === undefined
      ? {}
      : { conflictingPluginIds: [...status.conflictingPluginIds] }),
    ...(status.activeLease === undefined
      ? {}
      : {
          activeLease: {
            leaseId: status.activeLease.leaseId,
            leaseEpoch: status.activeLease.leaseEpoch,
            rootSessionKey: status.activeLease.rootSessionKey,
            mode: status.activeLease.mode,
            policyPackId: status.activeLease.policyPackId,
            policyPackDigest: status.activeLease.policyPackDigest,
            expiresAt: status.activeLease.expiresAt,
          },
        }),
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
  };
}

function mapRouteError(
  error: unknown,
  invalidKind: "activation" | "request",
): ControlRouteError {
  if (error instanceof ControlRouteError) return error;
  if (error instanceof AgentGuardRegistrationError) {
    return routeError(
      503,
      "TRUSTED_POLICY_UNATTESTED",
      "Native guard trusted contributions are unattested.",
    );
  }
  if (error instanceof TypeError) {
    return invalidKind === "activation"
      ? routeError(400, "INVALID_ACTIVATION", "Native guard lease activation is invalid.")
      : routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
  if (error instanceof Error && isLeaseConflictMessage(error.message)) {
    return routeError(
      409,
      "LEASE_CONFLICT",
      "Native guard lease state conflicts with the request.",
    );
  }
  return routeError(
    500,
    "NATIVE_GUARD_INTERNAL",
    "Native guard control operation failed.",
  );
}

function isLeaseConflictMessage(message: string): boolean {
  return message === "Native guard lease ID is already registered" ||
    message === "Native guard session is already registered" ||
    message === "Native guard lease is not active" ||
    message === "Native guard lease renewal does not match the active lease" ||
    message === "Native guard lease marker deletion is pending" ||
    message === "Native guard recovery markers conflict" ||
    message === "Native guard recovery activation does not match the guarded marker";
}

function routeError(
  statusCode: number,
  code: ErrorCode,
  message: string,
  closeConnection = false,
): ControlRouteError {
  return new ControlRouteError(statusCode, code, message, closeConnection);
}

type IdempotencyEntry = {
  requestDigest: string;
  promise: Promise<RouteResponse>;
  settled: boolean;
};

class IdempotencyCache {
  readonly #capacity: number;
  readonly #entries = new Map<string, IdempotencyEntry>();

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("Native guard idempotency capacity is invalid");
    }
    this.#capacity = capacity;
  }

  async execute(
    key: string,
    requestDigest: string,
    operation: () => Promise<RouteResponse>,
  ): Promise<RouteResponse> {
    const keyDigest = createHash("sha256").update(key).digest("hex");
    const existing = this.#entries.get(keyDigest);
    if (existing !== undefined) {
      if (existing.requestDigest !== requestDigest) {
        throw routeError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Native guard idempotency key conflicts with another request.",
        );
      }
      this.#entries.delete(keyDigest);
      this.#entries.set(keyDigest, existing);
      return structuredClone(await existing.promise);
    }

    this.#makeRoom();
    const entry: IdempotencyEntry = {
      requestDigest,
      settled: false,
      promise: Promise.resolve().then(operation),
    };
    this.#entries.set(keyDigest, entry);
    entry.promise = entry.promise.then(
      (result) => {
        entry.settled = true;
        if (result.statusCode >= 500) this.#entries.delete(keyDigest);
        return result;
      },
      (error: unknown) => {
        this.#entries.delete(keyDigest);
        throw error;
      },
    );
    return structuredClone(await entry.promise);
  }

  #makeRoom(): void {
    if (this.#entries.size < this.#capacity) return;
    for (const [key, entry] of this.#entries) {
      if (!entry.settled) continue;
      this.#entries.delete(key);
      return;
    }
    throw routeError(
      429,
      "IDEMPOTENCY_CAPACITY",
      "Native guard idempotency capacity is exhausted.",
    );
  }
}
