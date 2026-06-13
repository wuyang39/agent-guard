import type {
  AgentCheckResult,
  AgentConnectionConfig,
  AgentListResponse,
  CLineDashboardSummary,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  TraceDetailView,
  SystemStatus,
  ApiResponse,
  P2RunE2EResponse,
  RealtimeActivePolicyState,
} from "./types";

const defaultBaseUrl = "http://127.0.0.1:3100";
export const apiBaseUrl = import.meta.env.VITE_AGENT_GUARD_API_BASE ?? defaultBaseUrl;
const defaultOpenClawCliPath = import.meta.env.VITE_OPENCLAW_CLI_PATH ?? "";

export const agentGuardApi = {
  systemStatus() {
    return request<SystemStatus>("/api/v1/system/status");
  },

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

  dashboardSummary() {
    return request<CLineDashboardSummary>("/api/v1/dashboard/summary");
  },

  runE2E(config?: AgentConnectionConfig) {
    const adapterKind = config?.adapterKind ?? "openclaw";
    const endpointUrl =
      adapterKind === "openclaw"
        ? config?.gatewayUrl
        : adapterKind === "http_sample"
          ? config?.endpointUrl
          : undefined;

    return request<P2RunE2EResponse>("/api/v1/test-runs/e2e?async=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adapterKind,
        agent: {
          agentId: config?.agentId || undefined,
          name: config?.name || defaultAgentName(adapterKind),
          description:
            config?.description ||
            "Frontend-triggered Agent Guard detection run.",
        },
        connection: {
          endpointUrl,
          cliPath:
            adapterKind === "openclaw" && config?.openclawCliPath
              ? config.openclawCliPath
              : undefined,
          launchMode: "external_running",
          timeoutMs: config?.timeoutMs ?? 120000,
        },
        // Default to one real case so the frontend can complete a full end-to-end
        // loop quickly during product testing. Remove this to run the whole suite.
        caseIds: config?.caseIds.length ? config.caseIds : ["case.resource_injection"],
        generateDefenseReport: adapterKind !== "openclaw",
      }),
    });
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

  async runGroups() {
    const result = await request<{ runs: P2RunGroupWire[]; total: number }>(
      "/api/v1/test-runs",
    );
    return {
      schemaVersion: "mvp-1" as const,
      runGroups: result.runs.map(toRunGroup),
    };
  },

  async runGroup(runGroupId: string) {
    const result = await request<{ runGroup: P2RunGroupWire }>(
      `/api/v1/test-runs/${encodeURIComponent(runGroupId)}`,
    );
    return { runGroup: toRunGroup(result.runGroup) };
  },

  detectionDetail(reportId: string) {
    return request<DetectionDetailView>(
      `/api/v1/reports/detection/${encodeURIComponent(reportId)}`,
    );
  },

  defenseDetail(reportId: string) {
    return request<DefenseDetailView>(
      `/api/v1/reports/defense/${encodeURIComponent(reportId)}`,
    );
  },

  async traceDetail(traceId: string) {
    const result = await request<P2TraceDetailWire>(
      `/api/v1/traces/${encodeURIComponent(traceId)}`,
    );
    return {
      trace: result.trace,
      relatedRiskReports: result.relatedRiskReports ?? [],
      relatedFindings: result.relatedFindings ?? [],
      supervisionRecords: result.supervisionRecords ?? [],
    } satisfies TraceDetailView;
  },

  artifactUrl(artifactId: string) {
    return `${apiBaseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
  },

  liveSupervisionUrl() {
    return `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=1`;
  },

  realtimeMcpInfo() {
    return request<{ activePolicy: RealtimeActivePolicyState; openclawConfigExample: unknown }>(
      "/api/v1/openclaw/realtime/mcp",
    );
  },

  activeRealtimePolicy() {
    return request<RealtimeActivePolicyState>("/api/v1/openclaw/realtime/active-policy");
  },

  setRealtimeActivePolicy(policyPackId: string, resetSessions = true) {
    return request<RealtimeActivePolicyState>("/api/v1/openclaw/realtime/active-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyPackId, resetSessions }),
    });
  },

  resetRealtimeSessions(runtimeSessionId?: string) {
    return request<{ resetCount: number; runtimeSessionId?: string }>(
      "/api/v1/openclaw/realtime/sessions/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runtimeSessionId ? { runtimeSessionId } : {}),
      },
    );
  },

  finalizeRealtimeDefenseReport(runtimeSessionId = "session.openclaw.realtime") {
    return request<DefenseDetailView & { runGroup: { defenseReportId: string } }>(
      "/api/v1/openclaw/realtime/reports/defense",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeSessionId }),
      },
    );
  },
};

function defaultAgentName(adapterKind: AgentConnectionConfig["adapterKind"]): string {
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
    description: config.description || "Agent configured from Agent Guard Console.",
    openclawCliPath: config.openclawCliPath || defaultOpenClawCliPath,
    gatewayUrl: config.gatewayUrl || "http://127.0.0.1:18789",
    endpointUrl: config.endpointUrl || "http://127.0.0.1:7001/agent/run?mode=vulnerable",
    timeoutMs: Number(config.timeoutMs) || 120000,
    caseIds: config.caseIds?.length ? config.caseIds : ["case.resource_injection"],
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, init);
  const payload = (await response.json()) as ApiResponse<T>;

  if (!payload.ok) {
    throw new Error(payload.error.message);
  }

  return payload.data;
}

type P2RunGroupWire = {
  runGroupId: string;
  agentId: string;
  agentName?: string;
  adapterKind?: "openclaw" | "http_sample" | "mock";
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  caseIds?: string[];
  caseCount: number;
  testRunIds: string[];
  traceIds: string[];
  riskReportIds: string[];
  detectionReportId?: string;
  riskProfileId?: string;
  policyPackId?: string;
  runtimeSessionIds: string[];
  defenseReportId?: string;
  artifactIds: string[];
};

type P2TraceDetailWire = {
  trace: TraceDetailView["trace"];
  relatedRiskReports?: TraceDetailView["relatedRiskReports"];
  relatedFindings?: TraceDetailView["relatedFindings"];
  supervisionRecords?: TraceDetailView["supervisionRecords"];
};

function toRunGroup(run: P2RunGroupWire): CLineRunGroup {
  return {
    schemaVersion: "mvp-1",
    runGroupId: run.runGroupId,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterKind: run.adapterKind,
    status: run.status,
    caseIds: run.caseIds ?? Array.from({ length: run.caseCount }, (_, index) => `case.${index + 1}`),
    caseCount: run.caseCount,
    detectionReportId: run.detectionReportId ?? "",
    riskProfileId: run.riskProfileId ?? "",
    policyPackId: run.policyPackId ?? "",
    defenseReportId: run.defenseReportId ?? "",
    traceIds: run.traceIds,
    riskReportIds: run.riskReportIds,
    runtimeSessionIds: run.runtimeSessionIds,
    artifactIds: run.artifactIds,
    createdAt: run.startedAt,
    updatedAt: run.endedAt ?? run.startedAt,
  };
}
