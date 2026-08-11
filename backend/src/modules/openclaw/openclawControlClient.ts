import { createHash, type KeyObject } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeGuardLeaseSummary,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import {
  buildOpenClawProcessEnv,
  resolveOpenClawCliInvocation,
} from "../agent/openclawAdapter";
import {
  isCompatibleNativeGuardVersion,
  parseNativeGuardGatewayAttestation,
  parseNativeGuardLiveCapability,
  type NativeGuardGatewayAttestation,
} from "./nativeGuardLiveCapability";
import { normalizeNativeGuardLeaseScope } from "@agent-guard/native-guard-protocol";

const STATUS_PATH = "/agent-guard/native-guard/v1/status";
const GATEWAY_ATTESTATION_PATH = "/agent-guard/native-guard/v1/gateway-attestation";
const ACTIVATE_PATH = "/agent-guard/native-guard/v1/leases/activate";
const RENEW_PATH = "/agent-guard/native-guard/v1/leases/renew";
const REVOKE_PATH = "/agent-guard/native-guard/v1/leases/revoke";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CAPABILITY_INVENTORY_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 16 * 1024;
const RESPONSE_CANCEL_TIMEOUT_MS = 25;
const AGENT_GUARD_PLUGIN_ID = "agent-guard-supervision";
const TRUSTED_TOOL_POLICY_ID = "agent-guard-admission";
const AGENT_GUARD_SERVICE_ID = "agent-guard-runtime";
const GATEWAY_INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const AGENT_GUARD_ROUTE_PATHS = new Set([
  ACTIVATE_PATH,
  RENEW_PATH,
  REVOKE_PATH,
  STATUS_PATH,
]);
const LEGACY_ROUTE_CONFLICT =
  /^http route already registered: ([^\s()]+) \((?:exact|prefix)\) by [^\s()]+ \([^()\r\n]+\)$/i;
const LEGACY_SERVICE_CONFLICT =
  /^service already registered: ([^\s()]+) \([^\s()]+\)$/i;
const LEGACY_POLICY_CONFLICT =
  /^trusted tool policy already registered: ([^\s()]+) \([^\s()]+\)$/i;
const LEGACY_HOOK_CONFLICT =
  /^hook already registered: ([^\s()]+) \(([^\s()]+)\)$/i;

export type NativeGuardFinalizerAssurance = NativeGuardStatus["finalizerAssurance"];

export type NativeGuardCapability = {
  openclawVersion: string;
  supportsNativeGuard: boolean;
  finalizerAssurance: NativeGuardFinalizerAssurance;
  conflictingPluginIds: string[];
  gatewayInstanceId?: string;
};

export type InspectOpenClawCapabilitiesInput = {
  cliPath?: string;
  env?: Record<string, string>;
  isolatedProfile: boolean;
  liveRegistry?: boolean;
  inheritProcessEnv?: boolean;
  signal?: AbortSignal;
};

export type AttestOpenClawGatewayInput = {
  signal?: AbortSignal;
  gatewayUrl: string;
  challenge: string;
  attestationPublicKey: KeyObject;
};

export type OpenClawCommandInput = {
  command: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};

export type OpenClawCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type OpenClawCommandRunner = (
  input: OpenClawCommandInput,
) => Promise<OpenClawCommandResult>;

export type OpenClawControlClient = {
  status(gatewayUrl: string): Promise<NativeGuardStatus>;
  inspectCapabilities(input: InspectOpenClawCapabilitiesInput): Promise<NativeGuardCapability>;
  attestGateway(input: AttestOpenClawGatewayInput): Promise<NativeGuardGatewayAttestation>;
  activate(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  renew(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  revoke(gatewayUrl: string, leaseId: string): Promise<NativeGuardStatus>;
};

export type OpenClawControlClientOptions = {
  gatewayToken?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  capabilityTimeoutMs?: number;
  commandRunner?: OpenClawCommandRunner;
};

export class OpenClawControlClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OpenClawControlClientError";
  }
}

