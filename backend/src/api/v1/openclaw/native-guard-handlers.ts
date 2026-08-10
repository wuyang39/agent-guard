import { randomUUID, type KeyObject } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  NativeGuardEvidenceProof,
  NativeGuardEvent,
  NativeGuardStatus,
  NativeToolDecisionRequest,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
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
  type InspectOpenClawCapabilitiesInput,
  type OpenClawControlClient,
} from "../../../modules/openclaw/openclawControlClient";
import {
  createOpenClawHostCapabilityCache,
  type OpenClawHostCapabilityCache,
} from "../../../modules/openclaw/openclawHostCapabilityCache";
import {
  readHostGatewayAttestationBootstrap,
} from "../../../modules/openclaw/hostGatewayAttestationBootstrap";
import {
  controlTokenMatches,
  parseLeaseBearer,
  resolveNativeGuardAllowedOrigins,
} from "../../../modules/openclaw/nativeGuardAuth";
import { getActiveAgentConfig } from "../../../storage/agentConfigStore";
import { failure, success } from "../../response";

const BASE_PATH = "/api/v1/openclaw/native-guard";
const DECISION_PATH = "/api/v1/openclaw/native-guard/decision";
const MAX_DECISION_PARAMETER_BYTES = 256 * 1024;
const MAX_DECISION_ENVELOPE_BYTES = 64 * 1024;
const MAX_DECISION_BODY_BYTES = MAX_DECISION_PARAMETER_BYTES + MAX_DECISION_ENVELOPE_BYTES;
const MAX_DECISION_PARAMETER_KEYS = 4_096;
export const HOST_NATIVE_GUARD_CAPABILITY_TIMEOUT_MS = 60_000;

export type NativeGuardRouteDependencies = {
  controlToken?: string;
  allowedOrigins: readonly string[];
  coordinator: Pick<
    NativeGuardCoordinator,
    | "activate"
    | "activateWithIdentity"
    | "renew"
    | "revoke"
    | "status"
    | "isLeaseUsable"
    | "isLeaseEvidenceUsable"
    | "hasManagedLeases"
    | "markLeaseRootEnded"
    | "getLastStatus"
  >;
  leaseService: Pick<
    NativeGuardLeaseService,
    | "authenticate"
    | "authenticateEvidence"
    | "verifyEvidenceRequest"
    | "releaseEvidenceRequest"
    | "signEvidenceAcknowledgement"
    | "recoverEvidenceAcknowledgement"
    | "authorizeEvidence"
    | "resolveBySession"
    | "bindChildWithEvidence"
    | "endSessionWithEvidence"
  >;
  decisionService: NativeToolDecisionService;
  eventStore: Pick<NativeGuardEventStore, "append">;
  /** Full store shared with guarded E2E readers; never replace with a fallback. */
  runtimeEventStore: NativeGuardEventStore;
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
  warmupHostCapability?: boolean;
};

export function createNativeGuardRouteDependencies(
  options: NativeGuardRuntimeOptions = {},
): NativeGuardRouteDependencies {
  const env = options.env ?? process.env;
  const leaseService = options.leaseService ?? createNativeGuardLeaseService();
  const eventStore = options.eventStore ?? createNativeGuardEventStore();
  const controlClient = options.controlClient ?? createOpenClawControlClient({
    env,
    capabilityTimeoutMs: HOST_NATIVE_GUARD_CAPABILITY_TIMEOUT_MS,
  });
  const hostCapabilityCache = createOpenClawHostCapabilityCache();
  const coordinator = options.coordinator ?? createLazyNativeGuardCoordinator({
    env,
    leaseService,
    controlClient,
    hostCapabilityCache,
    loadActiveAgentConfig:
      options.loadActiveAgentConfig ?? getActiveAgentConfig,
    createCoordinator:
      options.createCoordinator ?? createNativeGuardCoordinator,
  });
  const warmupHostCapability = options.warmupHostCapability ?? (
    options.coordinator === undefined &&
    options.controlClient === undefined &&
    options.loadActiveAgentConfig === undefined &&
    options.createCoordinator === undefined
  );
  if (warmupHostCapability) {
    queueMicrotask(() => {
      void coordinator.status().catch(() => undefined);
    });
  }
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
    runtimeEventStore: eventStore,
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
  hostCapabilityCache: OpenClawHostCapabilityCache;
  loadActiveAgentConfig: () => Promise<AgentConnectionConfig>;
  createCoordinator: typeof createNativeGuardCoordinator;
};

