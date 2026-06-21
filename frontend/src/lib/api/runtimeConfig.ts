import { request } from "./core";
import type {
  RuntimeConfigCheckResult,
  RuntimeConfigSnapshot,
  RuntimeDownstreamMcpConfigInput,
  RuntimeLlmConfigInput,
} from "./types";

export const runtimeConfigApi = {
  runtimeConfig() {
    return request<RuntimeConfigSnapshot>("/api/v1/runtime-config");
  },

  saveLlmConfig(config: RuntimeLlmConfigInput) {
    return request<RuntimeConfigSnapshot>("/api/v1/runtime-config/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  },

  checkLlmConfig(config?: RuntimeLlmConfigInput) {
    return request<RuntimeConfigCheckResult>("/api/v1/runtime-config/llm/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config ?? {}),
    });
  },

  saveDownstreamMcpConfig(config: RuntimeDownstreamMcpConfigInput) {
    return request<RuntimeConfigSnapshot & { gatewayReload?: { toolCount: number; externalProviderCount: number } }>(
      "/api/v1/runtime-config/downstream-mcp",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      },
    );
  },

  checkDownstreamMcpConfig(config?: RuntimeDownstreamMcpConfigInput) {
    return request<RuntimeConfigCheckResult>("/api/v1/runtime-config/downstream-mcp/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config ?? {}),
    });
  },
};
