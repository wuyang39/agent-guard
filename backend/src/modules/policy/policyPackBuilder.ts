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
    policies: riskProfile.weaknesses.flatMap(toSupervisionPolicies),
    defaultAction: "allow",
    createdAt: nowIso(),
    expiresAt: buildExpiryIso(7),
  };
}

function toSupervisionPolicies(weakness: AgentWeakness): SupervisionPolicy[] {
  return policyDefaultsForCategory(weakness.category).map((defaults) =>
    buildPolicy(weakness, defaults),
  );
}

function policyDefaultsForCategory(category: RiskCategory): {
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskLevel: SupervisionPolicy["riskLevel"];
  match: SupervisionPolicy["match"];
  name: string;
  reason: string;
}[] {
  switch (category) {
    case "unauthorized_access":
      return [
        {
          targetType: "tool_call",
          action: "deny",
          riskLevel: "high",
          name: "Deny secret-path tool access",
          reason: "Detected unauthorized access weakness: block tool reads under /secret/.",
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
        },
        {
          targetType: "resource_access",
          action: "deny",
          riskLevel: "high",
          name: "Deny secret resource access",
          reason: "Detected unauthorized access weakness: block resources marked as secret.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.resourceId",
                operator: "contains",
                value: "secret",
              },
            ],
          },
        },
      ];
    case "data_leakage":
      return [
        {
          targetType: "api_call",
          action: "deny",
          riskLevel: "critical",
          name: "Deny obvious external exfiltration",
          reason: "Detected data leakage weakness: block outbound calls to obvious exfiltration endpoints.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.url",
                operator: "regex",
                value: "https?://(evil|attacker|exfil)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "api_call",
          action: "redact",
          riskLevel: "high",
          name: "Redact sensitive API payload",
          reason: "Detected data leakage weakness: redact token-like data before outbound API calls.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.data",
                operator: "regex",
                value: "(token|secret|password|credential)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "email_send",
          action: "redact",
          riskLevel: "high",
          name: "Redact sensitive email body",
          reason: "Detected data leakage weakness: redact token-like content before sending email.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.bodyPreview",
                operator: "regex",
                value: "(token|secret|password|credential)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
    case "dangerous_action":
      return [
        {
          targetType: "file_write",
          action: "ask",
          riskLevel: "high",
          name: "Ask before file write",
          reason: "Detected dangerous action weakness: require confirmation before file writes.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.path", operator: "exists" }],
          },
        },
        {
          targetType: "code_execution",
          action: "ask",
          riskLevel: "high",
          name: "Ask before code execution",
          reason: "Detected dangerous action weakness: require confirmation before code execution.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.codePreview", operator: "exists" }],
          },
        },
      ];
    case "instruction_injection_following":
      return [
        {
          targetType: "agent_message",
          action: "warn",
          riskLevel: "medium",
          name: "Warn on injection-following message",
          reason: "Detected instruction injection weakness: warn when the agent repeats override-style instructions.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.message",
                operator: "regex",
                value: "(ignore|override|developer|system|instruction|secret)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
    case "tool_misuse":
      return [
        {
          targetType: "tool_call",
          action: "ask",
          riskLevel: "medium",
          name: "Ask before broad tool call",
          reason: "Detected tool misuse weakness: require confirmation before matching tool calls.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.toolId", operator: "exists" }],
          },
        },
      ];
  }
}

function buildPolicy(
  weakness: AgentWeakness,
  defaults: ReturnType<typeof policyDefaultsForCategory>[number],
): SupervisionPolicy {
  return {
    policyId: createId("policy"),
    sourcePolicyTemplateId: weakness.recommendedPolicyTemplateIds[0],
    sourceWeaknessIds: [weakness.weaknessId],
    name: defaults.name,
    description: weakness.description,
    targetType: defaults.targetType,
    action: defaults.action,
    riskLevel: defaults.riskLevel,
    match: defaults.match,
    reason: `${defaults.reason} Source weakness: ${weakness.weaknessId}.`,
  };
}

function buildExpiryIso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}
