import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  AgentRiskProfile,
  AgentWeakness,
  DetectionReport,
} from "./detectionTypes";
import type { RiskCategory } from "@agent-guard/contracts";

export function buildAgentRiskProfile(
  detectionReport: DetectionReport,
): AgentRiskProfile {
  const weaknesses = buildWeaknesses(detectionReport);

  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: createId("risk_profile"),
    agentId: detectionReport.agentId,
    sourceDetectionReportId: detectionReport.reportId,
    weaknesses,
    highRiskTools: [],
    sensitiveResourcePatterns: buildSensitiveResourcePatterns(weaknesses),
    exfiltrationPatterns: buildExfiltrationPatterns(weaknesses),
    recommendedControls: [
      ...new Set(weaknesses.flatMap((weakness) => weakness.recommendedPolicyTemplateIds)),
    ],
    confidence: detectionReport.riskSummary.totalFindings > 0 ? "medium" : "low",
    generatedAt: nowIso(),
  };
}

function buildWeaknesses(report: DetectionReport): AgentWeakness[] {
  const grouped = new Map<RiskCategory, AgentWeakness>();

  for (const scenario of report.failedScenarios) {
    const existing = grouped.get(scenario.weaknessCategory);
    if (existing) {
      existing.sourceFindingIds.push(...scenario.findingIds);
      continue;
    }

    grouped.set(scenario.weaknessCategory, {
      weaknessId: createId("weakness"),
      category: scenario.weaknessCategory,
      title: formatWeaknessTitle(scenario.weaknessCategory),
      description: `Agent triggered ${scenario.weaknessCategory} findings during pre-supervision detection.`,
      sourceFindingIds: [...scenario.findingIds],
      recommendedPolicyTemplateIds: [
        `policy_template.${scenario.weaknessCategory}`,
      ],
    });
  }

  return [...grouped.values()];
}

function buildSensitiveResourcePatterns(weaknesses: AgentWeakness[]): string[] {
  return weaknesses.some((weakness) => weakness.category === "unauthorized_access")
    ? ["/secret/*"]
    : [];
}

function buildExfiltrationPatterns(weaknesses: AgentWeakness[]): string[] {
  return weaknesses.some((weakness) => weakness.category === "data_leakage")
    ? ["token", "secret", "password"]
    : [];
}

function formatWeaknessTitle(category: RiskCategory): string {
  const titles: Record<RiskCategory, string> = {
    tool_misuse: "Tool misuse weakness",
    unauthorized_access: "Unauthorized access weakness",
    data_leakage: "Data leakage weakness",
    dangerous_action: "Dangerous action weakness",
    instruction_injection_following: "Instruction injection following weakness",
  };

  return titles[category];
}
