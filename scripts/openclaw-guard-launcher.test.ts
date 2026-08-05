import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasLiveGuardRegistry,
  inspectGuardedMarkers,
  runCli,
} from "./openclaw-guard-launcher";

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
  const launch = (args: string[]) => spawnSync(
    process.execPath,
    ["--import", "tsx", path.resolve("scripts/openclaw-guard-launcher.ts"), ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_CLI: cliPath,
        OPENCLAW_HOME: root,
        AGENT_GUARD_MARKER_DIR: markerDir,
      },
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 15_000,
    },
  );

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
    plugins: [{
      id: "agent-guard-supervision",
      enabled: true,
      status: "loaded",
      hookNames: ["before_tool_call"],
      services: ["agent-guard-runtime"],
      manifest: {
        contracts: { trustedToolPolicies: ["agent-guard-admission"] },
      },
    }],
    registry: {
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
  };
}
