import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import {
  DetectionConfigError,
  generateDetectionOpenClawConfig,
  scrubDetectionOpenClawConfig,
} from "./detectionOpenClawConfig";
import {
  DetectionProfileSeedError,
  resolveDetectionProfileSeed,
} from "./detectionProfileSeed";

const PROFILE_ROOT = path.resolve("tmp", "detection-profile");
const PLUGIN_ROOT = path.resolve("plugins", "agent-guard-supervision");

function detectionPaths() {
  return {
    pluginRoot: PLUGIN_ROOT,
    markerDir: path.join(PROFILE_ROOT, "agent-guard", "markers"),
    spoolDir: path.join(PROFILE_ROOT, "agent-guard", "spool"),
  };
}

test("generates a Docker-only detection profile with destructive features disabled", () => {
  const config = generateDetectionOpenClawConfig({
    ...detectionPaths(),
    userConfig: {
      agents: { defaults: { model: "openai:gpt-4.1", sandbox: { mode: "host" } } },
      tools: { elevated: { enabled: true } },
      plugins: ["untrusted-plugin"],
    },
  });

  assert.equal(config.agents.defaults.sandbox.mode, "all");
  assert.equal(config.agents.defaults.sandbox.scope, "session");
  assert.equal(config.agents.defaults.sandbox.backend, "docker");
  assert.equal(config.agents.defaults.sandbox.workspaceAccess, "ro");
  assert.equal(config.agents.defaults.sandbox.docker.network, "none");
  assert.equal(config.agents.defaults.sandbox.docker.readOnlyRoot, true);
  assert.deepEqual(config.agents.defaults.sandbox.docker.capDrop, ["ALL"]);
  assert.deepEqual(config.agents.defaults.sandbox.docker.binds, []);
  assert.deepEqual(config.agents.defaults.sandbox.docker.securityOpt, ["no-new-privileges:true"]);
  assert.equal(config.agents.defaults.sandbox.browser.enabled, false);
  assert.equal(config.tools.elevated.enabled, false);
  assert.deepEqual(config.gateway, { mode: "local" });
  assert.deepEqual(config.plugins, {
    enabled: true,
    allow: ["agent-guard-supervision"],
    load: { paths: [PLUGIN_ROOT] },
    slots: { memory: "none" },
    entries: {
      "agent-guard-supervision": {
        enabled: true,
        config: {
          markerDir: path.join(PROFILE_ROOT, "agent-guard", "markers"),
          spoolDir: path.join(PROFILE_ROOT, "agent-guard", "spool"),
        },
      },
    },
  });
});

test("preserves references and SecretRefs without copying inline secret values", () => {
  const config = scrubDetectionOpenClawConfig({
    model: "anthropic:claude-sonnet",
    provider: { id: "anthropic", apiKey: { SecretRef: "env:ANTHROPIC_API_KEY" } },
  });
  assert.equal(config.model, "anthropic:claude-sonnet");
  assert.deepEqual(config.provider, { id: "anthropic", apiKey: { SecretRef: "env:ANTHROPIC_API_KEY" } });
  assert.throws(
    () => scrubDetectionOpenClawConfig({ provider: { apiKey: "sk-inline-secret" } }),
    (error: unknown) => error instanceof DetectionConfigError && error.code === "INLINE_SECRET_UNSAFE",
  );
  assert.throws(
    () => scrubDetectionOpenClawConfig({ provider: { apiKey: { value: "sk-nested-secret" } } }),
    (error: unknown) => error instanceof DetectionConfigError && error.code === "INLINE_SECRET_UNSAFE",
  );
  const accessor = {} as { provider?: unknown };
  Object.defineProperty(accessor, "provider", { get: () => ({ apiKey: "must-not-read" }), enumerable: true });
  assert.throws(() => scrubDetectionOpenClawConfig(accessor), /accessors|INLINE_SECRET_UNSAFE/i);
});

test("does not copy user tools, plugins, binds, browser, or elevated settings", () => {
  const config = generateDetectionOpenClawConfig({
    ...detectionPaths(),
    userConfig: {
      tools: { elevated: { enabled: true }, custom: { enabled: true } },
      plugins: ["evil"],
      agents: { defaults: { sandbox: { docker: { binds: ["C:/secret:/secret"] }, browser: { enabled: true } } } },
    },
  });
  assert.deepEqual(config.plugins.allow, ["agent-guard-supervision"]);
  assert.deepEqual(config.plugins.load.paths, [PLUGIN_ROOT]);
  assert.deepEqual(config.plugins.slots, { memory: "none" });
  assert.deepEqual(Object.keys(config.plugins.entries), ["agent-guard-supervision"]);
  assert.deepEqual(config.tools, { elevated: { enabled: false } });
  assert.deepEqual(config.agents.defaults.sandbox.docker.binds, []);
  assert.equal(config.agents.defaults.sandbox.browser.enabled, false);
  assert.deepEqual(scrubDetectionOpenClawConfig({ tools: { elevated: { enabled: true } }, model: "openai:gpt" }), { model: "openai:gpt" });
});