type NativeRuntimeIdentity = {
  key: string;
  gatewayUrl: string;
  backendUrl: string;
  capabilityInput: InspectOpenClawCapabilitiesInput;
  gatewayAttestationPublicKey?: KeyObject;
};

function createLazyNativeGuardCoordinator(
  options: LazyCoordinatorOptions,
): NativeGuardCoordinator {
  let current: NativeGuardCoordinator | undefined;
  let currentIdentity: string | undefined;
  let resolutionTail = Promise.resolve();
  const inFlightByCoordinator = new Map<NativeGuardCoordinator, number>();
  const leaseOwners = new Map<string, NativeGuardCoordinator>();

  async function reserveCoordinator(): Promise<NativeGuardCoordinator> {
    const previousResolution = resolutionTail;
    let releaseResolution!: () => void;
    resolutionTail = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    await previousResolution;
    try {
      const coordinator = await resolveFreshCoordinator();
      retainCoordinator(coordinator);
      return coordinator;
    } finally {
      releaseResolution();
    }
  }

  function retainCoordinator(coordinator: NativeGuardCoordinator): void {
    inFlightByCoordinator.set(
      coordinator,
      (inFlightByCoordinator.get(coordinator) ?? 0) + 1,
    );
  }

  function releaseCoordinator(coordinator: NativeGuardCoordinator): void {
    const remaining = (inFlightByCoordinator.get(coordinator) ?? 1) - 1;
    if (remaining > 0) {
      inFlightByCoordinator.set(coordinator, remaining);
      return;
    }
    inFlightByCoordinator.delete(coordinator);
  }

  async function delegate<T>(
    operation: (coordinator: NativeGuardCoordinator) => Promise<T>,
  ): Promise<T> {
    const coordinator = await reserveCoordinator();
    try {
      return await operation(coordinator);
    } finally {
      releaseCoordinator(coordinator);
    }
  }

  async function delegateToOwner<T>(
    coordinator: NativeGuardCoordinator,
    operation: (coordinator: NativeGuardCoordinator) => Promise<T>,
  ): Promise<T> {
    retainCoordinator(coordinator);
    try {
      return await operation(coordinator);
    } finally {
      releaseCoordinator(coordinator);
    }
  }

  function revokeCleanupConfirmed(
    coordinator: NativeGuardCoordinator,
    leaseId: string,
    status: NativeGuardStatus,
  ): boolean {
    if (
      status.activeLease?.leaseId === leaseId ||
      status.activeLeases?.some((lease) => lease.leaseId === leaseId) ||
      (status.activeLeaseCount > 0 &&
        status.activeLease === undefined &&
        status.activeLeases === undefined)
    ) {
      return false;
    }
    try {
      return !coordinator.isLeaseUsable(leaseId) &&
        !coordinator.isLeaseEvidenceUsable(leaseId) &&
        !coordinator.isLeaseRevoking(leaseId);
    } catch {
      return false;
    }
  }

  function reconcileLeaseOwners(
    coordinator: NativeGuardCoordinator,
    status: NativeGuardStatus,
  ): void {
    for (const [leaseId, owner] of leaseOwners) {
      if (owner === coordinator && revokeCleanupConfirmed(owner, leaseId, status)) {
        leaseOwners.delete(leaseId);
      }
    }
  }

  async function activateWithOwner(input: ActivateNativeGuardInput): Promise<{
    status: NativeGuardStatus;
    leaseId: string;
    leaseEpoch: number;
  }> {
    return delegate(async (coordinator) => {
      const activation = await coordinator.activateWithIdentity(input);
      leaseOwners.set(activation.leaseId, coordinator);
      return activation;
    });
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
    if (current && (inFlightByCoordinator.get(current) ?? 0) > 0) {
      throw runtimeConfigError(
        "NATIVE_GUARD_ACTIVE_AGENT_CHANGED",
        "Native guard active agent changed during a management operation.",
      );
    }
    if (current && current.hasManagedLeases()) {
      throw runtimeConfigError(
        "NATIVE_GUARD_ACTIVE_AGENT_CHANGED",
        "Native guard active agent changed while a lease is managed.",
      );
    }
    if (currentIdentity) options.hostCapabilityCache.invalidate(currentIdentity);
    const cachedControlClient = options.hostCapabilityCache.wrap(
      identity.key,
      options.controlClient,
    );
    const created = options.createCoordinator({
      leaseService: options.leaseService,
      controlClient: cachedControlClient,
      gatewayUrl: identity.gatewayUrl,
      backendUrl: identity.backendUrl,
      capabilityInput: identity.capabilityInput,
      gatewayAttestationPublicKey: identity.gatewayAttestationPublicKey,
    });
    current = created;
    currentIdentity = identity.key;
    return created;
  }

  return {
    async activate(input) {
      return (await activateWithOwner(input)).status;
    },
    async activateWithIdentity(input) {
      return activateWithOwner(input);
    },
    async renew(leaseId, ttlMs) {
      const owner = leaseOwners.get(leaseId);
      if (owner) {
        return delegateToOwner(owner, (coordinator) => coordinator.renew(leaseId, ttlMs));
      }
      return delegate((coordinator) => coordinator.renew(leaseId, ttlMs));
    },
    async revoke(leaseId) {
      const owner = leaseOwners.get(leaseId);
      if (owner) {
        const status = await delegateToOwner(
          owner,
          (coordinator) => coordinator.revoke(leaseId),
        );
        if (revokeCleanupConfirmed(owner, leaseId, status)) {
          leaseOwners.delete(leaseId);
        }
        return status;
      }
      return delegate((coordinator) => coordinator.revoke(leaseId));
    },
    async status() {
      return delegate(async (coordinator) => {
        const status = await coordinator.status();
        reconcileLeaseOwners(coordinator, status);
        return status;
      });
    },
    isLeaseUsable(leaseId) {
      try {
        return current?.isLeaseUsable(leaseId) === true;
      } catch {
        return false;
      }
    },
    isLeaseEvidenceUsable(leaseId) {
      try {
        return current?.isLeaseEvidenceUsable(leaseId) === true;
      } catch {
        return false;
      }
    },
    hasManagedLeases() {
      try {
        return current?.hasManagedLeases() === true;
      } catch {
        return false;
      }
    },
    markLeaseRootEnded(leaseId) {
      try {
        return current?.markLeaseRootEnded(leaseId) === true;
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
  const profileEnv = resolveOpenClawProfileEnv(env);
  let hostBootstrap: ReturnType<typeof readHostGatewayAttestationBootstrap> | undefined;
  const hostBootstrapFile = nonEmpty(env.AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE)
    ? env.AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE
    : undefined;
  if (hostBootstrapFile) {
    try {
      hostBootstrap = readHostGatewayAttestationBootstrap(hostBootstrapFile);
    } catch {
      throw runtimeConfigError(
        "NATIVE_GUARD_HOST_ATTESTATION_INVALID",
        "Native guard host Gateway attestation bootstrap is invalid.",
      );
    }
  }
  return {
    key: JSON.stringify([
      activeAgent.agentId,
      cliPath ?? null,
      gatewayUrl,
      backendUrl,
      isolatedProfile,
      profileEnv.OPENCLAW_HOME ?? null,
      profileEnv.OPENCLAW_CONFIG_PATH ?? null,
      profileEnv.OPENCLAW_STATE_DIR ?? null,
      hostBootstrap?.keyFingerprint ?? null,
    ]),
    gatewayUrl,
    backendUrl,
    capabilityInput: {
      ...(cliPath ? { cliPath } : {}),
      ...(Object.keys(profileEnv).length > 0 ? { env: profileEnv } : {}),
      isolatedProfile,
      liveRegistry: true,
    },
    ...(hostBootstrap
      ? {
          gatewayAttestationPublicKey: hostBootstrap.attestationPublicKey,
        }
      : {}),
  };
}

function resolveOpenClawProfileEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const profileEnv: Record<string, string> = {};
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_STATE_DIR",
  ] as const) {
    if (nonEmpty(env[key])) profileEnv[key] = env[key];
  }
  return profileEnv;
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
  coordinator: Pick<NativeGuardCoordinator, "isLeaseEvidenceUsable">,
  eventStore: Pick<NativeGuardEventStore, "append">,
): Pick<NativeGuardEventStore, "append"> {
  return {
    async append(event, record) {
      if (!coordinator.isLeaseEvidenceUsable(event.leaseId)) {
        throw new NativeGuardLeaseNotUsableError();
      }
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
    bodyLimit: MAX_DECISION_BODY_BYTES,
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

  app.post(`${BASE_PATH}/lifecycle/bind-child`, {
    bodyLimit: 16 * 1024,
    schema: { body: LIFECYCLE_BIND_SCHEMA },
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
  }, async (request, reply) => {
    const credential = leaseBearers.get(request);
    const body = request.body as Parameters<NativeGuardLeaseService["bindChildWithEvidence"]>[0];
    const proof = parseEvidenceProofHeader(request.headers["x-agent-guard-evidence-proof"]);
    const bodyDigest = digestEvidenceBody(body);
    const cached = credential && proof && bodyDigest
      ? dependencies.leaseService.recoverEvidenceAcknowledgement(
          proof,
          `${BASE_PATH}/lifecycle/bind-child`,
          bodyDigest,
          credential,
        )
      : undefined;
    if (cached !== undefined) return success(cached);
    const verified = credential && proof && bodyDigest
      ? dependencies.leaseService.verifyEvidenceRequest(
          body.leaseId,
          credential,
          proof,
          `${BASE_PATH}/lifecycle/bind-child`,
          bodyDigest,
        )
      : undefined;
    if (!credential || !proof || !verified) {
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    if (!dependencies.coordinator.isLeaseEvidenceUsable(body.leaseId)) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LEASE_NOT_USABLE",
        "Native guard lease is not active.",
      ));
    }
    if (!dependencies.leaseService.bindChildWithEvidence(body, credential)) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LIFECYCLE_CONFLICT",
        "Native guard lifecycle binding does not match the active lease.",
      ));
    }
    try {
      return success(dependencies.leaseService.signEvidenceAcknowledgement(body.leaseId, {
        schemaVersion: "native-guard-1",
        signatureContext: "native_guard.evidence_ack.v1",
        ackId: `ack.${randomUUID()}`,
        ackType: "child_bound",
        proofId: verified.proofId,
        leaseId: body.leaseId,
        leaseEpoch: verified.leaseEpoch,
        bodyDigest: verified.bodyDigest,
        acknowledgedAt: new Date().toISOString(),
      }));
    } catch {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(503).send(failure(
        "NATIVE_GUARD_LIFECYCLE_CONFLICT",
        "Native guard lifecycle acknowledgement could not be signed.",
      ));
    }
  });

  app.post(`${BASE_PATH}/lifecycle/end-session`, {
    bodyLimit: 16 * 1024,
    schema: { body: LIFECYCLE_END_SCHEMA },
    onRequest: async (request, reply) => {
      const credential = parseLeaseBearer(request.headers.authorization);
      if (credential) leaseBearers.set(request, credential);
    },
  }, async (request, reply) => {
    const credential = leaseBearers.get(request);
    const body = request.body as Parameters<NativeGuardLeaseService["endSessionWithEvidence"]>[0];
    const proof = parseEvidenceProofHeader(request.headers["x-agent-guard-evidence-proof"]);
    const bodyDigest = digestEvidenceBody(body);
    const cached = proof && bodyDigest
      ? dependencies.leaseService.recoverEvidenceAcknowledgement(
          proof,
          `${BASE_PATH}/lifecycle/end-session`,
          bodyDigest,
          credential,
        )
      : undefined;
    if (cached !== undefined) return success(cached);
    const verified = credential && proof && bodyDigest
      ? dependencies.leaseService.verifyEvidenceRequest(
          body.leaseId,
          credential,
          proof,
          `${BASE_PATH}/lifecycle/end-session`,
          bodyDigest,
        )
      : undefined;
    if (!credential || !proof || !verified) {
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    if (!dependencies.coordinator.isLeaseEvidenceUsable(body.leaseId)) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LEASE_NOT_USABLE",
        "Native guard lease is not active.",
      ));
    }
    const evidenceLease = dependencies.leaseService.authenticateEvidence(body.leaseId, credential);
    if (!dependencies.leaseService.endSessionWithEvidence(body, credential)) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LIFECYCLE_CONFLICT",
        "Native guard lifecycle end does not match the active lease.",
      ));
    }
    if (
      evidenceLease?.rootSessionKey === body.sessionKey &&
      !dependencies.coordinator.markLeaseRootEnded(body.leaseId)
    ) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(409).send(failure(
        "NATIVE_GUARD_LEASE_NOT_USABLE",
        "Native guard lease is not active.",
      ));
    }
    try {
      return success(dependencies.leaseService.signEvidenceAcknowledgement(body.leaseId, {
        schemaVersion: "native-guard-1",
        signatureContext: "native_guard.evidence_ack.v1",
        ackId: `ack.${randomUUID()}`,
        ackType: "session_ended",
        proofId: verified.proofId,
        leaseId: body.leaseId,
        leaseEpoch: verified.leaseEpoch,
        bodyDigest: verified.bodyDigest,
        acknowledgedAt: new Date().toISOString(),
      }));
    } catch {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(503).send(failure(
        "NATIVE_GUARD_LIFECYCLE_CONFLICT",
        "Native guard lifecycle acknowledgement could not be signed.",
      ));
    }
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
          eventEvidenceAuthenticates(dependencies.leaseService, event, credential))
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
    const proof = parseEvidenceProofHeader(request.headers["x-agent-guard-evidence-proof"]);
    const bodyDigest = digestEvidenceBody({ events });
    const leaseId = events[0]?.leaseId;
    const verified = credential && proof && bodyDigest && leaseId
      ? dependencies.leaseService.verifyEvidenceRequest(
          leaseId,
          credential,
          proof,
          `${BASE_PATH}/events/batch`,
          bodyDigest,
        )
      : undefined;
    if (!verified || !proof) {
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    for (const event of events) {
      const safeEvent = scrubExactSecret(event, credential) as NativeGuardEvent;
      if (!eventEvidenceAuthenticates(
        dependencies.leaseService,
        event,
        credential,
      )) {
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      if (!dependencies.coordinator.isLeaseEvidenceUsable(event.leaseId)) {
        return reply.code(409).send(failure(
          "NATIVE_GUARD_LEASE_NOT_USABLE",
          "Native guard lease is not active.",
        ));
      }
      try {
        await dependencies.eventStore.append(safeEvent);
      } catch {
        dependencies.leaseService.releaseEvidenceRequest(verified);
        return reply.code(503).send(failure(
          "NATIVE_GUARD_EVENT_BATCH_FAILED",
          "Native guard events could not be persisted.",
        ));
      }
    }
    for (const event of events) {
      if (!eventEvidenceAuthenticates(
        dependencies.leaseService,
        event,
        credential,
      )) {
        dependencies.leaseService.releaseEvidenceRequest(verified);
        return reply.code(401).send(failure(
          "NATIVE_GUARD_UNAUTHORIZED",
          "Native guard authentication failed.",
        ));
      }
      if (!dependencies.coordinator.isLeaseEvidenceUsable(event.leaseId)) {
        dependencies.leaseService.releaseEvidenceRequest(verified);
        return reply.code(409).send(failure(
          "NATIVE_GUARD_LEASE_NOT_USABLE",
          "Native guard lease is not active.",
        ));
      }
    }
    const currentEvidence = dependencies.leaseService.authenticateEvidence(leaseId, credential);
    if (
      currentEvidence === undefined ||
      currentEvidence.leaseEpoch !== verified.leaseEpoch ||
      currentEvidence.evidenceSigningKeyId !== proof.keyId
    ) {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(401).send(failure(
        "NATIVE_GUARD_UNAUTHORIZED",
        "Native guard authentication failed.",
      ));
    }
    try {
      return success(dependencies.leaseService.signEvidenceAcknowledgement(leaseId, {
        schemaVersion: "native-guard-1",
        signatureContext: "native_guard.evidence_ack.v1",
        ackId: `ack.${randomUUID()}`,
        ackType: "events_accepted",
        proofId: verified.proofId,
        leaseId,
        leaseEpoch: verified.leaseEpoch,
        bodyDigest: verified.bodyDigest,
        accepted: events.length,
        eventIdsDigest: digestJson(events.map(({ eventId }) => eventId)),
        acknowledgedAt: new Date().toISOString(),
      }));
    } catch {
      dependencies.leaseService.releaseEvidenceRequest(verified);
      return reply.code(503).send(failure(
        "NATIVE_GUARD_EVENT_BATCH_FAILED",
        "Native guard events could not be acknowledged.",
      ));
    }
  });
}

