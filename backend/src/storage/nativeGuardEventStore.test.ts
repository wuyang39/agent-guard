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

test("syncs active appends and hardens existing file permissions", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const event = buildEvent({
      eventId: "event.durable-append",
      leaseId: "lease.durable-append",
    });
    const filePath = path.join(rootDir, `${event.leaseId}.jsonl`);
    await fs.writeFile(filePath, "", { encoding: "utf8", mode: 0o644 });
    let syncedPath: string | undefined;
    const store = createNativeGuardEventStore({
      rootDir,
      fileHooks: {
        afterAppendSync({ targetPath }) {
          syncedPath = targetPath;
        },
      },
    });

    assert.equal(await store.append(event), true);
    assert.equal(syncedPath, filePath);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(filePath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("rescans after a post-sync append error without duplicating the durable row", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    let failAfterSync = true;
    const event = buildEvent({
      eventId: "event.post-sync-ambiguous",
      leaseId: "lease.post-sync-ambiguous",
    });
    const store = createNativeGuardEventStore({
      rootDir,
      fileHooks: {
        afterAppendSync() {
          if (failAfterSync) {
            failAfterSync = false;
            throw new Error("injected post-sync append error");
          }
        },
      },
    });

    await assert.rejects(store.append(event), /injected post-sync append error/);
    assert.equal(await store.append(event), false);
    const persisted = await fs.readFile(
      path.join(rootDir, `${event.leaseId}.jsonl`),
      "utf8",
    );
    assert.equal(persisted.trim().split("\n").length, 1);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
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
        detail: { ...original.detail, action: "allow", reasonCode: "changed" },
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
      `${JSON.stringify({ sequence: 50, event: prefixEvent })}\n{"credential":"raw-tail-credential","pem":"-----BEGIN PRIVATE KEY----- raw-tail-private-key`,
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
    const quarantine = files.find((file) =>
      file.startsWith("lease.crash-tail.jsonl.corrupt-"),
    );
    assert.ok(quarantine);
    const quarantineContent = await fs.readFile(
      path.join(rootDir, quarantine),
      "utf8",
    );
    assert.equal(quarantineContent.includes("raw-tail-credential"), false);
    assert.equal(quarantineContent.includes("raw-tail-private-key"), false);
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

test("keeps corrupt active JSONL intact when atomic replacement fails", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const prefixEvent = buildEvent({
      eventId: "event.atomic-corrupt-prefix",
      leaseId: "lease.atomic-corrupt",
    });
    const activePath = path.join(rootDir, "lease.atomic-corrupt.jsonl");
    const original = `${JSON.stringify({ sequence: 1, event: prefixEvent })}\n{"token":"raw-corrupt-token"`;
    await fs.writeFile(activePath, original, "utf8");
    const store = createNativeGuardEventStore({
      rootDir,
      fileHooks: {
        async beforeAtomicRename({ kind }) {
          if (kind === "active") throw new Error("injected active rename failure");
        },
      },
    });

    await assert.rejects(store.listBySession(prefixEvent.sessionKey), /injected active rename failure/);
    assert.equal(await fs.readFile(activePath, "utf8"), original);
    const files = await fs.readdir(rootDir);
    const quarantine = files.find((file) =>
      file.startsWith("lease.atomic-corrupt.jsonl.corrupt-"),
    );
    assert.ok(quarantine);
    const quarantineContent = await fs.readFile(
      path.join(rootDir, quarantine),
      "utf8",
    );
    assert.equal(quarantineContent.includes("raw-corrupt-token"), false);
    assert.equal(files.some((file) => file.includes(".tmp-")), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("does not truncate a legacy JSONL when atomic rewrite fails", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    const event = buildEvent({
      eventId: "event.atomic-legacy",
      leaseId: "lease.atomic-legacy",
      detail: {
        ...buildEvent().detail,
        toolName: "curl Bearer raw-legacy-token",
        unexpected: "legacy-extra",
      },
    });
    const activePath = path.join(rootDir, "lease.atomic-legacy.jsonl");
    const original = `${JSON.stringify({ sequence: 1, event })}\n`;
    await fs.writeFile(activePath, original, "utf8");
    const store = createNativeGuardEventStore({
      rootDir,
      fileHooks: {
        async beforeAtomicRename({ kind }) {
          if (kind === "active") throw new Error("injected legacy rename failure");
        },
      },
    });

    await assert.rejects(store.listByRun(event.runId!), /injected legacy rename failure/);
    assert.equal(await fs.readFile(activePath, "utf8"), original);
    const files = await fs.readdir(rootDir);
    assert.equal(files.some((file) => file.includes(".tmp-")), false);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("ignores an unsafe lease JSONL name without blocking healthy files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-events-"));
  try {
    await fs.writeFile(
      path.join(rootDir, "..unsafe.jsonl"),
      "raw-invalid-lease-secret",
      "utf8",
    );
    const healthyEvent = buildEvent({
      eventId: "event.safe-amid-unsafe",
      leaseId: "lease.safe-amid-unsafe",
      runId: "run.safe-amid-unsafe",
    });
    await fs.writeFile(
      path.join(rootDir, "lease.safe-amid-unsafe.jsonl"),
      `${JSON.stringify({ sequence: 1, event: healthyEvent })}\n`,
      "utf8",
    );

    const store = createNativeGuardEventStore({ rootDir });
    assert.deepEqual(await store.listByRun("run.safe-amid-unsafe"), [healthyEvent]);
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

test("preserves and scrubs the typed Task10 tool-outcome shape", async () => {
  await withStore(async ({ rootDir, store }) => {
    const event = buildEvent({
      eventId: "event.tool-outcome",
      type: "tool_outcome",
      detail: {
        finalParamsDigest: "a".repeat(64),
        error: "Authorization: Bearer outcome-error-secret",
        durationMs: 12.5,
        resultDigest: "b".repeat(64),
        resultPreview: "token=outcome-preview-secret",
        unexpected: "drop-outcome-extra",
      },
    });
    delete event.decisionId;

    assert.equal(await store.append(event), true);
    const [saved] = await store.listByRun(event.runId!);
    assert.deepEqual(saved.detail, {
      finalParamsDigest: "a".repeat(64),
      error: "Authorization=[REDACTED]",
      durationMs: 12.5,
      resultDigest: "b".repeat(64),
      resultPreview: "token=[REDACTED]",
    });
    const persisted = await fs.readFile(
      path.join(rootDir, `${event.leaseId}.jsonl`),
      "utf8",
    );
    assert.equal(persisted.includes("outcome-error-secret"), false);
    assert.equal(persisted.includes("outcome-preview-secret"), false);
    assert.equal(persisted.includes("drop-outcome-extra"), false);
  });
});

test("defensively truncates oversized tool-outcome previews to 8 KiB", async () => {
  await withStore(async ({ store }) => {
    const event = buildEvent({
      eventId: "event.tool-outcome-large-preview",
      type: "tool_outcome",
      detail: {
        finalParamsDigest: "a".repeat(64),
        durationMs: 1,
        resultDigest: "b".repeat(64),
        resultPreview: `token=preview-secret ${"界".repeat(4_000)}`,
      },
    });
    delete event.decisionId;

    assert.equal(await store.append(event), true);
    const [saved] = await store.listByRun(event.runId!);
    assert.ok(
      Buffer.byteLength(saved.detail.resultPreview as string, "utf8") <= 8 * 1024,
    );
    assert.equal(
      (saved.detail.resultPreview as string).includes("preview-secret"),
      false,
    );
  });
});

test("rejects missing typed decision and tool-outcome fields", async () => {
  await withStore(async ({ store }) => {
    const invalidDecision = buildEvent({
      eventId: "event.invalid-decision-shape",
      detail: { action: "deny", reasonCode: "policy_deny" },
    });
    delete invalidDecision.decisionId;
    await assert.rejects(
      store.append(invalidDecision),
      /decision/i,
    );
    await assert.rejects(
      store.append(buildEvent({
        eventId: "event.invalid-redact-shape",
        detail: {
          requestId: "req.redact",
          action: "redact",
          reasonCode: "policy_redact",
          targetType: "api_call",
          toolName: "web_fetch",
          paramsDigest: "a".repeat(64),
        },
      })),
      /rewritten.*digest/i,
    );
    const invalidOutcome = buildEvent({
        eventId: "event.invalid-outcome-shape",
        type: "tool_outcome",
        detail: { durationMs: -1 },
      });
    delete invalidOutcome.toolCallId;
    delete invalidOutcome.decisionId;
    await assert.rejects(
      store.append(invalidOutcome),
      /tool.outcome/i,
    );
  });
});

test("projects evidence fields and scrubs secret patterns from retained values", async () => {
  await withStore(async ({ rootDir, store }) => {
    const event = buildEvent({
      detail: {
        requestId: "request.evidence",
        action: "deny",
        reasonCode: "policy_deny",
        targetType: "api_call",
        toolName: "curl Bearer tool-secret-value",
        paramsDigest: "c".repeat(64),
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
        requestId: "request.legacy",
        action: "deny",
        reasonCode: "policy_deny",
        targetType: "api_call",
        toolName: "curl Bearer legacy-tool-token",
        paramsDigest: "d".repeat(64),
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
        detail: {
          ...buildEvent().detail,
          callback: () => undefined,
        },
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
    detail: {
      requestId: "request.1",
      action: "deny",
      reasonCode: "policy_deny",
      targetType: "tool_call",
      toolName: "shell",
      paramsDigest: "a".repeat(64),
    },
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
