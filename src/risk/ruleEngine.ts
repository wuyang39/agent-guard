import type { TestContext } from "../config/schemas";
import type { TraceEvent } from "../monitor/traceTypes";
import type { RiskRule } from "./riskTypes";

export function matchesRule(
  _rule: RiskRule,
  _event: TraceEvent,
  _context: TestContext,
): boolean {
  return false;
}
