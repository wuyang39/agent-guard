import type {
  CLineDashboardSummary,
  CLineRunBundle,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  TraceDetailView,
  SystemStatus,
  SampleAgentStatus,
  ApiResponse,
} from "./types";

const defaultBaseUrl = "http://127.0.0.1:3100";
export const apiBaseUrl = import.meta.env.VITE_AGENT_GUARD_API_BASE ?? defaultBaseUrl;

export const agentGuardApi = {
  systemStatus() {
    return request<SystemStatus>("/api/v1/system/status");
  },

  sampleAgentStatus() {
    return request<SampleAgentStatus>("/api/v1/agents/sample/status");
  },

  startSampleAgent() {
    return request<SampleAgentStatus>("/api/v1/agents/sample/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  },

  dashboardSummary() {
    return request<CLineDashboardSummary>("/api/v1/dashboard/summary");
  },

  runE2E() {
    return request<CLineRunBundle>("/api/v1/test-runs/e2e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  },

  runGroups() {
    return request<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>(
      "/api/v1/test-runs",
    );
  },

  runGroup(runGroupId: string) {
    return request<CLineRunBundle>(`/api/v1/test-runs/${encodeURIComponent(runGroupId)}`);
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

  traceDetail(traceId: string) {
    return request<TraceDetailView>(`/api/v1/traces/${encodeURIComponent(traceId)}`);
  },

  artifactUrl(artifactId: string) {
    return `${apiBaseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}?raw=1`;
  },

  liveSupervisionUrl() {
    return `${apiBaseUrl}/api/v1/supervision/live/stream`;
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
