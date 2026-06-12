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

export type CLineRunStatus = "completed" | "failed";

export type CLineRunGroup = {
  schemaVersion: "mvp-1";
  runGroupId: string;
  agentId: string;
  status: CLineRunStatus;
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

export type TraceDetailView = {
  trace: InteractionTrace;
  relatedRiskReports: RiskReport[];
  relatedFindings: RiskReport["findings"];
  supervisionRecords: RuntimeSupervisionRecord[];
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
