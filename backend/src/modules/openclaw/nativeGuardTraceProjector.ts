/**
 * nativeGuardTraceProjector — 从真实 Hook 决策/outcome 投影正式 Trace 事件
 *
 * Task 12 核心模块。正式 Trace 的 tool_call、tool_result、system_error
 * 仅从 NativeGuardEventStore 的真实 Hook 事件投影；JSONL 仅保留交叉校验。
 *
 * 非 Hook 事件（task_sent、agent_message 等）由现有 bridge/recorder 继续生成。
 */

import { createId } from "../../shared/ids";
import type { TraceEvent, ToolCallPayload, ToolResultPayload, SystemErrorPayload, JsonObject } from "@agent-guard/contracts";
import type { NativeGuardEvent } from "@agent-guard/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProjectedTraceContext = {
  traceId: string;
  runId: string;
  caseId: string;
  sandboxId: string;
};

export type ReconciliationIssue = {
  toolCallId: string;
  reason: string;
  kind: "coverage_breach" | "mismatch" | "duplicate_outcome";
};

export type ReconciliationResult = {
  reconciled: boolean;
  coverageBreachCount: number;
  mismatchCount: number;
  issues: ReconciliationIssue[];
  projected: { tool_call: number; tool_result: number; system_error: number };
};

/** Formal Trace projection decomposed for testing per scenario. */
export type ProjectedTraceSegment = {
  events: Omit<TraceEvent, "sequence" | "timestamp">[];
  reconciliation: ReconciliationResult;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function projectNativeGuardTrace(
  context: ProjectedTraceContext,
  nativeGuardEvents: NativeGuardEvent[],
  jsonlToolCallIds: string[],
): ProjectedTraceSegment {
  const events: Omit<TraceEvent, "sequence" | "timestamp">[] = [];
  const seenCallIds = new Set<string>();
  const outcomeByCallId = new Map<string, NativeGuardEvent[]>();
  const issues: ReconciliationIssue[] = [];

  // ---- Index Hook events ----
  const decisions = nativeGuardEvents.filter((e) => e.type === "decision");
  const outcomes = nativeGuardEvents.filter((e) => e.type === "tool_outcome");

  for (const outcome of outcomes) {
    const callId = outcome.toolCallId;
    if (!callId) continue;
    const list = outcomeByCallId.get(callId) ?? [];
    list.push(outcome);
    outcomeByCallId.set(callId, list);
  }

  // ---- Duplicate outcome detection ----
  for (const [callId, list] of outcomeByCallId) {
    if (list.length > 1) {
      issues.push({
        toolCallId: callId,
        reason: `Duplicate outcome events (${String(list.length)}) for the same tool call.`,
        kind: "duplicate_outcome",
      });
    }
  }

  // ---- Project tool_call from decision events ----
  for (const decision of decisions) {
    const detail = decision.detail;
    const callId = typeof detail.toolCallId === "string" && detail.toolCallId
      ? detail.toolCallId
      : decision.toolCallId ?? decision.eventId;

    seenCallIds.add(callId);

    const toolName = typeof detail.toolName === "string" ? detail.toolName : "unknown";
    const action = typeof detail.action === "string" ? detail.action : "allow";

    events.push({
      eventId: createId("evt"),
      traceId: context.traceId,
      runId: context.runId,
      caseId: context.caseId,
      type: "tool_call",
      actor: "agent",
      payload: {
        callId,
        toolId: toolName,
        toolName,
        parameters: (typeof detail.rewrittenParams === "object" && detail.rewrittenParams !== null
          ? detail.rewrittenParams
          : typeof detail.params === "object" && detail.params !== null
            ? detail.params
            : {}) as unknown as JsonObject,
        isHighRiskTool: action === "deny" || action === "ask",
      } satisfies ToolCallPayload,
    });
  }

  // ---- Project tool_result from outcome events ----
  for (const outcome of outcomes) {
    const detail = outcome.detail;
    const callId = outcome.toolCallId ?? outcome.eventId;

    const isError = typeof detail.error === "string" && detail.error.length > 0;
    const resultPreview = typeof detail.resultPreview === "string" ? detail.resultPreview : "";

    events.push({
      eventId: createId("evt"),
      traceId: context.traceId,
      runId: context.runId,
      caseId: context.caseId,
      type: "tool_result",
      actor: "mcp_server",
      payload: {
        callId,
        toolId: typeof detail.toolName === "string" ? detail.toolName : "unknown",
        result: isError ? { error: String(detail.error) } as unknown as JsonObject : String(resultPreview),
        containsInjection: false,
        riskTagIds: [],
      } satisfies ToolResultPayload,
    });

    // If the result is an error and there's no corresponding decision, flag it as system_error
    if (isError && !seenCallIds.has(callId)) {
      const sysDetail: JsonObject = { callId };
      const toolNameValue = typeof detail.toolName === "string" ? detail.toolName : undefined;
      if (toolNameValue !== undefined) (sysDetail as Record<string, unknown>).toolName = toolNameValue;

      events.push({
        eventId: createId("evt"),
        traceId: context.traceId,
        runId: context.runId,
        caseId: context.caseId,
        type: "system_error",
        actor: "system",
        payload: {
          code: "TOOL_OUTCOME_ERROR",
          message: typeof detail.error === "string" ? detail.error : "Tool outcome reported an error.",
          detail: sysDetail,
        } satisfies SystemErrorPayload,
      });
    }
  }

  // ---- Coverage breach: JSONL has call but Hook has no corresponding before event ----
  for (const jsonlCallId of jsonlToolCallIds) {
    if (!seenCallIds.has(jsonlCallId)) {
      issues.push({
        toolCallId: jsonlCallId,
        reason: "JSONL has tool call but no corresponding Hook before event.",
        kind: "coverage_breach",
      });
    }
  }

  const coverageBreachCount = issues.filter((i) => i.kind === "coverage_breach").length;
  const mismatchCount = issues.filter((i) => i.kind !== "coverage_breach").length;

  return {
    events,
    reconciliation: {
      reconciled: issues.length === 0,
      coverageBreachCount,
      mismatchCount,
      issues,
      projected: {
        tool_call: events.filter((e) => e.type === "tool_call").length,
        tool_result: events.filter((e) => e.type === "tool_result").length,
        system_error: events.filter((e) => e.type === "system_error").length,
      },
    },
  };
}

/**
 * Finalize projected events into full TraceEvent objects with sequence numbers
 * and timestamps, suitable for insertion into an InteractionTrace.
 */
export function finalizeProjectedTrace(
  segment: ProjectedTraceSegment,
  context: ProjectedTraceContext,
  startedAt: string,
): TraceEvent[] {
  const now = startedAt;
  return segment.events.map((event, index) => ({
    ...event,
    timestamp: now,
    sequence: index + 1,
    traceId: context.traceId,
    runId: context.runId,
    caseId: context.caseId,
  }));
}
