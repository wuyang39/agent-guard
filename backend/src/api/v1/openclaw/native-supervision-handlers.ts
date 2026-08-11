import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MainAgentSupervisionServiceError,
  type MainAgentSupervisionService,
  type MainAgentSupervisionStatus,
} from "../../../modules/openclaw/mainAgentSupervisionService";
import { failure, success } from "../../response";
import type { NativeSupervisionAccessService } from "../../../modules/openclaw/nativeSupervisionAccessService";

const BASE_PATH = "/api/v1/openclaw/native-supervision";
export const NATIVE_SUPERVISION_CONTROL_COOKIE = "agent_guard_supervision_session";
export const NATIVE_SUPERVISION_EVENTS_COOKIE = "agent_guard_native_events";
const MAX_COOKIE_HEADER_LENGTH = 4096;

const START_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["policyPackId"],
  properties: {
    policyPackId: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const STOP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

export type NativeSupervisionRouteOptions = {
  service: MainAgentSupervisionService;
  accessService: NativeSupervisionAccessService;
  allowedOrigins: readonly string[];
  now?: () => number | Date;
};

export async function openClawNativeSupervisionRoutes(
  app: FastifyInstance,
  options: NativeSupervisionRouteOptions,
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedNativeSupervisionOrigin(request.headers.origin, options.allowedOrigins)) {
      return reply.code(403).send(failure("NATIVE_SUPERVISION_ORIGIN_FORBIDDEN", "Native supervision request origin is not allowed."));
    }
    if (request.method === "OPTIONS" || isNativeSupervisionBootstrapRequest(request.url)) return;
    const control = readNativeSupervisionCookie(request.headers.cookie, NATIVE_SUPERVISION_CONTROL_COOKIE);
    if (!control || !options.accessService.authenticateControl(control)) {
      return reply.code(401).send(failure("NATIVE_SUPERVISION_ACCESS_REQUIRED", "Native supervision control access is required."));
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!isAllowedNativeSupervisionOrigin(request.headers.origin, options.allowedOrigins)) {
      reply.removeHeader("access-control-allow-origin");
      reply.removeHeader("access-control-allow-credentials");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MainAgentSupervisionServiceError) {
      reply.code(error.statusCode);
      return failure(error.code, error.message);
    }
    const fastifyError = error as { code?: string; validation?: unknown };
    if (
      fastifyError.validation !== undefined ||
      fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply.code(400);
      if (isNativeSupervisionBootstrapRequest(request.url)) {
        return failure(
          "NATIVE_SUPERVISION_INVALID_REQUEST",
          "Native supervision request payload is invalid.",
        );
      }
      return failure(
        "MAIN_AGENT_SUPERVISION_INVALID_REQUEST",
        "Main-agent supervision request payload is invalid.",
      );
    }
    reply.code(503);
    return failure(
      "MAIN_AGENT_SUPERVISION_UNAVAILABLE",
      "Main-agent supervision is unavailable.",
    );
  });

  app.get(BASE_PATH, async () => success(sanitizeStatus(
    await options.service.status(),
  )));

  app.post(`${BASE_PATH}/start`, {
    schema: { body: START_SCHEMA },
    preValidation: rejectNonExactStartBody,
  }, async (request) => {
    const { policyPackId } = request.body as { policyPackId: string };
    return success(sanitizeStatus(await options.service.start(policyPackId)));
  });

  app.post(`${BASE_PATH}/stop`, {
    schema: {},
    preValidation: rejectNonEmptyStopBody,
  }, async () => success(sanitizeStatus(await options.service.stop())));

  app.post(`${BASE_PATH}/access/bootstrap`, {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["token"],
        maxProperties: 1,
        properties: { token: { type: "string", minLength: 43, maxLength: 43 } },
      },
    },
    preValidation: rejectExactBootstrapBody,
  }, async (request, reply) => {
    const capability = options.accessService.exchangeBootstrap(
      (request.body as { token: string }).token,
    );
    if (!capability) {
      return reply.code(401).send(failure("NATIVE_SUPERVISION_BOOTSTRAP_INVALID", "Native supervision bootstrap access is invalid."));
    }
    setCapabilityCookie(
      reply,
      NATIVE_SUPERVISION_CONTROL_COOKIE,
      capability,
      BASE_PATH,
      request,
      options.now,
    );
    return reply.code(204).send();
  });

  app.post(`${BASE_PATH}/access/events`, async (request, reply) => {
    const control = readNativeSupervisionCookie(
      request.headers.cookie,
      NATIVE_SUPERVISION_CONTROL_COOKIE,
    );
    const capability = control ? options.accessService.issueEventCapability(control) : undefined;
    if (!capability) {
      return reply.code(401).send(failure("NATIVE_SUPERVISION_ACCESS_REQUIRED", "Native supervision control access is required."));
    }
    setCapabilityCookie(
      reply,
      NATIVE_SUPERVISION_EVENTS_COOKIE,
      capability,
      "/api/v1/openclaw/realtime/events/stream",
      request,
      options.now,
    );
    return reply.code(204).send();
  });
}

