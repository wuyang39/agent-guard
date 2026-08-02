import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  NativeGuardEvent,
  NativeGuardLeaseActivation,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import {
  MAX_EVENT_SPOOL_BYTES,
  MAX_EVENT_SPOOL_EVENTS,
  createEventSpool,
  sanitizeOutcomeResult,
  type EventSpool,
} from "./eventSpool";
import { AgentGuardRuntime } from "./runtime";

const NOW = "2026-08-02T10:00:00.000Z";

test("result preview is truncated on a valid UTF-8 boundary at 8 KiB", () => {
  const evidence = sanitizeOutcomeResult({ output: "界".repeat(8_192) });

  assert.ok(Buffer.byteLength(evidence.resultPreview, "utf8") <= 8 * 1024);
  assert.equal(evidence.resultPreview.includes("\uFFFD"), false);
  assert.match(evidence.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    evidence.resultDigest,
    sanitizeOutcomeResult({ output: "界".repeat(8_192) }).resultDigest,
  );
});

test("result projection redacts nested secret keys case-insensitively", () => {
  const evidence = sanitizeOutcomeResult({
    token: "one",
    nested: {
      Authorization: "two",
      PASSWORD: "three",
      serviceCredential: "four",
      session_cookie: "five",
      clientSecret: "six",
      safe: "visible",
    },
  });

  assert.equal(evidence.resultPreview.includes("one"), false);
  assert.equal(evidence.resultPreview.includes("two"), false);
  assert.equal(evidence.resultPreview.includes("three"), false);
  assert.equal(evidence.resultPreview.includes("four"), false);
  assert.equal(evidence.resultPreview.includes("five"), false);
  assert.equal(evidence.resultPreview.includes("six"), false);
  assert.equal((evidence.resultPreview.match(/\[REDACTED\]/g) ?? []).length, 6);
  assert.match(evidence.resultPreview, /visible/);
});

test("result projection never invokes getters or Proxy traps", () => {
  let getterCalls = 0;
  let proxyCalls = 0;
  const value: Record<string, unknown> = { safe: "visible" };
  Object.defineProperty(value, "password", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "getter-secret";
    },
  });
  Object.defineProperty(value, "computed", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "computed-secret";
    },
  });
  value.proxied = new Proxy({ token: "proxy-secret" }, {
    ownKeys: (target) => {
      proxyCalls += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor: (target, key) => {
      proxyCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get: (target, key, receiver) => {
      proxyCalls += 1;
      return Reflect.get(target, key, receiver);
    },
  });

  const evidence = sanitizeOutcomeResult(value);

  assert.equal(getterCalls, 0);
  assert.equal(proxyCalls, 0);
  assert.equal(evidence.resultPreview.includes("getter-secret"), false);
  assert.equal(evidence.resultPreview.includes("proxy-secret"), false);
  assert.match(evidence.resultPreview, /\[REDACTED\]/);
  assert.match(evidence.resultPreview, /\[UNAVAILABLE\]/);
});

test("result projection is bounded for circular and exotic values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const exotic = Object.create({ inherited: "secret" }) as Record<string, unknown>;
  exotic.visible = "not-inspected";

  const first = sanitizeOutcomeResult({ circular, exotic, tail: Array(20_000).fill("x") });
  const second = sanitizeOutcomeResult({ circular, exotic, tail: Array(20_000).fill("x") });

  assert.equal(first.resultDigest, second.resultDigest);
  assert.ok(Buffer.byteLength(first.resultPreview, "utf8") <= 8 * 1024);
  assert.equal(first.resultPreview.includes("not-inspected"), false);
});

