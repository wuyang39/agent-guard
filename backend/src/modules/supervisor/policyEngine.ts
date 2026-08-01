import type { JsonObject, JsonValue } from "@agent-guard/contracts";
import { RE2JS } from "re2js";
import safeRegex from "safe-regex2";
import type { FieldMatcher } from "../risk/riskTypes";
import type { SupervisionPolicy, SupervisionPolicyPack } from "../policy/policyTypes";
import type { SupervisionRuntimeAction } from "./supervisorTypes";

const MAX_POLICY_REGEX_LENGTH = 256;

export function findMatchingPolicies(
  policyPack: SupervisionPolicyPack,
  action: SupervisionRuntimeAction,
): SupervisionPolicy[] {
  return policyPack.policies.filter(
    (policy) => policy.targetType === action.targetType && matchesPolicy(policy, action),
  );
}

function matchesPolicy(
  policy: SupervisionPolicy,
  action: SupervisionRuntimeAction,
): boolean {
  const matcherResults = (policy.match.matchers ?? []).map((matcher) =>
    matchesField(action as unknown as JsonObject, matcher),
  );

  if (matcherResults.length === 0) {
    return true;
  }

  return policy.match.relation === "all"
    ? matcherResults.every(Boolean)
    : matcherResults.some(Boolean);
}

function matchesField(
  source: JsonObject,
  matcher: FieldMatcher,
): boolean {
  const actual = getFieldValue(source, matcher.fieldPath);
  const expected = matcher.value;

  switch (matcher.operator) {
    case "exists":
      return actual !== undefined;
    case "equals":
      return normalize(actual, matcher) === normalize(expected, matcher);
    case "contains":
      return stringify(actual, matcher).includes(stringify(expected, matcher));
    case "starts_with":
      return stringify(actual, matcher).startsWith(stringify(expected, matcher));
    case "ends_with":
      return stringify(actual, matcher).endsWith(stringify(expected, matcher));
    case "in":
      return Array.isArray(expected) && expected.includes(actual ?? null);
    case "regex":
      return matchesRegex(
        stringify(actual, matcher, false),
        stringifyValue(expected),
        matcher.caseSensitive,
      );
  }
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

function stringify(
  value: JsonValue | undefined,
  matcher: FieldMatcher,
  applyCaseFolding = true,
): string {
  const normalized = normalize(value, matcher, applyCaseFolding);
  return stringifyValue(normalized);
}

function stringifyValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function normalize(
  value: JsonValue | undefined,
  matcher: FieldMatcher,
  applyCaseFolding = true,
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

  if (
    applyCaseFolding &&
    (matcher.caseSensitive === false || matcher.caseSensitive === undefined)
  ) {
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

function matchesRegex(
  actual: string,
  pattern: string,
  caseSensitive: boolean | undefined,
): boolean {
  if (!pattern || pattern.length > MAX_POLICY_REGEX_LENGTH) {
    return false;
  }

  try {
    if (!safeRegex(pattern)) {
      return false;
    }
    const flags = caseSensitive === true ? 0 : RE2JS.CASE_INSENSITIVE;
    return RE2JS.compile(pattern, flags).test(actual.slice(0, 65_536));
  } catch {
    return false;
  }
}
