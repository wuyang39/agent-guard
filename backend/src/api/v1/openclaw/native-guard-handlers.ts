import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  NativeGuardEvent,
  NativeGuardStatus,
  NativeToolDecisionRequest,
} from "@agent-guard/contracts";
import type { AgentConnectionConfig } from "../../types";
import {
  createNativeGuardCoordinator,
  type ActivateNativeGuardInput,
  type NativeGuardCoordinator,
} from "../../../modules/openclaw/nativeGuardCoordinator";
import {
  createNativeGuardLeaseService,
  type NativeGuardLeaseService,
} from "../../../modules/openclaw/nativeGuardLeaseService";
import {
  createNativeToolDecisionService,
  type NativeToolDecisionService,
} from "../../../modules/openclaw/nativeToolDecisionService";
import {
  createNativeGuardEventStore,
  type NativeGuardEventStore,
} from "../../../storage/nativeGuardEventStore";
import {
  createOpenClawControlClient,
  type OpenClawControlClient,
} from "../../../modules/openclaw/openclawControlClient";
import {
  controlTokenMatches,
  parseLeaseBearer,
  resolveNativeGuardAllowedOrigins,
} from "../../../modules/openclaw/nativeGuardAuth";
import { getActiveAgentConfig } from "../../../storage/agentConfigStore";
import { failure, success } from "../../response";

const BASE_PATH = "/api/v1/openclaw/native-guard";
const DECISION_PATH = "/api/v1/openclaw/native-guard/decision";

export type NativeGuardRouteDependencies = {
  controlToken?: string;
  allowedOrigins: readonly string[];
  coordinator: Pick<
    NativeGuardCoordinator,
    "activate" | "renew" | "revoke" | "status" | "isLeaseUsable" | "getLastStatus"
  >;
  leaseService: Pick<
    NativeGuardLeaseService,
    "authenticate" | "resolveBySession"
  >;
  decisionService: NativeToolDecisionService;
  eventStore: Pick<NativeGuardEventStore, "append">;
};

export type NativeGuardRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  coordinator?: NativeGuardCoordinator;
  leaseService?: NativeGuardLeaseService;
  eventStore?: NativeGuardEventStore;
  controlClient?: OpenClawControlClient;
  createDecisionService?: typeof createNativeToolDecisionService;
  loadActiveAgentConfig?: () => Promise<AgentConnectionConfig>;
  createCoordinator?: typeof createNativeGuardCoordinator;
};

export function createNativeGuardRouteDependencies(
  options: NativeGuardRuntimeOptions = {},
): NativeGuardRouteDependencies {
  const env = options.env ?? process.env;
  const leaseService = options.leaseService ?? createNativeGuardLeaseService();
  const eventStore = options.eventStore ?? createNativeGuardEventStore();
  const controlClient = options.controlClient ?? createOpenClawControlClient({ env });
  const coordinator = options.coordinator ?? createLazyNativeGuardCoordinator({
    env,
    leaseService,
    controlClient,
    loadActiveAgentConfig:
      options.loadActiveAgentConfig ?? getActiveAgentConfig,
    createCoordinator:
      options.createCoordinator ?? createNativeGuardCoordinator,
  });
  const guardedEventStore = createLeaseUsabilityEventAppender(
    coordinator,
    eventStore,
  );
  const decisionService = (options.createDecisionService ?? createNativeToolDecisionService)({
    leaseService,
    eventStore: guardedEventStore,
    beforeSign: async (request) => {
      assertNativeGuardLeaseUsable(coordinator, request.leaseId);
    },
  });

  return {
    controlToken: resolveNativeGuardControlToken(env),
    allowedOrigins: resolveNativeGuardAllowedOrigins(env),
    coordinator,
    leaseService,
    decisionService,
    eventStore: guardedEventStore,
  };
}