test("duplicate event IDs are uploaded once", async (t) => {
  const directory = await temporaryDirectory(t);
  const uploaded: NativeGuardEvent[] = [];
  const spool = createEventSpool({
    directory,
    upload: async (_lease, events) => { uploaded.push(...events); },
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => spool.stop());

  assert.equal(await spool.enqueue(outcomeEvent({ eventId: "same" })), true);
  assert.equal(await spool.enqueue(outcomeEvent({ eventId: "same" })), false);
  await spool.flushNow();
  assert.equal(await spool.enqueue(outcomeEvent({ eventId: "same" })), false);
  await spool.flushNow();

  assert.deepEqual(uploaded.map(({ eventId }) => eventId), ["same"]);
});

test("failed upload is durably persisted and retried", async (t) => {
  const directory = await temporaryDirectory(t);
  const scheduled: Array<() => void> = [];
  let fail = true;
  let uploads = 0;
  const spool = createEventSpool({
    directory,
    upload: async () => {
      uploads += 1;
      if (fail) throw new Error("offline");
    },
    autoFlush: false,
    scheduleTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancelTimeout: () => undefined,
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.enqueue(outcomeEvent({ eventId: "persisted" }));
  await spool.flushNow();
  assert.match(await readFile(join(directory, "events.jsonl"), "utf8"), /persisted/);
  assert.ok((await lstat(join(directory, "metadata.json"))).isFile());
  assert.equal(uploads, 1);
  assert.equal(scheduled.length, 1);

  fail = false;
  scheduled.shift()?.();
  await spool.flushNow();

  assert.equal(uploads, 2);
  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
});

test("duration availability contract permits omission only when explicitly unavailable", async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => spool.stop());
  const unavailable = outcomeEvent({
    eventId: "duration-unavailable",
    detail: {
      ...outcomeEvent().detail,
      durationSource: "unavailable",
    },
  });
  delete unavailable.detail.durationMs;

  assert.equal(await spool.enqueue(unavailable), true);
  await assert.rejects(spool.enqueue(outcomeEvent({
    eventId: "duration-unavailable-with-value",
    detail: { ...outcomeEvent().detail, durationSource: "unavailable" },
  })), /typed event/i);
});

test("default spool limits are 10,000 events and 50 MiB", () => {
  assert.equal(MAX_EVENT_SPOOL_EVENTS, 10_000);
  assert.equal(MAX_EVENT_SPOOL_BYTES, 50 * 1024 * 1024);
});

test("event-count and byte limits evict ordinary successful outcomes", async (t) => {
  const countDirectory = await temporaryDirectory(t);
  const countSpool = createEventSpool({
    directory: countDirectory,
    upload: async () => undefined,
    autoFlush: false,
    maxEvents: 2,
    maxBytes: 1_000_000,
  });
  stopBeforeRemove(countDirectory, () => countSpool.stop());
  await countSpool.enqueue(outcomeEvent({ eventId: "count-1" }));
  await countSpool.enqueue(outcomeEvent({ eventId: "count-2" }));
  await countSpool.enqueue(outcomeEvent({ eventId: "count-3" }));
  const countIds = await persistedEventIds(countDirectory);
  assert.deepEqual(countIds, ["count-2", "count-3"]);

  const byteDirectory = await temporaryDirectory(t);
  const sampleBytes = Buffer.byteLength(`${JSON.stringify(outcomeEvent({ eventId: "bytes-1" }))}\n`);
  const byteSpool = createEventSpool({
    directory: byteDirectory,
    upload: async () => undefined,
    autoFlush: false,
    maxEvents: 100,
    maxBytes: sampleBytes + 32,
  });
  stopBeforeRemove(byteDirectory, () => byteSpool.stop());
  await byteSpool.enqueue(outcomeEvent({ eventId: "bytes-1" }));
  await byteSpool.enqueue(outcomeEvent({ eventId: "bytes-2" }));
  assert.deepEqual(await persistedEventIds(byteDirectory), ["bytes-2"]);
});

test("eviction preserves deny, approval, error, and status transitions before success", async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    maxEvents: 4,
    maxBytes: 1_000_000,
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.enqueue(outcomeEvent({ eventId: "success-old" }));
  await spool.enqueue(outcomeEvent({ eventId: "error", detail: {
    ...outcomeEvent().detail,
    error: "bounded error",
  } }));
  await spool.enqueue(nativeEvent({
    eventId: "deny",
    type: "decision",
    decisionId: "decision-1",
    detail: {
      leaseEpoch: 1,
      requestId: "request-1",
      action: "deny",
      reasonCode: "policy_deny",
      targetType: "tool_call",
      toolName: "exec",
      paramsDigest: "a".repeat(64),
    },
  }));
  await spool.enqueue(nativeEvent({
    eventId: "approval",
    type: "approval_requested",
    toolCallId: "call-approval",
    detail: { leaseEpoch: 1, approvalId: "approval-1" },
  }));
  await spool.enqueue(nativeEvent({
    eventId: "status",
    type: "coverage_changed",
    toolCallId: undefined,
    detail: { leaseEpoch: 1, coverage: "active" },
  }));
  await spool.enqueue(outcomeEvent({ eventId: "success-new" }));

  assert.deepEqual(
    new Set(await persistedEventIds(directory)),
    new Set(["error", "deny", "approval", "status"]),
  );
});

