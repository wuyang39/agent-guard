/**
 * demo-p2.mjs — P2 一键演示入口
 *
 * 合约约定 (B ← → C):
 *   - API ready 判定: GET /api/v1/system/status → ok:true
 *   - API 端口:    DEMO_API_PORT (默认 3100)
 *   - Sample 端口: DEMO_SAMPLE_PORT (默认 7001)
 *   - 前端端口:    DEMO_FRONTEND_PORT (默认 5173)
 *   - 日志输出:    各进程使用 stdio: "inherit"
 *   - 失败码:      API 健康检查失败 → exit 1
 *   - 清理:       SIGINT / SIGTERM → kill all children
 *
 * B 负责: API 启动、sample agent 启动、健康检查
 * C 负责: 前端启动和正式 Web Console 访问入口
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const API_PORT = process.env.DEMO_API_PORT ?? "3100";
const SAMPLE_PORT = process.env.DEMO_SAMPLE_PORT ?? "7001";
const FRONTEND_PORT = process.env.DEMO_FRONTEND_PORT ?? "5173";
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const FRONTEND_BASE = `http://127.0.0.1:${FRONTEND_PORT}`;
const DEMO_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

const children = [];

// ---- helpers ----

function log(section, message) {
  console.log(`[demo:${section}] ${message}`);
}

async function healthCheck(url, label, timeoutMs = DEMO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const body = await resp.json().catch(() => undefined);
        if (body?.ok === true) {
          return body;
        }
      }
    } catch {
      // not ready yet
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} at ${url} did not become ready within ${timeoutMs}ms`);
}

async function httpReady(url, label, timeoutMs = DEMO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`${label} at ${url} did not become ready within ${timeoutMs}ms`);
}

async function isHttpReady(url) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return resp.ok;
  } catch {
    return false;
  }
}

function startChild(label, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: opts.shell ?? false,
    windowsHide: true,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  });
  children.push({ label, child });
  child.on("exit", (code) => {
    if (code && code !== 0 && code !== null) {
      log(label, `exited with code ${code}`);
    }
  });
  return child;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function shutdown() {
  log("shutdown", "stopping all services...");
  for (const { label, child } of [...children].reverse()) {
    if (!child.killed) {
      child.kill();
      log("shutdown", `${label} stopped`);
    }
  }
}

// ---- main ----

async function main() {
  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });

  console.log("=".repeat(56));
  console.log("  Agent Guard P2 Demo");
  console.log("=".repeat(56));

  // 1. Start sample agent server
  log("sample", `starting on port ${SAMPLE_PORT}...`);
  startChild("sample", process.execPath, ["scripts/sample-agent-server.mjs"], {
    env: { SAMPLE_AGENT_PORT: SAMPLE_PORT },
  });

  // 2. Wait for sample agent
  log("sample", "waiting for health check...");
  await healthCheck(`http://127.0.0.1:${SAMPLE_PORT}/health`, "Sample Agent");
  log("sample", `ready at http://127.0.0.1:${SAMPLE_PORT}/health`);

  // 3. Start API server
  log("api", `starting on port ${API_PORT}...`);
  startChild("api", process.execPath, ["--import", "tsx", "backend/src/server.ts"], {
    env: { API_PORT, SAMPLE_AGENT_PORT: SAMPLE_PORT },
  });

  // 4. Wait for API
  log("api", "waiting for health check...");
  const sys = await healthCheck(`${API_BASE}/api/v1/system/status`, "API Server");
  log("api", `ready: ${sys?.data?.service ?? "agent-guard-api"} v${sys?.data?.apiVersion ?? "?"}`);

  // 5. Start frontend if it is not already serving the formal console.
  if (await isHttpReady(FRONTEND_BASE)) {
    log("frontend", `already ready at ${FRONTEND_BASE}`);
  } else {
    log("frontend", `starting on port ${FRONTEND_PORT}...`);
    startChild("frontend", npmCommand(), ["run", "frontend", "--", "--port", FRONTEND_PORT], {
      env: { VITE_AGENT_GUARD_API_BASE: API_BASE },
    });
    log("frontend", "waiting for Vite...");
    await httpReady(FRONTEND_BASE, "Frontend");
    log("frontend", `ready at ${FRONTEND_BASE}`);
  }

  // 6. Contract output
  console.log("");
  console.log("  Demo URLs:");
  console.log(`    API Status:  ${API_BASE}/api/v1/system/status`);
  console.log(`    Dashboard:   ${API_BASE}/api/v1/dashboard/summary`);
  console.log(`    Realtime MCP: ${API_BASE}/api/v1/openclaw/realtime/mcp`);
  console.log(`    Sample Agent: http://127.0.0.1:${SAMPLE_PORT}/health`);
  console.log(`    Frontend:    ${FRONTEND_BASE}`);
  console.log("");

  log("demo", "services ready. Press Ctrl+C to stop.");

  // 7. Keep alive
  setInterval(() => {}, 60_000);
  await new Promise(() => {}); // wait forever
}

main().catch((err) => {
  console.error(`\n❌ demo:p2 FAILED: ${err.message}`);
  shutdown();
  process.exit(1);
});