function parseEvidenceProofHeader(value: string | string[] | undefined): NativeGuardEvidenceProof | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return undefined;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.length > 3_072 || bytes.toString("base64url") !== value) {
      return undefined;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as NativeGuardEvidenceProof;
  } catch {
    return undefined;
  }
}

function digestEvidenceBody(value: unknown): string | undefined {
  try {
    return digestJson(value);
  } catch {
    return undefined;
  }
}

function eventEvidenceAuthenticates(
  leaseService: Pick<
    NativeGuardLeaseService,
    "authorizeEvidence"
  >,
  event: NativeGuardEvent,
  credential: string,
): boolean {
  try {
    return leaseService.authorizeEvidence(
      event.leaseId,
      event.leaseEpoch,
      event.sessionKey,
      credential,
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
    params: { type: "object", maxProperties: MAX_DECISION_PARAMETER_KEYS },
    paramsDigest: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    derivedPaths: {
      type: "array",
      maxItems: 256,
      items: { type: "string", maxLength: 4_096 },
    },
    requestedAt: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

const LIFECYCLE_BIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leaseId", "leaseEpoch", "parentSessionKey", "childSessionKey"],
  properties: {
    leaseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    leaseEpoch: { type: "integer", minimum: 1 },
    parentSessionKey: { type: "string", minLength: 1, maxLength: 512 },
    childSessionKey: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const LIFECYCLE_END_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["leaseId", "leaseEpoch", "sessionKey"],
  properties: {
    leaseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    leaseEpoch: { type: "integer", minimum: 1 },
    sessionKey: { type: "string", minLength: 1, maxLength: 512 },
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
          "leaseEpoch",
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
          leaseEpoch: { type: "integer", minimum: 1 },
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
