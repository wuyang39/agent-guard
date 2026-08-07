/**
 * verify-openclaw-native-guard.ts — OpenClaw native guard fake-host verification.
 *
 * 离线验证（不要求真实 OpenClaw/插件/Docker）：
 *   1. OFF 零副作用
 *   2. allow/deny/redact 决策
 *   3. unattested ask 拒绝
 *   4. 恢复 (recovery) 状态
 *   5. 子 Agent 生命周期
 *   6. 冲突 Hook 检测
 *   7. 签名失败处理
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

runTest("Protocol (Ed25519, canonical JSON, digest)", [
  "packages/native-guard-protocol/src/index.test.ts",
]);

runTest("Plugin (lease registry, control routes, runtime, event spool)", [
  "plugins/agent-guard-supervision/src/leaseRegistry.test.ts",
  "plugins/agent-guard-supervision/src/controlRoutes.test.ts",
  "plugins/agent-guard-supervision/src/runtime.test.ts",
  "plugins/agent-guard-supervision/src/eventSpool.test.ts",
]);

runTest("Backend (coordinator, routes, runtime evidence, event store, trace projector, sandbox)", [
  "backend/src/app.test.ts",
  "backend/src/api/v1/openclaw/native-guard-handlers.test.ts",
  "backend/src/api/v1/test-runs/handlers.test.ts",
  "backend/src/modules/agent/openclawAdapter.test.ts",
  "backend/src/modules/agent/openclawSession.test.ts",
  "backend/src/modules/openclaw/nativeGuardCoordinator.test.ts",
  "backend/src/modules/openclaw/nativeGuardLiveCapability.test.ts",
  "backend/src/modules/openclaw/openclawControlClient.test.ts",
  "backend/src/modules/runner/testRunner.test.ts",
  "backend/src/services/e2eRunService.test.ts",
  "backend/src/storage/fileRunStore.test.ts",
  "backend/src/storage/nativeGuardEventStore.test.ts",
  "backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts",
  "backend/src/modules/openclaw/detectionSandboxManager.test.ts",
]);

runTest("Acceptance gates (launcher, installer, live Docker verifier)", [
  "scripts/openclaw-guard-launcher.test.ts",
  "scripts/install-openclaw-native-guard.test.ts",
  "scripts/verify-openclaw-detection-sandbox.test.ts",
]);

runTypecheck("Backend typecheck", "typecheck");
runTypecheck("Plugin typecheck", "typecheck:openclaw-plugin");
runTypecheck("Frontend typecheck", "typecheck:frontend");

runNpm("build:openclaw-plugin");

process.stdout.write(`
============================================================
OpenClaw Native Guard Fake-Host Verification: ALL PASSED
============================================================
`);
process.exit(0);
