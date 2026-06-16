import { defaultAgentName } from "./agents";
import { request } from "./core";
import type {
  AgentConnectionConfig,
  CLineDashboardSummary,
  CLineRunGroup,
  P2RunE2EResponse,
} from "./types";

export const runsApi = {
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
            "由前端发起的智能体安全检测。",
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
        // 默认只跑一个真实用例，保证前端产品测试可以快速完成闭环。
        caseIds: config?.caseIds.length ? config.caseIds : ["case.resource_injection"],
        generateDefenseReport: adapterKind !== "openclaw",
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
};

type P2RunGroupWire = {
  runGroupId: string;
  agentId: string;
  agentName?: string;
  adapterKind?: "openclaw" | "http_sample" | "mock";
  status: "running" | "completed" | "failed";
  phase?:
    | "queued"
    | "detecting"
    | "policy_ready"
    | "supervising"
    | "supervision_completed"
    | "defense_report_ready"
    | "failed";
  policyContextSource?: "stored_detection" | "synthetic_fallback";
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

function toRunGroup(run: P2RunGroupWire): CLineRunGroup {
  return {
    schemaVersion: "mvp-1",
    runGroupId: run.runGroupId,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterKind: run.adapterKind,
    status: run.status,
    phase: run.phase ?? inferRunPhase(run),
    policyContextSource: run.policyContextSource,
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

function inferRunPhase(run: P2RunGroupWire): CLineRunGroup["phase"] {
  if (run.status === "failed") return "failed";
  if (run.defenseReportId) return "defense_report_ready";
  if (run.runtimeSessionIds.length > 0) return "supervision_completed";
  if (run.policyPackId) return "policy_ready";
  if (run.status === "running") return "detecting";
  return "queued";
}
