import type { RiskCategory, RiskLevel, SchemaVersion } from "./common";

export type DetectionReport = {
  schemaVersion: SchemaVersion;
  reportId: string;
  agentId: string;
  sourceRiskReportIds: string[];
  scenarioSummary: DetectionScenarioSummary[];
  riskSummary: DetectionRiskSummary;
  failedScenarios: FailedScenario[];
  findingIds: string[];
  evidenceChainIds: string[];
  recommendedPolicyTemplateIds: string[];
  generatedAt: string;
};

export type DetectionScenarioSummary = {
  scenarioId: string;
  caseIds: string[];
  status: "passed" | "failed" | "partially_failed";
  triggeredFindingIds: string[];
};

export type DetectionRiskSummary = {
  totalScenarios: number;
  failedScenarioCount: number;
  totalFindings: number;
  highestRiskLevel: RiskLevel;
  countsByCategory: Record<RiskCategory, number>;
};

export type FailedScenario = {
  scenarioId: string;
  caseId: string;
  findingIds: string[];
  weaknessCategory: RiskCategory;
  evidenceEventIds: string[];
};

export type AgentRiskProfile = {
  schemaVersion: SchemaVersion;
  profileId: string;
  agentId: string;
  sourceDetectionReportId: string;
  weaknesses: AgentWeakness[];
  highRiskTools: string[];
  sensitiveResourcePatterns: string[];
  exfiltrationPatterns: string[];
  recommendedControls: string[];
  confidence: "low" | "medium" | "high";
  generatedAt: string;
};

export type AgentWeakness = {
  weaknessId: string;
  category: RiskCategory;
  title: string;
  description: string;
  sourceFindingIds: string[];
  recommendedPolicyTemplateIds: string[];
};
