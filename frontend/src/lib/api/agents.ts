import { defaultOpenClawCliPath, request } from "./core";
import type {
  AgentCheckResult,
  AgentConnectionConfig,
  AgentListResponse,
} from "./types";

const DEFAULT_AGENT_TIMEOUT_MS = 120000;
const DEFAULT_OPENCLAW_TIMEOUT_MS = 300000;

export const agentsApi = {
  async agents(): Promise<AgentListResponse> {
    const result = await request<{
      agents: Partial<AgentConnectionConfig>[];
      activeAgent: Partial<AgentConnectionConfig>;
    }>("/api/v1/agents");
    return {
      agents: result.agents.map(toAgentConfig),
      activeAgent: toAgentConfig(result.activeAgent),
    };
  },

  async saveAgent(config: AgentConnectionConfig) {
    const result = await request<{ agent: Partial<AgentConnectionConfig> }>("/api/v1/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    return { agent: toAgentConfig(result.agent) };
  },

  checkAgent(config: AgentConnectionConfig) {
    return request<AgentCheckResult>("/api/v1/agents/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adapterKind: config.adapterKind,
        endpointUrl:
          config.adapterKind === "openclaw" ? config.gatewayUrl : config.endpointUrl,
        cliPath: config.openclawCliPath,
      }),
    });
  },
};

export function defaultAgentName(adapterKind: AgentConnectionConfig["adapterKind"]): string {
  if (adapterKind === "http_sample") return "HTTP Sample Agent";
  if (adapterKind === "mock") return "Mock Agent";
  return "OpenClaw CLI Agent";
}

function toAgentConfig(config: Partial<AgentConnectionConfig>): AgentConnectionConfig {
  const adapterKind = config.adapterKind ?? "openclaw";
  return {
    adapterKind,
    agentId: config.agentId || "agent.openclaw.demo",
    name: config.name || defaultAgentName(adapterKind),
    description: config.description || "从控制台保存的智能体配置。",
    openclawCliPath: config.openclawCliPath || defaultOpenClawCliPath,
    gatewayUrl: config.gatewayUrl || "http://127.0.0.1:18789",
    endpointUrl: config.endpointUrl || "http://127.0.0.1:7001/agent/run?mode=vulnerable",
    timeoutMs: normalizeAgentTimeoutMs(adapterKind, config.timeoutMs),
    caseIds: config.caseIds?.length ? config.caseIds : ["case.resource_injection"],
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function normalizeAgentTimeoutMs(
  adapterKind: AgentConnectionConfig["adapterKind"],
  timeoutMs: number | undefined,
): number {
  const parsed = Number(timeoutMs);
  const fallback =
    adapterKind === "openclaw" ? DEFAULT_OPENCLAW_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (adapterKind === "openclaw") return Math.max(DEFAULT_OPENCLAW_TIMEOUT_MS, Math.floor(parsed));
  return Math.max(5000, Math.floor(parsed));
}
