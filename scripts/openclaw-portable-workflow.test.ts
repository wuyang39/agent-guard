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

async function runPowerShell(
  script: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<unknown> {
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
    { cwd: repoRoot, windowsHide: true, env: { ...process.env, ...env } },
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

test("portable launcher isolates native supervision secrets per child process", async () => {
  const source = await readFile(
    path.join(repoRoot, "scripts", "start-agent-guard-openclaw.ps1"),
    "utf8",
  );

  assert.match(source, /\[hashtable\]\$EnvironmentOverrides/);
  assert.match(source, /\[Environment\]::SetEnvironmentVariable\([\s\S]*?finally[\s\S]*?\[Environment\]::SetEnvironmentVariable/);

  const gatewayStart = source.slice(
    source.indexOf('$gateway = Start-NodeService "gateway"'),
    source.indexOf('$sample = Start-NodeService "sample"'),
  );
  const sampleStart = source.slice(
    source.indexOf('$sample = Start-NodeService "sample"'),
    source.indexOf('$backend = Start-NodeService "backend"'),
  );
  const backendStart = source.slice(
    source.indexOf('$backend = Start-NodeService "backend"'),
    source.indexOf('$frontend = Start-NodeService "frontend"'),
  );
  const frontendStart = source.slice(
    source.indexOf('$frontend = Start-NodeService "frontend"'),
    source.indexOf('$records = @('),
  );
  for (const unprivileged of [gatewayStart, sampleStart, frontendStart]) {
    assert.match(unprivileged, /"AGENT_GUARD_CONTROL_TOKEN"\s*=\s*\$null/);
    assert.match(unprivileged, /"AGENT_GUARD_UI_BOOTSTRAP_TOKEN"\s*=\s*\$null/);
    assert.match(unprivileged, /"AGENT_GUARD_FRONTEND_ORIGIN"\s*=\s*\$null/);
  }
  assert.doesNotMatch(gatewayStart, /"--token"/);
  for (const noGatewayCredential of [sampleStart, frontendStart]) {
    assert.match(noGatewayCredential, /"OPENCLAW_GATEWAY_TOKEN"\s*=\s*\$null/);
  }
  assert.match(backendStart, /"AGENT_GUARD_CONTROL_TOKEN"\s*=\s*\$controlToken/);
  assert.match(backendStart, /"AGENT_GUARD_UI_BOOTSTRAP_TOKEN"\s*=\s*\$uiBootstrapToken/);
  assert.match(backendStart, /"AGENT_GUARD_FRONTEND_ORIGIN"\s*=\s*\$frontendOrigin/);
  assert.match(backendStart, /"OPENCLAW_GATEWAY_TOKEN"\s*=\s*\$gatewayToken/);
});

test("portable launcher keeps the one-time pairing URL out of persisted metadata", async () => {
  const source = await readFile(
    path.join(repoRoot, "scripts", "start-agent-guard-openclaw.ps1"),
    "utf8",
  );
  const planBlock = source.slice(source.indexOf("$plan = [ordered]@{"), source.indexOf("if ($PrintPlan)"));
  const recordBlock = source.slice(source.indexOf("$records = @("), source.indexOf("} catch {"));

  assert.match(source, /\$pairingUrl\s*=\s*"\$\{frontendOrigin\}\/\#agent-guard-bootstrap=\$uiBootstrapToken"/);
  assert.doesNotMatch(planBlock, /uiBootstrapToken|pairingUrl/i);
  assert.doesNotMatch(recordBlock, /uiBootstrapToken|pairingUrl/i);
  assert.match(source, /Open-PairingUrl \$pairingUrl \(\[bool\]\$NoBrowser\)/);

  const sentinels = {
    OPENCLAW_GATEWAY_TOKEN: "plan-gateway-sentinel",
    AGENT_GUARD_CONTROL_TOKEN: "plan-control-sentinel",
    AGENT_GUARD_UI_BOOTSTRAP_TOKEN: "plan-bootstrap-sentinel",
    AGENT_GUARD_FRONTEND_ORIGIN: "http://127.0.0.1:5999",
  };
  const plan = await runPowerShell("start-agent-guard-openclaw.ps1", ["-PrintPlan"], sentinels);
  const serializedPlan = JSON.stringify(plan);
  for (const sentinel of Object.values(sentinels)) {
    assert.doesNotMatch(serializedPlan, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Start-NodeService enforces the child environment matrix and restores its parent", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-guard-env-probe-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const probePath = path.join(tempRoot, "probe.mjs");
  const harnessPath = path.join(tempRoot, "harness.ps1");
  await writeFile(probePath, `
import { writeFileSync } from "node:fs";
const names = [
  "OPENCLAW_GATEWAY_TOKEN",
  "AGENT_GUARD_CONTROL_TOKEN",
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN",
  "AGENT_GUARD_FRONTEND_ORIGIN",
];
writeFileSync(
  process.argv[2],
  JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))),
  "utf8",
);
process.stdout.write("probe-ready\\n");
`, "utf8");
  await writeFile(harnessPath, String.raw`
param([string]$RepoRoot, [string]$TempRoot)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$launcherPath = Join-Path $RepoRoot "scripts\start-agent-guard-openclaw.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $launcherPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw "Launcher parse failed" }
$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Start-NodeService"
}, $true)
if ($null -eq $functionAst) { throw "Start-NodeService was not found" }
. ([scriptblock]::Create($functionAst.Extent.Text))

$names = @(
  "OPENCLAW_GATEWAY_TOKEN",
  "AGENT_GUARD_CONTROL_TOKEN",
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN",
  "AGENT_GUARD_FRONTEND_ORIGIN"
)
foreach ($name in $names) {
  [Environment]::SetEnvironmentVariable(
    $name,
    "parent-$name",
    [EnvironmentVariableTarget]::Process
  )
}
$logDir = Join-Path $TempRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$probePath = Join-Path $TempRoot "probe.mjs"

function Invoke-Probe([string]$Name, [hashtable]$Overrides) {
  $outputPath = Join-Path $TempRoot "$Name.json"
  $started = Start-NodeService $Name @($probePath, $outputPath) $TempRoot $logDir $Overrides
  $started.process.WaitForExit()
  $started.process.Refresh()
  if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
    $stderr = Get-Content -Raw -LiteralPath $started.stderr
    throw "$Name probe did not write its result (exit=$($started.process.ExitCode)): $stderr"
  }
  return [ordered]@{
    serviceName = $started.name
    environment = Get-Content -Raw -LiteralPath $outputPath | ConvertFrom-Json
  }
}

$gateway = Invoke-Probe "gateway" @{
  "OPENCLAW_GATEWAY_TOKEN" = "gateway-child"
  "AGENT_GUARD_CONTROL_TOKEN" = $null
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN" = $null
  "AGENT_GUARD_FRONTEND_ORIGIN" = $null
}
$sample = Invoke-Probe "sample" @{
  "OPENCLAW_GATEWAY_TOKEN" = $null
  "AGENT_GUARD_CONTROL_TOKEN" = $null
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN" = $null
  "AGENT_GUARD_FRONTEND_ORIGIN" = $null
}
$backend = Invoke-Probe "backend" @{
  "OPENCLAW_GATEWAY_TOKEN" = "backend-gateway-child"
  "AGENT_GUARD_CONTROL_TOKEN" = "backend-control-child"
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN" = "backend-bootstrap-child"
  "AGENT_GUARD_FRONTEND_ORIGIN" = "http://127.0.0.1:5888"
}
$frontend = Invoke-Probe "frontend" @{
  "OPENCLAW_GATEWAY_TOKEN" = $null
  "AGENT_GUARD_CONTROL_TOKEN" = $null
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN" = $null
  "AGENT_GUARD_FRONTEND_ORIGIN" = $null
}

$restored = [ordered]@{}
foreach ($name in $names) {
  $restored[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}
$failureThrew = $false
try {
  $failureArgs = @{
    Name = "failure"
    Arguments = @($probePath, (Join-Path $TempRoot "failure.json"))
    WorkingDirectory = Join-Path $TempRoot "missing-working-directory"
    LogDirectory = $logDir
    EnvironmentOverrides = @{
      "AGENT_GUARD_CONTROL_TOKEN" = "temporary-failure-value"
    }
  }
  Start-NodeService @failureArgs | Out-Null
} catch {
  $failureThrew = $true
}
$afterFailure = [Environment]::GetEnvironmentVariable(
  "AGENT_GUARD_CONTROL_TOKEN",
  [EnvironmentVariableTarget]::Process
)
$logs = [string]((Get-ChildItem -LiteralPath $logDir -File | ForEach-Object {
  Get-Content -Raw -LiteralPath $_.FullName
}) -join [Environment]::NewLine)

[ordered]@{
  gateway = $gateway
  sample = $sample
  backend = $backend
  frontend = $frontend
  restored = $restored
  failureThrew = $failureThrew
  afterFailure = $afterFailure
  logs = $logs
} | ConvertTo-Json -Depth 5
`, "utf8");

  const result = await execFileAsync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      harnessPath,
      "-RepoRoot",
      repoRoot,
      "-TempRoot",
      tempRoot,
    ],
    { cwd: repoRoot, windowsHide: true },
  );
  const probe = JSON.parse(result.stdout.trim()) as Record<string, Record<string, string | null> | string | boolean>;
  const empty = {
    OPENCLAW_GATEWAY_TOKEN: null,
    AGENT_GUARD_CONTROL_TOKEN: null,
    AGENT_GUARD_UI_BOOTSTRAP_TOKEN: null,
    AGENT_GUARD_FRONTEND_ORIGIN: null,
  };
  assert.equal((probe.gateway as Record<string, unknown>).serviceName, "gateway");
  assert.equal((probe.sample as Record<string, unknown>).serviceName, "sample");
  assert.equal((probe.backend as Record<string, unknown>).serviceName, "backend");
  assert.equal((probe.frontend as Record<string, unknown>).serviceName, "frontend");
  assert.deepEqual((probe.gateway as Record<string, unknown>).environment, {
    ...empty,
    OPENCLAW_GATEWAY_TOKEN: "gateway-child",
  });
  assert.deepEqual((probe.sample as Record<string, unknown>).environment, empty);
  assert.deepEqual((probe.backend as Record<string, unknown>).environment, {
    OPENCLAW_GATEWAY_TOKEN: "backend-gateway-child",
    AGENT_GUARD_CONTROL_TOKEN: "backend-control-child",
    AGENT_GUARD_UI_BOOTSTRAP_TOKEN: "backend-bootstrap-child",
    AGENT_GUARD_FRONTEND_ORIGIN: "http://127.0.0.1:5888",
  });
  assert.deepEqual((probe.frontend as Record<string, unknown>).environment, empty);
  assert.deepEqual(probe.restored, Object.fromEntries(
    Object.keys(empty).map((name) => [name, `parent-${name}`]),
  ));
  assert.equal(probe.failureThrew, true);
  assert.equal(probe.afterFailure, "parent-AGENT_GUARD_CONTROL_TOKEN");
  const logs = String(probe.logs);
  assert.match(logs, /probe-ready/);
  for (const secret of [
    "gateway-child",
    "backend-gateway-child",
    "backend-control-child",
    "backend-bootstrap-child",
    "#agent-guard-bootstrap=",
  ]) {
    assert.doesNotMatch(logs, new RegExp(secret));
  }
});

test("browser launch failure prints one pairing URL without failing the launcher", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-guard-browser-probe-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const harnessPath = path.join(tempRoot, "browser-harness.ps1");
  const pairingUrl = `http://127.0.0.1:5173/#agent-guard-bootstrap=${"b".repeat(43)}`;
  await writeFile(harnessPath, String.raw`
param([string]$RepoRoot, [string]$PairingUrl)
$ErrorActionPreference = "Stop"
$tokens = $null
$parseErrors = $null
$launcherPath = Join-Path $RepoRoot "scripts\start-agent-guard-openclaw.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $launcherPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw "Launcher parse failed" }
$functionAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Open-PairingUrl"
}, $true)
if ($null -eq $functionAst) { throw "Open-PairingUrl was not found" }
. ([scriptblock]::Create($functionAst.Extent.Text))
function Start-Process { throw "URL handler is unavailable" }
Open-PairingUrl $PairingUrl $false
`, "utf8");

  const result = await execFileAsync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      harnessPath,
      "-RepoRoot",
      repoRoot,
      "-PairingUrl",
      pairingUrl,
    ],
    { cwd: repoRoot, windowsHide: true },
  );
  assert.equal(result.stdout.split(pairingUrl).length - 1, 1);
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
