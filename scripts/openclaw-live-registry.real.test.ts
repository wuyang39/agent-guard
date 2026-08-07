import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isCompatibleNativeGuardVersion } from "../backend/src/modules/openclaw/nativeGuardLiveCapability";
import { runCli } from "./openclaw-guard-launcher";
import { resolveRequiredOpenClawCli } from "./verify-openclaw-live-registry-gate";

const LAUNCHER = path.resolve("scripts/openclaw-guard-launcher.ts");

test("required real OpenClaw live registry allows guarded startup", { timeout: 120_000 }, async () => {
  const cliPath = resolveRequiredOpenClawCli(process.env);
  const versionResult = runCli(["--version"], cliPath);
  assert.equal(versionResult.exitCode, 0, "required OpenClaw CLI version probe failed");
  const version = versionResult.stdout.match(
    /(?:^|\D)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/,
  )?.[1];
  assert.ok(version && isCompatibleNativeGuardVersion(version), "required OpenClaw CLI is incompatible");

  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-live-registry-real-"));
  const markerDir = path.join(root, "markers");
  const spoolDir = path.join(root, "spool");
  const configPath = path.join(root, "openclaw.json");
  await mkdir(markerDir, { recursive: true });
  await writeFile(path.join(markerDir, "lease.1.json"), JSON.stringify({
    leaseId: "lease.1",
    rootSessionKey: "agent:guard:live-registry-real",
    childSessionKeys: [],
    mode: "supervision",
    policyPackId: "policy.live-registry-real",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
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
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", LAUNCHER, "--", "--version"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_GUARD_MARKER_DIR: markerDir,
          NODE_ENV: "production",
          OPENCLAW_CLI: cliPath,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
          OPENCLAW_HOME: root,
        },
        encoding: "utf8",
        shell: false,
        timeout: 90_000,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, "required live registry rejected guarded startup");
    assert.ok(
      (result.stdout ?? "").includes(versionResult.stdout),
      "guarded launcher did not execute the required OpenClaw --version child",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