test("spool rejects traversal, symlinks, partial lines, and oversized legacy data", async (t) => {
  assert.throws(() => createEventSpool({
    directory: `${tmpdir()}\\agent-guard\\..\\escape`,
    upload: async () => undefined,
  }), /directory/i);

  const root = await temporaryDirectory(t);
  const target = join(root, "target");
  const linked = join(root, "linked");
  await mkdir(target);
  await symlink(target, linked, "junction");
  const linkedSpool = createEventSpool({
    directory: linked,
    upload: async () => undefined,
    autoFlush: false,
  });
  await assert.rejects(linkedSpool.enqueue(outcomeEvent()), /symlink|directory/i);

  const partialDirectory = await temporaryDirectory(t);
  await writeFile(
    join(partialDirectory, "events.jsonl"),
    `${JSON.stringify(outcomeEvent({ eventId: "complete" }))}\n{\"eventId\":`,
  );
  const uploaded: NativeGuardEvent[] = [];
  const recovered = createEventSpool({
    directory: partialDirectory,
    upload: async (_lease, events) => { uploaded.push(...events); },
    autoFlush: false,
  });
  stopBeforeRemove(partialDirectory, () => recovered.stop());
  await recovered.flushNow();
  assert.deepEqual(uploaded.map(({ eventId }) => eventId), ["complete"]);

  const oversizedDirectory = await temporaryDirectory(t);
  await writeFile(join(oversizedDirectory, "events.jsonl"), "x".repeat(2_000));
  const oversized = createEventSpool({
    directory: oversizedDirectory,
    upload: async () => undefined,
    autoFlush: false,
    maxBytes: 1_000,
    maxRecordBytes: 256,
  });
  await assert.rejects(oversized.flushNow(), /oversized|corrupt/i);
});

test("metadata corruption is quarantined without discarding valid event data", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(
    join(directory, "events.jsonl"),
    `${JSON.stringify(outcomeEvent({ eventId: "recover-me" }))}\n`,
  );
  await writeFile(join(directory, "metadata.json"), "{broken");
  const uploaded: NativeGuardEvent[] = [];
  const spool = createEventSpool({
    directory,
    upload: async (_lease, events) => { uploaded.push(...events); },
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.flushNow();

  assert.deepEqual(uploaded.map(({ eventId }) => eventId), ["recover-me"]);
  assert.equal((await readFile(join(directory, "metadata.json"), "utf8")).includes("broken"), false);
});

test("legacy detail lease epoch migrates to top-level before retry and rewrites spool", async (t) => {
  const directory = await temporaryDirectory(t);
  const current = outcomeEvent({ eventId: "legacy-spool-epoch", leaseEpoch: 4 });
  const legacy = {
    ...current,
    detail: { ...current.detail, leaseEpoch: 4 },
  } as Record<string, unknown>;
  delete legacy.leaseEpoch;
  delete (legacy.detail as Record<string, unknown>).durationSource;
  await writeFile(join(directory, "events.jsonl"), `${JSON.stringify(legacy)}\n`);
  const spool = createEventSpool({
    directory,
    upload: async () => { throw new Error("keep pending for inspection"); },
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.flushNow();

  const rewritten = JSON.parse(
    (await readFile(join(directory, "events.jsonl"), "utf8")).trim(),
  ) as NativeGuardEvent;
  assert.equal(rewritten.leaseEpoch, 4);
  assert.equal(Object.hasOwn(rewritten.detail, "leaseEpoch"), false);
  assert.equal(rewritten.detail.durationSource, "legacy_unspecified");
});

test("upload batches contain at most 100 events from one lease", async (t) => {
  const directory = await temporaryDirectory(t);
  const batches: Array<{ leaseId: string; size: number }> = [];
  const spool = createEventSpool({
    directory,
    upload: async (lease, events) => { batches.push({ leaseId: lease.leaseId, size: events.length }); },
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => spool.stop());
  for (let index = 0; index < 101; index += 1) {
    await spool.enqueue(outcomeEvent({ eventId: `event-${index}` }));
  }
  await spool.enqueue(outcomeEvent({ eventId: "other-lease", leaseId: "lease-2" }));

  await spool.flushNow();

  assert.deepEqual(batches, [
    { leaseId: "lease-1", size: 100 },
    { leaseId: "lease-1", size: 1 },
    { leaseId: "lease-2", size: 1 },
  ]);
});

test("cancelLease and stop cancel retries and prevent further upload", async (t) => {
  const directory = await temporaryDirectory(t);
  const scheduled: Array<() => void> = [];
  let uploads = 0;
  const spool = createEventSpool({
    directory,
    upload: async () => {
      uploads += 1;
      throw new Error("offline");
    },
    autoFlush: false,
    scheduleTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancelTimeout: () => undefined,
  });
  await spool.enqueue(outcomeEvent({ eventId: "cancelled" }));
  await spool.flushNow();
  assert.equal(uploads, 1);
  assert.equal(scheduled.length, 1);

  spool.cancelLease("lease-1");
  scheduled.shift()?.();
  await spool.flushNow();
  assert.equal(uploads, 1);

  await spool.stop();
  await assert.rejects(spool.enqueue(outcomeEvent({ eventId: "stopped" })), /stopped/i);
});

test("after hook in OFF has no event, network, log, or filesystem side effect", async (t) => {
  const root = await temporaryDirectory(t);
  const directory = join(root, "must-not-exist");
  let fetchCalls = 0;
  let eventCalls = 0;
  let spoolCreations = 0;
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    spoolDir: directory,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
    emitEvent: () => { eventCalls += 1; },
    createEventSpool: (options) => {
      spoolCreations += 1;
      return createEventSpool(options);
    },
  });

  const result = await runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-off", result: "ok", durationMs: 2 },
    { toolName: "read", sessionKey: "ordinary", toolCallId: "call-off" },
  );

  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0);
  assert.equal(eventCalls, 0);
  assert.equal(spoolCreations, 0);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
});

