import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NativeGuardEvent } from "@agent-guard/contracts";
import { createNativeGuardEventStore } from "../../storage/nativeGuardEventStore";
import { createNativeGuardRealtimeBridge } from "./nativeGuardRealtimeBridge";
import type { emitNativeToolHookEvent } from "./realtimeMcpServer";

test("projects each durable decision and outcome once without raw detail", async () => {
  await withStore(async (store) => {
    const projected: Parameters<typeof emitNativeToolHookEvent>[0][] = [];
    const bridge = createNativeGuardRealtimeBridge({
      eventStore: store,
      emit(input) {
        projected.push(input);
        return {} as ReturnType<typeof emitNativeToolHookEvent>;
      },
    });

    const decision = buildEvent({
      eventId: "event.decision",
      detail: {
        requestId: "request.1",
        action: "deny",
        reasonCode: "policy_deny",
        targetType: "tool_call",
        toolName: "exec",
        paramsDigest: "a".repeat(64),
        credential: "credential-must-not-stream",
        token: "token-must-not-stream",
        params: { command: "secret command" },
        stderr: "secret stderr",
        unrelated: "must-not-stream",
      },
    });
    const outcome = buildEvent({
      eventId: "event.outcome",
      type: "tool_outcome",
      decisionId: "decision.1",
      detail: {
        requestId: "request.1",
        action: "deny",
        outcome: "blocked",
        finalParamsDigest: "b".repeat(64),
        resultDigest: "c".repeat(64),
        durationMs: 5,
        durationSource: "host",
        resultPreview: "preview-must-not-stream",
        error: "error-must-not-stream",
      },
    });

    assert.equal(await store.append(decision), true);
    assert.equal(await store.append(outcome), true);

    assert.deepEqual(projected, [
      {
        runtimeSessionId: "agent:main:cli:session-1",
        toolCallId: "call.1",
        toolName: "exec",
        action: "deny",
        detail: {
          leaseId: "lease.main",
          leaseEpoch: 7,
          phase: "decision",
          decisionId: "decision.1",
          reasonCode: "policy_deny",
          source: "native_guard",
        },
      },
      {
        runtimeSessionId: "agent:main:cli:session-1",
        toolCallId: "call.1",
        action: "deny",
        detail: {
          leaseId: "lease.main",
          leaseEpoch: 7,
          phase: "tool_outcome",
          decisionId: "decision.1",
          outcome: "blocked",
          source: "native_guard",
        },
      },
    ]);
    assert.equal(JSON.stringify(projected).includes("must-not-stream"), false);
    bridge.close();
  });
});

test("projects approval events and ignores non-tool lifecycle events", async () => {
  await withStore(async (store) => {
    const projected: Parameters<typeof emitNativeToolHookEvent>[0][] = [];
    const bridge = createNativeGuardRealtimeBridge({
      eventStore: store,
      emit(input) {
        projected.push(input);
        return {} as ReturnType<typeof emitNativeToolHookEvent>;
      },
    });

    assert.equal(await store.append(buildEvent({
      eventId: "event.approval-requested",
      type: "approval_requested",
      detail: {
        requestId: "request.1",
        approvalId: "approval.1",
        action: "ask",
        status: "pending",
        reasonCode: "approval_required",
      },
    })), true);
    assert.equal(await store.append(buildEvent({
      eventId: "event.approval-resolved",
      type: "approval_resolved",
      detail: {
        requestId: "request.1",
        approvalId: "approval.1",
        action: "allow",
        status: "approved",
        resolvedBy: "user",
      },
    })), true);
    assert.equal(await store.append(buildEvent({
      eventId: "event.coverage",
      type: "coverage_changed",
      toolCallId: undefined,
      decisionId: undefined,
      detail: { coverage: "active" },
    })), true);

    assert.deepEqual(projected.map((event) => event.detail), [
      {
        leaseId: "lease.main",
        leaseEpoch: 7,
        phase: "approval_requested",
        decisionId: "decision.1",
        reasonCode: "approval_required",
        source: "native_guard",
      },
      {
        leaseId: "lease.main",
        leaseEpoch: 7,
        phase: "approval_resolved",
        decisionId: "decision.1",
        source: "native_guard",
      },
    ]);
    bridge.close();
  });
});

test("does not project duplicate appends or events appended after close", async () => {
  await withStore(async (store) => {
    const projected: string[] = [];
    const event = buildEvent({ eventId: "event.once" });
    const bridge = createNativeGuardRealtimeBridge({
      eventStore: store,
      emit(input) {
        projected.push(input.toolCallId ?? "missing");
        return {} as ReturnType<typeof emitNativeToolHookEvent>;
      },
    });

    assert.equal(await store.append(event), true);
    assert.equal(await store.append(event), false);
    bridge.close();
    assert.equal(await store.append(buildEvent({
      eventId: "event.after-close",
      toolCallId: "call.after-close",
    })), true);

    assert.deepEqual(projected, ["call.1"]);
  });
});

test("keeps a durable append readable when realtime emission throws", async () => {
  await withStore(async (store) => {
    const event = buildEvent({ eventId: "event.emit-failure" });
    const bridge = createNativeGuardRealtimeBridge({
      eventStore: store,
      emit() {
        throw new Error("SSE listener failed");
      },
    });

    assert.equal(await store.append(event), true);
    assert.deepEqual(
      (await store.listBySession(event.sessionKey)).map(({ eventId }) => eventId),
      [event.eventId],
    );
    bridge.close();
  });
});

async function withStore(
  run: (store: ReturnType<typeof createNativeGuardEventStore>) => Promise<void>,
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-realtime-bridge-"));
  try {
    await run(createNativeGuardEventStore({ rootDir }));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function buildEvent(overrides: Partial<NativeGuardEvent> = {}): NativeGuardEvent {
  const event: NativeGuardEvent = {
    schemaVersion: "native-guard-1",
    eventId: "event.1",
    type: "decision",
    leaseId: "lease.main",
    leaseEpoch: 7,
    sessionKey: "agent:main:cli:session-1",
    runId: "run.main",
    toolCallId: "call.1",
    decisionId: "decision.1",
    timestamp: "2026-08-10T00:00:00.000Z",
    detail: {
      requestId: "request.1",
      action: "deny",
      reasonCode: "policy_deny",
      targetType: "tool_call",
      toolName: "exec",
      paramsDigest: "a".repeat(64),
    },
    ...overrides,
  };
  if (event.runId === undefined) delete event.runId;
  if (event.toolCallId === undefined) delete event.toolCallId;
  if (event.decisionId === undefined) delete event.decisionId;
  return event;
}
