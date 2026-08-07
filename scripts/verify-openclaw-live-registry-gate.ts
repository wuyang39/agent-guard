import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

type GateSpawnOptions = {
  cwd: string;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
  timeout: number;
  windowsHide: true;
};

type GateSpawn = (
  command: string,
  args: string[],
  options: GateSpawnOptions,
) => { error?: Error; status: number | null };

export function resolveRequiredOpenClawCli(env: NodeJS.ProcessEnv = process.env): string {
  const cliPath = env.TEST_OPENCLAW_AGENTGUARD_CLI?.trim();
  if (!cliPath) {
    throw new Error("TEST_OPENCLAW_AGENTGUARD_CLI is required for the real live registry gate");
  }
  return cliPath;
}

export function runOpenClawLiveRegistryGate(params: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  spawn?: GateSpawn;
} = {}): void {
  const env = params.env ?? process.env;
  const cliPath = resolveRequiredOpenClawCli(env);
  const spawn: GateSpawn = params.spawn ?? ((command, args, options) =>
    spawnSync(command, args, options));
  const result = spawn(
    params.nodePath ?? process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern=exact fork live registry",
      "scripts/openclaw-guard-launcher.test.ts",
    ],
    {
      cwd: params.cwd ?? process.cwd(),
      encoding: "utf8",
      env: { ...env, TEST_OPENCLAW_AGENTGUARD_CLI: cliPath },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("real OpenClaw live registry gate failed");
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runOpenClawLiveRegistryGate();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "real OpenClaw live registry gate failed"}\n`);
    process.exit(1);
  }
}