test("ACTIVE after hook emits bounded outcome asynchronously without changing the result", async (t) => {
  const directory = await temporaryDirectory(t);
  const events: NativeGuardEvent[] = [];
  const runtime = await activeRuntime({
    spoolDir: directory,
    emitEvent: async (event) => { events.push(event); },
  });
  stopBeforeRemove(directory, () => runtime.stop());
  const params = { path: "README.md" };
  const result = {
    authorization: "Bearer result-secret",
    first: "credential-secret",
    second: "separate-evidence-bearer",
    value: "ok",
  };

  const hookResult = await runtime.afterToolCall(
    {
      toolName: "read",
      params,
      toolCallId: "call-active",
      runId: "run-active",
      result,
      durationMs: 7,
    },
    {
      toolName: "read",
      sessionKey: "agent:main",
      toolCallId: "call-active",
      runId: "run-active",
    },
  );

  assert.equal(hookResult, undefined);
  await waitFor(() => events.length === 1);
  assert.equal(events[0]?.type, "tool_outcome");
  assert.equal(events[0]?.leaseEpoch, 1);
  assert.equal(events[0]?.detail.finalParamsDigest, digestJson(params));
  assert.equal(events[0]?.detail.durationMs, 7);
  assert.equal(events[0]?.detail.durationSource, "host");
  assert.equal(JSON.stringify(events).includes("result-secret"), false);
  assert.equal(JSON.stringify(events).includes("credential-secret"), false);
  assert.equal(JSON.stringify(events).includes("separate-evidence-bearer"), false);
});

test("missing outcome correlation reports duration unavailable without inventing milliseconds", async (t) => {
  const directory = await temporaryDirectory(t);
  const events: NativeGuardEvent[] = [];
  const runtime = await activeRuntime({
    spoolDir: directory,
    emitEvent: async (event) => { events.push(event); },
  });
  stopBeforeRemove(directory, () => runtime.stop());

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-uncorrelated", result: "ok" },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-uncorrelated" },
  );
  await waitFor(() => events.length === 1);

  assert.equal(events[0].detail.durationSource, "unavailable");
  assert.equal(Object.hasOwn(events[0].detail, "durationMs"), false);
});

test("after hook swallows asynchronous sink failure and stop prevents delayed reporting", async (t) => {
  const directory = await temporaryDirectory(t);
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { release = resolve; });
  let eventCalls = 0;
  const runtime = await activeRuntime({
    spoolDir: directory,
    emitEvent: async () => {
      eventCalls += 1;
      await entered;
      throw new Error("sink failed");
    },
  });

  assert.equal(await runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-async", result: "ok", durationMs: 1 },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-async" },
  ), undefined);
  await waitFor(() => eventCalls === 1);
  const stopping = runtime.stop();
  release();
  await stopping;

  assert.equal(await runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-late", result: "ok", durationMs: 1 },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-late" },
  ), undefined);
  assert.equal(eventCalls, 1);
});

