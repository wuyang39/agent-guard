import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import {
  buildOpenClawProcessEnv,
  resolveOpenClawCliInvocation,
} from "../agent/openclawAdapter";

const STATUS_PATH = "/agent-guard/native-guard/v1/status";
const ACTIVATE_PATH = "/agent-guard/native-guard/v1/leases/activate";
const RENEW_PATH = "/agent-guard/native-guard/v1/leases/renew";
const REVOKE_PATH = "/agent-guard/native-guard/v1/leases/revoke";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const AGENT_GUARD_PLUGIN_ID = "agent-guard-supervision";
const TRUSTED_TOOL_POLICY_ID = "agent-guard-admission";

export type NativeGuardFinalizerAssurance = NativeGuardStatus["finalizerAssurance"];

export type NativeGuardCapability = {
  openclawVersion: string;
  supportsNativeGuard: boolean;
  finalizerAssurance: NativeGuardFinalizerAssurance;
  conflictingPluginIds: string[];
};

export type InspectOpenClawCapabilitiesInput = {
  cliPath?: string;
  env?: Record<string, string>;
  isolatedProfile: boolean;
};

export type OpenClawCommandInput = {
  command: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
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
  activate(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  renew(gatewayUrl: string, activation: NativeGuardLeaseActivation): Promise<NativeGuardStatus>;
  revoke(gatewayUrl: string, leaseId: string): Promise<NativeGuardStatus>;
};

export type OpenClawControlClientOptions = {
  gatewayToken?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
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
      });
      const versionResult = await executeCli(
        commandRunner,
        cli,
        ["--version"],
        env,
        timeoutMs,
      );
      const pluginResult = await executeCli(
        commandRunner,
        cli,
        ["plugins", "list", "--json"],
        env,
        timeoutMs,
      );
      const openclawVersion = parseVersion(versionResult.stdout);
      const plugins = parsePluginList(pluginResult.stdout);
      const agentGuard = plugins.find((plugin) => plugin.id === AGENT_GUARD_PLUGIN_ID);
      const agentGuardHasBeforeHook = Boolean(
        agentGuard?.enabled && hasBeforeToolCallHook(agentGuard.raw),
      );
      const agentGuardReady = Boolean(
        agentGuard?.enabled &&
        agentGuardHasBeforeHook &&
        hasTrustedToolPolicyContract(agentGuard.raw),
      );
      const conflicts = plugins
        .filter((plugin) =>
          plugin.enabled &&
          plugin.id !== AGENT_GUARD_PLUGIN_ID &&
          hasBeforeToolCallHook(plugin.raw))
        .map((plugin) => plugin.id)
        .sort();
      const enabledIds = plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id);
      const supportsNativeGuard =
        versionAtLeast(openclawVersion, [2026, 7, 2]) && agentGuardReady;

      let finalizerAssurance: NativeGuardFinalizerAssurance = "unverified";
      if (supportsNativeGuard && agentGuardHasBeforeHook) {
        if (
          input.isolatedProfile &&
          enabledIds.length === 1 &&
          enabledIds[0] === AGENT_GUARD_PLUGIN_ID
        ) {
          finalizerAssurance = "isolated_profile";
        } else if (!input.isolatedProfile && conflicts.length === 0) {
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
  if (!contentType.includes("application/json")) {
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
        await reader.cancel().catch(() => undefined);
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
    !optionalString(value.reasonCode) ||
    !optionalString(value.detail) ||
    !optionalStringArray(value.conflictingPluginIds) ||
    !validActiveLease(value.activeLease)
  ) {
    throw controlError("OPENCLAW_CONTROL_INVALID_RESPONSE", "OpenClaw control status was invalid.");
  }
  return {
    coverage: value.coverage as NativeGuardStatus["coverage"],
    finalizerAssurance: value.finalizerAssurance as NativeGuardFinalizerAssurance,
    activeLeaseCount: value.activeLeaseCount as number,
    ...(typeof value.pluginVersion === "string" ? { pluginVersion: value.pluginVersion } : {}),
    ...(typeof value.openclawVersion === "string" ? { openclawVersion: value.openclawVersion } : {}),
    ...(Array.isArray(value.conflictingPluginIds)
      ? { conflictingPluginIds: [...value.conflictingPluginIds] as string[] }
      : {}),
    ...(isRecord(value.activeLease)
      ? { activeLease: {
          leaseId: value.activeLease.leaseId as string,
          leaseEpoch: value.activeLease.leaseEpoch as number,
          rootSessionKey: value.activeLease.rootSessionKey as string,
          mode: value.activeLease.mode as "detection" | "supervision",
          policyPackId: value.activeLease.policyPackId as string,
          policyPackDigest: value.activeLease.policyPackDigest as string,
          expiresAt: value.activeLease.expiresAt as string,
        } }
      : {}),
    ...(typeof value.reasonCode === "string" ? { reasonCode: value.reasonCode } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  };
}

function validActiveLease(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    nonEmptyString(value.leaseId) &&
    Number.isSafeInteger(value.leaseEpoch) &&
    (value.leaseEpoch as number) > 0 &&
    nonEmptyString(value.rootSessionKey) &&
    (value.mode === "detection" || value.mode === "supervision") &&
    nonEmptyString(value.policyPackId) &&
    nonEmptyString(value.policyPackDigest) &&
    nonEmptyString(value.expiresAt)
  );
}

type ParsedPlugin = { id: string; enabled: boolean; raw: Record<string, unknown> };

function parsePluginList(stdout: string): ParsedPlugin[] {
  assertOutputLimit(stdout);
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.plugins)
      ? value.plugins
      : undefined;
  if (!entries || !entries.every((entry) => isRecord(entry) && nonEmptyString(entry.id))) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  const ids = entries.map((entry) => entry.id as string);
  if (new Set(ids).size !== ids.length) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw plugin inventory was invalid.");
  }
  return entries.map((entry) => ({
    id: entry.id as string,
    enabled: entry.enabled === true,
    raw: entry,
  }));
}

