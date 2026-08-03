import assert from "node:assert/strict";
import test from "node:test";
import {
  DetectionConfigError,
  generateDetectionOpenClawConfig,
  scrubDetectionOpenClawConfig,
} from "./detectionOpenClawConfig";

test("generates a Docker-only detection profile with destructive features disabled", () => {
  const config = generateDetectionOpenClawConfig({
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
  assert.deepEqual(config.plugins, ["agent-guard-supervision"]);
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
    userConfig: {
      tools: { elevated: { enabled: true }, custom: { enabled: true } },
      plugins: ["evil"],
      agents: { defaults: { sandbox: { docker: { binds: ["C:/secret:/secret"] }, browser: { enabled: true } } } },
    },
  });
  assert.deepEqual(config.plugins, ["agent-guard-supervision"]);
  assert.deepEqual(config.tools, { elevated: { enabled: false } });
  assert.deepEqual(config.agents.defaults.sandbox.docker.binds, []);
  assert.equal(config.agents.defaults.sandbox.browser.enabled, false);
  assert.deepEqual(scrubDetectionOpenClawConfig({ tools: { elevated: { enabled: true } }, model: "openai:gpt" }), { model: "openai:gpt" });
});
