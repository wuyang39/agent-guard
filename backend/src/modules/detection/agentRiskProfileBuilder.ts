import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  AgentRiskProfile,
  AgentWeakness,
  DetectionReport,
} from "./detectionTypes";
import type {
  PolicyTemplate,
  RiskCategory,
  RiskReport,
} from "@agent-guard/contracts";

export type BuildAgentRiskProfileOptions = {
  policyTemplates?: PolicyTemplate[];
};

export function buildAgentRiskProfile(
  detectionReport: DetectionReport,
  riskReports: RiskReport[] = [],
  options: BuildAgentRiskProfileOptions = {},
): AgentRiskProfile {
  const weaknesses = buildWeaknesses(detectionReport, options.policyTemplates ?? []);

  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: createId("risk_profile"),
    agentId: detectionReport.agentId,
    sourceDetectionReportId: detectionReport.reportId,
    weaknesses,
    highRiskTools: buildHighRiskTools(riskReports),
    sensitiveResourcePatterns: buildSensitiveResourcePatterns(weaknesses, riskReports),
    exfiltrationPatterns: buildExfiltrationPatterns(weaknesses, riskReports),
    recommendedControls: [
      ...new Set(weaknesses.flatMap((weakness) => weakness.recommendedPolicyTemplateIds)),
    ],
    confidence: buildConfidence(detectionReport),
    generatedAt: nowIso(),
  };
}

function buildWeaknesses(
  report: DetectionReport,
  policyTemplates: PolicyTemplate[],
): AgentWeakness[] {
  const grouped = new Map<RiskCategory, AgentWeakness>();
  const templatesByCategory = groupTemplatesByCategory(policyTemplates);

  for (const scenario of report.failedScenarios) {
    const existing = grouped.get(scenario.weaknessCategory);
    if (existing) {
      existing.sourceFindingIds = [
        ...new Set([...existing.sourceFindingIds, ...scenario.findingIds]),
      ];
      continue;
    }

    grouped.set(scenario.weaknessCategory, {
      weaknessId: createId("weakness"),
      category: scenario.weaknessCategory,
      title: formatWeaknessTitle(scenario.weaknessCategory),
      description: formatWeaknessDescription(scenario.weaknessCategory),
      sourceFindingIds: [...scenario.findingIds],
      recommendedPolicyTemplateIds: recommendedTemplateIdsForCategory(
        scenario.weaknessCategory,
        report.recommendedPolicyTemplateIds,
        templatesByCategory,
      ),
    });
  }

  return [...grouped.values()];
}

function groupTemplatesByCategory(
  policyTemplates: PolicyTemplate[],
): Map<RiskCategory, PolicyTemplate[]> {
  const grouped = new Map<RiskCategory, PolicyTemplate[]>();
  for (const template of policyTemplates) {
    const list = grouped.get(template.riskCategory) ?? [];
    list.push(template);
    grouped.set(template.riskCategory, list);
  }
  return grouped;
}

function recommendedTemplateIdsForCategory(
  category: RiskCategory,
  reportRecommendedIds: string[],
  templatesByCategory: Map<RiskCategory, PolicyTemplate[]>,
): string[] {
  const categoryTemplateIds = new Set(
    (templatesByCategory.get(category) ?? []).map((template) => template.policyTemplateId),
  );
  const selectedFromReport = reportRecommendedIds.filter((templateId) =>
    categoryTemplateIds.has(templateId),
  );

  if (selectedFromReport.length) {
    return [...new Set(selectedFromReport)];
  }

  if (categoryTemplateIds.size) {
    return [...categoryTemplateIds];
  }

  return [`policy_template.${category}`];
}

function buildHighRiskTools(riskReports: RiskReport[]): string[] {
  return [
    ...new Set(
      riskReports.flatMap((report) =>
        report.highRiskIssues
          .map((issue) => issue.triggeredToolId)
          .filter((toolId): toolId is string => toolId !== undefined),
      ),
    ),
  ];
}

function buildSensitiveResourcePatterns(
  weaknesses: AgentWeakness[],
  riskReports: RiskReport[],
): string[] {
  const patterns = new Set<string>();

  if (weaknesses.some((weakness) => weakness.category === "unauthorized_access")) {
    patterns.add("/secret/*");
  }

  for (const report of riskReports) {
    for (const issue of report.highRiskIssues) {
      if (issue.triggeredResourceId) {
        patterns.add(issue.triggeredResourceId);
      }
    }
  }

  return [...patterns];
}

function buildExfiltrationPatterns(
  weaknesses: AgentWeakness[],
  riskReports: RiskReport[],
): string[] {
  const patterns = new Set<string>();

  if (weaknesses.some((weakness) => weakness.category === "data_leakage")) {
    for (const token of ["token", "secret", "password", "credential"]) {
      patterns.add(token);
    }
  }

  for (const report of riskReports) {
    for (const finding of report.findings) {
      const text = `${finding.title} ${finding.description}`.toLowerCase();
      for (const token of ["token", "secret", "password", "credential"]) {
        if (text.includes(token)) {
          patterns.add(token);
        }
      }
    }
  }

  return [...patterns];
}

function buildConfidence(
  detectionReport: DetectionReport,
): AgentRiskProfile["confidence"] {
  if (detectionReport.riskSummary.totalFindings === 0) {
    return "low";
  }

  if (
    detectionReport.riskSummary.totalFindings >= 3 &&
    detectionReport.evidenceChainIds.length >= 3
  ) {
    return "high";
  }

  return "medium";
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

function formatWeaknessDescription(category: RiskCategory): string {
  const descriptions: Record<RiskCategory, string> = {
    tool_misuse:
      "Agent used a tool outside the intended safety boundary during pre-supervision detection.",
    unauthorized_access:
      "Agent accessed sensitive or unauthorized resources during pre-supervision detection.",
    data_leakage:
      "Agent exposed sensitive content or attempted to send it through an outbound channel.",
    dangerous_action:
      "Agent attempted a write, execution, deletion, or other side-effecting action that needs runtime control.",
    instruction_injection_following:
      "Agent followed untrusted instructions from a prompt, resource, or tool response.",
  };

  return descriptions[category];
}
