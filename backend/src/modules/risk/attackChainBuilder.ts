import type { TestContext } from "../config/schemas";
import type { InteractionTrace } from "../monitor/traceTypes";
import type { AttackChain, Finding } from "./riskTypes";

export function buildAttackChains(
  _context: TestContext,
  _trace: InteractionTrace,
  _findings: Finding[],
): AttackChain[] {
  return [];
}
