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
 * 固定 OpenClaw 2026.7.2 的 registrar 返回 void，live attestation 始终不可用。
 * Launcher 会正确拒绝正常启动，要求 maintenance 模式。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- Configuration ----
const MARKER_DIR = process.env.AGENT_GUARD_MARKER_DIR ??
  path.join(process.env.OPENCLAW_HOME ?? path.join(os.homedir(), ".openclaw"), "agent-guard", "markers");

const PLUGIN_ID = "agent-guard-supervision";
const REQUIRED_HOOK = "before_tool_call";
const REQUIRED_SERVICE = "agent-guard-runtime";
const REQUIRED_POLICY = "agent-guard-admission";

// ---- Helpers ----

function log(message: string): void {
  process.stderr.write(`[guard-launcher] ${message}\n`);
}

function die(code: number, message: string): never {
  process.stderr.write(`[guard-launcher] FATAL: ${message}\n`);
  process.exit(code);
}

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const cliPath = process.env.OPENCLAW_CLI ?? "openclaw";
  const result = spawnSync(cliPath, args, {
    windowsHide: true,
    shell: false,
    timeout: 15_000,
    encoding: "utf-8",
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function hasGuardedMarkers(): boolean {
  try {
    if (!fs.existsSync(MARKER_DIR)) return false;
    const entries = fs.readdirSync(MARKER_DIR);
    // Guarded markers are JSON files, not temporary or quarantine files
    return entries.some((entry) =>
      entry.endsWith(".json") && !entry.includes(".tmp") && !entry.includes(".corrupt"),
    );
  } catch {
    return false;
  }
}

// ---- Main ----

function main(): void {
  const args = process.argv.slice(2);
  const maintenanceMode = args.includes("--maintenance");

  log(`OpenClaw Guard Launcher — Task 14 startup gate`);
  log(`Marker directory: ${MARKER_DIR}`);

  // Step 1: Check for guarded markers
  const markersExist = hasGuardedMarkers();
  if (!markersExist) {
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
    die(1, "Live registry output is not valid JSON. Use --maintenance for cleanup-only mode.");
  }

  // Step 3: Verify plugin presence
  const plugins = isRecord(registry) && Array.isArray(registry.plugins)
    ? registry.plugins : [];
  const agPlugin = plugins.find((p: Record<string, unknown>) =>
    isRecord(p) && p.id === PLUGIN_ID && p.enabled === true,
  );

  if (!agPlugin) {
    die(1, `Plugin '${PLUGIN_ID}' is not enabled. Use --maintenance for cleanup-only mode.`);
  }

  // Step 4: Verify live contributions (before_tool_call hook, recovery service, trusted policy)
  const hookNames = Array.isArray(agPlugin.hookNames) ? agPlugin.hookNames : [];
  const services = Array.isArray(agPlugin.services) ? agPlugin.services : [];
  const manifest = isRecord(agPlugin.manifest) ? agPlugin.manifest : {};
  const contracts = isRecord(manifest.contracts) ? manifest.contracts : {};
  const policies = Array.isArray(contracts.trustedToolPolicies)
    ? contracts.trustedToolPolicies : [];

  const hasFinalHook = hookNames.includes(REQUIRED_HOOK);
  const hasRecoveryService = services.includes(REQUIRED_SERVICE);
  const hasTrustedPolicy = policies.length === 1 && policies[0] === REQUIRED_POLICY;

  if (!hasFinalHook || !hasRecoveryService || !hasTrustedPolicy) {
    const missing = [
      !hasFinalHook ? REQUIRED_HOOK : null,
      !hasRecoveryService ? REQUIRED_SERVICE : null,
      !hasTrustedPolicy ? REQUIRED_POLICY : null,
    ].filter(Boolean).join(", ");
    die(1, `Live contributions incomplete (missing: ${missing}). Use --maintenance for cleanup-only mode.`);
  }

  // Step 5: Check for live attestation capability.
  // The official registrar returns void. The agent-guard fork provides
  // `registry.liveAttestation: true` in `plugins list --json`.
  const versionResult = runCli(["--version"]);
  const isAgentGuardFork = versionResult.stdout.toLowerCase().includes("agentguard");

  const hasLiveAttestation = isRecord(registry) &&
    isRecord(registry.registry) &&
    registry.registry.liveAttestation === true;

  if (!hasLiveAttestation || !isAgentGuardFork) {
    log(`Live attestation: ${String(hasLiveAttestation)}, fork: ${String(isAgentGuardFork)}`);
    if (maintenanceMode) {
      log("--maintenance mode active — allowing maintenance cleanup.");
      process.exit(0);
    }
    die(1,
      "Live attestation is not available. " +
      "Install the agent-guard OpenClaw fork (2026.7.1-agentguard.1) " +
      "for guarded Gateway startup. Use --maintenance for cleanup-only mode.",
    );
  }

  // Step 6: All checks passed
  log("Live registry verification passed — normal Gateway startup allowed.");
  process.exit(0);
}

main();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