export function createOpenClawControlClient(
  options: OpenClawControlClientOptions = {},
): OpenClawControlClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const capabilityTimeoutMs = positiveInteger(
    options.capabilityTimeoutMs ?? timeoutMs,
    "capabilityTimeoutMs",
  );
  const commandRunner = options.commandRunner ?? runCommand;

  async function request(
    gatewayUrl: string,
    path: string,
    operation?: "activate" | "renew" | "revoke",
    body?: NativeGuardLeaseActivation | { leaseId: string },
  ): Promise<NativeGuardStatus> {
    const url = controlUrl(gatewayUrl, path);
    const token = resolveGatewayToken(options);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const headers = new Headers({
        authorization: `Bearer ${token}`,
        "cache-control": "no-store",
        accept: "application/json",
      });
      if (body) headers.set("content-type", "application/json");
      if (operation && body) {
        const leaseId = body.leaseId;
        const epoch = "leaseEpoch" in body ? body.leaseEpoch : 0;
        headers.set("x-idempotency-key", idempotencyKey(operation, leaseId, epoch));
      }

      const response = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        controller.abort();
        await cancelResponseBody(response);
        throw controlError(
          "OPENCLAW_CONTROL_HTTP_ERROR",
          `OpenClaw control endpoint returned HTTP ${String(response.status)}.`,
        );
      }
      const value = await readLimitedJson(response, controller.signal);
      return parseNativeGuardStatus(value);
    } catch (error) {
      if (error instanceof OpenClawControlClientError) {
        throw controlError(error.code, safeControlErrorMessage(error.code));
      }
      if (timedOut || controller.signal.aborted) {
        throw controlError("OPENCLAW_CONTROL_TIMEOUT", "OpenClaw control request timed out.");
      }
      throw controlError("OPENCLAW_CONTROL_UNAVAILABLE", "OpenClaw control endpoint is unavailable.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status(gatewayUrl: string): Promise<NativeGuardStatus> {
      return request(gatewayUrl, STATUS_PATH);
    },

    async inspectCapabilities(
      input: InspectOpenClawCapabilitiesInput,
    ): Promise<NativeGuardCapability> {
      let cli: ReturnType<typeof resolveOpenClawCliInvocation>;
      try {
        cli = resolveOpenClawCliInvocation(input.cliPath);
      } catch {
        throw controlError("OPENCLAW_CLI_UNAVAILABLE", "OpenClaw CLI could not be resolved.");
      }

      const env = buildOpenClawProcessEnv({
        ...cli.env,
        ...input.env,
      }, input.inheritProcessEnv ?? true);
      const versionResult = await executeCli(
        commandRunner,
        cli,
        ["--version"],
        env,
        capabilityTimeoutMs,
        MAX_RESPONSE_BYTES,
        input.signal,
      );
      const liveRegistry = input.liveRegistry ?? !input.isolatedProfile;
      const pluginArgs = liveRegistry
        ? ["plugins", "list", "--json", "--live"]
        : ["plugins", "list", "--enabled", "--json"];
      const pluginResult = await executeCli(
        commandRunner,
        cli,
        pluginArgs,
        env,
        capabilityTimeoutMs,
        MAX_CAPABILITY_INVENTORY_BYTES,
        input.signal,
      );
      const openclawVersion = parseVersion(versionResult.stdout);
      const inventory = parsePluginList(pluginResult.stdout);
      const liveCapability = parseNativeGuardLiveCapability(inventory.raw);
      const plugins = inventory.plugins;
      const agentGuard = plugins.find((plugin) => plugin.id === AGENT_GUARD_PLUGIN_ID);
      const agentGuardHasBeforeHook = Boolean(
        agentGuard?.enabled && hasBeforeToolCallHook(agentGuard.raw),
      );
      const agentGuardReady = Boolean(
        agentGuard?.enabled &&
        hasHealthyPluginStatus(agentGuard.raw) &&
        (liveRegistry || hasTrustedToolPolicyContract(agentGuard.raw)) &&
        !inventory.diagnostics.some(isAgentGuardErrorDiagnostic),
      );
      const conflicts = plugins
        .filter((plugin) =>
          plugin.enabled &&
          plugin.id !== AGENT_GUARD_PLUGIN_ID &&
          hasBeforeToolCallHook(plugin.raw))
        .map((plugin) => plugin.id)
        .sort();
      const enabledIds = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
      const isolatedInventoryReady =
        enabledIds.length === 1 && enabledIds[0] === AGENT_GUARD_PLUGIN_ID;
      const hostInventoryReady =
        liveCapability !== undefined && agentGuardHasBeforeHook;
      const supportsNativeGuard =
        isCompatibleNativeGuardVersion(openclawVersion) &&
        agentGuardReady &&
        (liveRegistry ? hostInventoryReady : isolatedInventoryReady);

      let finalizerAssurance: NativeGuardFinalizerAssurance = "unverified";
      if (supportsNativeGuard) {
        if (!liveRegistry && input.isolatedProfile) {
          finalizerAssurance = "isolated_profile";
        } else if (conflicts.length === 0) {
          finalizerAssurance = "exclusive_before_hook";
        }
      }

      return {
        openclawVersion,
        supportsNativeGuard,
        finalizerAssurance,
        conflictingPluginIds: conflicts,
      };
    },

    async attestGateway(
      input: AttestOpenClawGatewayInput,
    ): Promise<NativeGuardGatewayAttestation> {
      if (!/^[A-Za-z0-9_-]{32}$/.test(input.challenge)) {
        throw controlError(
          "OPENCLAW_CONTROL_INVALID_CHALLENGE",
          "OpenClaw Gateway attestation challenge is invalid.",
        );
      }
      const gatewayUrl = controlUrl(input.gatewayUrl, "");
      const url = controlUrl(gatewayUrl, GATEWAY_ATTESTATION_PATH);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onParentAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", onParentAbort, { once: true });
      try {
        if (input.signal?.aborted) controller.abort();
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${resolveGatewayToken(options)}`,
            "cache-control": "no-store",
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ challenge: input.challenge }),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          controller.abort();
          await cancelResponseBody(response);
          throw controlError(
            "OPENCLAW_CONTROL_HTTP_ERROR",
            `OpenClaw control endpoint returned HTTP ${String(response.status)}.`,
          );
        }
        const value = await readLimitedJson(response, controller.signal);
        const attestation = parseNativeGuardGatewayAttestation(value, {
          gatewayUrl,
          challenge: input.challenge,
          attestationPublicKey: input.attestationPublicKey,
        });
        if (!attestation) {
          throw controlError(
            "OPENCLAW_CONTROL_INVALID_RESPONSE",
            "OpenClaw Gateway attestation was invalid.",
          );
        }
        return attestation;
      } catch (error) {
        if (error instanceof OpenClawControlClientError) {
          throw controlError(error.code, safeControlErrorMessage(error.code));
        }
        if (timedOut) {
          throw controlError("OPENCLAW_CONTROL_TIMEOUT", "OpenClaw control request timed out.");
        }
        if (input.signal?.aborted) {
          throw controlError("OPENCLAW_CONTROL_CANCELLED", "OpenClaw control request was cancelled.");
        }
        throw controlError("OPENCLAW_CONTROL_UNAVAILABLE", "OpenClaw control endpoint is unavailable.");
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onParentAbort);
      }
    },

    activate(
      gatewayUrl: string,
      activation: NativeGuardLeaseActivation,
    ): Promise<NativeGuardStatus> {
      return request(gatewayUrl, ACTIVATE_PATH, "activate", activation);
    },

    renew(
      gatewayUrl: string,
      activation: NativeGuardLeaseActivation,
    ): Promise<NativeGuardStatus> {
      return request(gatewayUrl, RENEW_PATH, "renew", activation);
    },

    revoke(gatewayUrl: string, leaseId: string): Promise<NativeGuardStatus> {
      if (!leaseId.trim()) {
        return Promise.reject(controlError("OPENCLAW_CONTROL_INVALID_LEASE", "Lease id is required."));
      }
      return request(gatewayUrl, REVOKE_PATH, "revoke", { leaseId });
    },
  };
}

function controlUrl(gatewayUrl: string, path: string): string {
  if (!/^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^?#]*)?(?:[?#].*)?$/i.test(gatewayUrl)) {
    throw controlError(
      "OPENCLAW_CONTROL_INVALID_GATEWAY",
      "OpenClaw gateway must be an unambiguous loopback URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw controlError("OPENCLAW_CONTROL_INVALID_GATEWAY", "OpenClaw gateway URL is invalid.");
  }
  const protocol = url.protocol === "ws:"
    ? "http:"
    : url.protocol === "wss:"
      ? "https:"
      : url.protocol;
  const hostname = url.hostname.toLowerCase();
  if (
    (protocol !== "http:" && protocol !== "https:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw controlError(
      "OPENCLAW_CONTROL_INVALID_GATEWAY",
      "OpenClaw gateway must be an unambiguous loopback URL.",
    );
  }
  return `${protocol}//${url.host}${path}`;
}

function resolveGatewayToken(options: OpenClawControlClientOptions): string {
  const token = options.gatewayToken ?? options.env?.OPENCLAW_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof token !== "string" || !token.trim()) {
    throw controlError("OPENCLAW_CONTROL_AUTH_REQUIRED", "OpenClaw gateway authentication is required.");
  }
  return token.trim();
}

function idempotencyKey(operation: string, leaseId: string, epoch: number): string {
  return createHash("sha256")
    .update(`agent-guard-native:${operation}:${leaseId}:${String(epoch)}`)
    .digest("base64url");
}

async function readLimitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get("content-encoding") !== null) {
    await cancelResponseBody(response);
    throw controlError(
      "OPENCLAW_CONTROL_INVALID_RESPONSE",
      "OpenClaw control response used an unsupported content encoding.",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      await cancelResponseBody(response);
      throw controlError(
        "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE",
        "OpenClaw control response exceeded the size limit.",
      );
    }
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim();
  if (mediaType !== "application/json") {
    await cancelResponseBody(response);
    throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control response was not JSON.");
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await boundedBestEffort(() => reader.cancel());
        throw controlError(
          "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE",
          "OpenClaw control response exceeded the size limit.",
        );
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control response was invalid.");
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error("OpenClaw control request aborted.");
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
      reject(new Error("OpenClaw control request aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function parseNativeGuardStatus(value: unknown): NativeGuardStatus {
  if (!isRecord(value)) {
    throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control status was invalid.");
  }
  const allowedKeys = new Set([
    "coverage",
    "finalizerAssurance",
    "pluginVersion",
    "openclawVersion",
    "gatewayInstanceId",
    "activeLeaseCount",
    "activeLeases",
    "activeLease",
    "conflictingPluginIds",
    "reasonCode",
    "detail",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalidControlStatus();
  const coverageValues: NativeGuardStatus["coverage"][] = [
    "off", "ready", "active", "recovery", "conditional", "unsupported", "misconfigured",
  ];
  const assuranceValues: NativeGuardFinalizerAssurance[] = [
    "isolated_profile", "exclusive_before_hook", "unverified",
  ];
  if (
    !coverageValues.includes(value.coverage as NativeGuardStatus["coverage"]) ||
    !assuranceValues.includes(value.finalizerAssurance as NativeGuardFinalizerAssurance) ||
    !Number.isSafeInteger(value.activeLeaseCount) ||
    (value.activeLeaseCount as number) < 0 ||
    !optionalString(value.pluginVersion) ||
    !optionalString(value.openclawVersion) ||
    !optionalString(value.gatewayInstanceId) ||
    !optionalString(value.reasonCode) ||
    !optionalString(value.detail) ||
    !optionalStringArray(value.conflictingPluginIds)
  ) {
    throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control status was invalid.");
  }
  const hasActiveLeases = Object.hasOwn(value, "activeLeases");
  const activeLeaseCount = value.activeLeaseCount as number;
  let activeLeases: NativeGuardLeaseSummary[] | undefined;
  let activeLease: NativeGuardLeaseSummary | Omit<NativeGuardLeaseSummary, "scope"> | undefined;
  if (hasActiveLeases) {
    if (!Array.isArray(value.activeLeases)) invalidControlStatus();
    activeLeases = value.activeLeases.map((entry) => parseLeaseSummary(entry, true));
    if (activeLeases.length !== activeLeaseCount) invalidControlStatus();
    if (new Set(activeLeases.map((entry) => entry.leaseId)).size !== activeLeases.length) {
      invalidControlStatus();
    }
    if (activeLeases.length === 1) {
      const singular = parseLeaseSummary(value.activeLease, true);
      if (!sameLeaseSummary(singular, activeLeases[0])) invalidControlStatus();
      activeLease = singular;
    } else if (value.activeLease !== undefined) {
      invalidControlStatus();
    }
  } else if (value.activeLease !== undefined) {
    activeLease = parseLeaseSummary(value.activeLease, false);
  }
  if (!hasActiveLeases) {
    if (
      activeLeaseCount > 1 ||
      (activeLeaseCount === 0 && activeLease !== undefined) ||
      (activeLeaseCount === 1 && activeLease === undefined)
    ) {
      invalidControlStatus();
    }
  }
  const parsedBase = {
    coverage: value.coverage as NativeGuardStatus["coverage"],
    finalizerAssurance: value.finalizerAssurance as NativeGuardFinalizerAssurance,
    activeLeaseCount,
    ...(typeof value.pluginVersion === "string" ? { pluginVersion: value.pluginVersion } : {}),
    ...(typeof value.openclawVersion === "string" ? { openclawVersion: value.openclawVersion } : {}),
    ...(typeof value.gatewayInstanceId === "string"
      ? { gatewayInstanceId: value.gatewayInstanceId }
      : {}),
    ...(Array.isArray(value.conflictingPluginIds)
      ? { conflictingPluginIds: [...value.conflictingPluginIds] as string[] }
      : {}),
    ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
  if (activeLeases !== undefined) {
    return {
      ...parsedBase,
      activeLeases,
      ...(activeLease ? { activeLease: activeLease as NativeGuardLeaseSummary } : {}),
    };
  }
  return { ...parsedBase, ...(activeLease ? { activeLease } : {}) };
}

function parseLeaseSummary(
  value: unknown,
  requireScope: true,
): NativeGuardLeaseSummary;
function parseLeaseSummary(
  value: unknown,
  requireScope: false,
): NativeGuardLeaseSummary | Omit<NativeGuardLeaseSummary, "scope">;
function parseLeaseSummary(
  value: unknown,
  requireScope: boolean,
): NativeGuardLeaseSummary | Omit<NativeGuardLeaseSummary, "scope"> {
  if (
    !isRecord(value) ||
    nonEmptyString(value.leaseId) === false ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) <= 0 ||
    nonEmptyString(value.rootSessionKey) === false ||
    (value.mode !== "detection" && value.mode !== "supervision") ||
    nonEmptyString(value.policyPackId) === false ||
    nonEmptyString(value.policyPackDigest) === false ||
    nonEmptyString(value.expiresAt) === false ||
    (value.gatewayInstanceId !== undefined &&
      (typeof value.gatewayInstanceId !== "string" ||
        !GATEWAY_INSTANCE_ID_PATTERN.test(value.gatewayInstanceId)))
  ) {
    return invalidControlStatus();
  }
  const hasScope = Object.hasOwn(value, "scope");
  const allowedKeys = new Set([
    "leaseId",
    "leaseEpoch",
    "rootSessionKey",
    "scope",
    "gatewayInstanceId",
    "mode",
    "policyPackId",
    "policyPackDigest",
    "expiresAt",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) invalidControlStatus();
  if (requireScope && !hasScope) invalidControlStatus();
  if (hasScope && !validLeaseScope(value.scope, value.rootSessionKey as string)) {
    invalidControlStatus();
  }
  const base: Omit<NativeGuardLeaseSummary, "scope"> = {
    leaseId: value.leaseId as string,
    leaseEpoch: value.leaseEpoch as number,
    rootSessionKey: value.rootSessionKey as string,
    ...(typeof value.gatewayInstanceId === "string"
      ? { gatewayInstanceId: value.gatewayInstanceId }
      : {}),
    mode: value.mode as NativeGuardLeaseSummary["mode"],
    policyPackId: value.policyPackId as string,
    policyPackDigest: value.policyPackDigest as string,
    expiresAt: value.expiresAt as string,
  };
  return hasScope
    ? { ...base, scope: cloneLeaseScope(value.scope as NativeGuardLeaseScope) }
    : base;
}

function validLeaseScope(scope: unknown, rootSessionKey: string): scope is NativeGuardLeaseScope {
  if (scope === "session_tree") return scopeNormalizes(scope, rootSessionKey);
  if (!isRecord(scope)) return false;
  if (scope.kind === "session") {
    return Object.keys(scope).length === 2 &&
      Object.hasOwn(scope, "sessionKey") &&
      nonEmptyString(scope.sessionKey) &&
      scope.sessionKey === rootSessionKey &&
      scopeNormalizes(scope as NativeGuardLeaseScope, rootSessionKey);
  }
  return scope.kind === "agent" &&
    Object.keys(scope).length === 2 &&
    Object.hasOwn(scope, "agentId") &&
    scope.agentId === "main" &&
    rootSessionKey === "agent:main:main" &&
    scopeNormalizes(scope as NativeGuardLeaseScope, rootSessionKey);
}

function scopeNormalizes(scope: NativeGuardLeaseScope, rootSessionKey: string): boolean {
  try {
    normalizeNativeGuardLeaseScope(scope, rootSessionKey);
    return true;
  } catch {
    return false;
  }
}

function cloneLeaseScope(scope: NativeGuardLeaseScope): NativeGuardLeaseScope {
  return typeof scope === "string" ? scope : { ...scope };
}

function sameLeaseSummary(
  left: NativeGuardLeaseSummary,
  right: NativeGuardLeaseSummary,
): boolean {
  return left.leaseId === right.leaseId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.rootSessionKey === right.rootSessionKey &&
    JSON.stringify(left.scope) === JSON.stringify(right.scope) &&
    left.gatewayInstanceId === right.gatewayInstanceId &&
    left.mode === right.mode &&
    left.policyPackId === right.policyPackId &&
    left.policyPackDigest === right.policyPackDigest &&
    left.expiresAt === right.expiresAt;
}

function invalidControlStatus(): never {
  throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control status was invalid.");
}

type ParsedPlugin = { id: string; enabled: boolean; raw: Record<string, unknown> };
type ParsedPluginDiagnostic = {
  level: "info" | "warn" | "error";
  message: string;
  pluginId?: string;
};
type ParsedPluginInventory = {
  plugins: ParsedPlugin[];
  diagnostics: ParsedPluginDiagnostic[];
  raw: unknown;
};

function parsePluginList(stdout: string): ParsedPluginInventory {
  assertOutputLimit(stdout, MAX_CAPABILITY_INVENTORY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  const inventory = isRecord(value) ? value : undefined;
  const entries = Array.isArray(value)
    ? value
    : inventory && Array.isArray(inventory.plugins)
      ? inventory.plugins
      : undefined;
  if (
    !entries ||
    !entries.every((entry) =>
      isRecord(entry) &&
      nonEmptyString(entry.id) &&
      validPluginFailureFields(entry))
  ) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  const ids = entries.map((entry) => entry.id as string);
  if (new Set(ids).size !== ids.length) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  const diagnostics: ParsedPluginDiagnostic[] = [];
  if (inventory && Object.hasOwn(inventory, "diagnostics")) {
    diagnostics.push(...parsePluginDiagnostics(inventory.diagnostics));
  }
  if (inventory && Object.hasOwn(inventory, "registry")) {
    if (!isRecord(inventory.registry)) {
      throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
    }
    if (Object.hasOwn(inventory.registry, "diagnostics")) {
      diagnostics.push(...parsePluginDiagnostics(inventory.registry.diagnostics));
    }
  }
  return {
    plugins: entries.map((entry) => ({
      id: entry.id as string,
      enabled: entry.enabled === true,
      raw: entry,
    })),
    diagnostics,
    raw: value,
  };
}

function parsePluginDiagnostics(value: unknown): ParsedPluginDiagnostic[] {
  if (
    Array.isArray(value) &&
    value.some((diagnostic) =>
      isRecord(diagnostic) &&
      typeof diagnostic.message === "string" &&
      Buffer.byteLength(diagnostic.message) > MAX_DIAGNOSTIC_MESSAGE_BYTES)
  ) {
    throw controlError(
      "OPENCLAW_CLI_OUTPUT_TOO_LARGE",
      "OpenClaw CLI output exceeded the size limit.",
    );
  }
  if (!Array.isArray(value) || !value.every(validPluginDiagnostic)) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  return value.map((diagnostic) => ({
    level: diagnostic.level as ParsedPluginDiagnostic["level"],
    message: diagnostic.message as string,
    ...(typeof diagnostic.pluginId === "string" ? { pluginId: diagnostic.pluginId } : {}),
  }));
}

function validPluginDiagnostic(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.message === "string" &&
    optionalString(value.pluginId) &&
    optionalString(value.source) &&
    optionalString(value.code);
}

function validPluginFailureFields(plugin: Record<string, unknown>): boolean {
  return (
    (plugin.status === undefined ||
      plugin.status === "loaded" ||
      plugin.status === "disabled" ||
      plugin.status === "error") &&
    optionalString(plugin.error) &&
    optionalString(plugin.failedAt) &&
    (plugin.failurePhase === undefined ||
      plugin.failurePhase === "validation" ||
      plugin.failurePhase === "load" ||
      plugin.failurePhase === "register")
  );
}

function hasHealthyPluginStatus(plugin: Record<string, unknown>): boolean {
  return (plugin.status === undefined || plugin.status === "loaded") &&
    plugin.error === undefined &&
    plugin.failedAt === undefined &&
    plugin.failurePhase === undefined;
}

function isAgentGuardErrorDiagnostic(diagnostic: ParsedPluginDiagnostic): boolean {
  if (diagnostic.level !== "error") return false;
  if (diagnostic.pluginId !== undefined && diagnostic.pluginId.length > 0) {
    return diagnostic.pluginId === AGENT_GUARD_PLUGIN_ID;
  }
  return isLegacyAgentGuardConflict(diagnostic.message);
}

function isLegacyAgentGuardConflict(message: string): boolean {
  const routeConflict = message.match(LEGACY_ROUTE_CONFLICT);
  if (routeConflict) return AGENT_GUARD_ROUTE_PATHS.has(routeConflict[1]);

  const serviceConflict = message.match(LEGACY_SERVICE_CONFLICT);
  if (serviceConflict) return serviceConflict[1] === AGENT_GUARD_SERVICE_ID;

  const policyConflict = message.match(LEGACY_POLICY_CONFLICT);
  if (policyConflict) return policyConflict[1] === TRUSTED_TOOL_POLICY_ID;

  const hookConflict = message.match(LEGACY_HOOK_CONFLICT);
  return hookConflict?.[1] === "before_tool_call" &&
    hookConflict[2] === AGENT_GUARD_PLUGIN_ID;
}

function parseVersion(stdout: string): string {
  assertOutputLimit(stdout, MAX_RESPONSE_BYTES);
  const match = stdout.match(/(?:^|\D)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (!match) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw version output was invalid.");
  }
  return match[1];
}

function hasBeforeToolCallHook(plugin: Record<string, unknown>): boolean {
  return (
    Array.isArray(plugin.hookNames) &&
    plugin.hookNames.some((hook) => hook === "before_tool_call")
  );
}

function hasTrustedToolPolicyContract(plugin: Record<string, unknown>): boolean {
  const declarations: unknown[] = [];
  for (const manifest of [plugin, plugin.manifest]) {
    if (!isRecord(manifest) || !isRecord(manifest.contracts)) continue;
    if (Object.hasOwn(manifest.contracts, "trustedToolPolicies")) {
      declarations.push(manifest.contracts.trustedToolPolicies);
    }
  }
  return declarations.length > 0 && declarations.every((policies) =>
    Array.isArray(policies) &&
    policies.length === 1 &&
    policies[0] === TRUSTED_TOOL_POLICY_ID);
}

async function executeCli(
  runner: OpenClawCommandRunner,
  cli: ReturnType<typeof resolveOpenClawCliInvocation>,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  parentSignal?: AbortSignal,
): Promise<OpenClawCommandResult> {
  let result: OpenClawCommandResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let rejectParentAbort: ((reason?: unknown) => void) | undefined;
  const parentAbort = new Promise<never>((_resolve, reject) => { rejectParentAbort = reject; });
  const onParentAbort = (): void => {
    controller.abort();
    rejectParentAbort?.(new Error("OpenClaw CLI inspection aborted."));
  };
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    if (parentSignal?.aborted) onParentAbort();
    result = await Promise.race([
      runner({
        command: cli.command,
        args: [...cli.argsPrefix, ...args],
        shell: cli.shell,
        env,
        timeoutMs,
        maxOutputBytes,
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { controller.abort(); reject(new Error("OpenClaw CLI inspection timed out.")); },
          timeoutMs,
        );
      }),
      parentAbort,
    ]);
  } catch (caught) {
    if (caught instanceof Error && caught.message === "OpenClaw CLI inspection timed out.") {
      throw controlError("OPENCLAW_CLI_TIMEOUT", "OpenClaw CLI inspection timed out.");
    }
    if (caught instanceof Error && caught.message === "OpenClaw CLI inspection aborted.") {
      throw controlError("OPENCLAW_CLI_CANCELLED", "OpenClaw CLI inspection was cancelled.");
    }
    throw controlError("OPENCLAW_CLI_FAILED", "OpenClaw CLI inspection failed.");
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
  assertOutputLimit(result.stdout, maxOutputBytes);
  assertOutputLimit(result.stderr, maxOutputBytes);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes) {
    throw controlError("OPENCLAW_CLI_OUTPUT_TOO_LARGE", "OpenClaw CLI output exceeded the size limit.");
  }
  if (result.exitCode !== 0) {
    throw controlError("OPENCLAW_CLI_EXIT_FAILURE", "OpenClaw CLI exited with a non-zero code.");
  }
  return result;
}

function runCommand(input: OpenClawCommandInput): Promise<OpenClawCommandResult> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(new Error("OpenClaw CLI inspection aborted."));
      return;
    }
    const child = spawn(input.command, input.args, {
      windowsHide: true,
      shell: input.shell,
      env: input.env,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      terminateProcessTree(child);
      reject(new Error("OpenClaw CLI inspection failed."));
    };
    const append = (current: string, chunk: Buffer | string): string => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > input.maxOutputBytes) {
        fail();
        return current;
      }
      return current + chunk.toString();
    };
    const timer = setTimeout(fail, input.timeoutMs);
    const onAbort = (): void => fail();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: exitCode ?? -1, stdout, stderr });
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const systemRoot = process.env.SystemRoot;
    const taskkillPath = systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, "System32", "taskkill.exe")
      : "C:\\Windows\\System32\\taskkill.exe";
    try {
      spawnSync(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
        timeout: 2_000,
      });
    } catch {
      // Fall through to the direct child kill when taskkill is unavailable.
    }
  }
  try {
    child.kill(process.platform === "win32" ? undefined : "SIGKILL");
  } catch {
    // The process may already have exited between timeout detection and cleanup.
  }
}

