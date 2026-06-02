import type { TestContext } from "../config/schemas";
import type { TraceEvent } from "../monitor/traceTypes";
import type { JsonObject, JsonValue } from "@agent-guard/contracts";
import { defaultOperatorRegistry, type OperatorRegistry } from "./operatorRegistry";
import type { FieldMatcher, RiskRule } from "./riskTypes";

export function matchesRule(
  rule: RiskRule,
  event: TraceEvent,
  context: TestContext,
  operators: OperatorRegistry = defaultOperatorRegistry,
): boolean {
  if (rule.match.eventTypes && !rule.match.eventTypes.includes(event.type)) {
    return false;
  }

  if (
    rule.match.attackEntryTypes &&
    !rule.match.attackEntryTypes.includes(context.testCase.attackEntryType)
  ) {
    return false;
  }

  if (rule.match.riskTagIds && !hasAnyRiskTag(event, context, rule.match.riskTagIds)) {
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

function hasAnyRiskTag(
  event: TraceEvent,
  context: TestContext,
  expectedRiskTagIds: string[],
): boolean {
  const actualRiskTagIds = getEventRiskTagIds(event, context);
  return expectedRiskTagIds.some((tagId) => actualRiskTagIds.includes(tagId));
}

function getEventRiskTagIds(event: TraceEvent, context: TestContext): string[] {
  const directRiskTagIds = getFieldValue(
    event as unknown as JsonObject,
    "payload.riskTagIds",
  );

  if (Array.isArray(directRiskTagIds)) {
    return directRiskTagIds.filter((value): value is string => typeof value === "string");
  }

  if (event.type === "tool_call" && "toolId" in event.payload) {
    const toolId = event.payload.toolId;
    return (
      context.sandbox.tools
        .find((tool) => tool.toolId === toolId)
        ?.riskTags.map((tag) => tag.tagId) ?? []
    );
  }

  if (event.type === "resource_access" && "resourceId" in event.payload) {
    const resourceId = event.payload.resourceId;
    return (
      context.sandbox.resources
        .find((resource) => resource.resourceId === resourceId)
        ?.riskTags.map((tag) => tag.tagId) ?? []
    );
  }

  if (event.type === "prompt_load" && "promptId" in event.payload) {
    const promptId = event.payload.promptId;
    return (
      context.sandbox.prompts
        .find((prompt) => prompt.promptId === promptId)
        ?.riskTags.map((tag) => tag.tagId) ?? []
    );
  }

  return [];
}
