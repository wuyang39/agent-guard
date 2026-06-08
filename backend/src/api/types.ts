/**
 * P2 API view types — 不进入 packages/contracts，除非多端复用。
 */

import type { RiskLevel, RunStatus } from "@agent-guard/contracts";

export type P2AdapterKind = "openclaw" | "http_sample" | "mock";

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
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  caseCount: number;
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
  format: "json" | "html";
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
    launchMode?: "external_running" | "spawn_local";
    timeoutMs?: number;
  };
  caseIds?: string[];
  generateDefenseReport: boolean;
};

export type SupervisorActionCounts = Record<
  "allow" | "deny" | "ask" | "warn" | "redact" | "isolate",
  number
>;
