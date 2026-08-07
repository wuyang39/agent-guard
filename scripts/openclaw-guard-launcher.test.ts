import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasLiveGuardRegistry,
  inspectGuardedMarkers,
  runCli,
} from "./openclaw-guard-launcher";

const LAUNCHER = path.resolve("scripts/openclaw-guard-launcher.ts");

function launchGuard(params: {
  cliPath: string;
  markerDir: string;
  homeDir: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", LAUNCHER, ...(params.args ?? [])],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...params.env,
        OPENCLAW_CLI: params.cliPath,
        OPENCLAW_HOME: params.homeDir,
        AGENT_GUARD_MARKER_DIR: params.markerDir,
      },
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: params.timeoutMs ?? 30_000,
    },
  );
}

test("marker inventory distinguishes an absent directory from guarded state", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.equal(inspectGuardedMarkers("unused", () => { throw missing; }), "none");
  assert.equal(inspectGuardedMarkers("unused", () => ["lease.json"]), "guarded");
  assert.equal(
    inspectGuardedMarkers("unused", () => ["lease.tmp.json", "lease.corrupt.json"]),
    "none",
  );
});

test("marker inventory fails closed when the directory cannot be read", () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(
    () => inspectGuardedMarkers("unused", () => { throw denied; }),
    /denied/,
  );
});

test("launcher rejects boolean-only or version-only live claims", () => {
  const complete = liveRegistry();
  assert.equal(
    hasLiveGuardRegistry(
      { ...complete, registry: { liveAttestation: true } },
      "OpenClaw 2026.7.1-agentguard.1",
    ),
    false,
  );
  assert.equal(
    hasLiveGuardRegistry(complete, "OpenClaw 2026.7.1-2"),
    false,
  );
});

test("launcher accepts a complete live registry from a compatible build", () => {
  assert.equal(
    hasLiveGuardRegistry(liveRegistry(), "OpenClaw 2026.7.1-agentguard.1"),
    true,
  );
  assert.equal(
    hasLiveGuardRegistry(liveRegistry(), "OpenClaw 2026.7.2"),
    true,
  );
});

test("launcher rejects static inventory and incomplete live contributions", () => {
  const staticInventory = {
    registry: {
      source: "derived",
      diagnostics: [],
    },
    plugins: [{
      id: "agent-guard-supervision",
      enabled: true,
      status: "loaded",
      hookNames: [],
      services: [],
      contracts: { trustedToolPolicies: ["agent-guard-admission"] },
    }],
    diagnostics: [],
  };
  assert.equal(
    hasLiveGuardRegistry(staticInventory, "OpenClaw 2026.7.1-agentguard.1"),
    false,
  );

  for (const missing of ["hook", "service", "policy", "capability"] as const) {
    const incomplete = structuredClone(liveRegistry());
    const plugin = (incomplete.plugins as Array<Record<string, unknown>>)[0];
    assert.ok(plugin);
    if (missing === "hook") plugin.hookNames = [];
    if (missing === "service") plugin.services = [];
    if (missing === "policy") plugin.trustedToolPolicies = [];
    if (missing === "capability") {
      (incomplete.registry as Record<string, unknown>).nativeGuard = null;
    }
    assert.equal(
      hasLiveGuardRegistry(incomplete, "OpenClaw 2026.7.1-agentguard.1"),
      false,
      `missing ${missing}`,
    );
  }
});

