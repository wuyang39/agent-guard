/**
 * verify-openclaw-native-guard.ts — OpenClaw native guard fake-host verification.
 *
 * 离线验证（不要求真实 OpenClaw/插件/Docker）：
 *   1. scope 协议兼容与 agent/session 生命周期
 *   2. 插件 allow/deny/redact、fallback 与恢复
 *   3. host main 与 detection sandbox 共存
 *   4. durable event 到 SSE 的净化投影
 *   5. sandbox/launcher/installer 验收门
 *
 * 此脚本运行离线协议级和插件级测试，不依赖运行中的 OpenClaw 实例。
 * 每个测试套件独立运行，以捕获各自崩溃/超时。
 */

import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const SHELL = isWindows ? (true as const) : (false as const);
const NPM_CMD = isWindows ? "npm.cmd" : "npm";
const NODE_CMD = isWindows ? "node.exe" : "node";

const BASE_ARGS = {
  windowsHide: true,
  shell: SHELL,
  timeout: 300_000,
  encoding: "utf-8" as const,
  cwd: process.cwd(),
  maxBuffer: 16 * 1024 * 1024,
};

function runTest(testLabel: string, testFiles: string[]): void {
  process.stdout.write(`\n  ${testLabel}...\n`);
  const result = spawnSync(NODE_CMD, ["--import", "tsx", "--test", ...testFiles], { ...BASE_ARGS, stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
  process.stdout.write(`  ✓ ${testLabel} passed.\n`);
}

function stage(index: number, label: string): void {
  process.stdout.write(`\n[Stage ${String(index)}] ${label}\n`);
}

function runTypecheck(label: string, script: string): void {
  process.stdout.write(`\n  ${label}...`);
  const result = spawnSync(NPM_CMD, ["run", script], BASE_ARGS);
  if (result.status !== 0) {
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    process.stderr.write(`\n${output.slice(-2000)}`);
    process.exit(1);
  }
  process.stdout.write(" ✓\n");
}

function runNpm(script: string): void {
  process.stdout.write(`\n  npm run ${script}...`);
  const result = spawnSync(NPM_CMD, ["run", script], BASE_ARGS);
  if (result.status !== 0) {
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    process.stderr.write(`\n${output.slice(-2000)}`);
    process.exit(1);
  }
  process.stdout.write(" ✓\n");
}

// ---------------------------------------------------------------------------
process.stdout.write("OpenClaw Native Guard Fake-Host Verification\n");

stage(1, "Scope protocol and lease resolution");
runTest("Protocol (Ed25519, canonical JSON, digest)", [
  "packages/native-guard-protocol/src/index.test.ts",
]);
runTest("Backend lease scopes (legacy, exact, agent fallback, lifecycle)", [
  "backend/src/modules/openclaw/nativeGuardLeaseService.test.ts",
]);

stage(2, "Plugin enforcement and recovery");
runTest("Plugin (lease registry, control routes, runtime, event spool)", [
  "plugins/agent-guard-supervision/src/leaseRegistry.test.ts",
  "plugins/agent-guard-supervision/src/controlRoutes.test.ts",
  "plugins/agent-guard-supervision/src/runtime.test.ts",
  "plugins/agent-guard-supervision/src/eventSpool.test.ts",
]);

stage(3, "Host main supervision and sandbox coexistence");
runTest("Backend app composition and main supervision lifecycle", [
  "backend/src/app.test.ts",
  "backend/src/api/v1/openclaw/native-supervision-handlers.test.ts",
  "backend/src/modules/openclaw/mainAgentSupervisionService.test.ts",
]);
runTest("Backend coordinator, control identity, and decision routes", [
  "backend/src/api/v1/openclaw/native-guard-handlers.test.ts",
  "backend/src/modules/openclaw/nativeGuardCoordinator.test.ts",
  "backend/src/modules/openclaw/nativeGuardLiveCapability.test.ts",
  "backend/src/modules/openclaw/openclawHostCapabilityCache.test.ts",
  "backend/src/modules/openclaw/openclawControlClient.test.ts",
  "backend/src/modules/openclaw/hostGatewayAttestationBootstrap.test.ts",
  "backend/src/modules/openclaw/nativeToolDecisionService.test.ts",
]);

stage(4, "Durable events, sanitized SSE, and session lifecycle");
runTest("Durable native event projection and realtime fan-out", [
  "backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts",
  "backend/src/modules/openclaw/realtimeMcpServer.test.ts",
  "backend/src/storage/nativeGuardEventStore.test.ts",
  "backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts",
]);
runTest("OpenClaw adapter and session lifecycle", [
  "backend/src/modules/agent/openclawAdapter.test.ts",
  "backend/src/modules/agent/openclawSession.test.ts",
]);

stage(5, "Detection sandbox orchestration");
runTest("Detection run routes, runner, persistence, and sandbox", [
  "backend/src/api/v1/test-runs/handlers.test.ts",
  "backend/src/modules/runner/testRunner.test.ts",
  "backend/src/services/e2eRunService.test.ts",
  "backend/src/storage/fileRunStore.test.ts",
  "backend/src/modules/openclaw/detectionOpenClawConfig.test.ts",
  "backend/src/modules/openclaw/detectionSandboxManager.test.ts",
]);

stage(6, "Offline acceptance gates");
runTest("Acceptance gates (launcher, installer, live Docker verifier)", [
  "scripts/openclaw-guard-launcher.test.ts",
  "scripts/install-openclaw-native-guard.test.ts",
  "scripts/verify-openclaw-detection-sandbox.test.ts",
]);

stage(7, "Static checks and plugin build");
runTypecheck("Backend typecheck", "typecheck");
runTypecheck("Plugin typecheck", "typecheck:openclaw-plugin");
runTypecheck("Frontend typecheck", "typecheck:frontend");

runNpm("build:openclaw-plugin");

process.stdout.write(`
============================================================
OpenClaw Native Guard Fake-Host Verification: ALL PASSED
============================================================
[PASS] legacy exact/session_tree compatibility
[PASS] main-agent fallback across current and future sessions
[PASS] worker-agent exclusion from main supervision
[PASS] exact-session precedence over agent fallback
[PASS] agent session_end preservation and lifecycle cleanup
[PASS] durable SSE projection and sensitive-detail sanitization
[PASS] host main supervision and sandbox detection coexistence
[PASS] sandbox revoke restoration and main Guard OFF restoration
`);
process.exit(0);
