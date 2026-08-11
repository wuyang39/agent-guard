import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SCRIPT = path.resolve("scripts", "install-openclaw-native-guard.ps1");

test("plugin package metadata accepts the exact Agent Guard fork or official compatible hosts", async () => {
  const pluginPackage = JSON.parse(
    await readFile(path.resolve("plugins", "agent-guard-supervision", "package.json"), "utf8"),
  ) as Record<string, any>;
  const supportedRange = "2026.7.1-agentguard.1 || >=2026.7.2";

  assert.equal(pluginPackage.peerDependencies?.openclaw, supportedRange);
  assert.equal(pluginPackage.openclaw?.install?.minHostVersion, supportedRange);
  assert.equal(pluginPackage.openclaw?.compat?.pluginApi, supportedRange);
});

test("installer uses the explicit compatible fork CLI and writes only the isolated profile", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = JSON.parse(
      await readFile(path.join(fixture.home, "openclaw.json"), "utf8"),
    ) as {
      pluginDirs?: unknown;
      plugins?: {
        load?: { paths?: string[] };
        entries?: Record<
          string,
          {
            enabled?: boolean;
            config?: { markerDir?: string; spoolDir?: string };
          }
        >;
      };
    };
    const entry = config.plugins?.entries?.["agent-guard-supervision"];
    assert.deepEqual(config.plugins?.load?.paths, [fixture.plugin]);
    assert.equal(entry?.enabled, true);
    assert.equal(
      entry?.config?.markerDir,
      path.join(fixture.home, "agent-guard", "markers"),
    );
    assert.equal(
      entry?.config?.spoolDir,
      path.join(fixture.home, "agent-guard", "spool"),
    );
    assert.equal(config.pluginDirs, undefined);
    const bytes = await readFile(path.join(fixture.home, "openclaw.json"));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer executes an explicit OpenClaw mjs entry through Node", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const mjsCli = path.join(fixture.root, "openclaw.mjs");
  await writeFile(
    mjsCli,
    [
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("OpenClaw 2026.7.1-agentguard.1\\n");',
      "} else {",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const result = runInstaller(fixture, { cli: mjsCli });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /node\s+"[^"]+openclaw\.mjs"\s+plugins list --json/u);
    await readFile(path.join(fixture.home, "openclaw.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer resolves OPENCLAW_CLI when no explicit CLI is provided", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  try {
    const result = runInstaller(fixture, {
      explicitCli: false,
      envCli: fixture.cli,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await readFile(path.join(fixture.home, "openclaw.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer never falls back when an explicit CLI fails", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  try {
    const missingCli = path.join(fixture.root, "missing-openclaw.cmd");
    const result = runInstaller(fixture, {
      cli: missingCli,
      envCli: fixture.cli,
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(fixture.home, "openclaw.json")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer requires an explicit CLI source before modifying config", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const configPath = path.join(fixture.home, "openclaw.json");
  const pathFallback = path.join(fixture.root, "openclaw.cmd");
  const original = Buffer.from("{\r\n  \"preserve\": \"cli-required\"\r\n}\r\n", "utf8");
  await mkdir(fixture.home, { recursive: true });
  await writeFile(configPath, original);
  await writeFile(
    pathFallback,
    '@echo off\r\nif "%~1"=="--version" (echo OpenClaw 2026.7.1-agentguard.1& exit /b 0)\r\nexit /b 1\r\n',
    "utf8",
  );
  try {
    const result = runInstaller(fixture, {
      explicitCli: false,
      envCli: undefined,
      path: `${fixture.root};${process.env.PATH ?? ""}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /OpenClawCli|OPENCLAW_CLI/i);
    assert.deepEqual(await readFile(configPath), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer requires an explicit isolated OpenClaw home before modifying config", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const userProfile = path.join(fixture.root, "user-profile");
  const fallbackHome = path.join(userProfile, ".openclaw");
  const configPath = path.join(fallbackHome, "openclaw.json");
  const original = Buffer.from("{\r\n  \"preserve\": \"home-required\"\r\n}\r\n", "utf8");
  await mkdir(fallbackHome, { recursive: true });
  await writeFile(configPath, original);
  try {
    const result = runInstaller(fixture, {
      explicitHome: false,
      envHome: undefined,
      envConfigDir: undefined,
      userProfile,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /OpenClawHome|OPENCLAW_HOME|OPENCLAW_CONFIG_DIR/i,
    );
    assert.deepEqual(await readFile(configPath), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer preserves unrelated config and merges the OpenClaw plugin schema", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const otherPlugin = path.join(fixture.root, "other-plugin");
  const configPath = path.join(fixture.home, "openclaw.json");
  const nested = nestedConfig(12);
  await mkdir(fixture.home, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    gateway: { port: 18789 },
    nested,
    pluginDirs: ["legacy-value"],
    plugins: {
      load: { paths: [otherPlugin] },
      entries: {
        "other-plugin": { enabled: false, config: { keep: true } },
      },
    },
  }), "utf8");
  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(config.gateway, { port: 18789 });
    assert.deepEqual(config.nested, nested);
    assert.equal(config.pluginDirs, undefined);
    assert.deepEqual(config.plugins.load.paths, ["legacy-value", otherPlugin, fixture.plugin]);
    assert.deepEqual(config.plugins.entries["other-plugin"], {
      enabled: false,
      config: { keep: true },
    });
    assert.equal(config.plugins.entries["agent-guard-supervision"].enabled, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer losslessly migrates legacy plugin arrays and pluginDirs", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const firstPlugin = path.join(fixture.root, "legacy-first");
  const secondPlugin = path.join(fixture.root, "legacy-second");
  const configPath = path.join(fixture.home, "openclaw.json");
  await mkdir(fixture.home, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    gateway: { port: 18789 },
    pluginDirs: [firstPlugin, secondPlugin, firstPlugin],
    plugins: [
      {
        id: "legacy-first",
        enabled: false,
        path: firstPlugin,
        config: { keep: true },
      },
      {
        id: "legacy-second",
        enabled: true,
        path: secondPlugin,
      },
    ],
  }), "utf8");
  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(config.pluginDirs, undefined);
    assert.deepEqual(config.plugins.load.paths, [firstPlugin, secondPlugin, fixture.plugin]);
    assert.deepEqual(config.plugins.entries["legacy-first"], {
      enabled: false,
      config: { keep: true },
    });
    assert.deepEqual(config.plugins.entries["legacy-second"], { enabled: true });
    assert.equal(config.plugins.entries["agent-guard-supervision"].enabled, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer rejects a legacy name that has no lossless modern mapping", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const configPath = path.join(fixture.home, "openclaw.json");
  await mkdir(fixture.home, { recursive: true });
  const original = JSON.stringify({
    pluginDirs: [path.join(fixture.root, "legacy")],
    plugins: [{
      id: "legacy",
      name: "Cannot Be Represented",
      enabled: true,
      path: path.join(fixture.root, "legacy"),
    }],
  });
  await writeFile(configPath, original, "utf8");
  try {
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer preserves invalid existing JSON byte-for-byte and exits nonzero", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const configPath = path.join(fixture.home, "openclaw.json");
  await mkdir(fixture.home, { recursive: true });
  const original = Buffer.from("{\r\n  \"plugins\": [ invalid\r\n", "utf8");
  await writeFile(configPath, original);
  try {
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readFile(configPath), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer rejects an unlossless legacy plugin entry before overwriting config", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const configPath = path.join(fixture.home, "openclaw.json");
  await mkdir(fixture.home, { recursive: true });
  const original = JSON.stringify({
    pluginDirs: [path.join(fixture.root, "legacy")],
    plugins: [{ id: "legacy", enabled: true, unsupported: "must-not-drop" }],
  });
  await writeFile(configPath, original, "utf8");
  try {
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall removes only Agent Guard from the current OpenClaw plugin schema", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-agentguard.1");
  const otherPlugin = path.join(fixture.root, "other-plugin");
  try {
    const installed = runInstaller(fixture);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const configPath = path.join(fixture.home, "openclaw.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config.gateway = { port: 18789 };
    config.plugins.load.paths.unshift(otherPlugin);
    config.plugins.entries["other-plugin"] = { enabled: true };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const uninstalled = runInstaller(fixture, { uninstall: true });
    assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
    const updatedBytes = await readFile(configPath);
    assert.notDeepEqual([...updatedBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const updated = JSON.parse(updatedBytes.toString("utf8")) as Record<string, any>;
    assert.deepEqual(updated.gateway, { port: 18789 });
    assert.deepEqual(updated.plugins.load.paths, [otherPlugin]);
    assert.deepEqual(updated.plugins.entries["other-plugin"], { enabled: true });
    assert.equal(updated.plugins.entries["agent-guard-supervision"], undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer rejects an unsupported official CLI before writing the profile", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1-2");
  try {
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(fixture.home, "openclaw.json")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Force cannot bypass the minimum OpenClaw version", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.1");
  try {
    const result = runInstaller(fixture, { force: true });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(fixture.home, "openclaw.json")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("installer rejects an official prerelease below 2026.7.2", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.7.2-beta.1");
  try {
    const result = runInstaller(fixture);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(fixture.home, "openclaw.json")));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const version of [
  "OpenClaw 2026.7.1-agentguard",
  "OpenClaw 2026.7.1-agentguard.2",
  "OpenClaw 2026.7.1-agentguard.evil",
  "OpenClaw 2026.7.2-agentguard.1",
  "OpenClaw 2026.8.0-agentguard.1",
]) {
  test(`installer rejects non-exact fork version ${version}`, {
    skip: process.platform !== "win32",
  }, async () => {
    const fixture = await createFixture(version);
    try {
      const result = runInstaller(fixture);
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(path.join(fixture.home, "openclaw.json")));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("installer accepts a newer official stable version", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createFixture("OpenClaw 2026.8.0");
  try {
    const result = runInstaller(fixture);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    await readFile(path.join(fixture.home, "openclaw.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

type Fixture = {
  root: string;
  home: string;
  plugin: string;
  cli: string;
};

async function createFixture(version: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-installer-"));
  const home = path.join(root, "profile");
  const plugin = path.join(root, "plugin");
  const cli = path.join(root, "openclaw-agentguard.cmd");
  await mkdir(path.join(plugin, "dist"), { recursive: true });
  await writeFile(path.join(plugin, "dist", "index.js"), "export {};\n", "utf8");
  await writeFile(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({ id: "agent-guard-supervision" }),
    "utf8",
  );
  await writeFile(
    cli,
    `@echo off\r\nif "%~1"=="--version" (echo ${version}& exit /b 0)\r\nexit /b 1\r\n`,
    "utf8",
  );
  return { root, home, plugin, cli };
}

function runInstaller(fixture: Fixture, options: {
  cli?: string;
  envCli?: string;
  explicitCli?: boolean;
  explicitHome?: boolean;
  envHome?: string;
  envConfigDir?: string;
  userProfile?: string;
  path?: string;
  uninstall?: boolean;
  force?: boolean;
} = {}) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT,
  ];
  if (options.explicitCli !== false) {
    args.push("-OpenClawCli", options.cli ?? fixture.cli);
  }
  if (options.explicitHome !== false) {
    args.push("-OpenClawHome", fixture.home);
  }
  args.push("-PluginSourceDir", fixture.plugin);
  if (options.uninstall) args.push("-Uninstall");
  if (options.force) args.push("-Force");
  return spawnSync(
    "powershell.exe",
    args,
    {
      windowsHide: true,
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        OPENCLAW_CLI: options.envCli,
        OPENCLAW_HOME: options.envHome,
        OPENCLAW_CONFIG_DIR: options.envConfigDir,
        USERPROFILE: options.userProfile ?? process.env.USERPROFILE,
        PATH: options.path ?? process.env.PATH,
      },
    },
  );
}

function nestedConfig(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: "preserved" };
  for (let index = 0; index < depth; index += 1) {
    value = { [`level${String(index)}`]: value };
  }
  return value;
}
