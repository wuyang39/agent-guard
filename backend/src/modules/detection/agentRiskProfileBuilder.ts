import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  AgentRiskExposure,
  AgentRiskProfile,
  AgentTestedScenario,
  AgentWeakness,
  DetectionReport,
  DetectionScenarioSummary,
} from "./detectionTypes";
import type {
  PolicyTemplate,
  RiskCategory,
  RiskLevel,
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
  const testedScenarios = buildTestedScenarios(detectionReport);
  const exposures = buildExposures(
    detectionReport,
    riskReports,
    weaknesses,
    options.policyTemplates ?? [],
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    profileId: createId("risk_profile"),
    agentId: detectionReport.agentId,
    sourceDetectionReportId: detectionReport.reportId,
    testedScenarios,
    weaknesses,
    exposures,
    highRiskTools: buildHighRiskTools(riskReports),
    sensitiveResourcePatterns: buildSensitiveResourcePatterns(weaknesses, riskReports),
    exfiltrationPatterns: buildExfiltrationPatterns(weaknesses, riskReports),
    recommendedControls: [
      ...new Set([
        ...weaknesses.flatMap((weakness) => weakness.recommendedPolicyTemplateIds),
        ...exposures.flatMap((exposure) => exposure.recommendedPolicyTemplateIds),
      ]),
    ],
    confidence: buildConfidence(detectionReport, exposures),
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

function buildTestedScenarios(report: DetectionReport): AgentTestedScenario[] {
  return report.scenarioSummary.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    caseIds: [...scenario.caseIds],
    status: scenario.status,
    triggeredFindingIds: [...scenario.triggeredFindingIds],
    exposureCategories: categoriesForScenario(report, scenario),
  }));
}

function buildExposures(
  report: DetectionReport,
  riskReports: RiskReport[],
  weaknesses: AgentWeakness[],
  policyTemplates: PolicyTemplate[],
): AgentRiskExposure[] {
  const templatesByCategory = groupTemplatesByCategory(policyTemplates);
  const findingIndex = buildFindingIndex(riskReports);
  const exposures: AgentRiskExposure[] = [];

  for (const weakness of weaknesses) {
    const relatedScenarios = report.failedScenarios.filter((scenario) =>
      scenario.findingIds.some((findingId) => weakness.sourceFindingIds.includes(findingId)),
    );
    exposures.push({
      exposureId: createId("exposure"),
      category: weakness.category,
      title: `Observed ${formatCategoryLabel(weakness.category)} exposure`,
      description:
        "A pre-supervision test produced concrete evidence for this risk category. Runtime policy generation can treat it as an observed weakness.",
      riskLevel: highestFindingRiskLevel(weakness.sourceFindingIds, findingIndex),
      status: "observed_weakness",
      sourceScenarioIds: [...new Set(relatedScenarios.map((scenario) => scenario.scenarioId))],
      sourceCaseIds: [...new Set(relatedScenarios.map((scenario) => scenario.caseId))],
      sourceFindingIds: [...weakness.sourceFindingIds],
      relatedToolIds: relatedToolIdsForFindings(weakness.sourceFindingIds, riskReports),
      recommendedPolicyTemplateIds: weakness.recommendedPolicyTemplateIds,
    });
  }

  for (const scenario of report.scenarioSummary) {
    for (const category of categoriesForScenario(report, scenario)) {
      const alreadyObserved = exposures.some(
        (exposure) =>
          exposure.status === "observed_weakness" &&
          exposure.category === category &&
          exposure.sourceScenarioIds.includes(scenario.scenarioId),
      );
      if (alreadyObserved) continue;

      exposures.push({
        exposureId: createId("exposure"),
        category,
        title: `Tested ${formatCategoryLabel(category)} exposure`,
        description:
          scenario.status === "passed"
            ? "This risk scenario was exercised and no failing action was observed. Keep it in the profile as a tested exposure for baseline hardening."
            : "This risk scenario was partially exercised without a category-specific finding. Keep it visible as residual exposure.",
        riskLevel: scenario.status === "passed" ? "medium" : "high",
        status: "tested_no_finding",
        sourceScenarioIds: [scenario.scenarioId],
        sourceCaseIds: [...scenario.caseIds],
        sourceFindingIds: [...scenario.triggeredFindingIds],
        relatedToolIds: relatedToolIdsForCases(scenario.caseIds, riskReports),
        recommendedPolicyTemplateIds: recommendedTemplateIdsForCategory(
          category,
          report.recommendedPolicyTemplateIds,
          templatesByCategory,
        ),
      });
    }
  }

  for (const toolId of buildHighRiskTools(riskReports)) {
    const category = categoryForToolId(toolId);
    exposures.push({
      exposureId: createId("exposure"),
      category,
      title: `High-risk tool capability exposed: ${toolId}`,
      description:
        "A high-risk tool appeared in detection evidence. Track it as a capability exposure even when the specific failure is represented elsewhere.",
      riskLevel: category === "data_leakage" ? "critical" : "high",
      status: "capability_exposed",
      sourceScenarioIds: [],
      sourceCaseIds: caseIdsForTool(toolId, riskReports),
      sourceFindingIds: findingIdsForTool(toolId, riskReports),
      relatedToolIds: [toolId],
      recommendedPolicyTemplateIds: recommendedTemplateIdsForCategory(
        category,
        report.recommendedPolicyTemplateIds,
        templatesByCategory,
      ),
    });
  }

  return dedupeExposures(exposures);
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

function categoriesForScenario(
  report: DetectionReport,
  scenario: DetectionScenarioSummary,
): RiskCategory[] {
  const categories = new Set<RiskCategory>();
  for (const failed of report.failedScenarios) {
    if (
      failed.scenarioId === scenario.scenarioId ||
      failed.findingIds.some((findingId) => scenario.triggeredFindingIds.includes(findingId))
    ) {
      categories.add(failed.weaknessCategory);
    }
  }

  if (categories.size === 0) {
    for (const category of inferCategoriesFromScenarioId(scenario.scenarioId)) {
      categories.add(category);
    }
  }

  return [...categories];
}

function inferCategoriesFromScenarioId(scenarioId: string): RiskCategory[] {
  const normalized = scenarioId.toLowerCase();
  const categories = new Set<RiskCategory>();

  if (/(exfil|leak|secret|credential|token|data)/.test(normalized)) {
    categories.add("data_leakage");
  }
  if (/(tool|mcp|function|plugin)/.test(normalized)) {
    categories.add("tool_misuse");
  }
  if (/(abuse|execute|exec|write|delete|danger|unsafe)/.test(normalized)) {
    categories.add("dangerous_action");
  }
  if (/(access|auth|permission|tenant|admin|secret)/.test(normalized)) {
    categories.add("unauthorized_access");
  }
  if (/(inject|jailbreak|prompt|instruction|indirect)/.test(normalized)) {
    categories.add("instruction_injection_following");
  }

  return categories.size ? [...categories] : ["tool_misuse"];
}

function buildFindingIndex(
  riskReports: RiskReport[],
): Map<string, { riskLevel: RiskLevel; category: RiskCategory }> {
  const index = new Map<string, { riskLevel: RiskLevel; category: RiskCategory }>();
  for (const report of riskReports) {
    for (const finding of report.findings) {
      index.set(finding.findingId, {
        riskLevel: finding.riskLevel,
        category: finding.category,
      });
    }
  }
  return index;
}

function highestFindingRiskLevel(
  findingIds: string[],
  findingIndex: Map<string, { riskLevel: RiskLevel; category: RiskCategory }>,
): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return findingIds.reduce<RiskLevel>((highest, findingId) => {
    const level = findingIndex.get(findingId)?.riskLevel;
    return level && rank[level] > rank[highest] ? level : highest;
  }, "medium");
}

