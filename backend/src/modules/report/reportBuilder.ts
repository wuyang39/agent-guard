import type { TestContext } from "../config/schemas";
import type { RiskEvaluationResult } from "../risk/riskTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { ReportSummary, RiskReport } from "./reportTypes";

const emptyCounts = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

const emptyCategoryCounts = {
  tool_misuse: 0,
  unauthorized_access: 0,
  data_leakage: 0,
  dangerous_action: 0,
  instruction_injection_following: 0,
};

export function buildRiskReport(
  context: TestContext,
  evaluation: RiskEvaluationResult,
): RiskReport {
  const summary: ReportSummary = {
    totalFindings: evaluation.findings.length,
    countsByRiskLevel: { ...emptyCounts },
    countsByCategory: { ...emptyCategoryCounts },
  };

  for (const finding of evaluation.findings) {
    summary.countsByRiskLevel[finding.riskLevel] += 1;
    summary.countsByCategory[finding.category] += 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    reportId: createId("report"),
    evaluationId: evaluation.evaluationId,
    contextId: context.contextId,
    caseId: context.caseId,
    traceId: evaluation.traceId,
    riskLevel: evaluation.riskLevel,
    summary,
    caseReport: {
      caseId: context.caseId,
      caseName: context.caseName,
      attackEntryType: context.testCase.attackEntryType,
      riskLevel: evaluation.riskLevel,
      findingIds: evaluation.findings.map((finding) => finding.findingId),
    },
    findings: evaluation.findings,
    evidenceChains: evaluation.evidenceChains,
    attackChains: evaluation.attackChains,
    highRiskIssues: [],
    toolCallTrace: {
      traceId: evaluation.traceId,
      steps: [],
    },
    attackChainViews: evaluation.attackChains.map((chain) => ({
      chainId: chain.chainId,
      findingId: chain.findingId,
      entryType: chain.entryType,
      summary: chain.summary,
      eventIds: chain.steps.map((step) => step.eventId),
    })),
    generatedAt: nowIso(),
  };
}