function assertOutputLimit(value: string, maxOutputBytes: number): void {
  if (Buffer.byteLength(value) > maxOutputBytes) {
    throw controlError("OPENCLAW_CLI_OUTPUT_TOO_LARGE", "OpenClaw CLI output exceeded the size limit.");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function controlError(code: string, message: string): OpenClawControlClientError {
  return new OpenClawControlClientError(code, message);
}

async function cancelResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  await boundedBestEffort(() => body.cancel());
}

async function boundedBestEffort(operation: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RESPONSE_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function safeControlErrorMessage(code: string): string {
  switch (code) {
    case "OPENCLAW_CONTROL_HTTP_ERROR":
      return "OpenClaw control endpoint returned an unsuccessful response.";
    case "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE":
      return "OpenClaw control response exceeded the size limit.";
    case "OPENCLAW_CONTROL_INVALID_RESPONSE":
      return "OpenClaw control response was invalid.";
    case "OPENCLAW_CLI_TIMEOUT":
      return "OpenClaw CLI inspection timed out.";
    case "OPENCLAW_CLI_CANCELLED":
      return "OpenClaw CLI inspection was cancelled.";
    case "OPENCLAW_CLI_EXIT_FAILURE":
      return "OpenClaw CLI exited with a non-zero code.";
    default:
      return "OpenClaw control request failed.";
  }
}
