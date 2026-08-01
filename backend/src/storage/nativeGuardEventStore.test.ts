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
    await assert.rejects(
      restarted.append(
        buildEvent({ eventId: event.eventId, leaseId: "lease.other" }),
      ),
      /conflict/i,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects a reused event id with different sanitized content", async () => {
  await withStore(async ({ store }) => {
    const original = buildEvent({ eventId: "event.conflict" });
    assert.equal(await store.append(original), true);
    assert.equal(await store.append(structuredClone(original)), false);
    await assert.rejects(
      store.append({
        ...original,
        detail: { action: "allow", reasonCode: "changed" },
      }),
      /conflict/i,
    );
  });
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

test("rejects unsafe lease paths", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.append(buildEvent({ leaseId: "../escape" })),
      /lease id/i,
    );
  });
});

test("quarantines a corrupt crash tail and preserves its valid prefix", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const healthy = createNativeGuardEventStore({ rootDir });
    const healthyEvent = buildEvent({
      eventId: "event.healthy",
      leaseId: "lease.healthy",
      runId: "run.recovery",
    });
    assert.equal(await healthy.append(healthyEvent), true);
    const prefixEvent = buildEvent({
      eventId: "event.prefix",
      leaseId: "lease.crash-tail",
      runId: "run.recovery",
    });
    await fs.writeFile(
      path.join(rootDir, "lease.crash-tail.jsonl"),
      `${JSON.stringify({ sequence: 50, event: prefixEvent })}\n{broken`,
      "utf8",
    );

    const restarted = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(await restarted.listByRun("run.recovery"), [
      healthyEvent,
      prefixEvent,
    ]);
    assert.equal(
      await restarted.append(buildEvent({
        eventId: "event.after-recovery",
        leaseId: "lease.healthy",
      })),
      true,
    );
    const files = await fs.readdir(rootDir);
    assert.ok(files.some((file) => file.startsWith("lease.crash-tail.jsonl.corrupt-")));
    const repaired = await fs.readFile(
      path.join(rootDir, "lease.crash-tail.jsonl"),
      "utf8",
    );
    assert.equal(repaired.trim().split("\n").length, 1);
    const cleanRestart = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(await cleanRestart.listByRun("run.recovery"), [
      healthyEvent,
      prefixEvent,
    ]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("isolates an interior corrupt schema without losing other leases", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const healthy = createNativeGuardEventStore({ rootDir });
    const healthyEvent = buildEvent({
      eventId: "event.healthy.interior",
      leaseId: "lease.healthy",
      runId: "run.interior",
    });
    assert.equal(await healthy.append(healthyEvent), true);
    const prefixEvent = buildEvent({
      eventId: "event.interior.prefix",
      leaseId: "lease.interior",
      runId: "run.interior",
    });
    const discardedEvent = buildEvent({
      eventId: "event.interior.discarded",
      leaseId: "lease.interior",
      runId: "run.interior",
    });
    await fs.writeFile(
      path.join(rootDir, "lease.interior.jsonl"),
      [
        JSON.stringify({ sequence: 20, event: prefixEvent }),
        JSON.stringify({ sequence: 21, event: { ...prefixEvent, schemaVersion: "bad" } }),
        JSON.stringify({ sequence: 22, event: discardedEvent }),
        "",
      ].join("\n"),
      "utf8",
    );

    const restarted = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(await restarted.listByRun("run.interior"), [
      healthyEvent,
      prefixEvent,
    ]);
    assert.equal(
      await restarted.append(buildEvent({
        eventId: "event.healthy.after-interior",
        leaseId: "lease.healthy",
      })),
      true,
    );
    const files = await fs.readdir(rootDir);
    assert.ok(files.some((file) => file.startsWith("lease.interior.jsonl.corrupt-")));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("rejects invalid event and record schemas before persistence", async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(
      store.append(buildEvent({ type: "unknown" as never })),
      /event type|schema/i,
    );
    await assert.rejects(
      store.append(buildEvent({
        eventId: "event.bad-time",
        timestamp: "2026-08-01T00:00:01Z",
      })),
      /timestamp/i,
    );
    await assert.rejects(
      store.append(
        buildEvent({ eventId: "event.bad-record" }),
        buildRecord({ action: "execute" as never }),
      ),
      /record action|schema/i,
    );
  });
});

test("projects evidence fields and scrubs secret patterns from retained values", async () => {
  await withStore(async ({ rootDir, store }) => {
    const event = buildEvent({
      detail: {
        action: "deny",
        reasonCode: "policy_deny",
        toolName: "curl Bearer tool-secret-value",
        message: "Cookie: session=cookie-secret-value",
        value: {
          credential: "nested-credential-secret",
          note: "ordinary secret handling remains visible",
        },
        unexpected: "drop-this-field",
      },
    });
    const record = buildRecord({
      decisionReason: [
        "ordinary secret handling remains visible",
        "token=record-token-value",
        'api_key="multi word raw value"',
        "Authorization: Basic cmF3OnNlY3JldA==",
        "-----BEGIN PRIVATE KEY-----\nprivate-key-value\n-----END PRIVATE KEY-----",
      ].join("; "),
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
      "tool-secret-value",
      "cookie-secret-value",
      "nested-credential-secret",
      "gateway-secret",
      "password-secret",
      "token-secret",
      "record-token-value",
      "word raw value",
      "cmF3OnNlY3JldA==",
      "private-key-value",
      "drop-this-field",
    ]) {
      assert.equal(persisted.includes(secret), false);
    }
    assert.match(persisted, /\[REDACTED\]/);
    assert.match(persisted, /ordinary secret handling remains visible/);
    const [saved] = await store.listByRun(event.runId!);
    assert.equal(Object.hasOwn(saved.detail, "unexpected"), false);
    assert.equal(
      (saved.detail.value as Record<string, unknown>).credential,
      "[REDACTED]",
    );
  });
});

test("scrubs and rewrites valid legacy envelopes while loading", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const event = buildEvent({
      eventId: "event.legacy-secret",
      leaseId: "lease.legacy-secret",
      runId: "run.legacy-secret",
      detail: {
        action: "deny",
        reasonCode: "policy_deny",
        toolName: "curl Bearer legacy-tool-token",
        unexpected: "legacy-unknown-value",
      },
    });
    const record = buildRecord({
      decisionReason: "password=legacy-record-password",
    });
    const filePath = path.join(rootDir, "lease.legacy-secret.jsonl");
    await fs.writeFile(
      filePath,
      `${JSON.stringify({ sequence: 1, event, record })}\n`,
      "utf8",
    );

    const store = createNativeGuardEventStore({ rootDir });
    const [saved] = await store.listByRun("run.legacy-secret");
    assert.equal(Object.hasOwn(saved.detail, "unexpected"), false);
    const rewritten = await fs.readFile(filePath, "utf8");
    assert.equal(rewritten.includes("legacy-tool-token"), false);
    assert.equal(rewritten.includes("legacy-record-password"), false);
    assert.equal(rewritten.includes("legacy-unknown-value"), false);
    assert.match(rewritten, /\[REDACTED\]/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
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

test("shares notifications across same-root instances and catches async listeners", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const subscriberStore = createNativeGuardEventStore({ rootDir });
    const writerStore = createNativeGuardEventStore({ rootDir });
    const received: string[] = [];
    subscriberStore.subscribe(async (event) => {
      received.push(event.eventId);
      await Promise.resolve();
      throw new Error("async listener failure");
    });

    const event = buildEvent({ eventId: "event.shared-listener" });
    assert.equal(await writerStore.append(event), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [event.eventId]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
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
