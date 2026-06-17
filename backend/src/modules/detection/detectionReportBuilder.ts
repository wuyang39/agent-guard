import type { RiskReport } from "../report/reportTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  DetectionReport,
  DetectionRiskSummary,
  DetectionScenarioSummary,
  FailedScenario,
} from "./detectionTypes";
import type {
  PolicyTemplate,
  RedTeamScenario,
  RedTeamScenarioSet,
  RiskCategory,
  RiskLevel,
} from "@agent-guard/contracts";

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const emptyCategoryCounts: Record<RiskCategory, number> = {
  tool_misuse: 0,
  unauthorized_access: 0,
  data_leakage: 0,
  dangerous_action: 0,
  instruction_injection_following: 0,
};

export type BuildDetectionReportInput = {
  agentId: string;
  riskReports: RiskReport[];
  redTeamScenarioSet?: RedTeamScenarioSet;
  policyTemplates?: PolicyTemplate[];
};

export function buildDetectionReport(
  input: BuildDetectionReportInput,
): DetectionReport {
  const scenarioIndex = buildScenarioIndex(input.redTeamScenarioSet);
  const templateIndex = buildTemplateIndex(input.policyTemplates);
  const scenarioSummary = buildScenarioSummary(input.riskReports, scenarioIndex);
  const failedScenarios = buildFailedScenarios(input.riskReports, scenarioIndex);
  const findingIds = input.riskReports.flatMap((report) =>
    report.findings.map((finding) => finding.findingId),
  );
  const evidenceChainIds = input.riskReports.flatMap((report) =>
    report.evidenceChains.map((chain) => chain.chainId),
  );
  const recommendedPolicyTemplateIds = buildRecommendedPolicyTemplateIds(
    input.riskReports,
    scenarioIndex,
    templateIndex,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    reportId: createId("detection_report"),
    agentId: input.agentId,
    sourceRiskReportIds: input.riskReports.map((report) => report.reportId),
    scenarioSummary,
    riskSummary: buildRiskSummary(input.riskReports, scenarioSummary),
    failedScenarios,
    findingIds,
    evidenceChainIds,
    recommendedPolicyTemplateIds,
    generatedAt: nowIso(),
  };
}

function buildScenarioSummary(
  riskReports: RiskReport[],
  scenarioIndex: ScenarioIndex,
): DetectionScenarioSummary[] {
  const grouped = new Map<
    string,
    {
      caseIds: Set<string>;
      failedCaseCount: number;
      totalCaseCount: number;
      triggeredFindingIds: string[];
    }
  >();

  for (const report of riskReports) {
    const scenarioIds = scenarioIdsForReport(report, scenarioIndex);
    for (const scenarioId of scenarioIds) {
      const triggeredFindingIds = report.findings.map(
        (finding) => finding.findingId,
      );

      const current =
        grouped.get(scenarioId) ??
        {
          caseIds: new Set<string>(),
          failedCaseCount: 0,
          totalCaseCount: 0,
          triggeredFindingIds: [],
        };

      current.caseIds.add(report.caseId);
      current.totalCaseCount += 1;
      current.triggeredFindingIds.push(...triggeredFindingIds);
      if (triggeredFindingIds.length > 0) {
        current.failedCaseCount += 1;
      }

      grouped.set(scenarioId, current);
    }
  }

  return [...grouped.entries()].map(([scenarioId, summary]) => ({
    scenarioId,
    caseIds: [...summary.caseIds],
    status: getScenarioStatus(summary.failedCaseCount, summary.totalCaseCount),
    triggeredFindingIds: [...new Set(summary.triggeredFindingIds)],
  }));
}

function buildFailedScenarios(
  riskReports: RiskReport[],
  scenarioIndex: ScenarioIndex,
): FailedScenario[] {
  const grouped = new Map<string, FailedScenario>();

  for (const report of riskReports) {
    for (const finding of report.findings) {
      for (const scenarioId of scenarioIdsForReport(report, scenarioIndex)) {
        const key = `${scenarioId}:${report.caseId}:${finding.category}`;
        const current =
          grouped.get(key) ??
          {
            scenarioId,
            caseId: report.caseId,
            findingIds: [],
            weaknessCategory: finding.category,
            evidenceEventIds: [],
          };

        current.findingIds.push(finding.findingId);
        current.evidenceEventIds.push(...finding.evidenceEventIds);
        grouped.set(key, current);
      }
    }
  }

  return [...grouped.values()].map((scenario) => ({
    ...scenario,
    findingIds: [...new Set(scenario.findingIds)],
    evidenceEventIds: [...new Set(scenario.evidenceEventIds)],
  }));
}

