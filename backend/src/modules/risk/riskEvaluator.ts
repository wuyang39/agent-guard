import type { TestContext } from "../config/schemas";
import type { InteractionTrace } from "../monitor/traceTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import { buildAttackChains } from "./attackChainBuilder";
import { buildEvidenceChains } from "./evidenceBuilder";
import type { Finding, RiskEvaluationResult, RiskLevel } from "./riskTypes";
import { matchesRule } from "./ruleEngine";
import {
  scoreTraceSemantically,
  type SemanticScorerOptions,
} from "./semanticScorer";

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
  return buildRiskEvaluationResult(context, trace, findings);
}

export async function evaluateRiskWithSemanticScoring(
  context: TestContext,
  trace: InteractionTrace,
  options: SemanticScorerOptions = {},
): Promise<RiskEvaluationResult> {
  const findings = [
    ...buildFindings(context, trace),
    ...(await scoreTraceSemantically(context, trace, options)),
  ];
  return buildRiskEvaluationResult(context, trace, dedupeFindings(findings));
}

function buildRiskEvaluationResult(
  context: TestContext,
  trace: InteractionTrace,
  findings: Finding[],
): RiskEvaluationResult {
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

function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    const key = [
      finding.ruleId,
      finding.category,
      finding.evidenceEventIds.join(","),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    existing.description = `${existing.description} ${finding.description}`;
  }
  return [...byKey.values()];
}

function getHighestRiskLevel(findings: Finding[]): RiskLevel {
  return findings.reduce<RiskLevel>(
    (highest, finding) =>
      riskRank[finding.riskLevel] > riskRank[highest] ? finding.riskLevel : highest,
    "low",
  );
}
