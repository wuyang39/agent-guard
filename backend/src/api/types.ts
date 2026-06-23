/**
 * P2 API view types — 不进入 packages/contracts，除非多端复用。
 */

import type { ReportFormat, RiskLevel, RunStatus } from "@agent-guard/contracts";

export type P2AdapterKind = "openclaw" | "http_sample" | "mock";

export type P2RunPhase =
  | "queued"
  | "detecting"
  | "policy_ready"
  | "supervising"
  | "supervision_completed"
  | "defense_report_ready"
  | "failed";

export type P2PolicyContextSource =
  | "stored_detection"
  | "synthetic_fallback";

export type P2RunProgress = {
  phase: P2RunPhase | "policy_building" | "reporting" | "completed";
  totalCases: number;
  completedCases: number;
  failedCases: number;
  runningCaseIds: string[];
  lastCompletedCaseId?: string;
  concurrency: number;
  percent: number;
  startedAt: string;
  updatedAt: string;
};

export type EntityLink = {
  kind:
    | "test_context"
    | "test_run"
    | "trace"
    | "risk_report"
    | "detection_report"
    | "risk_profile"
    | "policy_pack"
    | "runtime_session"
    | "defense_report"
    | "artifact";
  id: string;
  label: string;
};

export type P2RunGroup = {
  runGroupId: string;
  agentId: string;
  agentName: string;
  adapterKind: P2AdapterKind;
  selectionPlanId?: string;
  status: RunStatus;
  phase: P2RunPhase;
  policyContextSource?: P2PolicyContextSource;
  startedAt: string;
  updatedAt?: string;
  endedAt?: string;
  caseIds?: string[];
  caseCount: number;
  progress?: P2RunProgress;
  highestRiskLevel?: RiskLevel;
  testRunIds: string[];
  traceIds: string[];
  riskReportIds: string[];
  detectionReportId?: string;
  riskProfileId?: string;
  policyPackId?: string;
  runtimeSessionIds: string[];
  defenseReportId?: string;
  artifactIds: string[];
  error?: string;
};

export type P2ArtifactView = {
  artifactId: string;
  reportId: string;
  format: ReportFormat;
  label: string;
  url: string;
  generatedAt: string;
};

export type RunE2ERequest = {
  adapterKind: P2AdapterKind;
  agent: {
    agentId?: string;
    name: string;
    description?: string;
  };
  connection?: {
    endpointUrl?: string;
    cliPath?: string;
    launchMode?: "external_running" | "spawn_local";
    timeoutMs?: number;
  };
  caseIds?: string[];
  selectionPlanId?: string;
  generateDefenseReport: boolean;
};

export type AgentConnectionConfig = {
  adapterKind: P2AdapterKind;
  agentId: string;
  name: string;
  description?: string;
  openclawCliPath?: string;
  gatewayUrl?: string;
  endpointUrl?: string;
  timeoutMs?: number;
  caseIds?: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type AgentCheckResult = {
  adapterKind: P2AdapterKind;
  available: boolean;
  displayName: string;
  detail: string;
  normalizedAgent?: {
    agentId: string;
    name: string;
    adapterKind: P2AdapterKind;
  };
};

export type SupervisorActionCounts = Record<
  "allow" | "deny" | "ask" | "warn" | "redact" | "isolate",
  number
>;
