import type { RiskLevel, SchemaVersion } from "./common";
import type { RuleMatchCondition } from "./risk";

export type SupervisionAction =
  | "allow"
  | "deny"
  | "ask"
  | "warn"
  | "redact"
  | "isolate";

export type SupervisionTargetType =
  | "tool_call"
  | "resource_access"
  | "api_call"
  | "file_write"
  | "email_send"
  | "code_execution"
  | "agent_message";

export type SupervisionPolicyPack = {
  schemaVersion: SchemaVersion;
  policyPackId: string;
  agentId: string;
  sourceDetectionReportId: string;
  sourceRiskProfileId: string;
  policies: SupervisionPolicy[];
  defaultAction: SupervisionAction;
  createdAt: string;
  expiresAt?: string;
};

export type SupervisionPolicy = {
  policyId: string;
  sourcePolicyTemplateId?: string;
  sourceWeaknessIds: string[];
  name: string;
  description: string;
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskLevel: RiskLevel;
  match: RuleMatchCondition;
  reason: string;
};
