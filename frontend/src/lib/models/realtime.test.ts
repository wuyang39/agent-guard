import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSupervisionEvent } from "../api/types";
import {
  collectObservedMainSessionKeys,
  isCanonicalMainAgentSessionKey,
  shouldDisplayRealtimeEvent,
} from "./realtime";

const baseEvent: LiveSupervisionEvent = {
  timestamp: "2026-06-16T00:00:00.000Z",
  type: "supervision_decision",
};

test("realtime-only mode keeps events for the current runtime session", () => {
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, runtimeSessionId: "runtime.current" },
      "runtime.current",
      false,
    ),
    true,
  );
});

test("realtime-only mode drops events from another runtime session", () => {
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, runtimeSessionId: "runtime.old" },
      "runtime.current",
      false,
    ),
    false,
  );
});

test("history mode keeps events from other runtime sessions", () => {
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, runtimeSessionId: "runtime.old" },
      "runtime.current",
      true,
    ),
    true,
  );
});

test("realtime-only mode keeps canonical main native hooks across synthetic sessions", () => {
  assert.equal(
    shouldDisplayRealtimeEvent(
      {
        ...baseEvent,
        type: "native_tool_hook",
        runtimeSessionId: "agent:main:dashboard:abc",
      },
      "realtime.synthetic",
      false,
    ),
    true,
  );
});

test("canonical main session validation matches the protocol grammar", () => {
  assert.equal(isCanonicalMainAgentSessionKey("agent:main:cli:abc"), true);
  assert.equal(isCanonicalMainAgentSessionKey(`agent:main:${"s".repeat(180)}`), true);

  for (const invalid of [
    undefined,
    "",
    "agent:worker:cli:abc",
    "agent:main:",
    `agent:main:${"s".repeat(181)}`,
    "agent:main:cli\nabc",
    "agent:main:会话",
    "agent:main",
  ]) {
    assert.equal(isCanonicalMainAgentSessionKey(invalid), false, String(invalid));
  }
});

test("realtime-only mode rejects malformed and non-main native hooks", () => {
  for (const runtimeSessionId of ["agent:worker:cli:abc", "agent:main:会话", undefined]) {
    assert.equal(
      shouldDisplayRealtimeEvent(
        { ...baseEvent, type: "native_tool_hook", runtimeSessionId },
        "realtime.synthetic",
        false,
      ),
      false,
    );
  }
});

test("history mode still rejects malformed and non-main native hooks", () => {
  for (const runtimeSessionId of ["agent:worker:cli:abc", "agent:main:会话", undefined]) {
    assert.equal(
      shouldDisplayRealtimeEvent(
        { ...baseEvent, type: "native_tool_hook", runtimeSessionId },
        "realtime.synthetic",
        true,
      ),
      false,
    );
  }
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:cli:abc" },
      "realtime.synthetic",
      true,
    ),
    true,
  );
});

test("observed native session options contain unique canonical main keys only", () => {
  const events: LiveSupervisionEvent[] = [
    { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:cli:abc" },
    { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:worker:cli:abc" },
    { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:cli:abc" },
    { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:channel:def" },
    { ...baseEvent, runtimeSessionId: "agent:main:dashboard:not-native" },
  ];

  assert.deepEqual(collectObservedMainSessionKeys(events), [
    "agent:main:cli:abc",
    "agent:main:channel:def",
  ]);
});

test("a selected main session filters native hooks without changing normal realtime semantics", () => {
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:cli:abc" },
      "realtime.synthetic",
      false,
      "agent:main:channel:def",
    ),
    false,
  );
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:channel:def" },
      "realtime.synthetic",
      false,
      "agent:main:channel:def",
    ),
    true,
  );
  assert.equal(
    shouldDisplayRealtimeEvent(
      { ...baseEvent, runtimeSessionId: "runtime.other" },
      "runtime.current",
      false,
      "agent:main:channel:def",
    ),
    false,
  );
});
