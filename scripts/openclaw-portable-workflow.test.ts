import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

async function runPowerShell(script: string, args: string[]): Promise<unknown> {
  const result = await execFileAsync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", script),
      ...args,
    ],
    { cwd: repoRoot, windowsHide: true },
  );
  return JSON.parse(result.stdout.trim());
}

test("distribution manifest pins the public fork and immutable GHCR image", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "configs", "openclaw-distribution.json"), "utf8"),
  ) as {
    schemaVersion: string;
    fork: { repository: string; branch: string; commit: string; version: string };
    sandboxImage: string;
  };

  assert.equal(manifest.schemaVersion, "agent-guard-openclaw-distribution-1");
  assert.deepEqual(manifest.fork, {
    repository: "https://github.com/wuyang39/openclaw-agentguard.git",
    branch: "agentguard-2026.7.1",
    commit: "d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa",
    version: "2026.7.1-agentguard.1",
  });
  assert.equal(
    manifest.sandboxImage,
    "ghcr.io/wuyang39/openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38",
  );
});

test("bootstrap print plan resolves a clone-safe runtime without changing disk", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-guard-bootstrap-plan-"));
  const runtimeRoot = path.join(tempRoot, "runtime");
  try {
    const plan = await runPowerShell("bootstrap-agent-guard-openclaw.ps1", [
      "-RuntimeRoot",
      runtimeRoot,
      "-PrintPlan",
    ]) as Record<string, unknown>;

    const plannedRuntimeRoot = String(plan.runtimeRoot);
    assert.equal(path.basename(plannedRuntimeRoot), "runtime");
    assert.equal(plan.forkRoot, path.join(plannedRuntimeRoot, "openclaw-agentguard-active"));
    assert.equal(
      plan.profileRoot,
      path.join(os.homedir(), ".agent-guard", "openclaw-native-guard-profile"),
    );
    assert.equal(plan.environmentFile, path.join(plannedRuntimeRoot, "agent-guard-openclaw-env.ps1"));
    assert.equal(plan.forkCommit, "d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa");
    assert.equal(
      plan.sandboxImage,
      "ghcr.io/wuyang39/openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38",
    );
    await assert.rejects(readFile(path.join(runtimeRoot, "agent-guard-openclaw-env.ps1")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bootstrap resolves one executable per Windows prerequisite", async () => {
  const prerequisites = await runPowerShell("bootstrap-agent-guard-openclaw.ps1", [
    "-CheckPrerequisites",
  ]) as Record<string, string>;

  assert.match(path.basename(prerequisites.node), /^node(?:\.exe)?$/i);
  assert.match(path.basename(prerequisites.npm), /^npm(?:\.cmd)?$/i);
  assert.match(path.basename(prerequisites.git), /^git(?:\.exe)?$/i);
  assert.match(path.basename(prerequisites.docker), /^docker(?:\.exe)?$/i);
  assert.match(path.basename(prerequisites.corepack), /^corepack(?:\.cmd)?$/i);
});

test("start print plan uses the portable runtime and per-run gateway lifecycle", async () => {
  const runtimeRoot = path.join(repoRoot, "outputs");
  const plan = await runPowerShell("start-agent-guard-openclaw.ps1", [
    "-RuntimeRoot",
    runtimeRoot,
    "-PrintPlan",
  ]) as {
    services: Array<{ name: string; port: number }>;
    openClawCli: string;
    sandboxImage: string;
    gatewayLifecycle: string;
    supervisionGatewayLifecycle: string;
    controlTokenFile: string;
    hostAttestationBootstrapFile: string;
  };

  assert.deepEqual(plan.services, [
    { name: "gateway", port: 18789 },
    { name: "sample", port: 7001 },
    { name: "backend", port: 3100 },
    { name: "frontend", port: 5173 },
  ]);
  assert.equal(
    plan.openClawCli,
    path.join(path.resolve(runtimeRoot), "openclaw-agentguard-active", "openclaw.mjs"),
  );
  assert.match(plan.sandboxImage, /^ghcr\.io\/wuyang39\/openclaw-sandbox@sha256:[0-9a-f]{64}$/);
  assert.equal(plan.gatewayLifecycle, "per-run-detection-sandbox");
  assert.equal(plan.supervisionGatewayLifecycle, "managed-guard-launcher");
  assert.equal(
    plan.controlTokenFile,
    path.join(path.resolve(runtimeRoot), "runtime", "agent-guard-control-token.txt"),
  );
  assert.equal(
    plan.hostAttestationBootstrapFile,
    path.join(path.resolve(runtimeRoot), "runtime", "openclaw-host-attestation-bootstrap.json"),
  );
});

test("host launcher creates an exclusive fd3 bootstrap file and preserves normal launches", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-host-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = await import("./openclaw-guard-launcher") as unknown as {
    runOpenClawChild: (
      args: string[],
      cliPath: string,
      env: NodeJS.ProcessEnv,
    ) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  };
  assert.equal(typeof launcher.runOpenClawChild, "function");
  const bootstrapFile = path.join(root, "bootstrap.json");
  const record = `${JSON.stringify({
    contractVersion: "native-guard-bootstrap-1",
    attestationPublicKey: "child-writes-the-real-key",
  })}\n`;

  const guarded = await launcher.runOpenClawChild([
    "-e",
    `require("node:fs").writeSync(3, ${JSON.stringify(record)})`,
  ], process.execPath, {
    ...process.env,
    AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE: bootstrapFile,
  });
  assert.deepEqual(guarded, { exitCode: 0, signal: null });
  assert.equal(await readFile(bootstrapFile, "utf8"), record);
  await rm(bootstrapFile);

  const ordinary = await launcher.runOpenClawChild(
    ["-e", "process.exit(0)"],
    process.execPath,
    { ...process.env, AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE: undefined },
  );
  assert.deepEqual(ordinary, { exitCode: 0, signal: null });
});

test("host launcher fails closed on stale and unsafe bootstrap paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-host-launcher-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = await import("./openclaw-guard-launcher") as unknown as {
    runOpenClawChild: (
      args: string[],
      cliPath: string,
      env: NodeJS.ProcessEnv,
    ) => Promise<unknown>;
  };
  const stale = path.join(root, "bootstrap.json");
  await writeFile(stale, "stale", "utf8");

  for (const bootstrapFile of [stale, "relative-bootstrap.json"] as const) {
    await assert.rejects(
      () => launcher.runOpenClawChild(
        ["-e", "process.exit(0)"],
        process.execPath,
        { ...process.env, AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE: bootstrapFile },
      ),
      /bootstrap/i,
    );
  }
});

