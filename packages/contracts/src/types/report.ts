import type { AttackEntryType, ReportFormat, RiskCategory, RiskLevel, SchemaVersion } from "./common";
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
