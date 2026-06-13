import { spawn } from "node:child_process";

const processes = [];

function start(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  processes.push({ name, child });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
}

function shutdown() {
  for (const { child } of processes) {
    if (!child.killed) child.kill();
  }
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

console.log("P2 demo starting...");
console.log("API:      http://127.0.0.1:3100/api/v1/system/status");
console.log("Frontend: http://127.0.0.1:5173");
console.log("Sample:   http://127.0.0.1:7001/health");
console.log("Realtime: http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp");

start("sample-agent", process.execPath, ["scripts/sample-agent-server.mjs"], {
  SAMPLE_AGENT_PORT: process.env.SAMPLE_AGENT_PORT ?? "7001",
});
start("api", process.execPath, ["--import", "tsx", "backend/src/server.ts"], {
  API_PORT: process.env.API_PORT ?? "3100",
});
start("frontend", "npx", ["vite", "--config", "frontend/vite.config.ts", "--host", "127.0.0.1"]);