test("renewal retries persisted old-epoch evidence with only the current credential", async (t) => {
  const directory = await temporaryDirectory(t);
  const { publicKey } = generateKeyPairSync("ed25519");
  const authorizations: string[] = [];
  const uploadedEpochs: number[] = [];
  let spool: EventSpool | undefined;
  let fail = true;
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    fetch: async (_input, init) => {
      authorizations.push(String((init?.headers as Record<string, string>).Authorization));
      const body = JSON.parse(String(init?.body)) as { events: NativeGuardEvent[] };
      uploadedEpochs.push(body.events[0]?.leaseEpoch as number);
      if (fail) throw new Error("offline before renewal");
      return new Response(JSON.stringify({
        ok: true,
        data: { accepted: body.events.length },
        requestId: "request-upload",
      }), { headers: { "content-type": "application/json; charset=utf-8" } });
    },
    createEventSpool: (options) => {
      spool = createEventSpool(options);
      return spool;
    },
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  const first = activation(publicKey.export({ type: "spki", format: "pem" }).toString());
  await runtime.activate(first);
  stopBeforeRemove(directory, () => runtime.stop());

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-renew", result: "ok", durationMs: 1 },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-renew" },
  );
  await waitFor(() => authorizations.length === 1);
  await waitFor(async () => (await readFile(join(directory, "events.jsonl"), "utf8")).includes("call-renew"));

  fail = false;
  await runtime.renew({
    ...first,
    leaseEpoch: 2,
    credential: "rotated-credential",
    evidenceCredential: "rotated-evidence-credential",
    issuedAt: NOW,
    expiresAt: "2026-08-02T10:06:00.000Z",
  });
  await waitFor(() => authorizations.length === 2);
  assert.ok(spool);
  await spool.flushNow();

  assert.deepEqual(authorizations, [
    "Bearer separate-evidence-bearer",
    "Bearer rotated-evidence-credential",
  ]);
  assert.deepEqual(uploadedEpochs, [1, 1]);
  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
  assert.equal((await readFile(join(directory, "events.jsonl"), "utf8")).includes("rotated-credential"), false);
  assert.equal((await readFile(join(directory, "metadata.json"), "utf8")).includes("rotated-credential"), false);
});

test("ended child evidence retries through the still-active lease without rewriting identity", async (t) => {
  const directory = await temporaryDirectory(t);
  const { publicKey } = generateKeyPairSync("ed25519");
  const uploads: Array<{ authorization: string; event: NativeGuardEvent }> = [];
  let fail = true;
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { events: NativeGuardEvent[] };
      uploads.push({
        authorization: String((init?.headers as Record<string, string>).Authorization),
        event: body.events[0],
      });
      if (fail) throw new Error("offline while child ends");
      return new Response(JSON.stringify({
        ok: true,
        data: { accepted: body.events.length },
        requestId: "request-upload-child",
      }), { headers: { "content-type": "application/json" } });
    },
    lifecycleClient: {
      async bindChild() { return; },
      async endSession() { return; },
    },
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  const first = activation(publicKey.export({ type: "spki", format: "pem" }).toString());
  await runtime.activate(first);
  await runtime.bindChild("lease-1", "agent:main", "agent:child");
  stopBeforeRemove(directory, () => runtime.stop());

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-child", result: "ok", durationMs: 1 },
    { toolName: "read", sessionKey: "agent:child", toolCallId: "call-child" },
  );
  await waitFor(() => uploads.length === 1);
  assert.equal(await runtime.endSession("agent:child"), true);
  fail = false;
  await runtime.renew({
    ...first,
    leaseEpoch: 2,
    credential: "rotated-child-credential",
    evidenceCredential: "rotated-child-evidence-credential",
    issuedAt: NOW,
    expiresAt: "2026-08-02T10:06:00.000Z",
  });
  await waitFor(() => uploads.length === 2);

  assert.equal(uploads[1].authorization, "Bearer rotated-child-evidence-credential");
  assert.equal(uploads[1].event.sessionKey, "agent:child");
  assert.equal(uploads[1].event.leaseEpoch, 1);
});

