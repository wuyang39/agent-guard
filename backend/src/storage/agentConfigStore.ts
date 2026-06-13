import fs from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../shared";
import type { AgentConnectionConfig } from "../api/types";

const ROOT = path.resolve(process.cwd(), "outputs", "agent-configs");
const CONFIGS_FILE = path.join(ROOT, "agents.json");

type AgentConfigIndex = {
  schemaVersion: "mvp-1";
  activeAgentId?: string;
  agents: AgentConnectionConfig[];
};

const DEFAULT_AGENT: AgentConnectionConfig = {
  adapterKind: "openclaw",
  agentId: "agent.openclaw.demo",
  name: "OpenClaw CLI Agent",
  description: "OpenClaw local agent used by Agent Guard E2E detection.",
  openclawCliPath: "F:\\OpenClaw\\openclaw-local.cmd",
  gatewayUrl: "http://127.0.0.1:18789",
  endpointUrl: "http://127.0.0.1:7001/agent/run?mode=vulnerable",
  timeoutMs: 120000,
  caseIds: ["case.resource_injection"],
};

export async function listAgentConfigs(): Promise<AgentConnectionConfig[]> {
  const index = await readIndex();
  return index.agents;
}

export async function getActiveAgentConfig(): Promise<AgentConnectionConfig> {
  const index = await readIndex();
  const active =
    index.agents.find((agent) => agent.agentId === index.activeAgentId) ??
    index.agents[0];
  return active ?? DEFAULT_AGENT;
}

export async function getAgentConfig(
  agentId: string,
): Promise<AgentConnectionConfig | undefined> {
  const index = await readIndex();
  return index.agents.find((agent) => agent.agentId === agentId);
}

export async function saveAgentConfig(
  input: AgentConnectionConfig,
): Promise<AgentConnectionConfig> {
  const index = await readIndex();
  const existing = index.agents.find((agent) => agent.agentId === input.agentId);
  const now = nowIso();
  const normalized: AgentConnectionConfig = {
    ...DEFAULT_AGENT,
    ...existing,
    ...sanitizeAgentConfig(input),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const agents = [
    normalized,
    ...index.agents.filter((agent) => agent.agentId !== normalized.agentId),
  ];
  await writeIndex({
    schemaVersion: "mvp-1",
    activeAgentId: normalized.agentId,
    agents,
  });
  return normalized;
}

function sanitizeAgentConfig(input: AgentConnectionConfig): AgentConnectionConfig {
  return {
    adapterKind: input.adapterKind,
    agentId: input.agentId.trim() || DEFAULT_AGENT.agentId,
    name: input.name.trim() || DEFAULT_AGENT.name,
    description: input.description?.trim(),
    openclawCliPath: input.openclawCliPath?.trim(),
    gatewayUrl: input.gatewayUrl?.trim(),
    endpointUrl: input.endpointUrl?.trim(),
    timeoutMs: Number(input.timeoutMs) || DEFAULT_AGENT.timeoutMs,
    caseIds: Array.isArray(input.caseIds)
      ? input.caseIds.map((caseId) => caseId.trim()).filter(Boolean)
      : DEFAULT_AGENT.caseIds,
  };
}

async function readIndex(): Promise<AgentConfigIndex> {
  try {
    return JSON.parse(await fs.readFile(CONFIGS_FILE, "utf-8")) as AgentConfigIndex;
  } catch {
    const now = nowIso();
    return {
      schemaVersion: "mvp-1",
      activeAgentId: DEFAULT_AGENT.agentId,
      agents: [{ ...DEFAULT_AGENT, createdAt: now, updatedAt: now }],
    };
  }
}

async function writeIndex(index: AgentConfigIndex): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(CONFIGS_FILE, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
}
