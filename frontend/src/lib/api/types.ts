import type {
  AgentRiskProfile,
  DefenseReport,
  DetectionReport,
  InteractionTrace,
  ReportArtifact,
  RiskReport,
  RuntimeSupervisionRecord,
  SupervisionPolicyPack,
  TestRun,
} from "@agent-guard/contracts";

export type ApiResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export type CLineRunGroup = {
  schemaVersion: "mvp-1";
  runGroupId: string;
  agentId: string;
  status: "completed" | "failed";
  caseIds: string[];
  detectionReportId: string;
  riskProfileId: string;
  policyPackId: string;
  defenseReportId: string;
  traceIds: string[];
  riskReportIds: string[];
  runtimeSessionIds: string[];
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CLineRunBundle = {
  schemaVersion: "mvp-1";
  runGroup: CLineRunGroup;
  testRuns: TestRun[];
  traces: InteractionTrace[];
  riskReports: RiskReport[];
  detectionReport: DetectionReport;
  riskProfile: AgentRiskProfile;
  policyPack: SupervisionPolicyPack;
  supervisionRecords: RuntimeSupervisionRecord[];
  defenseReport: DefenseReport;
  artifacts: ReportArtifact[];
};

export type CLineDashboardSummary = {
  schemaVersion: "mvp-1";
  latestRunGroup?: CLineRunGroup;
  recentRunGroups: CLineRunGroup[];
  totals: {
    runGroups: number;
    traces: number;
    riskReports: number;
    findings: number;
    blockedActions: number;
    redactions: number;
    askDecisions: number;
    residualRisks: number;
  };
  highestRiskLevel: RiskReport["riskLevel"];
  countsByCategory: RiskReport["summary"]["countsByCategory"];
};

export type SystemStatus = {
  schemaVersion: "mvp-1";
  service: string;
  status: "ok";
  outputDir: string;
  generatedAt: string;
};

export type SampleAgentStatus = {
  running: boolean;
  endpoint: string;
  healthEndpoint: string;
  pid?: number;
  startedByApi?: boolean;
  message?: string;
};

export type LiveSupervisionEvent = {
  timestamp: string;
  type:
    | "live_started"
    | "agent_status"
    | "run_group"
    | "trace_summary"
    | "supervision_record"
    | "defense_report"
    | "live_complete"
    | "live_error";
  message?: string;
  status?: SampleAgentStatus;
  runGroup?: CLineRunGroup;
  riskReportCount?: number;
  traceCount?: number;
  traceId?: string;
  caseId?: string;
  eventCount?: number;
  record?: RuntimeSupervisionRecord;
  defenseReportId?: string;
  blockedActions?: number;
  redactions?: number;
  askDecisions?: number;
};

export type DetectionDetailView = {
  detectionReport: DetectionReport;
  riskProfile: AgentRiskProfile;
  policyPack: SupervisionPolicyPack;
  sourceRiskReports: RiskReport[];
};

export type DefenseDetailView = {
  defenseReport: DefenseReport;
  detectionReport: DetectionReport;
  riskProfile: AgentRiskProfile;
  policyPack: SupervisionPolicyPack;
  supervisionRecords: RuntimeSupervisionRecord[];
  artifacts: ReportArtifact[];
};

export type TraceDetailView = {
  trace: InteractionTrace;
  relatedRiskReports: RiskReport[];
  relatedFindings: RiskReport["findings"];
  supervisionRecords: RuntimeSupervisionRecord[];
};

export type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty"; message: string }
  | { status: "error"; message: string; fallback?: T }
  | { status: "ready"; data: T; source: "api" | "mock" };