test("guarded launcher requests the exact live CLI contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-live-contract-"));
  const markerDir = path.join(root, "markers");
  const entry = path.join(root, "cli.mjs");
  const callsPath = path.join(root, "calls.txt");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, "lease.json"), "{}", "utf8");
  await writeFile(entry, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    `const callsPath = ${JSON.stringify(callsPath)};`,
    "const call = process.argv.slice(2).join(' ');",
    "fs.appendFileSync(callsPath, `${call}\\n`, 'utf8');",
    "if (call === '--version') console.log('OpenClaw 2026.7.1-agentguard.1');",
    `else if (call === 'plugins list --json --live') console.log(${JSON.stringify(JSON.stringify(liveRegistry()))});`,
    "else console.log(JSON.stringify({registry:{source:'derived',diagnostics:[]},plugins:[],diagnostics:[]}));",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });

  try {
    const result = launchGuard({
      cliPath: entry,
      markerDir,
      homeDir: root,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const calls = await readFile(callsPath, "utf8");
    assert.deepEqual(calls.trim().split(/\r?\n/), [
      "plugins list --json --live",
      "--version",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact fork live registry allows guarded startup in an isolated profile", {
  skip: !process.env.TEST_OPENCLAW_AGENTGUARD_CLI,
  timeout: 120_000,
}, async () => {
  const cliPath = process.env.TEST_OPENCLAW_AGENTGUARD_CLI;
  assert.ok(cliPath);
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-exact-fork-"));
  const markerDir = path.join(root, "markers");
  const spoolDir = path.join(root, "spool");
  const configPath = path.join(root, "openclaw.json");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, "lease.1.json"), JSON.stringify({
    leaseId: "lease.1",
    rootSessionKey: "agent:guard:launcher-test",
    childSessionKeys: [],
    mode: "supervision",
    policyPackId: "policy.launcher-test",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-01T00:00:00.000Z",
  }), "utf8");
  await writeFile(configPath, JSON.stringify({
    plugins: {
      enabled: true,
      allow: ["agent-guard-supervision"],
      load: { paths: [path.resolve("plugins/agent-guard-supervision")] },
      entries: {
        "agent-guard-supervision": {
          enabled: true,
          config: { markerDir, spoolDir },
        },
      },
    },
  }), "utf8");

  try {
    const result = launchGuard({
      cliPath,
      markerDir,
      homeDir: root,
      timeoutMs: 90_000,
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher fails closed with bounded output when the CLI exceeds maxBuffer", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-buffer-"));
  const entry = path.join(root, "dist", "cli.js");
  const wrapper = path.join(root, "openclaw-agentguard.cmd");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(
    entry,
    "process.stdout.write('x'.repeat(512 * 1024));\n",
    "utf8",
  );
  await writeFile(
    wrapper,
    '@echo off\r\nnode "%~dp0dist\\cli.js" %*\r\n',
    "utf8",
  );

  try {
    const result = runCli(["plugins", "list", "--json"], wrapper);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /output.*limit/i);
    assert.ok(Buffer.byteLength(result.stderr, "utf8") < 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher run-scoped env overrides Windows wrapper-local defaults", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-env-"));
  const entry = path.join(root, "dist", "cli.js");
  const wrapper = path.join(root, "openclaw-agentguard.cmd");
  const runHome = path.join(root, "isolated-run");
  await mkdir(path.dirname(entry), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "openclaw.json"), "{}", "utf8");
  await writeFile(
    entry,
    "process.stdout.write(JSON.stringify({home:process.env.OPENCLAW_HOME,config:process.env.OPENCLAW_CONFIG_PATH}));\n",
    "utf8",
  );
  await writeFile(
    wrapper,
    '@echo off\r\nnode "%~dp0dist\\cli.js" %*\r\n',
    "utf8",
  );
  const previousHome = process.env.OPENCLAW_HOME;
  const previousConfig = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_HOME = runHome;
  process.env.OPENCLAW_CONFIG_PATH = path.join(runHome, "openclaw.json");

  try {
    const result = runCli(["plugins", "list", "--json"], wrapper);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      home: runHome,
      config: path.join(runHome, "openclaw.json"),
    });
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid registry JSON is allowed only for maintenance cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-maintenance-"));
  const markerDir = path.join(root, "markers");
  const entry = path.join(root, "cli.mjs");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, "lease.json"), "{}", "utf8");
  await writeFile(entry, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) console.log('OpenClaw 2026.7.2');",
    "else console.log('{invalid registry');",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  let cliPath = entry;
  if (process.platform === "win32") {
    cliPath = path.join(root, "openclaw.cmd");
    await writeFile(cliPath, '@echo off\r\nnode "%~dp0cli.mjs" %*\r\n', "utf8");
  }
  const launch = (args: string[]) => launchGuard({
    cliPath,
    markerDir,
    homeDir: root,
    args,
  });

  try {
    const maintenance = launch(["--maintenance"]);
    assert.equal(maintenance.status, 0, maintenance.stderr || maintenance.stdout);
    const normal = launch([]);
    assert.equal(normal.status, 1, normal.stderr || normal.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function liveRegistry(): Record<string, unknown> {
  return {
    workspaceDir: "C:\\isolated\\workspace",
    plugins: [{
      id: "agent-guard-supervision",
      enabled: true,
      status: "loaded",
      activated: true,
      hookNames: ["before_tool_call"],
      services: ["agent-guard-runtime"],
      trustedToolPolicies: ["agent-guard-admission"],
    }],
    registry: {
      contractVersion: "openclaw.plugins.live.v1",
      liveAttestation: true,
      nativeGuard: {
        contractVersion: "native-guard-1",
        registrarStatus: "live",
        finalBeforeToolCall: {
          pluginId: "agent-guard-supervision",
          exclusive: true,
        },
        trustedToolPolicy: {
          policyId: "agent-guard-admission",
          exclusive: true,
        },
        recoveryService: {
          serviceId: "agent-guard-runtime",
          live: true,
        },
        postApprovalLeaseRecheck: true,
        paramsProvenance: "json-only",
      },
    },
    diagnostics: [],
  };
}
