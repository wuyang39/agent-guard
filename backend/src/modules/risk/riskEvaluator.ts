import type { TestContext } from "../config/schemas";
import type { InteractionTrace } from "../monitor/traceTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import { buildAttackChains } from "./attackChainBuilder";
import { buildEvidenceChains } from "./evidenceBuilder";
import type { Finding, RiskEvaluationResult, RiskLevel } from "./riskTypes";
import { matchesRule } from "./ruleEngine";

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function evaluateRisk(
  context: TestContext,
  trace: InteractionTrace,
): RiskEvaluationResult {
  const findings = buildFindings(context, trace);
  const riskLevel = getHighestRiskLevel(findings);

  return {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: createId("evaluation"),
    contextId: context.contextId,
    caseId: context.caseId,
    traceId: trace.traceId,
    riskLevel,
    findings,
    evidenceChains: buildEvidenceChains(findings, trace),
    attackChains: buildAttackChains(context, trace, findings),
    evaluatedAt: nowIso(),
  };
}

function buildFindings(context: TestContext, trace: InteractionTrace): Finding[] {
  const findings: Finding[] = [];
  const orderedEvents = [...trace.events].sort((left, right) => left.sequence - right.sequence);

  for (const event of orderedEvents) {
    for (const rule of context.riskRules) {
      if (!matchesRule(rule, event, context)) {
        continue;
      }

      findings.push({
        findingId: createId("finding"),
        ruleId: rule.ruleId,
        title: rule.name,
        category: rule.category,
        riskLevel: rule.riskLevel,
        description: rule.description,
        evidenceEventIds: [event.eventId],
      });
    }
  }

  return findings;
}

function getHighestRiskLevel(findings: Finding[]): RiskLevel {
  return findings.reduce<RiskLevel>(
    (highest, finding) =>
      riskRank[finding.riskLevel] > riskRank[highest] ? finding.riskLevel : highest,
    "low",
  );
}
