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
  phase:
    | "queued"
    | "detecting"
    | "policy_ready"
    | "supervising"
    | "supervision_completed"
    | "defense_report_ready"
    | "failed";
  policyContextSource?: "stored_detection" | "synthetic_fallback";
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
  historicalWindow?: {
    runLimit: number;
    runCount: number;
  };
  latestRunMetrics?: {
    runGroupId: string;
    traces: number;
    riskReports: number;
    findings: number;
    blockedActions: number;
    redactions: number;
    askDecisions: number;
    residualRisks: number;
    highestRiskLevel: RiskReport["riskLevel"];
    countsByCategory: RiskReport["summary"]["countsByCategory"];
  };
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

export type RealtimePreparedSession = {
  runtimeSessionId: string;
  runGroupId: string;
  sourceRunGroupId: string;
  traceId: string;
  policyPackId: string;
  agentId: string;
  startedAt: string;
};

export type RuntimeLlmMode = "disabled" | "mock" | "openai_compatible";

export type RuntimeLlmConfig = {
  enabled: boolean;
  mode: RuntimeLlmMode;
  endpoint?: string;
  model?: string;
  timeoutMs: number;
  source: "runtime" | "env" | "default";
  hasApiKey: boolean;
};

export type RuntimeLlmConfigInput = {
  enabled: boolean;
  mode: RuntimeLlmMode;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
};

export type RuntimeDownstreamMcpConfig = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  endpointUrl?: string;
  timeoutMs: number;
  source: "runtime" | "env" | "default";
};

export type RuntimeDownstreamMcpConfigInput = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  endpointUrl?: string;
  timeoutMs: number;
};

export type RuntimeConfigSnapshot = {
  schemaVersion: "mvp-1";
  llm: RuntimeLlmConfig;
  downstreamMcp: RuntimeDownstreamMcpConfig;
  updatedAt: string;
};

export type RuntimeConfigCheckResult = {
  available: boolean;
  provider?: string;
  model?: string;
  providerId?: string;
  providerName?: string;
  toolCount?: number;
  tools?: {
    name: string;
    canonicalToolId: string;
    description: string;
  }[];
  detail: string;
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
  policyContextSource?: "stored_detection" | "synthetic_fallback";
  evidenceSummary?: DefenseEvidenceSummary;
  runtimeSessionSummaries?: RuntimeSessionSummary[];
  supervisionRecords: RuntimeSupervisionRecord[];
  artifacts: P2ArtifactView[];
};

export type DefenseEvidenceSummary = {
  declaredRuntimeSessionCount: number;
  runtimeSessionCount: number;
  supervisionRecordCount: number;
  realSupervisionRecordCount: number;
  policyContextSource?: "stored_detection" | "synthetic_fallback";
  usesSyntheticFallback: boolean;
  canProveDefenseEffect: boolean;
};

export type RuntimeSessionSummary = {
  runtimeSessionId: string;
  policyContextSource?: "stored_detection" | "synthetic_fallback";
  recordCount: number;
  blockedCount: number;
  redactedCount: number;
  askCount: number;
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
