import assert from "node:assert/strict";
import test from "node:test";
import {
  projectNativeGuardTrace,
  finalizeProjectedTrace,
} from "./nativeGuardTraceProjector";
import type { NativeGuardEvent } from "@agent-guard/contracts";

const CTX = { traceId: "trace.1", runId: "run.1", caseId: "case.1", sandboxId: "sandbox.1" };

function buildEvent(overrides: Partial<NativeGuardEvent> = {}): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId: "event.1",
    type: "decision",
    leaseId: "lease.1",
    leaseEpoch: 1,
    sessionKey: "session.1",
    runId: "run.1",
    toolCallId: "call.1",
    decisionId: "decision.1",
    timestamp: "2026-08-01T00:00:01.000Z",
    detail: {
      action: "allow",
      reasonCode: "policy_allow",
      toolName: "read",
      toolCallId: "call.1",
      params: { path: "/tmp/test" },
    },
    ...overrides,
  };
}

function buildDecisionSourcePair(input: {
  decisionId: string;
  requestId: string;
  toolCallId: string;
  action: "allow" | "deny";
  toolName: string;
  paramsDigest: string;
  params?: Record<string, unknown>;
}): [NativeGuardEvent, NativeGuardEvent] {
  const commonDetail = {
    reasonCode: input.action === "allow" ? "policy_allow" : "policy_deny",
    requestId: input.requestId,
    action: input.action,
    toolName: input.toolName,
    paramsDigest: input.paramsDigest,
  };
  const backendDecision = buildEvent({
    eventId: `pdp.${input.decisionId}`,
    toolCallId: input.toolCallId,
    decisionId: input.decisionId,
    timestamp: "2026-08-01T00:00:01.000Z",
    detail: {
      ...commonDetail,
      policyId: `policy.${input.action}`,
      targetType: input.action === "deny" ? "code_execution" : "tool_call",
      riskTags: input.action === "deny" ? ["code_execution"] : [],
      ...(input.params ? { params: input.params } : {}),
    },
  });
  const pluginDecision = buildEvent({
    eventId: `plugin.${input.decisionId}`,
    toolCallId: input.toolCallId,
    decisionId: input.decisionId,
    timestamp: "2026-08-01T00:00:01.010Z",
    detail: {
      ...commonDetail,
      targetType: "tool_call",
    },
  });
  return [backendDecision, pluginDecision];
}

// ---------------------------------------------------------------------------
// Reconciliation scenarios
// ---------------------------------------------------------------------------

test("dual-source PDP and plugin events for one decision project one tool call", () => {
  const [backendDecision, pluginDecision] = buildDecisionSourcePair({
    decisionId: "decision.dual",
    requestId: "request.dual",
    toolCallId: "call.dual",
    action: "allow",
    toolName: "read",
    paramsDigest: "a".repeat(64),
    params: { path: "/workspace/README.md" },
  });

  const result = projectNativeGuardTrace(
    CTX,
    [backendDecision, pluginDecision],
    ["call.dual"],
  );

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.mismatchCount, 0);
  assert.equal(result.reconciliation.projected.tool_call, 1);
  assert.deepEqual(
    (result.events[0].payload as { parameters: Record<string, unknown> }).parameters,
    { path: "/workspace/README.md" },
  );
});

test("two tool calls with PDP and plugin evidence each project two tool calls", () => {
  const readPair = buildDecisionSourcePair({
    decisionId: "decision.read",
    requestId: "request.read",
    toolCallId: "call.read",
    action: "allow",
    toolName: "read",
    paramsDigest: "a".repeat(64),
  });
  const execPair = buildDecisionSourcePair({
    decisionId: "decision.exec",
    requestId: "request.exec",
    toolCallId: "call.exec",
    action: "deny",
    toolName: "exec",
    paramsDigest: "b".repeat(64),
  });

  const result = projectNativeGuardTrace(
    CTX,
    [...readPair, ...execPair],
    ["call.read", "call.exec"],
  );

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.mismatchCount, 0);
  assert.equal(result.reconciliation.projected.tool_call, 2);
});