test("revoke before lazy spool creation leaves no upload or retry", async (t) => {
  const directory = await temporaryDirectory(t);
  const { publicKey } = generateKeyPairSync("ed25519");
  let fetchCalls = 0;
  const scheduled: Array<() => void> = [];
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("revoked evidence must not upload");
    },
    scheduleTimeout: (callback) => {
      scheduled.push(callback);
      return callback;
    },
    cancelTimeout: () => undefined,
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(activation(publicKey.export({ type: "spki", format: "pem" }).toString()));
  stopBeforeRemove(directory, () => runtime.stop());
  const stale = await runtime.lookup("agent:main");
  assert.equal(stale.state, "active");
  const entered = deferred();
  const release = deferred();
  let pauseNextLookup = true;
  runtime.lookup = async () => {
    if (pauseNextLookup) {
      pauseNextLookup = false;
      entered.resolve();
      await release.promise;
    }
    return stale;
  };

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-revoke", result: "ok", durationMs: 1 },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-revoke" },
  );
  await entered.promise;
  assert.equal(await runtime.revoke("lease-1"), true);
  release.resolve();
  await waitFor(async () => (
    await readFile(join(directory, "events.jsonl"), "utf8").catch(() => "")
  ).includes("call-revoke"));

  assert.equal(fetchCalls, 0);
  assert.equal(scheduled.length, 0);
});

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = join(
    tmpdir(),
    `agent-guard-event-spool-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(directory, { recursive: true });
  const stops: Array<() => void | Promise<void>> = [];
  temporaryDirectoryStops.set(directory, stops);
  t.after(async () => {
    try {
      for (const stop of stops) await stop();
    } finally {
      temporaryDirectoryStops.delete(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
  return directory;
}

const temporaryDirectoryStops = new Map<string, Array<() => void | Promise<void>>>();

function stopBeforeRemove(directory: string, stop: () => void | Promise<void>): void {
  const stops = temporaryDirectoryStops.get(directory);
  assert.ok(stops, "temporary directory cleanup must be registered");
  stops.push(stop);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function persistedEventIds(directory: string): Promise<string[]> {
  const text = await readFile(join(directory, "events.jsonl"), "utf8");
  return text.trim().length === 0
    ? []
    : text.trimEnd().split("\n").map((line) =>
      (JSON.parse(line) as NativeGuardEvent).eventId);
}

function nativeEvent(overrides: Partial<NativeGuardEvent> = {}): NativeGuardEvent {
  return {
    schemaVersion: "native-guard-1",
    eventId: "event-1",
    type: "tool_outcome",
    leaseId: "lease-1",
    leaseEpoch: 1,
    sessionKey: "agent:main",
    runId: "run-1",
    toolCallId: "call-1",
    timestamp: NOW,
    detail: {},
    ...overrides,
  };
}

function outcomeEvent(overrides: Partial<NativeGuardEvent> = {}): NativeGuardEvent {
  return nativeEvent({
    eventId: "outcome-1",
    detail: {
      finalParamsDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
      resultPreview: "ok",
      durationMs: 1,
      durationSource: "host",
    },
    ...overrides,
  });
}

function memoryMarkerStore() {
  const values: unknown[] = [];
  return {
    async load() { return structuredClone(values); },
    async write(marker: unknown) {
      values.splice(0, values.length, structuredClone(marker));
    },
    async remove() { values.splice(0, values.length); },
  };
}

async function activeRuntime(options: {
  spoolDir: string;
  emitEvent?: (event: NativeGuardEvent) => Promise<void> | void;
}): Promise<AgentGuardRuntime> {
  const { publicKey } = generateKeyPairSync("ed25519");
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: options.spoolDir,
    emitEvent: options.emitEvent,
    createId: (() => {
      let id = 0;
      return (prefix: string) => `${prefix}.${++id}`;
    })(),
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(activation(publicKey.export({ type: "spki", format: "pem" }).toString()));
  return runtime;
}

function activation(decisionPublicKey: string): NativeGuardLeaseActivation {
  return {
    schemaVersion: "native-guard-1",
    leaseId: "lease-1",
    leaseEpoch: 1,
    rootSessionKey: "agent:main",
    mode: "supervision",
    scope: "session_tree",
    policyPackId: "pack-1",
    policyPackDigest: "a".repeat(64),
    backendUrl: "http://127.0.0.1:4310/api/v1/openclaw/native-guard/decision",
    decisionPublicKey,
    failurePolicy: { lowRisk: "warn", highRisk: "deny", unknownRisk: "deny" },
    issuedAt: "2026-08-02T09:59:00.000Z",
    expiresAt: "2026-08-02T10:05:00.000Z",
    credential: "credential-secret",
    evidenceCredential: "separate-evidence-bearer",
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
