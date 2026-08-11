import assert from "node:assert/strict";
import test from "node:test";
import {
  emitNativeToolHookEvent,
  subscribeRealtimeEvents,
} from "./realtimeMcpServer";

test("continues realtime fan-out after an earlier subscriber throws", () => {
  const runtimeSessionId = "agent:main:cli:sync-subscriber-failure";
  const received: string[] = [];
  const unsubscribeFailure = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === runtimeSessionId) {
      throw new Error("sync subscriber failure");
    }
  });
  const unsubscribeHealthy = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === runtimeSessionId) received.push(event.type);
  });

  try {
    emitNativeToolHookEvent({ runtimeSessionId, toolCallId: "call.sync" });
    assert.deepEqual(received, ["native_tool_hook"]);
  } finally {
    unsubscribeFailure();
    unsubscribeHealthy();
  }
});

test("observes rejected realtime subscriber promises without stopping fan-out", async () => {
  const runtimeSessionId = "agent:main:cli:async-subscriber-failure";
  const received: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const unsubscribeFailure = subscribeRealtimeEvents(async (event) => {
    if (event.runtimeSessionId === runtimeSessionId) {
      throw new Error("async subscriber failure");
    }
  });
  const unsubscribeHealthy = subscribeRealtimeEvents((event) => {
    if (event.runtimeSessionId === runtimeSessionId) received.push(event.type);
  });

  try {
    emitNativeToolHookEvent({ runtimeSessionId, toolCallId: "call.async" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["native_tool_hook"]);
    assert.deepEqual(unhandled, []);
  } finally {
    unsubscribeFailure();
    unsubscribeHealthy();
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("isolates replay subscriber failures and continues replaying to others", () => {
  const runtimeSessionId = "agent:main:cli:replay-subscriber-failure";
  emitNativeToolHookEvent({ runtimeSessionId, toolCallId: "call.replay" });
  let unsubscribeFailure: (() => void) | undefined;
  let unsubscribeHealthy: (() => void) | undefined;
  const received: string[] = [];

  try {
    assert.doesNotThrow(() => {
      unsubscribeFailure = subscribeRealtimeEvents((event) => {
        if (event.runtimeSessionId === runtimeSessionId) {
          throw new Error("replay subscriber failure");
        }
      }, { replay: true });
    });
    unsubscribeHealthy = subscribeRealtimeEvents((event) => {
      if (event.runtimeSessionId === runtimeSessionId) received.push(event.type);
    }, { replay: true });
    assert.deepEqual(received, ["native_tool_hook"]);
  } finally {
    unsubscribeFailure?.();
    unsubscribeHealthy?.();
  }
});
