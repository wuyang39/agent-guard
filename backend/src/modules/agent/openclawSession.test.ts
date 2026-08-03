import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveOpenClawDataDirs, spawnOpenClawAgent } from "./openclawSession";

test("isolated OpenClaw env resolves artifacts inside the supplied state directory", () => {
  assert.deepEqual(resolveOpenClawDataDirs({ OPENCLAW_STATE_DIR: "C:/isolated/state" }), [path.resolve("C:/isolated/state")]);
  assert.deepEqual(resolveOpenClawDataDirs(undefined, false), []);
});

test("spawnOpenClawAgent passes isolated env and guard metadata only to the child", async () => {
  const previousPluginDirs = process.env.OPENCLAW_PLUGIN_DIRS;
  process.env.OPENCLAW_PLUGIN_DIRS = "C:/user/plugins";
  try {
    const script = "process.stdout.write(JSON.stringify({status:'ok',env:process.env.OPENCLAW_CONFIG_PATH,token:process.env.OPENCLAW_GATEWAY_TOKEN,required:process.env.AGENT_GUARD_NATIVE_REQUIRED,pluginDirs:process.env.OPENCLAW_PLUGIN_DIRS}))";
    const result = await spawnOpenClawAgent(
      "session-1",
      "message",
      {
        env: { OPENCLAW_CONFIG_PATH: "C:/isolated/openclaw.json" },
        gatewayToken: "test-token",
        nativeGuardRequired: true,
      },
      { command: process.execPath, argsPrefix: ["-e", script], displayPath: process.execPath, shell: false },
    );
    assert.deepEqual(result, {
      status: "ok",
      env: "C:/isolated/openclaw.json",
      token: "test-token",
      required: "1",
    });
  } finally {
    if (previousPluginDirs === undefined) delete process.env.OPENCLAW_PLUGIN_DIRS;
    else process.env.OPENCLAW_PLUGIN_DIRS = previousPluginDirs;
  }
});

test("spawnOpenClawAgent aborts the child process", async () => {
  const controller = new AbortController();
  const script = "setTimeout(() => process.stdout.write('{}'), 10000)";
  const promise = spawnOpenClawAgent(
    "session-1",
    "message",
    { signal: controller.signal, timeoutMs: 20_000 },
    { command: process.execPath, argsPrefix: ["-e", script], displayPath: process.execPath, shell: false },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /aborted|abort/i);
});

test("OFF child runs with an explicit native guard disabled marker", async () => {
  const previous = process.env.AGENT_GUARD_NATIVE_REQUIRED;
  process.env.AGENT_GUARD_NATIVE_REQUIRED = "1";
  try {
    const script = "process.stdout.write(JSON.stringify({marker:process.env.AGENT_GUARD_NATIVE_REQUIRED || ''}))";
    const result = await spawnOpenClawAgent(
      "session-off",
      "message",
      {},
      { command: process.execPath, argsPrefix: ["-e", script], displayPath: process.execPath, shell: false },
    );
    assert.deepEqual(result, { marker: "0" });
  } finally {
    if (previous === undefined) delete process.env.AGENT_GUARD_NATIVE_REQUIRED;
    else process.env.AGENT_GUARD_NATIVE_REQUIRED = previous;
  }
});