export function resolveNativeGuardControlToken(
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.AGENT_GUARD_CONTROL_TOKEN) return env.AGENT_GUARD_CONTROL_TOKEN;
  if (
    env.AGENT_GUARD_BROWSER_DEV === "1" &&
    env.NODE_ENV !== "production" &&
    env.AGENT_GUARD_DESKTOP === undefined
  ) {
    return env.VITE_AGENT_GUARD_CONTROL_TOKEN || undefined;
  }
  return undefined;
}

export function resolveNativeGuardDecisionUrl(env: NodeJS.ProcessEnv): string {
  const configured = env.AGENT_GUARD_NATIVE_GUARD_BACKEND_URL;
  if (configured !== undefined) return validateNativeGuardDecisionUrl(configured);

  const rawPort = env.API_PORT ?? "3100";
  if (!/^\d{1,5}$/.test(rawPort)) throw backendUrlInvalid();
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw backendUrlInvalid();
  }
  return `http://127.0.0.1:${String(port)}${DECISION_PATH}`;
}

type LazyCoordinatorOptions = {
  env: NodeJS.ProcessEnv;
  leaseService: NativeGuardLeaseService;
  controlClient: OpenClawControlClient;
  loadActiveAgentConfig: () => Promise<AgentConnectionConfig>;
  createCoordinator: typeof createNativeGuardCoordinator;
};

type NativeRuntimeIdentity = {
  key: string;
  gatewayUrl: string;
  backendUrl: string;
  capabilityInput: {
    cliPath?: string;
    isolatedProfile: boolean;
  };
};

function createLazyNativeGuardCoordinator(
  options: LazyCoordinatorOptions,
): NativeGuardCoordinator {
  let current: NativeGuardCoordinator | undefined;
  let currentIdentity: string | undefined;
  let resolving: Promise<NativeGuardCoordinator> | undefined;

  async function resolveCoordinator(): Promise<NativeGuardCoordinator> {
    if (resolving) return resolving;
    resolving = resolveFreshCoordinator().finally(() => {
      resolving = undefined;
    });
    return resolving;
  }

  async function resolveFreshCoordinator(): Promise<NativeGuardCoordinator> {
    let activeAgent: AgentConnectionConfig;
    try {
      activeAgent = await options.loadActiveAgentConfig();
    } catch {
      throw runtimeConfigError(
        "NATIVE_GUARD_ACTIVE_AGENT_INVALID",
        "Native guard active agent configuration is unavailable.",
      );
    }
    const identity = resolveNativeRuntimeIdentity(options.env, activeAgent);
    if (current && currentIdentity === identity.key) return current;
    if (current && current.getLastStatus().activeLeaseCount > 0) {
      throw runtimeConfigError(
        "NATIVE_GUARD_ACTIVE_AGENT_CHANGED",
        "Native guard active agent changed while a lease is managed.",
      );
    }
    const created = options.createCoordinator({
      leaseService: options.leaseService,
      controlClient: options.controlClient,
      gatewayUrl: identity.gatewayUrl,
      backendUrl: identity.backendUrl,
      capabilityInput: identity.capabilityInput,
    });
    current = created;
    currentIdentity = identity.key;
    return created;
  }

  return {
    async activate(input) {
      return (await resolveCoordinator()).activate(input);
    },
    async renew(leaseId, ttlMs) {
      return (await resolveCoordinator()).renew(leaseId, ttlMs);
    },
    async revoke(leaseId) {
      return (await resolveCoordinator()).revoke(leaseId);
    },
    async status() {
      return (await resolveCoordinator()).status();
    },
    isLeaseUsable(leaseId) {
      try {
        return current?.isLeaseUsable(leaseId) === true;
      } catch {
        return false;
      }
    },
    isLeaseRevoking(leaseId) {
      try {
        return current?.isLeaseRevoking(leaseId) === true;
      } catch {
        return false;
      }
    },
    getLastStatus() {
      return current
        ? current.getLastStatus()
        : structuredClone(OFF_NATIVE_GUARD_STATUS);
    },
  };
}