test("preserves all four model allowlist keys at their real OpenClaw schema locations", () => {
  const providers = {
    deepseek: {
      api: "openai-completions",
      apiKey: { SecretRef: "env:DEEPSEEK_API_KEY" },
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
    },
  };
  const config = generateDetectionOpenClawConfig({
    ...detectionPaths(),
    userConfig: {
      model: { primary: "deepseek/deepseek-v4-flash" },
      provider: "deepseek",
      models: { "deepseek/deepseek-v4-flash": { alias: "DeepSeek" } },
      providers,
      tools: { elevated: { enabled: true } },
      plugins: { entries: { arbitrary: { enabled: true } } },
    },
  });

  assert.deepEqual(config.agents.defaults.model, { primary: "deepseek/deepseek-v4-flash" });
  assert.equal(config.agents.defaults.provider, "deepseek");
  assert.deepEqual(config.agents.defaults.models, {
    "deepseek/deepseek-v4-flash": { alias: "DeepSeek" },
  });
  assert.deepEqual(config.models, { providers });
  assert.deepEqual(config.tools, { elevated: { enabled: false } });
  assert.deepEqual(Object.keys(config.plugins.entries), ["agent-guard-supervision"]);
});

test("scrubs the real top-level provider catalog and rejects its inline secrets", () => {
  const scrubbed = scrubDetectionOpenClawConfig({
    agents: {
      defaults: {
        model: { primary: "deepseek/deepseek-v4-flash" },
        models: { "deepseek/deepseek-v4-flash": { alias: "DeepSeek" } },
      },
    },
    models: {
      providers: {
        deepseek: {
          apiKey: { SecretRef: "env:DEEPSEEK_API_KEY" },
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
    },
  });
  assert.deepEqual(Object.keys(scrubbed).sort(), ["model", "models", "providers"]);
  assert.deepEqual(scrubbed.providers, {
    deepseek: {
      apiKey: { SecretRef: "env:DEEPSEEK_API_KEY" },
      models: [{ id: "deepseek-v4-flash" }],
    },
  });
  assert.throws(
    () => scrubDetectionOpenClawConfig({
      agents: { defaults: { model: "deepseek/deepseek-v4-flash" } },
      models: { providers: { deepseek: { apiKey: "inline-secret" } } },
    }),
    (error: unknown) => error instanceof DetectionConfigError && error.code === "INLINE_SECRET_UNSAFE",
  );
});

test("profile seed rejects malformed last-known-good configuration", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-config-seed-invalid-"));
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(`${configPath}.last-good`, "{not-json", "utf8");
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  await assert.rejects(
    resolveDetectionProfileSeed({
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
    }),
    (error: unknown) =>
      error instanceof DetectionProfileSeedError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /not valid JSON/i.test(error.message),
  );
});

test("profile seed rejects configuration without an explicit default model", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-config-seed-model-"));
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(`${configPath}.last-good`, JSON.stringify({
    agents: { defaults: { workspace: "ignored" } },
    models: { providers: { deepseek: {} } },
  }));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));

  await assert.rejects(
    resolveDetectionProfileSeed({
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
    }),
    (error: unknown) =>
      error instanceof DetectionProfileSeedError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /default model/i.test(error.message),
  );
});

test("profile seed rejects a last-known-good config outside the trusted OpenClaw state root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-config-seed-outside-"));
  const stateDir = path.join(root, "state");
  const outsideDir = path.join(root, "outside");
  const configPath = path.join(outsideDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(`${configPath}.last-good`, JSON.stringify({
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
  }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    resolveDetectionProfileSeed({
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
    }),
    (error: unknown) =>
      error instanceof DetectionProfileSeedError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /trusted OpenClaw root/i.test(error.message),
  );
});

test("profile seed rejects a junction in the last-known-good config ancestry", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-config-seed-symlink-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-config-seed-symlink-target-"));
  const configDir = path.join(stateDir, "config");
  const configPath = path.join(configDir, "openclaw.json");
  await fs.writeFile(path.join(outsideDir, "openclaw.json.last-good"), JSON.stringify({
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
  }));
  try {
    await fs.symlink(outsideDir, configDir, "junction");
  } catch (error) {
    if (isSymlinkPrivilegeError(error)) {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
      t.skip("Junction creation requires additional privileges on this host");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  await assert.rejects(
    resolveDetectionProfileSeed({
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      },
    }),
    (error: unknown) =>
      error instanceof DetectionProfileSeedError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /symbolic link/i.test(error.message),
  );
});

function isSymlinkPrivilegeError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES");
}
