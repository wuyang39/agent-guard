import type {
  AttackEntryType,
  JsonObject,
  ReportFormat,
  RiskCategory,
  RiskLevel,
  SchemaVersion,
} from "./common";
import type { AttackChain, EvidenceChain, Finding } from "./risk";
import type { TraceEventType } from "./trace";

export type RiskReport = {
  schemaVersion: SchemaVersion;
  reportId: string;
  evaluationId: string;
  contextId: string;
  caseId: string;
  traceId: string;
  riskLevel: RiskLevel;
  summary: ReportSummary;
  caseReport: CaseReport;
  findings: Finding[];
  evidenceChains: EvidenceChain[];
  attackChains: AttackChain[];
  highRiskIssues: HighRiskIssue[];
  toolCallTrace: ToolCallTraceView;
  attackChainViews: AttackChainView[];
  generatedAt: string;
};

export type ReportSummary = {
  totalFindings: number;
  countsByRiskLevel: Record<RiskLevel, number>;
  countsByCategory: Record<RiskCategory, number>;
};

export type CaseReport = {
  caseId: string;
  caseName: string;
  attackEntryType: AttackEntryType;
  riskLevel: RiskLevel;
  findingIds: string[];
};

export type HighRiskIssue = {
  issueId: string;
  findingId: string;
  title: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  triggeredToolId?: string;
  triggeredResourceId?: string;
  triggeredRuleId: string;
};

export type ToolCallTraceView = {
  traceId: string;
  steps: ToolCallTraceStep[];
};

export type ToolCallTraceStep = {
  sequence: number;
  eventId: string;
  type: TraceEventType;
  title: string;
  detail: string;
};

export type AttackChainView = {
  chainId: string;
  findingId: string;
  entryType: AttackEntryType;
  summary: string;
  eventIds: string[];
};

export type ReportArtifact = {
  schemaVersion: SchemaVersion;
  artifactId: string;
  reportId: string;
  format: ReportFormat;
  path: string;
  generatedAt: string;
};

export type TestContextView = {
  schemaVersion: SchemaVersion;
  contextViewId: string;
  contextId: string;
  caseId: string;
  caseName: string;
  agentId: string;
  scenarioIds: string[];
  attackEntryType?: AttackEntryType;
  task: {
    taskId?: string;
    instructionPreview?: string;
  };
  tools: TestContextToolView[];
  resources: TestContextResourceView[];
  prompts: TestContextPromptView[];
  riskRuleIds: string[];
  source: "config" | "trace_only" | "missing";
  warnings: string[];
};

export type TestContextToolView = {
  toolId: string;
  name?: string;
  riskLevel?: RiskLevel;
  sideEffect?: "none" | "read" | "write" | "network" | "command" | "execution";
};

export type TestContextResourceView = {
  resourceId: string;
  name?: string;
  sensitivity?: "public" | "internal" | "sensitive" | "secret";
};

export type TestContextPromptView = {
  promptId: string;
  name?: string;
  attackEntryType?: AttackEntryType;
};

export type ReportSection = {
  sectionId: string;
  title: string;
  summary: string;
  bullets: string[];
  sourceIds: string[];
};

export type DefenseClaim = {
  claimId: string;
  title: string;
  statement: string;
  claimType:
    | "risk"
    | "detection"
    | "policy"
    | "runtime_effect"
    | "residual_risk"
    | "limitation";
  confidence: "low" | "medium" | "high";
  sourceIds: {
    contextIds?: string[];
    traceEventIds?: string[];
    findingIds?: string[];
    policyIds?: string[];
    runtimeRecordIds?: string[];
  };
  reviewStatus: "auto_checked" | "needs_review" | "blocked_by_missing_evidence";
};

export type EvidenceBundle = {
  evidenceBundleId: string;
  reportId: string;
  coverage: EvidenceCoverageMatrix;
  items: EvidenceItem[];
  missingEvidence: MissingEvidenceItem[];
};

export type EvidenceKind =
  | "test_context"
  | "trace"
  | "trace_event"
  | "risk_report"
  | "finding"
  | "detection_report"
  | "risk_profile"
  | "policy_pack"
  | "policy"
  | "runtime_session"
  | "runtime_record"
  | "defense_report"
  | "artifact"
  | "missing_evidence";

export type EvidenceItem = {
  evidenceId: string;
  kind: EvidenceKind;
  objectId: string;
  title: string;
  summary: string;
  relatedClaimIds: string[];
  data?: JsonObject;
};

export type MissingEvidenceItem = {
  missingEvidenceId: string;
  requiredKind: EvidenceKind;
  relatedClaimId?: string;
  sourceId?: string;
  reason: string;
  severity: "info" | "warning" | "blocking";
};

export type EvidenceCoverageMatrix = {
  riskClaims: EvidenceCoverageRow[];
  detectionClaims: EvidenceCoverageRow[];
  policyClaims: EvidenceCoverageRow[];
  runtimeEffectClaims: EvidenceCoverageRow[];
  residualRiskClaims: EvidenceCoverageRow[];
};

export type EvidenceCoverageRow = {
  claimId: string;
  requiredEvidenceKinds: EvidenceKind[];
  availableEvidenceKinds: EvidenceKind[];
  missingEvidenceKinds: EvidenceKind[];
  coverageStatus: "complete" | "partial" | "missing";
};

export type TraceabilityGraph = {
  graphId: string;
  nodes: TraceabilityNode[];
  edges: TraceabilityEdge[];
};

export type TraceabilityNode = {
  nodeId: string;
  kind:
    | "test_context"
    | "test_run"
    | "trace"
    | "trace_event"
    | "risk_report"
    | "finding"
    | "detection_report"
    | "risk_profile"
    | "policy_pack"
    | "policy"
    | "runtime_session"
    | "runtime_record"
    | "defense_report"
    | "artifact"
    | "claim";
  label: string;
  data?: JsonObject;
};

export type TraceabilityEdge = {
  edgeId: string;
  from: string;
  to: string;
  relation:
    | "produced_by"
    | "derived_from"
    | "uses_policy"
    | "observed_in"
    | "supports_claim"
    | "exported_as";
};

export type ReportQualitySummary = {
  reportId: string;
  score: number;
  level: "draft" | "reviewable" | "submission_ready";
  checks: ReportQualityCheck[];
  blockingIssues: string[];
  generatedAt: string;
};

export type ReportQualityCheck = {
  checkId: string;
  title: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export type ReportBundle = {
  schemaVersion: SchemaVersion;
  bundleId: string;
  runGroupId: string;
  agentId: string;
  generatedAt: string;
  source: {
    testContextViewIds: string[];
    testRunIds: string[];
    traceIds: string[];
    riskReportIds: string[];
    detectionReportId?: string;
    riskProfileId?: string;
    policyPackId?: string;
    runtimeSessionIds: string[];
    defenseReportId?: string;
  };
  testContextViews: TestContextView[];
  executiveSummary: ReportSection;
  claims: DefenseClaim[];
  evidenceBundle: EvidenceBundle;
  traceabilityGraph: TraceabilityGraph;
  quality: ReportQualitySummary;
  exports: ReportArtifact[];
};
