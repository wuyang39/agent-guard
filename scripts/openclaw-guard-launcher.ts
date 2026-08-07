/**
 * openclaw-guard-launcher.ts — OpenClaw Gateway startup guard (Task 14)
 *
 * 进程外启动边界。在 OpenClaw Gateway 启动前运行，检查 guarded marker
 * 和 live registry，决定是否允许正常启动。
 *
 * 规则:
 *   1. 无 guarded marker → 允许正常启动（原生防护未激活）
 *   2. 有 guarded marker + live registry 证明完整 → 允许正常启动
 *   3. 有 guarded marker + live registry 不完整 → 只允许 maintenance cleanup
 *
 * 使用: node --import tsx scripts/openclaw-guard-launcher.ts [--maintenance] -- <openclaw args>
 *
 * 退出码:
 *   0 — maintenance cleanup allowed, or child exited successfully
 *   1 — guarded startup contract rejected
 *   2 — launcher configuration or child startup failed
 *
 * Launcher 接受精确匹配的受控 fork 或兼容的官方稳定版，但两条路线都必须
 * 提供完整的 live attestation；否则 guarded 启动会被拒绝，仅允许 maintenance 清理。
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveOpenClawCliInvocation } from "../backend/src/modules/agent/openclawAdapter";
import {
  isCompatibleNativeGuardVersion,
  parseNativeGuardLiveCapability,
} from "../backend/src/modules/openclaw/nativeGuardLiveCapability";

// ---- Configuration ----
const MARKER_DIR = process.env.AGENT_GUARD_MARKER_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"), "agent-guard", "markers");

const PLUGIN_ID = "agent-guard-supervision";
const REQUIRED_HOOK = "before_tool_call";
const REQUIRED_SERVICE = "agent-guard-runtime";
const REQUIRED_POLICY = "agent-guard-admission";
const LIVE_REGISTRY_CONTRACT_VERSION = "openclaw.plugins.live.v1";
const CLI_MAX_BUFFER_BYTES = 256 * 1024;
const CLI_DEFAULT_TIMEOUT_MS = 15_000;
const CLI_MAX_TIMEOUT_MS = 60_000;

type CliSpawnOptions = {
  windowsHide: true;
  shell: boolean;
  timeout: number;
  encoding: "utf-8";
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
};

type CliSpawn = (
  command: string,
  args: string[],
  options: CliSpawnOptions,
) => { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null };

type RunCliOptions = {
  timeoutMs?: number;
  spawn?: CliSpawn;
};

type ChildResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

// ---- Helpers ----

function log(message: string): void {
  process.stderr.write(`[guard-launcher] ${message}\n`);
}

function die(code: number, message: string): never {
  process.stderr.write(`[guard-launcher] FATAL: ${message}\n`);
  process.exit(code);
}

export function runCli(
  args: string[],
  cliPath = process.env.OPENCLAW_CLI ?? "openclaw",
  options: RunCliOptions = {},
): { exitCode: number; stdout: string; stderr: string } {
  const timeoutMs = options.timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CLI_MAX_TIMEOUT_MS) {
    throw new RangeError("CLI timeout must be an integer between 1 and 60000 milliseconds");
  }
  const cli = resolveOpenClawCliInvocation(cliPath);
  const spawn: CliSpawn = options.spawn ?? ((command, spawnArgs, spawnOptions) =>
    spawnSync(command, spawnArgs, spawnOptions));
  const result = spawn(cli.command, [...cli.argsPrefix, ...args], {
    windowsHide: true,
    shell: cli.shell,
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: CLI_MAX_BUFFER_BYTES,
    env: { ...cli.env, ...process.env },
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      exitCode: 1,
      stdout: "",
      stderr: code === "ENOBUFS"
        ? `CLI output exceeded the ${String(CLI_MAX_BUFFER_BYTES)} byte limit.`
        : `CLI execution failed: ${result.error.message.slice(0, 160)}`,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export function runLiveRegistryCli(
  cliPath = process.env.OPENCLAW_CLI ?? "openclaw",
  options: Pick<RunCliOptions, "spawn"> = {},
): { exitCode: number; stdout: string; stderr: string } {
  return runCli(["plugins", "list", "--json", "--live"], cliPath, {
    ...options,
    timeoutMs: CLI_MAX_TIMEOUT_MS,
  });
}

function runOpenClawChild(
  args: string[],
  cliPath = process.env.OPENCLAW_CLI ?? "openclaw",
): Promise<ChildResult> {
  const cli = resolveOpenClawCliInvocation(cliPath);
  return new Promise((resolve) => {
    const child = spawn(cli.command, [...cli.argsPrefix, ...args], {
      windowsHide: true,
      shell: cli.shell,
      stdio: "inherit",
      env: { ...cli.env, ...process.env },
    });
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = signals.map((signal) => ({
      signal,
      handler: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      },
    }));
    const removeSignalHandlers = () => {
      for (const { signal, handler } of signalHandlers) {
        process.removeListener(signal, handler);
      }
    };
    for (const { signal, handler } of signalHandlers) process.on(signal, handler);
    child.once("error", (error) => {
      removeSignalHandlers();
      log(`OpenClaw child failed to start: ${error.message}`);
      resolve({ exitCode: 2, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      removeSignalHandlers();
      resolve({ exitCode, signal });
    });
  });
}

export function inspectGuardedMarkers(
  markerDir: string,
  readDirectory: (directory: string) => string[] = (directory) =>
    fs.readdirSync(directory),
): "none" | "guarded" {
  try {
    const entries = readDirectory(markerDir);
    return entries.some((entry) =>
      entry.endsWith(".json") && !entry.includes(".tmp") && !entry.includes(".corrupt"),
    ) ? "guarded" : "none";
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return "none";
    throw error;
  }
}

export function hasLiveGuardRegistry(
  inventory: unknown,
  versionOutput: string,
): boolean {
  const version = versionOutput.match(
    /(?:^|\D)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/,
  )?.[1];
  if (!version || !isCompatibleNativeGuardVersion(version)) return false;
  if (
    !isRecord(inventory) ||
    !hasExactKeys(inventory, ["workspaceDir", "registry", "plugins", "diagnostics"]) ||
    (inventory.workspaceDir !== null && typeof inventory.workspaceDir !== "string") ||
    !isRecord(inventory.registry) ||
    !hasExactKeys(inventory.registry, ["contractVersion", "liveAttestation", "nativeGuard"]) ||
    inventory.registry.contractVersion !== LIVE_REGISTRY_CONTRACT_VERSION ||
    inventory.registry.liveAttestation !== true ||
    !Array.isArray(inventory.plugins) ||
    !Array.isArray(inventory.diagnostics)
  ) {
    return false;
  }
  if (!parseNativeGuardLiveCapability(inventory)) return false;
  if (!inventory.plugins.every(isLivePluginContribution)) return false;
  const plugin = inventory.plugins.find((entry) =>
    entry.id === PLUGIN_ID &&
    entry.enabled === true &&
    entry.status === "loaded" &&
    entry.activated === true
  );
  if (!plugin) return false;
  return plugin.hookNames.includes(REQUIRED_HOOK) &&
    plugin.services.includes(REQUIRED_SERVICE) &&
    plugin.trustedToolPolicies.length === 1 &&
    plugin.trustedToolPolicies[0] === REQUIRED_POLICY;
}

// ---- Main ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separatorIndex = args.indexOf("--");
  const launcherArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const childArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);
  const maintenanceMode = launcherArgs.includes("--maintenance");

  log(`OpenClaw Guard Launcher — Task 14 startup gate`);
  log(`Marker directory: ${MARKER_DIR}`);

  if (launcherArgs.some((arg) => arg !== "--maintenance")) {
    die(2, "Unknown launcher option. Pass OpenClaw child arguments after --.");
  }
  if (maintenanceMode) {
    log("Maintenance cleanup mode active — OpenClaw child launch is disabled.");
    return;
  }
  if (childArgs.length === 0) {
    die(2, "Missing OpenClaw child command after --.");
  }

  // Step 1: Check for guarded markers
  let markerState: ReturnType<typeof inspectGuardedMarkers>;
  try {
    markerState = inspectGuardedMarkers(MARKER_DIR);
  } catch {
    die(2, "Guarded marker inventory is unavailable; refusing normal startup.");
  }
  if (markerState === "none") {
    log("No guarded markers found — starting OpenClaw without Guard intervention.");
    await finishWithChild(childArgs);
    return;
  }
  log("Guarded markers found — live registry verification required.");

  // Step 2: Query live registry
  const pluginsResult = runLiveRegistryCli();
  if (pluginsResult.exitCode !== 0) {
    die(1, "Live registry unavailable. Use --maintenance for cleanup-only mode.");
  }

  let registry: unknown;
  try {
    registry = JSON.parse(pluginsResult.stdout);
  } catch {
    die(1, "Live registry output is not valid JSON. Use --maintenance for cleanup-only mode.");
  }

  const versionResult = runCli(["--version"]);
  const hasLiveAttestation = versionResult.exitCode === 0 &&
    hasLiveGuardRegistry(registry, versionResult.stdout);
  if (!hasLiveAttestation) {
    die(1,
      "Live attestation is not available. " +
      "Use exact fork 2026.7.1-agentguard.1 or an official stable >=2026.7.2 " +
      "that passes live attestation " +
      "for guarded Gateway startup. Use --maintenance for cleanup-only mode.",
    );
  }

  // Step 6: All checks passed
  log("Live registry verification passed — starting OpenClaw child.");
  await finishWithChild(childArgs);
}

async function finishWithChild(childArgs: string[]): Promise<void> {
  const result = await runOpenClawChild(childArgs);
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.exitCode ?? 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch(() => {
    die(2, "Unexpected launcher failure; refusing OpenClaw startup.");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type LivePluginContribution = {
  id: string;
  enabled: boolean;
  status: string;
  activated: boolean;
  hookNames: string[];
  services: string[];
  trustedToolPolicies: string[];
};

function isLivePluginContribution(value: unknown): value is LivePluginContribution {
  return isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "enabled",
      "status",
      "activated",
      "hookNames",
      "services",
      "trustedToolPolicies",
    ]) &&
    typeof value.id === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.status === "string" &&
    typeof value.activated === "boolean" &&
    isStringArray(value.hookNames) &&
    isStringArray(value.services) &&
    isStringArray(value.trustedToolPolicies);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}
