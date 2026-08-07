import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveRequiredOpenClawCli,
  runOpenClawLiveRegistryGate,
} from "./verify-openclaw-live-registry-gate";

test("real live registry gate requires an explicit exact-fork CLI", () => {
  assert.throws(
    () => resolveRequiredOpenClawCli({}),
    /TEST_OPENCLAW_AGENTGUARD_CLI or OPENCLAW_CLI is required/,
  );
  assert.throws(
    () => resolveRequiredOpenClawCli({ TEST_OPENCLAW_AGENTGUARD_CLI: "  " }),
    /TEST_OPENCLAW_AGENTGUARD_CLI or OPENCLAW_CLI is required/,
  );
  assert.equal(
    resolveRequiredOpenClawCli({ TEST_OPENCLAW_AGENTGUARD_CLI: " C:\\openclaw.cmd " }),
    "C:\\openclaw.cmd",
  );
  assert.equal(
    resolveRequiredOpenClawCli({ OPENCLAW_CLI: " C:\\fallback-openclaw.cmd " }),
    "C:\\fallback-openclaw.cmd",
  );
  assert.equal(
    resolveRequiredOpenClawCli({
      TEST_OPENCLAW_AGENTGUARD_CLI: " C:\\preferred-openclaw.cmd ",
      OPENCLAW_CLI: "C:\\fallback-openclaw.cmd",
    }),
    "C:\\preferred-openclaw.cmd",
  );
});

test("real live registry gate runs the standalone required test without a name pattern", () => {
  const calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdio: "inherit" | ["ignore", "pipe", "pipe"];
    timeout: number;
  }> = [];
  runOpenClawLiveRegistryGate({
    env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
    nodePath: "node-test",
    spawn: (command, args, options) => {
      calls.push({
        command,
        args,
        env: options.env ?? {},
        stdio: options.stdio,
        timeout: options.timeout,
      });
      return {
        status: 0,
        stdout: [
          "TAP version 13",
          "ok 1 - required real OpenClaw live registry allows guarded startup",
          "1..1",
          "# tests 1",
          "# pass 1",
          "# fail 0",
        ].join("\n"),
      };
    },
  });

  assert.deepEqual(calls, [{
    command: "node-test",
    args: [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      "scripts/openclaw-live-registry.real.test.ts",
    ],
    env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 240_000,
  }]);
});

test("required real test executes a bounded child through the guarded launcher", async () => {
  const source = await readFile("scripts/openclaw-live-registry.real.test.ts", "utf8");
  assert.match(
    source,
    /spawnSync\(\s*process\.execPath,\s*\["--import",\s*"tsx",\s*LAUNCHER,\s*"--",\s*"--version"\]/u,
  );
  assert.match(
    source,
    /assert\.ok\(\s*\(result\.stdout\s*\?\?\s*""\)\.includes\(versionResult\.stdout\)/u,
  );
});

test("real live registry gate rejects a successful child that ran zero tests", () => {
  assert.throws(
    () => runOpenClawLiveRegistryGate({
      env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
      spawn: () => ({
        status: 0,
        stdout: [
          "TAP version 13",
          "1..0",
          "# tests 0",
          "# pass 0",
          "# fail 0",
        ].join("\n"),
      }),
    }),
    /real OpenClaw live registry gate failed/,
  );
});

test("real live registry gate rejects hidden or duplicate TAP test points", () => {
  const validSummary = [
    "TAP version 13",
    "ok 1 - required real OpenClaw live registry allows guarded startup",
    "1..1",
    "# tests 1",
    "# pass 1",
    "# fail 0",
  ];
  for (const extraPoint of [
    "not ok 2 - hidden child failure",
    "ok 1 - required real OpenClaw live registry allows guarded startup",
  ]) {
    assert.throws(
      () => runOpenClawLiveRegistryGate({
        env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
        spawn: () => ({ status: 0, stdout: [...validSummary, extraPoint].join("\n") }),
      }),
      /real OpenClaw live registry gate failed/,
    );
  }
});

test("real live registry gate reports a fixed child failure without payloads", () => {
  assert.throws(
    () => runOpenClawLiveRegistryGate({
      env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
      spawn: () => ({
        status: 1,
        stdout: "Authorization: Bearer stdout-secret",
        stderr: "Authorization: Bearer stderr-secret",
      }),
    }),
    (error: unknown) => {
      assert.equal((error as Error).message, "real OpenClaw live registry gate failed");
      return true;
    },
  );
});

test("verify:native-guard:all includes the mandatory real live registry gate", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts["verify:native-guard:real"],
    "node --import tsx scripts/verify-openclaw-live-registry-gate.ts",
  );
  assert.match(
    pkg.scripts["verify:native-guard:all"] ?? "",
    /build:openclaw-plugin.*verify:native-guard:real.*verify:native-guard:docker/,
  );
  assert.match(
    pkg.scripts["verify:all"] ?? "",
    /build:openclaw-plugin.*verify:native-guard:real/,
  );
});