test("same decisionId with conflicting tool-call identity is a mismatch", async (t) => {
  const [first] = buildDecisionSourcePair({
    decisionId: "decision.conflict",
    requestId: "request.first",
    toolCallId: "call.first",
    action: "allow",
    toolName: "read",
    paramsDigest: "a".repeat(64),
  });
  const cases: Array<{
    name: string;
    event: NativeGuardEvent;
    jsonlCallIds: string[];
  }> = [
    {
      name: "requestId",
      event: { ...structuredClone(first), eventId: "conflict.request", detail: { ...first.detail, requestId: "request.other" } },
      jsonlCallIds: ["call.first"],
    },
    {
      name: "toolCallId",
      event: { ...structuredClone(first), eventId: "conflict.call", toolCallId: "call.other", detail: { ...first.detail } },
      jsonlCallIds: ["call.first", "call.other"],
    },
    {
      name: "action",
      event: { ...structuredClone(first), eventId: "conflict.action", detail: { ...first.detail, action: "deny" } },
      jsonlCallIds: ["call.first"],
    },
    {
      name: "toolName",
      event: { ...structuredClone(first), eventId: "conflict.tool", detail: { ...first.detail, toolName: "exec" } },
      jsonlCallIds: ["call.first"],
    },
    {
      name: "paramsDigest",
      event: { ...structuredClone(first), eventId: "conflict.params", detail: { ...first.detail, paramsDigest: "f".repeat(64) } },
      jsonlCallIds: ["call.first"],
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const result = projectNativeGuardTrace(CTX, [first, fixture.event], fixture.jsonlCallIds);

      assert.equal(result.reconciliation.reconciled, false);
      assert.equal(result.reconciliation.mismatchCount, 1);
      assert.equal(result.reconciliation.coverageBreachCount, 0);
      assert.ok(result.reconciliation.issues.every((issue) =>
        issue.kind !== "coverage_breach"
      ));
      assert.equal(result.reconciliation.projected.tool_call, 1);
      assert.ok(result.reconciliation.issues.some((issue) =>
        issue.kind === "duplicate_decision"
      ));
      assert.equal((result.events[0].payload as { callId: string }).callId, "call.first");
    });
  }
});

test("same tool call with different decisionIds is a mismatch and retains the first", () => {
  const [first] = buildDecisionSourcePair({
    decisionId: "decision.first",
    requestId: "request.shared",
    toolCallId: "call.shared",
    action: "allow",
    toolName: "read",
    paramsDigest: "a".repeat(64),
  });
  const second = {
    ...structuredClone(first),
    eventId: "pdp.decision.second",
    decisionId: "decision.second",
  };

  const result = projectNativeGuardTrace(CTX, [first, second], ["call.shared"]);

  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.mismatchCount, 1);
  assert.equal(result.reconciliation.projected.tool_call, 1);
  assert.ok(result.reconciliation.issues.some((issue) =>
    issue.kind === "duplicate_decision" && issue.toolCallId === "call.shared"
  ));
});

test("allow+outcome: projects tool_call and tool_result, reconciled clean", () => {
  const decision = buildEvent({
    eventId: "decision.allow",
    type: "decision",
    toolCallId: "call.1",
    detail: { action: "allow", reasonCode: "policy_allow", toolName: "read", toolCallId: "call.1", params: { path: "/tmp/test" } },
  });
  const outcome = buildEvent({
    eventId: "outcome.1",
    type: "tool_outcome",
    toolCallId: "call.1",
    decisionId: undefined,
    detail: {
      finalParamsDigest: "a".repeat(64),
      durationMs: 100,
      durationSource: "host",
      resultDigest: "b".repeat(64),
      resultPreview: "file content",
      toolName: "read",
    },
  });

  const result = projectNativeGuardTrace(CTX, [decision, outcome], ["call.1"]);

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.coverageBreachCount, 0);
  assert.equal(result.reconciliation.projected.tool_call, 1);
  assert.equal(result.reconciliation.projected.tool_result, 1);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].type, "tool_call");
  assert.equal((result.events[0].payload as { callId: string }).callId, "call.1");
  assert.equal(result.events[1].type, "tool_result");
});

