import type { RiskCategory, RiskLevel, SchemaVersion } from "./common";
import type { AgentWeakness } from "./detection";
import type { SupervisionPolicy } from "./policy";
import type { BlockedAction, RuntimeAlert } from "./supervision";

export type DefenseReport = {
  schemaVersion: SchemaVersion;
  defenseReportId: string;
  agentId: string;
  detectionReportId: string;
  riskProfileId: string;
  policyPackId: string;
  runtimeSessionIds: string[];
  detectedWeaknesses: AgentWeakness[];
  generatedPolicies: SupervisionPolicy[];
  runtimeAlerts: RuntimeAlert[];
  blockedActions: BlockedAction[];
  defenseEffectiveness: DefenseEffectiveness;
  residualRisk: ResidualRisk[];
  generatedAt: string;
};

export type DefenseEffectiveness = {
  blockedHighRiskActionCount: number;
  alertedActionCount: number;
  redactedActionCount: number;
  askDecisionCount: number;
  mitigatedWeaknessIds: string[];
};

export type ResidualRisk = {
  residualRiskId: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  description: string;
  relatedWeaknessIds: string[];
};
