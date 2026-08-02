import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import type { PluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentGuardRuntime } from "./runtime";

const ACTIVATE_PATH = "/agent-guard/native-guard/v1/leases/activate";
const RENEW_PATH = "/agent-guard/native-guard/v1/leases/renew";
const REVOKE_PATH = "/agent-guard/native-guard/v1/leases/revoke";
const STATUS_PATH = "/agent-guard/native-guard/v1/status";
const MAX_BODY_BYTES = 64 * 1024;
const SAFE_LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ErrorCode =
  | "INVALID_ACTIVATION"
  | "INVALID_REQUEST"
  | "LEASE_CONFLICT"
  | "METHOD_NOT_ALLOWED"
  | "NATIVE_GUARD_INTERNAL"
  | "REQUEST_ABORTED"
  | "REQUEST_TOO_LARGE"
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
export type LifecycleApi = Pick<PluginApi, "on" | "registerService">;
export type AgentGuardPluginApi = ControlRouteApi & LifecycleApi;

export function registerAgentGuardPlugin(
  api: AgentGuardPluginApi,
  runtime: AgentGuardRuntime,
): void {
  registerControlRoutes(api, runtime);
  registerAgentGuardLifecycle(api, runtime);
}

export function registerAgentGuardLifecycle(
  api: LifecycleApi,
  runtime: AgentGuardRuntime,
): void {
  api.registerService({
    id: "agent-guard-runtime",
    start: async () => runtime.start(),
    stop: async () => runtime.stop(),
  });
  api.on("subagent_spawned", async (event, context) => {
    const parentSessionKey = context.requesterSessionKey;
    if (parentSessionKey === undefined) return;
    const parent = await runtime.lookup(parentSessionKey);
    if (parent.state !== "active") return;
    await runtime.bindChild(parent.leaseId, parentSessionKey, event.childSessionKey);
  });
  api.on("subagent_ended", async (event) => {
    await runtime.endSession(event.targetSessionKey);
  });
  api.on("session_end", async (event, context) => {
    const sessionKey = event.sessionKey ?? context.sessionKey;
    if (sessionKey !== undefined) await runtime.endSession(sessionKey);
  });
}

export function registerControlRoutes(api: ControlRouteApi, runtime: AgentGuardRuntime): void {
  api.registerHttpRoute({
    path: ACTIVATE_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      await handleRoute(request, response, "POST", "activation", async () => {
        const body = await readJson(request) as NativeGuardLeaseActivation;
        sendStatus(response, await runtime.activate(body));
      });
    },
  });
  api.registerHttpRoute({
    path: RENEW_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      await handleRoute(request, response, "POST", "activation", async () => {
        const body = await readJson(request) as NativeGuardLeaseActivation;
        sendStatus(response, await runtime.renew(body));
      });
    },
  });
  api.registerHttpRoute({
    path: REVOKE_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      await handleRoute(request, response, "POST", "request", async () => {
        const body = parseRevoke(await readJson(request));
        await runtime.revoke(body.leaseId);
        sendStatus(response, await runtime.status());
      });
    },
  });
  api.registerHttpRoute({
    path: STATUS_PATH,
    auth: "gateway",
    match: "exact",
    handler: async (request, response) => {
      await handleRoute(request, response, "GET", "request", async () => {
        sendStatus(response, await runtime.status());
      });
    },
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
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
  const contents = await readBoundedBody(request, declaredLength);
  if (contents.length === 0) {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return JSON.parse(text) as unknown;
  } catch {
    throw routeError(400, "INVALID_REQUEST", "Native guard control request is invalid.");
  }
}

async function handleRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: "GET" | "POST",
  invalidKind: "activation" | "request",
  operation: () => Promise<void>,
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

function readBoundedBody(
  request: IncomingMessage,
  declaredLength: number | undefined,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
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

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
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