function buildRiskSummary(
  riskReports: RiskReport[],
  scenarioSummary: DetectionScenarioSummary[],
): DetectionRiskSummary {
  const countsByCategory = { ...emptyCategoryCounts };
  let highestRiskLevel: RiskLevel = "low";
  let totalFindings = 0;

  for (const report of riskReports) {
    if (riskRank[report.riskLevel] > riskRank[highestRiskLevel]) {
      highestRiskLevel = report.riskLevel;
    }
    for (const finding of report.findings) {
      totalFindings += 1;
      countsByCategory[finding.category] += 1;
    }
  }

  return {
    totalScenarios: scenarioSummary.length,
    failedScenarioCount: scenarioSummary.filter(
      (scenario) => scenario.status !== "passed",
    ).length,
    totalFindings,
    highestRiskLevel,
    countsByCategory,
  };
}

function getScenarioStatus(
  failedCaseCount: number,
  totalCaseCount: number,
): DetectionScenarioSummary["status"] {
  if (failedCaseCount === 0) {
    return "passed";
  }

  return failedCaseCount === totalCaseCount ? "failed" : "partially_failed";
}

type ScenarioIndex = {
  byCaseId: Map<string, RedTeamScenario[]>;
};

function buildScenarioIndex(
  scenarioSet: RedTeamScenarioSet | undefined,
): ScenarioIndex {
  const byCaseId = new Map<string, RedTeamScenario[]>();
  for (const scenario of scenarioSet?.scenarios ?? []) {
    for (const caseId of scenario.caseIds) {
      const list = byCaseId.get(caseId) ?? [];
      list.push(scenario);
      byCaseId.set(caseId, list);
    }
  }
  return { byCaseId };
}

function buildTemplateIndex(
  templates: PolicyTemplate[] | undefined,
): {
  byId: Map<string, PolicyTemplate>;
  byCategory: Map<RiskCategory, PolicyTemplate[]>;
} {
  const byId = new Map<string, PolicyTemplate>();
  const byCategory = new Map<RiskCategory, PolicyTemplate[]>();
  for (const template of templates ?? []) {
    byId.set(template.policyTemplateId, template);
    const list = byCategory.get(template.riskCategory) ?? [];
    list.push(template);
    byCategory.set(template.riskCategory, list);
  }
  return { byId, byCategory };
}

function scenarioIdsForReport(
  report: RiskReport,
  scenarioIndex: ScenarioIndex,
): string[] {
  const scenarios = scenarioIndex.byCaseId.get(report.caseId);
  if (scenarios?.length) {
    return scenarios.map((scenario) => scenario.scenarioId);
  }
  return [report.caseReport.attackEntryType];
}

function buildRecommendedPolicyTemplateIds(
  riskReports: RiskReport[],
  scenarioIndex: ScenarioIndex,
  templateIndex: ReturnType<typeof buildTemplateIndex>,
): string[] {
  const ids: string[] = [];

  for (const report of riskReports) {
    const scenarios = scenarioIndex.byCaseId.get(report.caseId) ?? [];
    for (const finding of report.findings) {
      const scenarioTemplateIds = scenarios.flatMap(
        (scenario) => scenario.recommendedPolicyTemplateIds,
      );
      const matchingScenarioTemplates = scenarioTemplateIds.filter((templateId) => {
        const template = templateIndex.byId.get(templateId);
        return template?.riskCategory === finding.category;
      });
      const categoryTemplates =
        templateIndex.byCategory.get(finding.category)?.map(
          (template) => template.policyTemplateId,
        ) ?? [];

      const selected = matchingScenarioTemplates.length
        ? matchingScenarioTemplates
        : categoryTemplates;

      ids.push(...(selected.length ? selected : [`policy_template.${finding.category}`]));
    }
  }

  return [...new Set(ids)];
}
