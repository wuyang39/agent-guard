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

const ARGS = {
  windowsHide: true,
  shell: false as const,
  timeout: 300_000,
  encoding: "utf-8" as const,
  cwd: process.cwd(),
  maxBuffer: 16 * 1024 * 1024,
};

function runTest(testLabel: string, testFiles: string[]): void {
  process.stdout.write(`\n  ${testLabel}...\n`);
  const result = spawnSync("node", ["--import", "tsx", "--test", ...testFiles], { ...ARGS, stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
  process.stdout.write(`  ✓ ${testLabel} passed.\n`);
}

function runTypecheck(label: string, script: string): void {
  process.stdout.write(`\n  ${label}...`);
  const result = spawnSync("npm", ["run", script], ARGS);
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

runTest("Backend (coordinator, control client, event store, trace projector, sandbox)", [
  "backend/src/modules/openclaw/nativeGuardCoordinator.test.ts",
  "backend/src/modules/openclaw/openclawControlClient.test.ts",
  "backend/src/storage/nativeGuardEventStore.test.ts",
  "backend/src/modules/openclaw/nativeGuardTraceProjector.test.ts",
  "backend/src/modules/openclaw/detectionSandboxManager.test.ts",
]);

runTypecheck("Backend typecheck", "typecheck");
runTypecheck("Plugin typecheck", "typecheck:openclaw-plugin");
runTypecheck("Frontend typecheck", "typecheck:frontend");

process.stdout.write("\n  Plugin build...");
const build = spawnSync("npm", ["run", "build:openclaw-plugin"], ARGS);
if (build.status !== 0) { process.stderr.write(`\n${(build.stderr ?? "").slice(-2000)}`); process.exit(1); }
process.stdout.write(" ✓\n");

process.stdout.write(`
============================================================
OpenClaw Native Guard Fake-Host Verification: ALL PASSED
============================================================
`);
process.exit(0);
