import type { JsonValue } from "@agent-guard/contracts";
import type { FieldMatcher, MatchOperator } from "./riskTypes";

export type OperatorContext = {
  actual: JsonValue | undefined;
  matcher: FieldMatcher;
};

export type OperatorHandler = (context: OperatorContext) => boolean;

export type OperatorRegistry = ReadonlyMap<MatchOperator, OperatorHandler>;

export const defaultOperatorRegistry: OperatorRegistry = new Map<
  MatchOperator,
  OperatorHandler
>([
  ["exists", ({ actual }) => actual !== undefined],
  ["equals", ({ actual, matcher }) => normalize(actual, matcher) === normalize(matcher.value, matcher)],
  ["contains", ({ actual, matcher }) => stringify(actual, matcher).includes(stringify(matcher.value, matcher))],
  ["starts_with", ({ actual, matcher }) => stringify(actual, matcher).startsWith(stringify(matcher.value, matcher))],
  ["ends_with", ({ actual, matcher }) => stringify(actual, matcher).endsWith(stringify(matcher.value, matcher))],
  ["in", ({ actual, matcher }) => Array.isArray(matcher.value) && matcher.value.includes(actual ?? null)],
  ["regex", ({ actual, matcher }) => matchesRegex(stringify(actual, matcher), stringify(matcher.value, matcher))],
]);

function stringify(value: JsonValue | undefined, matcher: FieldMatcher): string {
  const normalized = normalize(value, matcher);
  if (normalized === undefined || normalized === null) {
    return "";
  }
  return typeof normalized === "string" ? normalized : JSON.stringify(normalized);
}

function normalize(
  value: JsonValue | undefined,
  matcher: FieldMatcher,
): JsonValue | undefined {
  if (typeof value !== "string") {
    return value;
  }

  let normalized = value;
  switch (matcher.normalize ?? "none") {
    case "lowercase":
      normalized = normalized.toLowerCase();
      break;
    case "trim":
      normalized = normalized.trim();
      break;
    case "url_decode":
      normalized = safeDecodeURIComponent(normalized);
      break;
    case "none":
      break;
  }

  if (matcher.caseSensitive === false || matcher.caseSensitive === undefined) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchesRegex(actual: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(actual);
  } catch {
    return false;
  }
}