test("deny: projects tool_call without tool_result, reconciled clean", () => {
  const decision = buildEvent({
    eventId: "decision.deny",
    type: "decision",
    toolCallId: "call.denied",
    detail: { action: "deny", reasonCode: "policy_deny", toolName: "exec", toolCallId: "call.denied", params: { command: "rm -rf /" } },
  });

  const result = projectNativeGuardTrace(CTX, [decision], ["call.denied"]);

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.projected.tool_call, 1);
  assert.equal(result.reconciliation.projected.tool_result, 0);
  const payload = result.events[0].payload as { isHighRiskTool: boolean };
  assert.equal(payload.isHighRiskTool, true);
});

test("coverage breach: JSONL has call but Hook has no before event", () => {
  const decision = buildEvent({
    eventId: "decision.other",
    toolCallId: "call.other",
    detail: { action: "allow", reasonCode: "policy_allow", toolName: "read", toolCallId: "call.other", params: {} },
  });

  const result = projectNativeGuardTrace(CTX, [decision], ["call.other", "call.missing"]);

  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.coverageBreachCount, 1);
  assert.ok(result.reconciliation.issues.some((issue) =>
    issue.kind === "coverage_breach" && issue.toolCallId === "call.missing"
  ));
});

test("duplicate outcome: flags mismatch but still projects both", () => {
  const decision = buildEvent({
    eventId: "decision.dup",
    type: "decision",
    toolCallId: "call.dup",
    detail: { action: "allow", reasonCode: "policy_allow", toolName: "read", toolCallId: "call.dup", params: {} },
  });
  const outcome1 = buildEvent({
    eventId: "outcome.dup.1",
    type: "tool_outcome",
    toolCallId: "call.dup",
    decisionId: undefined,
    detail: { finalParamsDigest: "a".repeat(64), durationMs: 100, durationSource: "host", resultDigest: "b".repeat(64), resultPreview: "ok" },
  });
  const outcome2 = buildEvent({
    eventId: "outcome.dup.2",
    type: "tool_outcome",
    toolCallId: "call.dup",
    decisionId: undefined,
    detail: { finalParamsDigest: "c".repeat(64), durationMs: 200, durationSource: "host", resultDigest: "d".repeat(64), resultPreview: "also ok" },
  });

  const result = projectNativeGuardTrace(CTX, [decision, outcome1, outcome2], ["call.dup"]);

  assert.equal(result.reconciliation.reconciled, false);
  assert.ok(result.reconciliation.issues.some((issue) =>
    issue.kind === "duplicate_outcome" && issue.toolCallId === "call.dup"
  ));
  // Still projects both outcomes.
  assert.equal(result.reconciliation.projected.tool_result, 2);
});

test("OFF: zero hook events, no coverage breach for empty JSONL", () => {
  const result = projectNativeGuardTrace(CTX, [], []);

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.coverageBreachCount, 0);
  assert.deepEqual(result.events, []);
});

test("OFF: zero hook events, JSONL has calls → coverage breach", () => {
  const result = projectNativeGuardTrace(CTX, [], ["call.orphan"]);

  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.coverageBreachCount, 1);
  assert.ok(result.reconciliation.issues.some((issue) =>
    issue.kind === "coverage_breach" && issue.toolCallId === "call.orphan"
  ));
});

test("system_error: error outcome without prior decision projects system_error", () => {
  const outcome = buildEvent({
    eventId: "outcome.error",
    type: "tool_outcome",
    toolCallId: "call.error",
    decisionId: undefined,
    detail: {
      finalParamsDigest: "a".repeat(64),
      error: "command not found",
      durationSource: "unavailable",
      resultDigest: "b".repeat(64),
      toolName: "exec",
    },
  });

  const result = projectNativeGuardTrace(CTX, [outcome], ["call.error"]);

  assert.equal(result.reconciliation.projected.system_error, 1);
  assert.equal(result.reconciliation.coverageBreachCount, 1); // No decision event for this call
  const sysError = result.events.find((e) => e.type === "system_error");
  assert.ok(sysError);
  assert.equal((sysError.payload as { code: string }).code, "TOOL_OUTCOME_ERROR");
});

