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
import type { RiskCategory, RiskLevel } from "@agent-guard/contracts";

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
};

export function buildDetectionReport(
  input: BuildDetectionReportInput,
): DetectionReport {
  const failedScenarios = buildFailedScenarios(input.riskReports);
  const scenarioSummary = buildScenarioSummary(input.riskReports);
  const findingIds = input.riskReports.flatMap((report) =>
    report.findings.map((finding) => finding.findingId),
  );
  const evidenceChainIds = input.riskReports.flatMap((report) =>
    report.evidenceChains.map((chain) => chain.chainId),
  );
  const recommendedPolicyTemplateIds = [
    ...new Set(
      input.riskReports.flatMap((report) =>
        report.findings.map((finding) =>
          toPolicyTemplateId(finding.category),
        ),
      ),
    ),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    reportId: createId("detection_report"),
    agentId: input.agentId,
    sourceRiskReportIds: input.riskReports.map((report) => report.reportId),
    scenarioSummary,
    riskSummary: buildRiskSummary(input.riskReports, failedScenarios),
    failedScenarios,
    findingIds,
    evidenceChainIds,
    recommendedPolicyTemplateIds,
    generatedAt: nowIso(),
  };
}

function buildScenarioSummary(
  riskReports: RiskReport[],
): DetectionScenarioSummary[] {
  return riskReports.map((report) => {
    const triggeredFindingIds = report.findings.map(
      (finding) => finding.findingId,
    );

    return {
      scenarioId: report.caseReport.attackEntryType,
      caseIds: [report.caseId],
      status: triggeredFindingIds.length > 0 ? "failed" : "passed",
      triggeredFindingIds,
    };
  });
}

function buildFailedScenarios(riskReports: RiskReport[]): FailedScenario[] {
  return riskReports.flatMap((report) =>
    report.findings.map((finding) => ({
      scenarioId: report.caseReport.attackEntryType,
      caseId: report.caseId,
      findingIds: [finding.findingId],
      weaknessCategory: finding.category,
      evidenceEventIds: finding.evidenceEventIds,
    })),
  );
}

function buildRiskSummary(
  riskReports: RiskReport[],
  failedScenarios: FailedScenario[],
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
    totalScenarios: riskReports.length,
    failedScenarioCount: new Set(
      failedScenarios.map((scenario) => scenario.scenarioId),
    ).size,
    totalFindings,
    highestRiskLevel,
    countsByCategory,
  };
}

function toPolicyTemplateId(category: RiskCategory): string {
  return `policy_template.${category}`;
}
