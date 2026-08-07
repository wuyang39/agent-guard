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
) => { error?: Error; status: number | null; stdout?: string };

export function resolveRequiredOpenClawCli(env: NodeJS.ProcessEnv = process.env): string {
  const cliPath = env.TEST_OPENCLAW_AGENTGUARD_CLI?.trim() || env.OPENCLAW_CLI?.trim();
  if (!cliPath) {
    throw new Error(
      "TEST_OPENCLAW_AGENTGUARD_CLI or OPENCLAW_CLI is required for the real live registry gate",
    );
  }
  return cliPath;
}

function hasExactlyOneRequiredTestPass(output: string | undefined): boolean {
  if (!output) {
    return false;
  }
  const testPoints = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:not )?ok\b/u.test(line));
  return (
    testPoints.length === 1 &&
    testPoints[0] === "ok 1 - required real OpenClaw live registry allows guarded startup" &&
    /^1\.\.1\r?$/m.test(output) &&
    /^# tests 1\r?$/m.test(output) &&
    /^# pass 1\r?$/m.test(output) &&
    /^# fail 0\r?$/m.test(output)
  );
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
      "--test-reporter=tap",
      "scripts/openclaw-live-registry.real.test.ts",
    ],
    {
      cwd: params.cwd ?? process.cwd(),
      encoding: "utf8",
      env: { ...env, TEST_OPENCLAW_AGENTGUARD_CLI: cliPath },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 240_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || !hasExactlyOneRequiredTestPass(result.stdout)) {
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
