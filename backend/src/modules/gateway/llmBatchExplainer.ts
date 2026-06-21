import type {
  JsonObject,
  JsonValue,
  LlmProfileMetadata,
  SupervisionBatchCaseExplanation,
  SupervisionBatchExplanationDraft,
  SupervisionBatchResult,
} from "@agent-guard/contracts";
import { createId, nowIso } from "../../shared";
import type { LlmClient } from "../llm/llmClient";

export type BuildBatchExplanationOptions = {
  llmClient?: LlmClient;
  timeoutMs?: number;
};

const PROMPT_VERSION = "p3-b-batch-explanation-v1";

export async function buildSupervisionBatchExplanationDraft(
  batch: SupervisionBatchResult,
  opts: BuildBatchExplanationOptions = {},
): Promise<SupervisionBatchExplanationDraft> {
  const base = buildDeterministicDraft(batch);
  if (!opts.llmClient) return base;

  try {
    const response = await opts.llmClient.completeJson({
      system: [
        "You explain runtime supervision batch results for an Agent Guard gateway.",
        "Do not create final report claims.",
        "Do not change counts, actions, record IDs, or decisions.",
        "Return JSON with summary, keyFindings, and limitations only.",
      ].join(" "),
      user: JSON.stringify({
        batchId: batch.batchId,
        runtimeSessionId: batch.runtimeSessionId,
        policyPackId: batch.policyPackId,
        source: batch.source,
        counts: {
          externalCaseCount: batch.externalCaseCount,
          supervisedToolCallCount: batch.supervisedToolCallCount,
          policyHitCount: batch.policyHitCount,
          guardrailHitCount: batch.guardrailHitCount,
          blockedCount: batch.blockedCount,
          askCount: batch.askCount,
          warnedCount: batch.warnedCount,
          redactedCount: batch.redactedCount,
          allowedCount: batch.allowedCount,
        },
        cases: batch.cases.map((item) => ({
          externalCaseId: item.externalCaseId,
          toolName: item.toolName,
          status: item.status,
          blocked: item.blocked,
          actionCounts: item.actionCounts,
          providerId: item.gateway?.providerId,
          decisionSource: item.gateway?.decisionSource,
          recordCount: item.recordIds.length,
          error: item.error,
        })),
      }),
      responseSchemaName: "SupervisionBatchExplanationDraft",
      timeoutMs: opts.timeoutMs,
    });
    const patch = sanitizeExplanationPatch(response.json);
    return {
      ...base,
      summary: patch.summary ?? base.summary,
      keyFindings: patch.keyFindings ?? base.keyFindings,
      limitations: patch.limitations ?? base.limitations,
      llmAssisted: true,
      llmMetadata: {
        provider: response.provider,
        model: response.model,
        promptVersion: PROMPT_VERSION,
        rationale: patch.rationale,
        generatedAt: nowIso(),
      } satisfies LlmProfileMetadata,
    };
  } catch {
    return base;
  }
}

function buildDeterministicDraft(
  batch: SupervisionBatchResult,
): SupervisionBatchExplanationDraft {
  return {
    schemaVersion: "mvp-1",
    explanationId: createId("batch_explanation"),
    batchId: batch.batchId,
    runtimeSessionId: batch.runtimeSessionId,
    policyPackId: batch.policyPackId,
    source: batch.source,
    summary:
      `Batch ${batch.batchId} supervised ${batch.supervisedToolCallCount}/${batch.externalCaseCount} external cases with ` +
      `${batch.policyHitCount} policy hits and ${batch.guardrailHitCount} platform guardrail hits.`,
    keyFindings: buildKeyFindings(batch),
    caseExplanations: batch.cases.map(explainCase),
    limitations: [
      "This is a B-line runtime explanation draft, not a final DefenseReport claim.",
      "The draft summarizes observed runtime supervision records and does not generate or modify policies.",
    ],
    llmAssisted: false,
    generatedAt: nowIso(),
  };
}

function buildKeyFindings(batch: SupervisionBatchResult): string[] {
  const findings = [
    `${batch.recordIds.length} runtime supervision records are linked to this batch.`,
  ];
  if (batch.blockedCount > 0) {
    findings.push(`${batch.blockedCount} actions were denied or blocked.`);
  }
  if (batch.askCount > 0) {
    findings.push(`${batch.askCount} actions required ask-mode supervision.`);
  }
  if (batch.redactedCount > 0) {
    findings.push(`${batch.redactedCount} actions triggered redaction.`);
  }
  if (batch.guardrailHitCount > 0) {
    findings.push(`${batch.guardrailHitCount} records came from platform guardrails, not C-line policy hits.`);
  }
  if (batch.cases.some((item) => item.status === "failed")) {
    findings.push("At least one downstream tool failed after supervision; linked records are preserved.");
  }
  return findings;
}

function explainCase(item: SupervisionBatchResult["cases"][number]): SupervisionBatchCaseExplanation {
  const outcome = classifyOutcome(item);
  return {
    externalCaseId: item.externalCaseId,
    toolName: item.toolName,
    outcome,
    explanation: explanationForOutcome(item, outcome),
    recordIds: item.recordIds,
  };
}

function classifyOutcome(
  item: SupervisionBatchResult["cases"][number],
): SupervisionBatchCaseExplanation["outcome"] {
  if (item.status === "failed") return "downstream_failed";
  if (item.gateway?.decisionSource === "platform_guardrail") {
    return "platform_guardrail_blocked";
  }
  if ((item.actionCounts.deny ?? 0) > 0 || item.blocked) return "policy_blocked";
  if (
    (item.actionCounts.ask ?? 0) > 0 ||
    (item.actionCounts.redact ?? 0) > 0 ||
    (item.actionCounts.warn ?? 0) > 0
  ) {
    return "policy_supervised";
  }
  return "executed";
}

function explanationForOutcome(
  item: SupervisionBatchResult["cases"][number],
  outcome: SupervisionBatchCaseExplanation["outcome"],
): string {
  switch (outcome) {
    case "platform_guardrail_blocked":
      return `External case ${item.externalCaseId} used an unknown or unregistered tool and was blocked by the Gateway platform guardrail.`;
    case "policy_blocked":
      return `External case ${item.externalCaseId} matched a deny policy and did not proceed to normal downstream execution.`;
    case "policy_supervised":
      return `External case ${item.externalCaseId} matched runtime supervision policy actions such as ask, warn, or redact.`;
    case "downstream_failed":
      return `External case ${item.externalCaseId} reached downstream execution after supervision, but the downstream provider returned an error.`;
    case "executed":
      return `External case ${item.externalCaseId} completed without a blocking supervision action.`;
  }
}

function sanitizeExplanationPatch(input: JsonObject): {
  summary?: string;
  keyFindings?: string[];
  limitations?: string[];
  rationale?: string;
} {
  return {
    summary: typeof input.summary === "string" ? input.summary.slice(0, 600) : undefined,
    keyFindings: filterStringArray(input.keyFindings, 12, 240),
    limitations: filterStringArray(input.limitations, 8, 240),
    rationale: typeof input.rationale === "string" ? input.rationale.slice(0, 500) : undefined,
  };
}

function filterStringArray(
  value: JsonValue | undefined,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.slice(0, maxLength))
    .slice(0, maxItems);
  return result.length > 0 ? [...new Set(result)] : undefined;
}
