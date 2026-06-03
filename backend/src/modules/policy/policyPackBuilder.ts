import type { AgentRiskProfile, AgentWeakness } from "../detection/detectionTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  SupervisionAction,
  SupervisionPolicy,
  SupervisionPolicyPack,
  SupervisionTargetType,
} from "./policyTypes";
import type { RiskCategory } from "@agent-guard/contracts";

export function buildSupervisionPolicyPack(
  riskProfile: AgentRiskProfile,
): SupervisionPolicyPack {
  return {
    schemaVersion: SCHEMA_VERSION,
    policyPackId: createId("policy_pack"),
    agentId: riskProfile.agentId,
    sourceDetectionReportId: riskProfile.sourceDetectionReportId,
    sourceRiskProfileId: riskProfile.profileId,
    policies: riskProfile.weaknesses.map(toSupervisionPolicy),
    defaultAction: "allow",
    createdAt: nowIso(),
  };
}

function toSupervisionPolicy(weakness: AgentWeakness): SupervisionPolicy {
  const categoryDefaults = policyDefaultsForCategory(weakness.category);

  return {
    policyId: createId("policy"),
    sourcePolicyTemplateId: weakness.recommendedPolicyTemplateIds[0],
    sourceWeaknessIds: [weakness.weaknessId],
    name: `${categoryDefaults.action} ${weakness.title}`,
    description: weakness.description,
    targetType: categoryDefaults.targetType,
    action: categoryDefaults.action,
    riskLevel: categoryDefaults.riskLevel,
    match: categoryDefaults.match,
    reason: `Generated from detected weakness ${weakness.weaknessId}.`,
  };
}

function policyDefaultsForCategory(category: RiskCategory): {
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskLevel: SupervisionPolicy["riskLevel"];
  match: SupervisionPolicy["match"];
} {
  switch (category) {
    case "unauthorized_access":
      return {
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: {
          relation: "all",
          matchers: [
            {
              fieldPath: "payload.parameters.path",
              operator: "starts_with",
              value: "/secret/",
            },
          ],
        },
      };
    case "data_leakage":
      return {
        targetType: "api_call",
        action: "deny",
        riskLevel: "critical",
        match: {
          relation: "any",
          matchers: [
            {
              fieldPath: "payload.data",
              operator: "contains",
              value: "token",
              caseSensitive: false,
            },
            {
              fieldPath: "payload.data",
              operator: "contains",
              value: "secret",
              caseSensitive: false,
            },
          ],
        },
      };
    case "dangerous_action":
      return {
        targetType: "tool_call",
        action: "ask",
        riskLevel: "high",
        match: { relation: "any", matchers: [{ fieldPath: "payload", operator: "exists" }] },
      };
    case "instruction_injection_following":
      return {
        targetType: "agent_message",
        action: "warn",
        riskLevel: "medium",
        match: { relation: "any", matchers: [{ fieldPath: "payload", operator: "exists" }] },
      };
    case "tool_misuse":
      return {
        targetType: "tool_call",
        action: "ask",
        riskLevel: "medium",
        match: { relation: "any", matchers: [{ fieldPath: "payload", operator: "exists" }] },
      };
  }
}
