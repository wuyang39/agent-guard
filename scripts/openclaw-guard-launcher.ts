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
 * 使用: node --import tsx scripts/openclaw-guard-launcher.ts [--maintenance]
 *
 * 退出码:
 *   0 — 允许正常 Gateway 启动
 *   1 — 只允许 maintenance cleanup 模式
 *   2 — 内部错误（无法查询 registry）
 *
 * Launcher 接受精确匹配的受控 fork 或兼容的官方稳定版，但两条路线都必须
 * 提供完整的 live attestation；否则 guarded 启动会被拒绝，仅允许 maintenance 清理。
 */

import { spawnSync } from "node:child_process";
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
const CLI_MAX_BUFFER_BYTES = 256 * 1024;

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
): { exitCode: number; stdout: string; stderr: string } {
  const cli = resolveOpenClawCliInvocation(cliPath);
  const result = spawnSync(cli.command, [...cli.argsPrefix, ...args], {
    windowsHide: true,
    shell: cli.shell,
    timeout: 15_000,
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
  if (!parseNativeGuardLiveCapability(inventory)) return false;
  if (!isRecord(inventory) || !Array.isArray(inventory.plugins)) return false;
  const plugin = inventory.plugins.find((entry) =>
    isRecord(entry) &&
    entry.id === PLUGIN_ID &&
    entry.enabled === true &&
    entry.status === "loaded"
  );
  if (!isRecord(plugin)) return false;
  const hookNames = Array.isArray(plugin.hookNames) ? plugin.hookNames : [];
  const services = Array.isArray(plugin.services) ? plugin.services : [];
  const manifest = isRecord(plugin.manifest) ? plugin.manifest : {};
  const contracts = isRecord(manifest.contracts) ? manifest.contracts : {};
  const policies = Array.isArray(contracts.trustedToolPolicies)
    ? contracts.trustedToolPolicies
    : [];
  return hookNames.includes(REQUIRED_HOOK) &&
    services.includes(REQUIRED_SERVICE) &&
    policies.length === 1 &&
    policies[0] === REQUIRED_POLICY;
}

// ---- Main ----

function main(): void {
  const args = process.argv.slice(2);
  const maintenanceMode = args.includes("--maintenance");

  log(`OpenClaw Guard Launcher — Task 14 startup gate`);
  log(`Marker directory: ${MARKER_DIR}`);

  // Step 1: Check for guarded markers
  let markerState: ReturnType<typeof inspectGuardedMarkers>;
  try {
    markerState = inspectGuardedMarkers(MARKER_DIR);
  } catch {
    die(2, "Guarded marker inventory is unavailable; refusing normal startup.");
  }
  if (markerState === "none") {
    log("No guarded markers found — normal Gateway startup allowed.");
    process.exit(0);
  }
  log("Guarded markers found — live registry verification required.");

  // Step 2: Query live registry
  const pluginsResult = runCli(["plugins", "list", "--json"]);
  if (pluginsResult.exitCode !== 0) {
    if (maintenanceMode) {
      log("Live registry unavailable but --maintenance mode active — allowing maintenance cleanup.");
      process.exit(0);
    }
    die(1, "Live registry unavailable. Use --maintenance for cleanup-only mode.");
  }

  let registry: unknown;
  try {
    registry = JSON.parse(pluginsResult.stdout);
  } catch {
    if (maintenanceMode) {
      log("Live registry JSON is invalid but --maintenance mode is active — allowing maintenance cleanup.");
      process.exit(0);
    }
    die(1, "Live registry output is not valid JSON. Use --maintenance for cleanup-only mode.");
  }

  const versionResult = runCli(["--version"]);
  const hasLiveAttestation = versionResult.exitCode === 0 &&
    hasLiveGuardRegistry(registry, versionResult.stdout);
  if (!hasLiveAttestation) {
    if (maintenanceMode) {
      log("--maintenance mode active — allowing maintenance cleanup.");
      process.exit(0);
    }
    die(1,
      "Live attestation is not available. " +
      "Use exact fork 2026.7.1-agentguard.1 or an official stable >=2026.7.2 " +
      "that passes live attestation " +
      "for guarded Gateway startup. Use --maintenance for cleanup-only mode.",
    );
  }

  // Step 6: All checks passed
  log("Live registry verification passed — normal Gateway startup allowed.");
  process.exit(0);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
