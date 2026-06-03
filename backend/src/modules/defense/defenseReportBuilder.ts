import type { AgentRiskProfile, DetectionReport } from "../detection/detectionTypes";
import type { SupervisionPolicyPack } from "../policy/policyTypes";
import type {
  BlockedAction,
  RuntimeAlert,
  RuntimeSupervisionRecord,
} from "../supervisor/supervisorTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { DefenseEffectiveness, DefenseReport, ResidualRisk } from "./defenseTypes";

export type BuildDefenseReportInput = {
  detectionReport: DetectionReport;
  riskProfile: AgentRiskProfile;
  policyPack: SupervisionPolicyPack;
  runtimeRecords: RuntimeSupervisionRecord[];
};

export function buildDefenseReport(
  input: BuildDefenseReportInput,
): DefenseReport {
  const runtimeAlerts = buildRuntimeAlerts(input.runtimeRecords);
  const blockedActions = buildBlockedActions(input.runtimeRecords);

  return {
    schemaVersion: SCHEMA_VERSION,
    defenseReportId: createId("defense_report"),
    agentId: input.detectionReport.agentId,
    detectionReportId: input.detectionReport.reportId,
    riskProfileId: input.riskProfile.profileId,
    policyPackId: input.policyPack.policyPackId,
    runtimeSessionIds: [
      ...new Set(input.runtimeRecords.map((record) => record.runtimeSessionId)),
    ],
    detectedWeaknesses: input.riskProfile.weaknesses,
    generatedPolicies: input.policyPack.policies,
    runtimeAlerts,
    blockedActions,
    defenseEffectiveness: buildDefenseEffectiveness(input.runtimeRecords),
    residualRisk: buildResidualRisk(input),
    generatedAt: nowIso(),
  };
}

function buildRuntimeAlerts(
  records: RuntimeSupervisionRecord[],
): RuntimeAlert[] {
  return records
    .filter((record) => record.action === "warn")
    .map((record) => ({
      alertId: createId("runtime_alert"),
      recordId: record.recordId,
      riskLevel: "medium",
      title: "Runtime supervision warning",
      message: record.decisionReason,
      createdAt: nowIso(),
    }));
}

function buildBlockedActions(
  records: RuntimeSupervisionRecord[],
): BlockedAction[] {
  return records
    .filter((record) => record.action === "deny")
    .map((record) => ({
      blockedActionId: createId("blocked_action"),
      recordId: record.recordId,
      policyId: record.policyId,
      targetType: record.targetType,
      targetId: record.targetId,
      reason: record.decisionReason,
      createdAt: nowIso(),
    }));
}

function buildDefenseEffectiveness(
  records: RuntimeSupervisionRecord[],
): DefenseEffectiveness {
  return {
    blockedHighRiskActionCount: records.filter((record) => record.action === "deny").length,
    alertedActionCount: records.filter((record) => record.action === "warn").length,
    redactedActionCount: records.filter((record) => record.action === "redact").length,
    askDecisionCount: records.filter((record) => record.action === "ask").length,
    mitigatedWeaknessIds: [],
  };
}

function buildResidualRisk(input: BuildDefenseReportInput): ResidualRisk[] {
  const matchedPolicyIds = new Set(input.runtimeRecords.map((record) => record.policyId));
  const unmatchedPolicies = input.policyPack.policies.filter(
    (policy) => !matchedPolicyIds.has(policy.policyId),
  );

  return unmatchedPolicies.map((policy) => ({
    residualRiskId: createId("residual_risk"),
    category: "dangerous_action",
    riskLevel: policy.riskLevel,
    description: `Policy ${policy.policyId} has not been observed in runtime supervision records.`,
    relatedWeaknessIds: policy.sourceWeaknessIds,
  }));
}