test("mixed: multiple calls reconciled correctly", () => {
  const decision1 = buildEvent({ eventId: "d1", decisionId: "decision.c1", toolCallId: "c1", detail: { action: "allow", reasonCode: "ok", toolName: "read", toolCallId: "c1", params: {} } });
  const outcome1 = buildEvent({ eventId: "o1", type: "tool_outcome", toolCallId: "c1", decisionId: undefined, detail: { finalParamsDigest: "a".repeat(64), durationMs: 1, durationSource: "host", resultDigest: "b".repeat(64), resultPreview: "ok" } });
  const decision2 = buildEvent({ eventId: "d2", decisionId: "decision.c2", toolCallId: "c2", detail: { action: "deny", reasonCode: "blocked", toolName: "exec", toolCallId: "c2", params: {} } });

  const result = projectNativeGuardTrace(CTX, [decision1, outcome1, decision2], ["c1", "c2"]);

  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.projected.tool_call, 2);
  assert.equal(result.reconciliation.projected.tool_result, 1);
  assert.equal(result.events.length, 3);
});

test("cancel: no outcome for a cancelled tool call", () => {
  const decision = buildEvent({
    eventId: "decision.cancel",
    type: "decision",
    toolCallId: "call.cancel",
    detail: { action: "deny", reasonCode: "cancelled", toolName: "exec", toolCallId: "call.cancel", params: {} },
  });

  const result = projectNativeGuardTrace(CTX, [decision], ["call.cancel"]);

  // Denied call counted as reconciled when JSONL also has it.
  assert.equal(result.reconciliation.reconciled, true);
  assert.equal(result.reconciliation.projected.tool_call, 1);
  assert.equal(result.reconciliation.projected.tool_result, 0);
});

test("multiple missing calls: each JSONL call without Hook is a breach", () => {
  // Zero Hook events, three JSONL calls → 3 coverage breaches.
  const result = projectNativeGuardTrace(CTX, [], ["c1", "c2", "c3"]);
  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.coverageBreachCount, 3);
});

test("partial breach: some calls have Hook, some do not", () => {
  const decision = buildEvent({ eventId: "d1", toolCallId: "c1", detail: { action: "allow", reasonCode: "ok", toolName: "read", toolCallId: "c1", params: {} } });
  // Two JSONL calls: c1 has Hook, c2 does not → 1 breach.
  const result = projectNativeGuardTrace(CTX, [decision], ["c1", "c2"]);
  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.coverageBreachCount, 1);
  assert.equal(result.reconciliation.projected.tool_call, 1);
});

test("mismatch without coverage breach: duplicate outcome only", () => {
  const decision = buildEvent({ eventId: "d1", toolCallId: "call.dup", detail: { action: "allow", reasonCode: "ok", toolName: "read", toolCallId: "call.dup", params: {} } });
  const o1 = buildEvent({ eventId: "o1", type: "tool_outcome", toolCallId: "call.dup", decisionId: undefined, detail: { finalParamsDigest: "a".repeat(64), durationMs: 1, durationSource: "host", resultDigest: "b".repeat(64), resultPreview: "ok" } });
  const o2 = buildEvent({ eventId: "o2", type: "tool_outcome", toolCallId: "call.dup", decisionId: undefined, detail: { finalParamsDigest: "c".repeat(64), durationMs: 2, durationSource: "host", resultDigest: "d".repeat(64), resultPreview: "also ok" } });
  // Duplicate outcome is a mismatch but no coverage breach (call is seen).
  const result = projectNativeGuardTrace(CTX, [decision, o1, o2], ["call.dup"]);
  assert.equal(result.reconciliation.reconciled, false);
  assert.equal(result.reconciliation.coverageBreachCount, 0); // mismatch ≠ breach
});

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

test("finalizeProjectedTrace assigns sequence and timestamps", () => {
  const segment = projectNativeGuardTrace(
    CTX,
    [buildEvent({ eventId: "d1", toolCallId: "c1", detail: { action: "allow", reasonCode: "ok", toolName: "read", toolCallId: "c1", params: {} } })],
    ["c1"],
  );
  const startedAt = "2026-08-01T00:00:00.000Z";
  const events = finalizeProjectedTrace(segment, CTX, startedAt);

  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].timestamp, startedAt);
  assert.equal(events[0].traceId, CTX.traceId);
  assert.equal(events[0].runId, CTX.runId);
  assert.equal(events[0].caseId, CTX.caseId);
});
