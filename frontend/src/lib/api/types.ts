import type {
  AgentRiskProfile,
  DefenseReport,
  DetectionReport,
  InteractionTrace,
  RiskReport,
  RuntimeSupervisionRecord,
  SupervisionAction,
  SupervisionPolicyPack,
  SupervisionTargetType,
  TestRun,
} from "@agent-guard/contracts";

export type ApiResponse<T> =
  | {
      ok: true;
      data: T;
      requestId?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
      requestId?: string;
    };

export type CLineRunGroup = {
  schemaVersion: "mvp-1";
  runGroupId: string;
  agentId: string;
  agentName?: string;
  adapterKind?: "openclaw" | "http_sample" | "mock";
  status: "running" | "completed" | "failed";
  caseIds: string[];
  caseCount?: number;
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

export type P2ArtifactView = {
  artifactId: string;
  reportId: string;
  format: "json" | "html";
  label: string;
  url: string;
  generatedAt: string;
};

export type P2RunE2EResponse = {
  runGroup: CLineRunGroup;
  links: unknown[];
  async?: boolean;
  statusUrl?: string;
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
  artifacts: P2ArtifactView[];
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

export type AgentAdapterKind = "openclaw" | "http_sample" | "mock";

export type AgentConnectionConfig = {
  adapterKind: AgentAdapterKind;
  agentId: string;
  name: string;
  description: string;
  openclawCliPath: string;
  gatewayUrl: string;
  endpointUrl: string;
  authToken: string;
  timeoutMs: number;
  caseIds: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type AgentListResponse = {
  agents: AgentConnectionConfig[];
  activeAgent: AgentConnectionConfig;
};

export type AgentCheckResult = {
  adapterKind: AgentAdapterKind;
  available: boolean;
  displayName: string;
  detail: string;
  normalizedAgent?: {
    agentId: string;
    name: string;
    adapterKind: AgentAdapterKind;
  };
};

export type SystemStatus = {
  schemaVersion: "mvp-1";
  service: string;
  status: "ok";
  apiVersion?: string;
  outputDir?: string;
  generatedAt?: string;
  defaultAdapterKind?: "openclaw" | "http_sample" | "mock";
  fallbackAdapterKinds?: ("http_sample" | "mock")[];
  activeAgent?: AgentConnectionConfig;
  latestRunGroup?: CLineRunGroup;
  health?: {
    api: boolean;
    openclawCli: boolean;
    outputStore: boolean;
    realtimeMcp: boolean;
    configuredAgents: number;
  };
  features?: Record<string, boolean>;
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
  eventId?: string;
  timestamp: string;
  type:
    | "active_policy_updated"
    | "session_reset"
    | "session_created"
    | "tool_call_started"
    | "supervision_decision"
    | "tool_call_result"
    | "defense_report_generated"
    | "live_error";
  message?: string;
  runtimeSessionId?: string;
  policyPackId?: string;
  traceId?: string;
  toolId?: string;
  toolName?: string;
  action?: SupervisionAction;
  targetType?: SupervisionTargetType;
  blocked?: boolean;
  detail?: Record<string, unknown>;
  status?: SampleAgentStatus;
  runGroup?: CLineRunGroup;
  riskReportCount?: number;
  traceCount?: number;
  caseId?: string;
  eventCount?: number;
  record?: RuntimeSupervisionRecord;
  defenseReportId?: string;
  blockedActions?: number;
  redactions?: number;
  askDecisions?: number;
};

export type RealtimeActivePolicyState = {
  requestedPolicyPackId?: string;
  resolvedPolicyPackId: string;
  runGroupId: string;
  source: "request" | "active" | "env" | "latest" | "fallback";
  policyCount: number;
  updatedAt?: string;
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
  artifacts: P2ArtifactView[];
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