async function rejectExactBootstrapBody(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = request.body;
  if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.token !== "string" || body.token.length !== 43) {
    reply.code(400).send(failure("NATIVE_SUPERVISION_INVALID_REQUEST", "Native supervision request payload is invalid."));
  }
}

export function readNativeSupervisionCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return undefined;
  const parts = header.split(";");
  if (parts.length > 64) return undefined;
  let found: string | undefined;
  for (const part of parts) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    if (found !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    found = value;
  }
  return found;
}

export function isAllowedNativeSupervisionOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username === "" && parsed.password === "" && parsed.origin === origin && allowedOrigins.includes(origin);
  } catch { return false; }
}

export function isNativeSupervisionRequest(url: string): boolean {
  return url === BASE_PATH || url.startsWith(`${BASE_PATH}/`) || url.startsWith(`${BASE_PATH}?`);
}

function isNativeSupervisionBootstrapRequest(url: string): boolean {
  const path = `${BASE_PATH}/access/bootstrap`;
  return url === path || url.startsWith(`${path}?`);
}

function setCapabilityCookie(
  reply: FastifyReply,
  name: string,
  capability: { token: string; expiresAtMs: number },
  path: string,
  request: FastifyRequest,
  now: (() => number | Date) | undefined,
): void {
  const maxAge = Math.max(0, Math.floor(
    (capability.expiresAtMs - readNow(now)) / 1_000,
  ));
  const secure = request.protocol === "https";
  reply.header(
    "set-cookie",
    `${name}=${capability.token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}${secure ? "; Secure" : ""}`,
  );
}

function readNow(now: (() => number | Date) | undefined): number {
  const value = now?.() ?? Date.now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError("now must return a valid millisecond timestamp");
  }
  return milliseconds;
}

async function rejectNonExactStartBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.policyPackId !== "string" ||
    body.policyPackId.length < START_SCHEMA.properties.policyPackId.minLength ||
    body.policyPackId.length > START_SCHEMA.properties.policyPackId.maxLength
  ) {
    reply.code(400).send(invalidRequest());
  }
}

async function rejectNonEmptyStopBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (
    request.body !== undefined &&
    (!isRecord(request.body) || Object.keys(request.body).length > STOP_SCHEMA.maxProperties)
  ) {
    reply.code(400).send(invalidRequest());
  }
}

function invalidRequest() {
  return failure(
    "MAIN_AGENT_SUPERVISION_INVALID_REQUEST",
    "Main-agent supervision request payload is invalid.",
  );
}

function sanitizeStatus(status: MainAgentSupervisionStatus): MainAgentSupervisionStatus {
  return {
    coverage: status.coverage,
    scope: { kind: "agent", agentId: "main" },
    ...(status.policyPackId === undefined ? {} : { policyPackId: status.policyPackId }),
    ...(status.leaseId === undefined ? {} : { leaseId: status.leaseId }),
    ...(status.leaseEpoch === undefined ? {} : { leaseEpoch: status.leaseEpoch }),
    ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
    ...(status.gatewayInstanceId === undefined
      ? {}
      : { gatewayInstanceId: status.gatewayInstanceId }),
    activeLeaseCount: status.activeLeaseCount,
    mainLeaseCount: status.mainLeaseCount,
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
