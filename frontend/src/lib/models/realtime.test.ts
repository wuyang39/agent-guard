import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSupervisionEvent } from "../api/types";
import { shouldDisplayRealtimeEvent } from "./realtime";

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
