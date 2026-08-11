import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveSupervisionEvent } from "../api/types";
import {
  addObservedMainSessionKey,
  collectObservedMainSessionKeys,
  createLatestOperationGate,
  createRealtimeStreamController,
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
    "agent:main:cli:..:spoof",
    "agent:ma..in:cli:spoof",
    "agent:main",
  ]) {
    assert.equal(isCanonicalMainAgentSessionKey(invalid), false, String(invalid));
  }
});

test("realtime-only mode rejects malformed and non-main native hooks", () => {
  for (const runtimeSessionId of [
    "agent:worker:cli:abc",
    "agent:main:会话",
    "agent:main:cli:..:spoof",
    undefined,
  ]) {
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
  for (const runtimeSessionId of [
    "agent:worker:cli:abc",
    "agent:main:会话",
    "agent:main:cli:..:spoof",
    undefined,
  ]) {
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
    { ...baseEvent, type: "native_tool_hook", runtimeSessionId: "agent:main:cli:..:spoof" },
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

test("observed main session reducer keeps replayed keys unique without storing events", async () => {
  const event = {
    ...baseEvent,
    type: "native_tool_hook",
    runtimeSessionId: "agent:main:dashboard:replayed",
  } satisfies LiveSupervisionEvent;
  const first = addObservedMainSessionKey([], event);
  const replayed = addObservedMainSessionKey(first, event);
  const reopenedHistory = addObservedMainSessionKey(replayed, event);
  const spoofed = addObservedMainSessionKey(reopenedHistory, {
    ...event,
    runtimeSessionId: "agent:main:dashboard:..:spoof",
  });

  assert.deepEqual(first, ["agent:main:dashboard:replayed"]);
  assert.equal(replayed.length, 1);
  assert.equal(reopenedHistory.length, 1);
  assert.equal(spoofed.length, 1);
});

test("latest operation gate prevents an older GET from overwriting a newer POST", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const applied: string[] = [];
  let resolveGet: (() => void) | undefined;
  let resolvePost: (() => void) | undefined;

  const getOperation = gate.begin();
  const getResult = new Promise<void>((resolve) => {
    resolveGet = resolve;
  }).then(() => {
    if (getOperation.isCurrent()) applied.push("GET");
  });
  const postOperation = gate.begin();
  const postResult = new Promise<void>((resolve) => {
    resolvePost = resolve;
  }).then(() => {
    if (postOperation.isCurrent()) applied.push("POST");
  });

  resolvePost?.();
  await postResult;
  resolveGet?.();
  await getResult;
  assert.deepEqual(applied, ["POST"]);
});

test("stream controller closes the main source when ask construction fails", async () => {
  const { create, sources } = await createFakeStreamController({ throwOnCreate: 2 });
  const controller = create();

  assert.throws(
    () => controller.open(streamOpenOptions()),
    /ask construction failed/,
  );
  assert.equal(sources[0]?.closeCount, 1);
  assert.equal(controller.isOpen(), false);
});

test("stream controller credentials only the main native supervision source", async () => {
  const calls: Array<{ url: string; init?: { withCredentials?: boolean } }> = [];
  const controller = createRealtimeStreamController({
    eventTypes: [],
    createEventSource(url, init) {
      calls.push({ url, init });
      return new FakeEventSource();
    },
    onEvent() {},
    onAskConfig() {},
    onAskDecision() {},
    onAskResolved() {},
    onError() {},
    onStreamingChange() {},
  });

  controller.open(streamOpenOptions());

  assert.deepEqual(calls, [
    { url: "http://main.test/events", init: { withCredentials: true } },
    { url: "http://main.test/asks", init: undefined },
  ]);
  controller.close();
});

test("stream controller closes both sources on main and ask errors", async () => {
  for (const failingSourceIndex of [0, 1]) {
    const errors: string[] = [];
    const { create, sources } = await createFakeStreamController({ errors });
    const controller = create();
    controller.open(streamOpenOptions());

    sources[failingSourceIndex]?.fail();

    assert.equal(sources[0]?.closeCount, 1);
    assert.equal(sources[1]?.closeCount, 1);
    assert.equal(controller.isOpen(), false);
    assert.equal(errors.length, 1);
  }
});

test("stale stream errors and events cannot affect a reopened stream", async () => {
  const events: LiveSupervisionEvent[] = [];
  const errors: string[] = [];
  const { create, sources } = await createFakeStreamController({ events, errors });
  const controller = create();
  controller.open(streamOpenOptions());
  const oldMain = sources[0]!;
  controller.open(streamOpenOptions());
  const currentMain = sources[2]!;
  const currentAsk = sources[3]!;

  oldMain.emit("native_tool_hook", {
    ...baseEvent,
    type: "native_tool_hook",
    runtimeSessionId: "agent:main:cli:stale",
  });
  oldMain.fail();

  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
  assert.equal(currentMain.closeCount, 0);
  assert.equal(currentAsk.closeCount, 0);
  assert.equal(controller.isOpen(), true);
});

type FakeStreamController = {
  open(options: ReturnType<typeof streamOpenOptions>): void;
  close(): void;
  isOpen(): boolean;
};

class FakeEventSource {
  onerror: (() => void) | null = null;
  closeCount = 0;
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closeCount += 1;
  }

  emit(type: string, payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  fail() {
    this.onerror?.();
  }
}

async function createFakeStreamController(options: {
  throwOnCreate?: number;
  events?: LiveSupervisionEvent[];
  errors?: string[];
}) {
  const sources: FakeEventSource[] = [];
  let createCount = 0;
  return {
    sources,
    create() {
      return createRealtimeStreamController({
        eventTypes: ["native_tool_hook"],
        createEventSource() {
          createCount += 1;
          if (createCount === options.throwOnCreate) {
            throw new Error("ask construction failed");
          }
          const source = new FakeEventSource();
          sources.push(source);
          return source;
        },
        onEvent(event: LiveSupervisionEvent) {
          options.events?.push(event);
        },
        onAskConfig() {},
        onAskDecision() {},
        onAskResolved() {},
        onError(message: string) {
          options.errors?.push(message);
        },
        onStreamingChange() {},
      });
    },
  };
}

function streamOpenOptions() {
  return {
    mainUrl: "http://main.test/events",
    askUrl: "http://main.test/asks",
    runtimeSessionId: "runtime.synthetic",
    includeHistory: false,
  };
}
