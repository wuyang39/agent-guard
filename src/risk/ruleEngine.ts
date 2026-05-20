import type { TestContext } from "../config/schemas";
import type { TraceEvent } from "../monitor/traceTypes";
import type { JsonObject, JsonValue } from "../shared/contracts";
import { defaultOperatorRegistry, type OperatorRegistry } from "./operatorRegistry";
import type { FieldMatcher, RiskRule } from "./riskTypes";

export function matchesRule(
  rule: RiskRule,
  event: TraceEvent,
  _context: TestContext,
  operators: OperatorRegistry = defaultOperatorRegistry,
): boolean {
  if (rule.match.eventTypes && !rule.match.eventTypes.includes(event.type)) {
    return false;
  }

  const matcherResults = (rule.match.matchers ?? []).map((matcher) =>
    matchesField(event as unknown as JsonObject, matcher, operators),
  );

  if (matcherResults.length === 0) {
    return true;
  }

  return rule.match.relation === "all"
    ? matcherResults.every(Boolean)
    : matcherResults.some(Boolean);
}

function matchesField(
  event: JsonObject,
  matcher: FieldMatcher,
  operators: OperatorRegistry,
): boolean {
  const handler = operators.get(matcher.operator);
  if (!handler) {
    return false;
  }

  return handler({
    actual: getFieldValue(event, matcher.fieldPath),
    matcher,
  });
}

function getFieldValue(source: JsonObject, fieldPath: string): JsonValue | undefined {
  const segments = fieldPath.split(".");
  let current: JsonValue | undefined = source;

  for (const segment of segments) {
    if (!isJsonObject(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