function relatedToolIdsForFindings(
  findingIds: string[],
  riskReports: RiskReport[],
): string[] {
  const tools = new Set<string>();
  for (const report of riskReports) {
    for (const issue of report.highRiskIssues) {
      if (findingIds.includes(issue.findingId) && issue.triggeredToolId) {
        tools.add(issue.triggeredToolId);
      }
    }
  }
  return [...tools];
}

function relatedToolIdsForCases(
  caseIds: string[],
  riskReports: RiskReport[],
): string[] {
  const tools = new Set<string>();
  for (const report of riskReports) {
    if (!caseIds.includes(report.caseId)) continue;
    for (const issue of report.highRiskIssues) {
      if (issue.triggeredToolId) tools.add(issue.triggeredToolId);
    }
  }
  return [...tools];
}

function caseIdsForTool(toolId: string, riskReports: RiskReport[]): string[] {
  const caseIds = new Set<string>();
  for (const report of riskReports) {
    if (report.highRiskIssues.some((issue) => issue.triggeredToolId === toolId)) {
      caseIds.add(report.caseId);
    }
  }
  return [...caseIds];
}

function findingIdsForTool(toolId: string, riskReports: RiskReport[]): string[] {
  const findingIds = new Set<string>();
  for (const report of riskReports) {
    for (const issue of report.highRiskIssues) {
      if (issue.triggeredToolId === toolId) {
        findingIds.add(issue.findingId);
      }
    }
  }
  return [...findingIds];
}

function categoryForToolId(toolId: string): RiskCategory {
  const normalized = toolId.toLowerCase();
  if (/(send_request|call_api|email|network|http|webhook)/.test(normalized)) {
    return "data_leakage";
  }
  if (/(exec|execute|bash|shell|write|delete|memory)/.test(normalized)) {
    return "dangerous_action";
  }
  if (/(read|resource|database|query)/.test(normalized)) {
    return "unauthorized_access";
  }
  return "tool_misuse";
}

function dedupeExposures(exposures: AgentRiskExposure[]): AgentRiskExposure[] {
  const byKey = new Map<string, AgentRiskExposure>();
  for (const exposure of exposures) {
    const key = [
      exposure.status,
      exposure.category,
      exposure.sourceScenarioIds.join(","),
      exposure.relatedToolIds.join(","),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, exposure);
      continue;
    }
    existing.sourceCaseIds = [...new Set([...existing.sourceCaseIds, ...exposure.sourceCaseIds])];
    existing.sourceFindingIds = [
      ...new Set([...existing.sourceFindingIds, ...exposure.sourceFindingIds]),
    ];
    existing.relatedToolIds = [...new Set([...existing.relatedToolIds, ...exposure.relatedToolIds])];
    existing.recommendedPolicyTemplateIds = [
      ...new Set([
        ...existing.recommendedPolicyTemplateIds,
        ...exposure.recommendedPolicyTemplateIds,
      ]),
    ];
  }
  return [...byKey.values()];
}

function formatCategoryLabel(category: RiskCategory): string {
  return category.replace(/_/g, " ");
}

function buildConfidence(
  detectionReport: DetectionReport,
  exposures: AgentRiskExposure[],
): AgentRiskProfile["confidence"] {
  if (detectionReport.riskSummary.totalFindings === 0) {
    return exposures.length > 0 || detectionReport.scenarioSummary.length > 0 ? "medium" : "low";
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
