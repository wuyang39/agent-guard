import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { resolveOpenClawDataDirs, spawnOpenClawAgent } from "./openclawSession";
import { scrubSecrets } from "../../shared/scrubSecrets";

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

// ---- scrubSecrets / safeStderr validation ----

test("scrubSecrets redacts API key assignments in diagnostic text", () => {
  const raw = "Error: api_key=sk-abc123def456ghi789jkl";
  const scrubbed = scrubSecrets(raw);
  assert.equal(scrubbed.includes("sk-abc123def456ghi789jkl"), false);
  assert.match(scrubbed, /api_key=\[REDACTED\]/i);
});

test("scrubSecrets redacts Bearer tokens in stderr", () => {
  const raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const scrubbed = scrubSecrets(raw);
  // The JWT value must be gone.
  assert.equal(scrubbed.includes("eyJhbGciOiJIUzI1NiJ9"), false);
  // Auth-header pattern matches first → "Authorization=[REDACTED]".
  // Both forms are acceptable; the key requirement is that the token is gone.
  assert.match(scrubbed, /\[REDACTED\]/);
  assert.equal(scrubbed.includes("Bearer eyJ"), false);
});

test("scrubSecrets redacts cookie/session values", () => {
  const raw = "cookie: session=abc123secret; HttpOnly";
  const scrubbed = scrubSecrets(raw);
  assert.equal(scrubbed.includes("abc123secret"), false);
  assert.match(scrubbed, /cookie=\[REDACTED\]/i);
});

test("scrubSecrets redacts private key blocks", () => {
  const raw = "Loaded config with -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
  const scrubbed = scrubSecrets(raw);
  assert.equal(scrubbed.includes("MIIEpA"), false);
  assert.match(scrubbed, /\[REDACTED PRIVATE KEY\]/);
});

test("scrubSecrets redacts password and secret fields", () => {
  const raw = 'password="superSecret123" secret: mySecretValue';
  const scrubbed = scrubSecrets(raw);
  assert.equal(scrubbed.includes("superSecret123"), false);
  assert.equal(scrubbed.includes("mySecretValue"), false);
  assert.match(scrubbed, /password=\[REDACTED\]/i);
  assert.match(scrubbed, /secret=\[REDACTED\]/i);
});

test("scrubSecrets preserves non-sensitive diagnostic content", () => {
  const raw = "Error: connection refused on port 8080, retry after 5000ms";
  const scrubbed = scrubSecrets(raw);
  assert.match(scrubbed, /connection refused/);
  assert.match(scrubbed, /port 8080/);
  assert.match(scrubbed, /retry after/);
});

test("scrubSecrets handles empty and short strings safely", () => {
  assert.equal(scrubSecrets(""), "");
  assert.equal(scrubSecrets("ok"), "ok");
  assert.equal(scrubSecrets("err"), "err");
});
