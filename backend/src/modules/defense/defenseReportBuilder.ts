import type { AgentRiskProfile, DetectionReport } from "../detection/detectionTypes";
import type { SupervisionPolicyPack } from "../policy/policyTypes";
import type { SupervisionPolicy } from "../policy/policyTypes";
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
  const policiesById = new Map(
    input.policyPack.policies.map((policy) => [policy.policyId, policy]),
  );
  const relatedRecords = input.runtimeRecords.filter(
    (record) =>
      record.policyPackId === input.policyPack.policyPackId &&
      policiesById.has(record.policyId),
  );
  const runtimeAlerts = buildRuntimeAlerts(relatedRecords, policiesById);
  const blockedActions = buildBlockedActions(relatedRecords);

  return {
    schemaVersion: SCHEMA_VERSION,
    defenseReportId: createId("defense_report"),
    agentId: input.detectionReport.agentId,
    detectionReportId: input.detectionReport.reportId,
    riskProfileId: input.riskProfile.profileId,
    policyPackId: input.policyPack.policyPackId,
    runtimeSessionIds: [
      ...new Set(relatedRecords.map((record) => record.runtimeSessionId)),
    ],
    detectedWeaknesses: input.riskProfile.weaknesses,
    generatedPolicies: input.policyPack.policies,
    runtimeAlerts,
    blockedActions,
    defenseEffectiveness: buildDefenseEffectiveness(relatedRecords, policiesById),
    residualRisk: buildResidualRisk(input, relatedRecords, policiesById),
    generatedAt: nowIso(),
  };
}

function buildRuntimeAlerts(
  records: RuntimeSupervisionRecord[],
  policiesById: Map<string, SupervisionPolicy>,
): RuntimeAlert[] {
  return records
    .filter((record) => record.action === "warn")
    .map((record) => ({
      alertId: createId("runtime_alert"),
      recordId: record.recordId,
      riskLevel: policiesById.get(record.policyId)?.riskLevel ?? "medium",
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
  policiesById: Map<string, SupervisionPolicy>,
): DefenseEffectiveness {
  const mitigatedWeaknessIds = new Set<string>();

  for (const record of records) {
    if (record.action === "allow") {
      continue;
    }

    for (const weaknessId of policiesById.get(record.policyId)?.sourceWeaknessIds ?? []) {
      mitigatedWeaknessIds.add(weaknessId);
    }
  }

  return {
    blockedHighRiskActionCount: records.filter((record) => {
      const policy = policiesById.get(record.policyId);
      return (
        record.action === "deny" &&
        (policy?.riskLevel === "high" || policy?.riskLevel === "critical")
      );
    }).length,
    alertedActionCount: records.filter((record) => record.action === "warn").length,
    redactedActionCount: records.filter((record) => record.action === "redact").length,
    askDecisionCount: records.filter((record) => record.action === "ask").length,
    mitigatedWeaknessIds: [...mitigatedWeaknessIds],
  };
}

function buildResidualRisk(
  input: BuildDefenseReportInput,
  records: RuntimeSupervisionRecord[],
  policiesById: Map<string, SupervisionPolicy>,
): ResidualRisk[] {
  const mitigatedWeaknessIds = new Set<string>();

  for (const record of records) {
    if (record.action === "allow") {
      continue;
    }
    for (const weaknessId of policiesById.get(record.policyId)?.sourceWeaknessIds ?? []) {
      mitigatedWeaknessIds.add(weaknessId);
    }
  }

  return input.riskProfile.weaknesses
    .filter((weakness) => !mitigatedWeaknessIds.has(weakness.weaknessId))
    .map((weakness) => ({
      residualRiskId: createId("residual_risk"),
      category: weakness.category,
      riskLevel: getHighestPolicyRiskLevel(
        input.policyPack.policies.filter((policy) =>
          policy.sourceWeaknessIds.includes(weakness.weaknessId),
        ),
      ),
      description:
        `No runtime supervision record has mitigated weakness ${weakness.weaknessId} yet.`,
      relatedWeaknessIds: [weakness.weaknessId],
    }));
}

function getHighestPolicyRiskLevel(
  policies: SupervisionPolicy[],
): ResidualRisk["riskLevel"] {
  const riskRank: Record<ResidualRisk["riskLevel"], number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  return policies.reduce<ResidualRisk["riskLevel"]>(
    (highest, policy) =>
      riskRank[policy.riskLevel] > riskRank[highest] ? policy.riskLevel : highest,
    "low",
  );
}
