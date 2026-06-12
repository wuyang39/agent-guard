import type {
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

export const agentGuardApi = {
  systemStatus() {
    return request<SystemStatus>("/api/v1/system/status");
  },

  dashboardSummary() {
    return request<CLineDashboardSummary>("/api/v1/dashboard/summary");
  },

  runE2E() {
    return request<P2RunE2EResponse>("/api/v1/test-runs/e2e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adapterKind: "openclaw",
        agent: {
          name: "OpenClaw CLI Agent",
          description: "Frontend-triggered OpenClaw CLI JSONL detection run.",
        },
        connection: {
          launchMode: "external_running",
          timeoutMs: 120000,
        },
        generateDefenseReport: true,
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
      relatedRiskReports: [],
      relatedFindings: [],
      supervisionRecords: [],
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
};

function toRunGroup(run: P2RunGroupWire): CLineRunGroup {
  return {
    schemaVersion: "mvp-1",
    runGroupId: run.runGroupId,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterKind: run.adapterKind,
    status: run.status,
    caseIds: Array.from({ length: run.caseCount }, (_, index) => `case.${index + 1}`),
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
