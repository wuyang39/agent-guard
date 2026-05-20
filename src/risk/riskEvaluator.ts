import type { TestContext } from "../config/schemas";
import type { InteractionTrace } from "../monitor/traceTypes";
import { createId } from "../shared/ids";
import { SCHEMA_VERSION } from "../shared/schemaVersion";
import { nowIso } from "../shared/time";
import { buildAttackChains } from "./attackChainBuilder";
import { buildEvidenceChains } from "./evidenceBuilder";
import type { Finding, RiskEvaluationResult, RiskLevel } from "./riskTypes";

export function evaluateRisk(
  context: TestContext,
  trace: InteractionTrace,
): RiskEvaluationResult {
  const findings: Finding[] = [];
  const riskLevel: RiskLevel = "low";

  return {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: createId("evaluation"),
    contextId: context.contextId,
    caseId: context.caseId,
    traceId: trace.traceId,
    riskLevel,
    findings,
    evidenceChains: buildEvidenceChains(findings),
    attackChains: buildAttackChains(context, trace, findings),
    evaluatedAt: nowIso(),
  };
}