function resolveNativeRuntimeIdentity(
  env: NodeJS.ProcessEnv,
  activeAgent: AgentConnectionConfig,
): NativeRuntimeIdentity {
  if (activeAgent.adapterKind !== "openclaw" || !activeAgent.agentId?.trim()) {
    throw runtimeConfigError(
      "NATIVE_GUARD_ACTIVE_AGENT_INVALID",
      "Native guard requires an active OpenClaw agent.",
    );
  }
  const gatewayUrl = nonEmpty(env.OPENCLAW_GATEWAY_URL)
    ? env.OPENCLAW_GATEWAY_URL
    : activeAgent.gatewayUrl;
  if (!nonEmpty(gatewayUrl)) {
    throw runtimeConfigError(
      "NATIVE_GUARD_ACTIVE_AGENT_INVALID",
      "Native guard active OpenClaw gateway is unavailable.",
    );
  }
  const cliPath = nonEmpty(env.OPENCLAW_CLI)
    ? env.OPENCLAW_CLI
    : activeAgent.openclawCliPath;
  const backendUrl = resolveNativeGuardDecisionUrl(env);
  const isolatedProfile = env.AGENT_GUARD_OPENCLAW_ISOLATED_PROFILE === "1";
  return {
    key: JSON.stringify([
      activeAgent.agentId,
      cliPath ?? null,
      gatewayUrl,
      backendUrl,
      isolatedProfile,
    ]),
    gatewayUrl,
    backendUrl,
    capabilityInput: {
      ...(cliPath ? { cliPath } : {}),
      isolatedProfile,
    },
  };
}

function validateNativeGuardDecisionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw backendUrlInvalid();
  }
  const hostname = url.hostname.toLowerCase();
  const port = url.port === "" ? 80 : Number(url.port);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== DECISION_PATH ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw backendUrlInvalid();
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export class NativeGuardRuntimeConfigurationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeGuardRuntimeConfigurationError";
  }
}

function backendUrlInvalid(): NativeGuardRuntimeConfigurationError {
  return runtimeConfigError(
    "NATIVE_GUARD_BACKEND_URL_INVALID",
    "Native guard decision backend URL is invalid.",
  );
}

