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
    /TEST_OPENCLAW_AGENTGUARD_CLI is required/,
  );
  assert.throws(
    () => resolveRequiredOpenClawCli({ TEST_OPENCLAW_AGENTGUARD_CLI: "  " }),
    /TEST_OPENCLAW_AGENTGUARD_CLI is required/,
  );
  assert.equal(
    resolveRequiredOpenClawCli({ TEST_OPENCLAW_AGENTGUARD_CLI: " C:\\openclaw.cmd " }),
    "C:\\openclaw.cmd",
  );
});

test("real live registry gate runs only the non-skipped cross-repo launcher test", () => {
  const calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdio: "inherit" | ["ignore", "pipe", "pipe"];
  }> = [];
  runOpenClawLiveRegistryGate({
    env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
    nodePath: "node-test",
    spawn: (command, args, options) => {
      calls.push({ command, args, env: options.env ?? {}, stdio: options.stdio });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [{
    command: "node-test",
    args: [
      "--import",
      "tsx",
      "--test",
      "--test-name-pattern=exact fork live registry",
      "scripts/openclaw-guard-launcher.test.ts",
    ],
    env: { TEST_OPENCLAW_AGENTGUARD_CLI: "C:\\openclaw.cmd" },
    stdio: ["ignore", "pipe", "pipe"],
  }]);
});

test("real live registry gate reports a fixed failure without child payloads", () => {
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
    /verify:native-guard:real.*verify:native-guard:docker/,
  );
});
