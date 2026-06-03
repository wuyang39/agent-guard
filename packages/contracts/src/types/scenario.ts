import type { RiskCategory, SchemaVersion } from "./common";
import type { SupervisionAction, SupervisionTargetType } from "./policy";
import type { RuleMatchCondition } from "./risk";

export type RedTeamScenarioSet = {
  schemaVersion: SchemaVersion;
  scenarioSetId: string;
  name: string;
  description?: string;
  scenarios: RedTeamScenario[];
};

export type RedTeamScenario = {
  scenarioId: string;
  name: string;
  attackType: string;
  caseIds: string[];
  sampleIds: string[];
  expectedWeaknessCategories: RiskCategory[];
  recommendedPolicyTemplateIds: string[];
};

export type PolicyTemplate = {
  schemaVersion: SchemaVersion;
  policyTemplateId: string;
  name: string;
  description: string;
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskCategory: RiskCategory;
  match: RuleMatchCondition;
  reasonTemplate: string;
};