function runtimeConfigError(
  code: string,
  message: string,
): NativeGuardRuntimeConfigurationError {
  return new NativeGuardRuntimeConfigurationError(code, message);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

const OFF_NATIVE_GUARD_STATUS: NativeGuardStatus = {
  coverage: "off",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
};

export class NativeGuardLeaseNotUsableError extends Error {
  readonly code = "NATIVE_GUARD_LEASE_NOT_USABLE";

  constructor() {
    super("Native guard lease is not active.");
    this.name = "NativeGuardLeaseNotUsableError";
  }
}

export function createLeaseUsabilityEventAppender(
  coordinator: Pick<NativeGuardCoordinator, "isLeaseUsable">,
  eventStore: Pick<NativeGuardEventStore, "append">,
): Pick<NativeGuardEventStore, "append"> {
  return {
    async append(event, record) {
      assertNativeGuardLeaseUsable(coordinator, event.leaseId);
      return eventStore.append(event, record);
    },
  };
}

export function assertNativeGuardLeaseUsable(
  coordinator: Pick<NativeGuardCoordinator, "isLeaseUsable">,
  leaseId: string,
): void {
  if (!coordinator.isLeaseUsable(leaseId)) {
    throw new NativeGuardLeaseNotUsableError();
  }
}

export async function openClawNativeGuardRoutes(
  app: FastifyInstance,
  dependencies: NativeGuardRouteDependencies,
): Promise<void> {
  const leaseBearers = new WeakMap<object, string>();
  const requireControlToken = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (controlTokenMatches(
      dependencies.controlToken,
      request.headers["x-agent-guard-control-token"],
    )) return;
    return reply.code(401).send(failure(
      "NATIVE_GUARD_UNAUTHORIZED",
      "Native guard authentication failed.",
    ));
  };
  app.addHook("onRequest", async (request, reply) => {
    if (originAllowed(request.headers.origin, dependencies.allowedOrigins)) return;
    return reply.code(403).send(failure(
      "NATIVE_GUARD_ORIGIN_FORBIDDEN",
      "Native guard request origin is not allowed.",
    ));
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (!originAllowed(request.headers.origin, dependencies.allowedOrigins)) {
      reply.removeHeader("access-control-allow-origin");
      reply.removeHeader("access-control-allow-credentials");
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const fastifyError = error as { code?: string; validation?: unknown };
    if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413);
      return failure(
        "NATIVE_GUARD_BODY_TOO_LARGE",
        "Native guard request body exceeds the allowed size.",
      );
    }
    if (
      fastifyError.validation !== undefined ||
      fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply.code(400);
      return failure(
        "NATIVE_GUARD_INVALID_REQUEST",
        "Native guard request payload is invalid.",
      );
    }
    reply.code(500);
    return failure(
      "NATIVE_GUARD_INTERNAL_ERROR",
      "Native guard request failed.",
    );
  });

  app.options(`${BASE_PATH}/*`, async (request, reply) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Agent-Guard-Control-Token",
      );
      reply.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    return reply.code(204).send();
  });

  app.get(`${BASE_PATH}/status`, {
    onRequest: requireControlToken,
  }, async () => {
    return success(sanitizeNativeGuardStatus(await dependencies.coordinator.status()));
  });

  app.post(`${BASE_PATH}/leases`, {
    schema: { body: ACTIVATE_LEASE_SCHEMA },
    onRequest: requireControlToken,
  }, async (request) => success(sanitizeNativeGuardStatus(
    await dependencies.coordinator.activate(request.body as ActivateNativeGuardInput),
  )));

  app.post(`${BASE_PATH}/leases/:leaseId/renew`, {
    schema: {
      params: LEASE_PARAMS_SCHEMA,
      body: RENEW_LEASE_SCHEMA,
    },
    onRequest: requireControlToken,
  }, async (request) => {
    const { leaseId } = request.params as { leaseId: string };
    const { ttlMs } = request.body as { ttlMs?: number };
    return success(sanitizeNativeGuardStatus(
      await dependencies.coordinator.renew(leaseId, ttlMs),
    ));
  });

  app.delete(`${BASE_PATH}/leases/:leaseId`, {
    schema: { params: LEASE_PARAMS_SCHEMA },
    onRequest: requireControlToken,
  }, async (request) => {
    const { leaseId } = request.params as { leaseId: string };
    return success(sanitizeNativeGuardStatus(
      await dependencies.coordinator.revoke(leaseId),
    ));
  });

  app.post(`${BASE_PATH}/decision`, {
    bodyLimit: 256 * 1024,
    schema: { body: DECISION_REQUEST_SCHEMA },
    onRequest: async (request, reply) => {
      const credential = parseLeaseBearer(request.headers.authorization);
      if (!credential) {
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      leaseBearers.set(request, credential);
    },
    preHandler: async (request, reply) => {
      const credential = leaseBearers.get(request);
      const { leaseId } = request.body as { leaseId: string };
      if (credential && dependencies.leaseService.authenticate(leaseId, credential)) return;
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    },
  }, async (request, reply) => {
    const body = request.body as NativeToolDecisionRequest;
    const { leaseId } = body;
    if (!dependencies.coordinator.isLeaseUsable(leaseId)) {
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LEASE_NOT_USABLE",
        "Native guard lease is not active.",
      ));
    }
    const credential = leaseBearers.get(request);
    if (!credential) {
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    let result: Awaited<ReturnType<NativeToolDecisionService["decide"]>>;
    try {
      result = await dependencies.decisionService.decide(body, credential);
    } catch {
      return reply.code(503).send(failure(
        "NATIVE_GUARD_DECISION_FAILED",
        "Native guard decision could not be completed.",
      ));
    }
    if (!dependencies.coordinator.isLeaseUsable(leaseId)) {
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LEASE_NOT_USABLE",
        "Native guard lease is not active.",
      ));
    }
    return success(result.response);
  });

  app.post(`${BASE_PATH}/events/batch`, {
    bodyLimit: 1024 * 1024,
    schema: { body: EVENT_BATCH_SCHEMA },
    onRequest: async (request, reply) => {
      const credential = parseLeaseBearer(request.headers.authorization);
      if (!credential) {
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      leaseBearers.set(request, credential);
    },
    preHandler: async (request, reply) => {
      const credential = leaseBearers.get(request);
      const { events } = request.body as { events: NativeGuardEvent[] };
      const leaseIds = new Set(events.map(({ leaseId }) => leaseId));
      if (leaseIds.size !== 1) {
        return reply.code(400).send(failure(
          "NATIVE_GUARD_INVALID_REQUEST",
          "Native guard request payload is invalid.",
        ));
      }
      if (
        credential &&
        events.every((event) =>
          eventSessionAuthenticates(dependencies.leaseService, event, credential))
      ) return;
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    },
  }, async (request, reply) => {
    const credential = leaseBearers.get(request);
    if (!credential) {
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    const { events } = request.body as { events: NativeGuardEvent[] };
    for (const event of events) {
      const safeEvent = scrubExactSecret(event, credential) as NativeGuardEvent;
      if (!eventSessionAuthenticates(
        dependencies.leaseService,
        event,
        credential,
      )) {
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      if (!dependencies.coordinator.isLeaseUsable(event.leaseId)) {
        return reply.code(409).send(failure(
          "NATIVE_GUARD_LEASE_NOT_USABLE",
          "Native guard lease is not active.",
        ));
      }
      try {
        await dependencies.eventStore.append(safeEvent);
      } catch {
        return reply.code(503).send(failure(
          "NATIVE_GUARD_EVENT_BATCH_FAILED",
          "Native guard events could not be persisted.",
        ));
      }
    }
    for (const event of events) {
      if (!eventSessionAuthenticates(
        dependencies.leaseService,
        event,
        credential,
      )) {
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      if (!dependencies.coordinator.isLeaseUsable(event.leaseId)) {
        return reply.code(409).send(failure(
          "NATIVE_GUARD_LEASE_NOT_USABLE",
          "Native guard lease is not active.",
        ));
      }
    }
    return success({ accepted: events.length });
  });
}

function eventSessionAuthenticates(
  leaseService: Pick<
    NativeGuardLeaseService,
    "authenticate" | "resolveBySession"
  >,
  event: NativeGuardEvent,
  credential: string,
): boolean {
  try {
    const authenticated = leaseService.authenticate(event.leaseId, credential);
    const sessionLease = leaseService.resolveBySession(event.sessionKey);
    return Boolean(
      authenticated &&
      sessionLease &&
      authenticated.leaseId === event.leaseId &&
      sessionLease.leaseId === authenticated.leaseId &&
      sessionLease.leaseEpoch === authenticated.leaseEpoch,
    );
  } catch {
    return false;
  }
}

export function scrubExactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) {
    return value.map((item) => scrubExactSecret(item, secret));
  }
  if (typeof value === "object" && value !== null) {
    const safeEntries: Array<[string, unknown]> = [];
    const safeKeys = new Set<string>();
    for (const [key, item] of Object.entries(value)) {
      const safeKey = key.replaceAll(secret, "[REDACTED]");
      if (safeKeys.has(safeKey)) {
        throw new NativeGuardSecretScrubConflictError();
      }
      safeKeys.add(safeKey);
      safeEntries.push([safeKey, scrubExactSecret(item, secret)]);
    }
    return Object.fromEntries(safeEntries);
  }
  return value;
}

export class NativeGuardSecretScrubConflictError extends Error {
  readonly code = "NATIVE_GUARD_SECRET_SCRUB_CONFLICT";

  constructor() {
    super("Native guard evidence keys conflict after secret scrubbing.");
    this.name = "NativeGuardSecretScrubConflictError";
  }
}

const ACTIVATE_LEASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rootSessionKey", "mode"],
  properties: {
    rootSessionKey: { type: "string", minLength: 1, maxLength: 512 },
    mode: { type: "string", enum: ["detection", "supervision"] },
    policyPackId: { type: "string", minLength: 1, maxLength: 256 },
    ttlMs: { type: "integer", minimum: 1, maximum: 900_000 },
  },
} as const;

