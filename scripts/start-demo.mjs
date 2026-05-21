import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const processes = [];

function startProcess(name, script, env = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, script)], {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  processes.push(child);
}

function shutdown() {
  for (const child of processes) {
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
process.on("exit", shutdown);

startProcess("sample-agent", "sample-agent-server.mjs", { SAMPLE_AGENT_PORT: process.env.SAMPLE_AGENT_PORT || "7001" });
startProcess("workbench", "demo-web-server.mjs", { PORT: process.env.PORT || "5177" });

console.log("");
console.log("Agent Guard demo is starting...");
console.log("Workbench: http://localhost:5177");
console.log("Sample Agent: http://localhost:7001/agent/run?mode=vulnerable");
console.log("Press Ctrl+C to stop both services.");