function parseVersion(stdout: string): string {
  assertOutputLimit(stdout);
  const match = stdout.match(/(?:^|\D)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/);
  if (!match) {
    throw controlError("OPENCLAW_CLI_INVALID_OUTPUT", "OpenClaw version output was invalid.");
  }
  return match[1];
}

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const [core, prerelease] = version.split("-", 2);
  const parts = core.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return prerelease === undefined;
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
): Promise<OpenClawCommandResult> {
  let result: OpenClawCommandResult;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    result = await Promise.race([
      runner({
        command: cli.command,
        args: [...cli.argsPrefix, ...args],
        shell: cli.shell,
        env,
        timeoutMs,
        maxOutputBytes: MAX_RESPONSE_BYTES,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenClaw CLI inspection timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    throw controlError("OPENCLAW_CLI_FAILED", "OpenClaw CLI inspection failed.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  assertOutputLimit(result.stdout);
  assertOutputLimit(result.stderr);
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_RESPONSE_BYTES) {
    throw controlError("OPENCLAW_CLI_OUTPUT_TOO_LARGE", "OpenClaw CLI output exceeded the size limit.");
  }
  if (result.exitCode !== 0) {
    throw controlError("OPENCLAW_CLI_FAILED", "OpenClaw CLI inspection failed.");
  }
  return result;
}

function runCommand(input: OpenClawCommandInput): Promise<OpenClawCommandResult> {
  return new Promise((resolve, reject) => {
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
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk); });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

function assertOutputLimit(value: string): void {
  if (Buffer.byteLength(value) > MAX_RESPONSE_BYTES) {
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
  try {
    await response.body?.cancel();
  } catch {
    // Rejection paths never surface body cancellation failures.
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
    default:
      return "OpenClaw control request failed.";
  }
}