const LEASE_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leaseId"],
  properties: {
    leaseId: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    },
  },
} as const;

const RENEW_LEASE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ttlMs: { type: "integer", minimum: 1, maximum: 900_000 },
  },
} as const;

const DECISION_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "requestId",
    "leaseId",
    "leaseEpoch",
    "sessionKey",
    "toolCallId",
    "toolName",
    "params",
    "paramsDigest",
    "requestedAt",
  ],
  properties: {
    schemaVersion: { const: "native-guard-1" },
    requestId: { type: "string", minLength: 1, maxLength: 256 },
    leaseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    leaseEpoch: { type: "integer", minimum: 1 },
    sessionKey: { type: "string", minLength: 1, maxLength: 512 },
    runId: { type: "string", minLength: 1, maxLength: 256 },
    toolCallId: { type: "string", minLength: 1, maxLength: 256 },
    toolName: { type: "string", minLength: 1, maxLength: 256 },
    toolKind: { type: "string", minLength: 1, maxLength: 128 },
    toolInputKind: { type: "string", minLength: 1, maxLength: 128 },
    providerId: { type: "string", minLength: 1, maxLength: 256 },
    params: { type: "object", maxProperties: 1_000 },
    paramsDigest: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    derivedPaths: {
      type: "array",
      maxItems: 256,
      items: { type: "string", maxLength: 4_096 },
    },
    requestedAt: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const EVENT_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "schemaVersion",
          "eventId",
          "type",
          "leaseId",
          "sessionKey",
          "timestamp",
          "detail",
        ],
        properties: {
          schemaVersion: { const: "native-guard-1" },
          eventId: { type: "string", minLength: 1, maxLength: 256 },
          type: {
            type: "string",
            enum: [
              "lease_activated",
              "lease_renewed",
              "lease_recovery",
              "lease_revoked",
              "decision",
              "approval_requested",
              "approval_resolved",
              "tool_outcome",
              "sandbox_attested",
              "coverage_changed",
            ],
          },
          leaseId: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
          },
          sessionKey: { type: "string", minLength: 1, maxLength: 512 },
          runId: { type: "string", minLength: 1, maxLength: 256 },
          toolCallId: { type: "string", minLength: 1, maxLength: 256 },
          decisionId: { type: "string", minLength: 1, maxLength: 256 },
          timestamp: { type: "string", minLength: 1, maxLength: 64 },
          detail: { type: "object", maxProperties: 1_000 },
        },
      },
    },
  },
} as const;

export type PublicNativeGuardStatus = Pick<
  NativeGuardStatus,
  | "coverage"
  | "finalizerAssurance"
  | "pluginVersion"
  | "openclawVersion"
  | "activeLeaseCount"
  | "conflictingPluginIds"
  | "reasonCode"
> & {
  activeLease?: Omit<NonNullable<NativeGuardStatus["activeLease"]>, "rootSessionKey">;
};

export function sanitizeNativeGuardStatus(
  status: NativeGuardStatus,
): PublicNativeGuardStatus {
  const safe: PublicNativeGuardStatus = {
    coverage: status.coverage,
    finalizerAssurance: status.finalizerAssurance,
    activeLeaseCount: status.activeLeaseCount,
    ...(status.pluginVersion ? { pluginVersion: status.pluginVersion } : {}),
    ...(status.openclawVersion ? { openclawVersion: status.openclawVersion } : {}),
    ...(status.conflictingPluginIds
      ? { conflictingPluginIds: [...status.conflictingPluginIds] }
      : {}),
    ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}),
  };
  if (status.activeLease) {
    const { rootSessionKey: _rootSessionKey, ...publicLease } = status.activeLease;
    safe.activeLease = publicLease;
  }
  return structuredClone(safe);
}

function originAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}
