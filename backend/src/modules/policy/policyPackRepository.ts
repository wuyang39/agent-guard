import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { getReportEntry } from "../../storage/fileReportStore";
import { getRunGroup } from "../../storage/fileRunStore";
import { resolveInsideDirectory } from "../../storage/pathSafety";

const REPORTS_DIR = path.resolve(process.cwd(), "outputs", "reports");
const SCHEMA_VERSIONS = ["mvp-1", "p3-a-1"] as const;
const SUPERVISION_ACTIONS = [
  "allow",
  "deny",
  "ask",
  "warn",
  "redact",
  "isolate",
] as const;
const TARGET_TYPES = [
  "tool_call",
  "resource_access",
  "api_call",
  "file_write",
  "email_send",
  "code_execution",
  "agent_message",
] as const;
const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
const MATCH_RELATIONS = ["all", "any"] as const;
const MATCH_OPERATORS = [
  "exists",
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "in",
  "regex",
] as const;
const NORMALIZATIONS = ["none", "lowercase", "trim", "url_decode"] as const;
const TRACE_EVENT_TYPES = [
  "test_started",
  "task_sent",
  "agent_message",
  "tool_call",
  "tool_result",
  "resource_access",
  "prompt_load",
  "system_error",
] as const;
const ATTACK_ENTRY_TYPES = [
  "malicious_user_prompt",
  "malicious_resource",
  "tool_response_injection",
  "multi_turn_induction",
] as const;

export async function loadStoredOpenClawPolicyPack(
  policyPackId: string,
): Promise<{
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
} | undefined> {
  try {
    const entry = await getReportEntry(policyPackId);
    if (!entry || entry.reportType !== "policy_pack") return undefined;

    const runGroup = await getRunGroup(entry.runGroupId);
    if (!runGroup || runGroup.adapterKind !== "openclaw") return undefined;
    if (
      runGroup.policyContextSource &&
      runGroup.policyContextSource !== "stored_detection"
    ) {
      return undefined;
    }

    const filePath = path.join(
      resolveInsideDirectory(REPORTS_DIR, entry.runGroupId),
      "supervision-policy-pack.json",
    );
    const storedPolicyPack: unknown = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    );
    if (
      !isSupervisionPolicyPack(storedPolicyPack) ||
      storedPolicyPack.policyPackId !== policyPackId
    ) {
      return undefined;
    }

    return {
      policyPack: storedPolicyPack,
      policyPackDigest: digestJson(storedPolicyPack),
      runGroupId: entry.runGroupId,
    };
  } catch {
    return undefined;
  }
}

function isSupervisionPolicyPack(
  value: unknown,
): value is SupervisionPolicyPack {
  return (
    isRecord(value) &&
    isOneOf(value.schemaVersion, SCHEMA_VERSIONS) &&
    isNonEmptyString(value.policyPackId) &&
    isNonEmptyString(value.agentId) &&
    isNonEmptyString(value.sourceDetectionReportId) &&
    isNonEmptyString(value.sourceRiskProfileId) &&
    Array.isArray(value.policies) &&
    value.policies.length > 0 &&
    value.policies.every(isSupervisionPolicy) &&
    isOneOf(value.defaultAction, SUPERVISION_ACTIONS) &&
    typeof value.createdAt === "string" &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string")
  );
}

function isSupervisionPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.policyId) &&
    (value.sourcePolicyTemplateId === undefined ||
      isNonEmptyString(value.sourcePolicyTemplateId)) &&
    isStringArray(value.sourceWeaknessIds) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isOneOf(value.targetType, TARGET_TYPES) &&
    isOneOf(value.action, SUPERVISION_ACTIONS) &&
    isOneOf(value.riskLevel, RISK_LEVELS) &&
    isRuleMatchCondition(value.match) &&
    typeof value.reason === "string"
  );
}

function isRuleMatchCondition(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.relation, MATCH_RELATIONS) &&
    isOptionalEnumArray(value.eventTypes, TRACE_EVENT_TYPES) &&
    isOptionalEnumArray(value.attackEntryTypes, ATTACK_ENTRY_TYPES) &&
    (value.riskTagIds === undefined || isStringArray(value.riskTagIds)) &&
    (value.matchers === undefined ||
      (Array.isArray(value.matchers) && value.matchers.every(isFieldMatcher)))
  );
}

function isFieldMatcher(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.fieldPath) &&
    isOneOf(value.operator, MATCH_OPERATORS) &&
    (!Object.hasOwn(value, "value") || isJsonValue(value.value)) &&
    (value.caseSensitive === undefined || typeof value.caseSensitive === "boolean") &&
    (value.normalize === undefined || isOneOf(value.normalize, NORMALIZATIONS))
  );
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalEnumArray(
  value: unknown,
  allowedValues: readonly string[],
): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((item) => isOneOf(item, allowedValues)))
  );
}

function isOneOf(value: unknown, allowedValues: readonly string[]): boolean {
  return typeof value === "string" && allowedValues.includes(value);
}
