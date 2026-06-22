/**
 * verify-shared-llm-config.ts — verifies A/B lines share one LLM config surface.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLlmClientConfig } from "../backend/src/modules/llm/llmClient";
import { resolvePyritRuntimeEnv } from "../backend/src/modules/corpus";
import { getResolvedRuntimeLlmSettings } from "../backend/src/modules/runtime/runtimeSettings";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSharedConfig(env: NodeJS.ProcessEnv, expected: {
  endpoint: string;
  apiKey: string;
  model: string;
}): void {
  const runtime = getResolvedRuntimeLlmSettings(env);
  const bConfig = loadLlmClientConfig(env);
  const aRuntime = resolvePyritRuntimeEnv(projectRoot, env, "python");

  assert(runtime.enabled, "runtime LLM config should be enabled");
  assert(runtime.mode === "openai_compatible", `runtime mode mismatch: ${runtime.mode}`);
  assert(runtime.endpoint === expected.endpoint, `runtime endpoint mismatch: ${runtime.endpoint}`);
  assert(runtime.apiKey === expected.apiKey, "runtime apiKey mismatch");
  assert(runtime.model === expected.model, `runtime model mismatch: ${runtime.model}`);

  assert(bConfig.enabled, "B-line LLM config should be enabled");
  assert(bConfig.endpoint === expected.endpoint, `B endpoint mismatch: ${bConfig.endpoint}`);
  assert(bConfig.apiKey === expected.apiKey, "B apiKey mismatch");
  assert(bConfig.model === expected.model, `B model mismatch: ${bConfig.model}`);

  assert(aRuntime.hasEndpoint, "A-line PyRIT runtime endpoint should be set");
  assert(aRuntime.hasKey, "A-line PyRIT runtime key should be set");
  assert(aRuntime.hasModel, "A-line PyRIT runtime model should be set");
  assert(aRuntime.missingModelEnv.length === 0, "A-line PyRIT runtime should not miss model env");
}

console.log("Shared LLM config verification");

assertSharedConfig(
  {
    AGENT_GUARD_LLM_ENABLED: "1",
    AGENT_GUARD_LLM_MODE: "openai_compatible",
    AGENT_GUARD_LLM_ENDPOINT: "https://llm.example.test/v1",
    AGENT_GUARD_LLM_API_KEY: "shared-key",
    AGENT_GUARD_LLM_MODEL: "shared-model",
  },
  {
    endpoint: "https://llm.example.test/v1",
    apiKey: "shared-key",
    model: "shared-model",
  },
);
console.log("1. AGENT_GUARD_LLM_* shared by B and A ok");

assertSharedConfig(
  {
    OPENAI_CHAT_ENDPOINT: "http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1",
    OPENAI_CHAT_KEY: "openai-chat-key",
    OPENAI_CHAT_MODEL: "agent-guard-openclaw",
  },
  {
    endpoint: "http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1",
    apiKey: "openai-chat-key",
    model: "agent-guard-openclaw",
  },
);
console.log("2. OPENAI_CHAT_* env auto-detected by B and A ok");

assertSharedConfig(
  {
    AGENT_GUARD_LLM_ENABLED: "true",
    AGENT_GUARD_LLM_MODE: "openai_compatible",
    AGENT_GUARD_LLM_ENDPOINT: "https://api.deepseek.com",
    AGENT_GUARD_LLM_KEY: "legacy-shared-key",
    AGENT_GUARD_LLM_MODEL: "deepseek-chat",
  },
  {
    endpoint: "https://api.deepseek.com",
    apiKey: "legacy-shared-key",
    model: "deepseek-chat",
  },
);
console.log("3. AGENT_GUARD_LLM_KEY compatibility ok");

console.log("SHARED LLM CONFIG VERIFIED");
