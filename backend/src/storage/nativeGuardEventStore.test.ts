import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  NativeGuardEvent,
  RuntimeSupervisionRecord,
} from "@agent-guard/contracts";
import { createNativeGuardEventStore } from "./nativeGuardEventStore";

test("persists events and paired records in append order", async () => {
  await withStore(async ({ rootDir, store }) => {
    const first = buildEvent({ eventId: "event.1", runId: "run.1" });
    const second = buildEvent({
      eventId: "event.2",
      sessionKey: "session.child",
      runId: "run.1",
    });
    const record = buildRecord();

    assert.equal(await store.append(first, record), true);
    assert.equal(await store.append(second), true);
    assert.deepEqual(await store.listByRun("run.1"), [first, second]);
    assert.deepEqual(await store.listRecordsByRun("run.1"), [record]);
    assert.deepEqual(await store.listBySession("session.child"), [second]);

    const persisted = await fs.readFile(
      path.join(rootDir, `${first.leaseId}.jsonl`),
      "utf8",
    );
    assert.equal(persisted.trim().split("\n").length, 2);
  });
});

test("deduplicates concurrent and restarted appends across the whole store", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const event = buildEvent({ eventId: "event.shared" });
    const firstStore = createNativeGuardEventStore({ rootDir });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => firstStore.append(event)),
    );
    assert.equal(results.filter(Boolean).length, 1);

    const restarted = createNativeGuardEventStore({ rootDir });
    assert.equal(await restarted.append(event), false);
    assert.equal(
      await restarted.append(
        buildEvent({ eventId: event.eventId, leaseId: "lease.other" }),
      ),
      false,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("preserves global append order across lease files after restart", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const store = createNativeGuardEventStore({ rootDir });
    const first = buildEvent({
      eventId: "event.first",
      leaseId: "lease.z",
      runId: "run.shared",
    });
    const second = buildEvent({
      eventId: "event.second",
      leaseId: "lease.a",
      runId: "run.shared",
    });
    assert.equal(await store.append(first), true);
    assert.equal(await store.append(second), true);

    const restarted = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(await restarted.listByRun("run.shared"), [first, second]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("serializes duplicate appends across store instances", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const firstStore = createNativeGuardEventStore({ rootDir });
    const secondStore = createNativeGuardEventStore({ rootDir });
    const duplicate = buildEvent({ eventId: "event.cross-instance" });
    const results = await Promise.all([
      firstStore.append(duplicate),
      secondStore.append(duplicate),
    ]);
    assert.equal(results.filter(Boolean).length, 1);

    const later = buildEvent({
      eventId: "event.cross-instance-later",
      leaseId: "lease.later",
      runId: "run.cross-instance",
    });
    assert.equal(await secondStore.append(later), true);
    const restarted = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(
      (await restarted.listByRun("run.cross-instance")).map(({ eventId }) => eventId),
      [later.eventId],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects unsafe lease paths and corrupt existing JSONL", async () => {
  await withStore(async ({ rootDir, store }) => {
    await assert.rejects(
      store.append(buildEvent({ leaseId: "../escape" })),
      /lease id/i,
    );
    await fs.writeFile(
      path.join(rootDir, "lease.corrupt.jsonl"),
      `${JSON.stringify({ event: buildEvent({ leaseId: "lease.corrupt" }) })}\n{broken`,
      "utf8",
    );

    const restarted = createNativeGuardEventStore({ rootDir });
    await assert.rejects(
      restarted.append(buildEvent({ eventId: "event.after-corruption" })),
      /corrupt/i,
    );
  });
});

test("redacts nested secrets in persisted detail and gateway", async () => {
  await withStore(async ({ rootDir, store }) => {
    const event = buildEvent({
      detail: {
        authorization: "Bearer event-secret",
        nested: {
          private_key: "private-secret",
          cookie: "cookie-secret",
          "x-api-key": "api-key-secret",
          okay: "visible",
        },
      },
    });
    const record = buildRecord({
      gateway: {
        providerId: "provider.1",
        credential: "gateway-secret",
        nested: { password: "password-secret", token: "token-secret" },
      } as never,
    });

    assert.equal(await store.append(event, record), true);
    const persisted = await fs.readFile(
      path.join(rootDir, `${event.leaseId}.jsonl`),
      "utf8",
    );
    for (const secret of [
      "event-secret",
      "private-secret",
      "cookie-secret",
      "api-key-secret",
      "gateway-secret",
      "password-secret",
      "token-secret",
    ]) {
      assert.equal(persisted.includes(secret), false);
    }
    assert.match(persisted, /\[REDACTED\]/);
    assert.match(persisted, /visible/);
  });
});

test("rejects cycles and unsupported JSON values", async () => {
  await withStore(async ({ store }) => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      store.append(buildEvent({ detail: cyclic })),
      /circular|cycle/i,
    );
    await assert.rejects(
      store.append(buildEvent({
        eventId: "event.unsupported",
        detail: { callback: () => undefined },
      })),
      /support|json/i,
    );
  });
});

test("notifies subscribers once only after successful first append", async () => {
  await withStore(async ({ store }) => {
    const event = buildEvent();
    const received: string[] = [];
    const unsubscribe = store.subscribe((saved) => {
      received.push(saved.eventId);
    });
    store.subscribe(() => {
      throw new Error("listener failure");
    });

    assert.equal(await store.append(event), true);
    assert.equal(await store.append(event), false);
    unsubscribe();
    assert.equal(
      await store.append(buildEvent({ eventId: "event.after-unsubscribe" })),
      true,
    );
    assert.deepEqual(received, [event.eventId]);
  });
});

test("does not reserve an event id when persistence fails", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  const event = buildEvent();
  try {
    const store = createNativeGuardEventStore({ rootDir });
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.writeFile(rootDir, "not a directory", "utf8");
    await assert.rejects(store.append(event));

    await fs.rm(rootDir, { force: true });
    await fs.mkdir(rootDir, { recursive: true });
    assert.equal(await store.append(event), true);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

async function withStore(
  run: (fixture: {
    rootDir: string;
    store: ReturnType<typeof createNativeGuardEventStore>;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    await run({ rootDir, store: createNativeGuardEventStore({ rootDir }) });
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

function buildEvent(
  overrides: Partial<NativeGuardEvent> = {},
): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId: "event.1",
    type: "decision",
    leaseId: "lease.1",
    sessionKey: "session.root",
    runId: "run.default",
    toolCallId: "tool-call.1",
    decisionId: "decision.1",
    timestamp: "2026-08-01T00:00:01.000Z",
    detail: { action: "deny", reasonCode: "policy_deny" },
    ...overrides,
  };
}

function buildRecord(
  overrides: Partial<RuntimeSupervisionRecord> = {},
): RuntimeSupervisionRecord {
  return {
    schemaVersion: "mvp-1",
    recordId: "supervision_record.1",
    runtimeSessionId: "session.root",
    agentId: "agent.native",
    policyPackId: "policy_pack.native",
    policyId: "policy.native",
    action: "deny",
    decisionReason: "Denied by policy.",
    targetType: "tool_call",
    targetId: "tool-call.1",
    inputEventId: "event.1",
    createdAt: "2026-08-01T00:00:01.000Z",
    ...overrides,
  };
}