test("portable start removes the exact stale host bootstrap before Gateway launch", async () => {
  const source = await readFile(
    path.join(repoRoot, "scripts", "start-agent-guard-openclaw.ps1"),
    "utf8",
  );
  const removal = source.indexOf("Remove-Item -LiteralPath $hostAttestationBootstrapFile");
  const gatewayStart = source.indexOf('Start-NodeService "gateway"');
  assert.notEqual(removal, -1);
  assert.ok(removal < gatewayStart);
  assert.match(source, /AGENT_GUARD_HOST_ATTESTATION_BOOTSTRAP_FILE/);
});

test("stop handles a top-level PowerShell JSON array registry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-guard-stop-registry-"));
  const runtimeState = path.join(tempRoot, "runtime");
  const pidFile = path.join(runtimeState, "agent-guard-services.json");
  await mkdir(runtimeState, { recursive: true });
  await writeFile(pidFile, JSON.stringify([
    { name: "one", pid: 2_147_483_000, startedAt: "2000-01-01T00:00:00.000Z" },
    { name: "two", pid: 2_147_483_001, startedAt: "2000-01-01T00:00:00.000Z" },
  ]), "utf8");
  try {
    await execFileAsync(
      powershell,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(repoRoot, "scripts", "stop-agent-guard-openclaw.ps1"),
        "-RuntimeRoot",
        tempRoot,
      ],
      { cwd: repoRoot, windowsHide: true },
    );
    await assert.rejects(readFile(pidFile));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("load verifier defaults to strict 5 then 30 case stages", async () => {
  const result = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/verify-openclaw-load.ts",
      "--print-plan",
    ],
    { cwd: repoRoot, windowsHide: true },
  );
  const plan = JSON.parse(result.stdout.trim()) as {
    caseCounts: number[];
    stopOnFailure: boolean;
    requireNoResidualDockerResources: boolean;
  };

  assert.deepEqual(plan.caseCounts, [5, 30]);
  assert.equal(plan.stopOnFailure, true);
  assert.equal(plan.requireNoResidualDockerResources, true);
});
