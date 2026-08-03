import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  NativeGuardEvidenceProof,
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeToolDecisionResponse,
} from "@agent-guard/contracts";
import {
  digestJson,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import {
  MAX_EVENT_SPOOL_BYTES,
  MAX_EVENT_SPOOL_EVENTS,
  createEventSpool,
  sanitizeOutcomeDiagnostic,
  sanitizeOutcomeResult,
  type EventSpool,
  type EventSpoolOptions,
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

test("result projection scrubs exact and generic secrets from object keys", () => {
  const exactSecret = "object-key-exact-secret";
  const collidingSecret = "object-key-colliding-secret";
  let getterCalls = 0;
  const result: Record<string, unknown> = {
    [`prefix-${exactSecret}-suffix`]: "ordinary",
    "Authorization: Bearer key-material": "ordinary",
    [exactSecret]: "first collision",
    [collidingSecret]: "second collision",
  };
  Object.defineProperty(result, `accessor-${exactSecret}`, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "must-not-be-read";
    },
  });

  const evidence = sanitizeOutcomeResult(result, [exactSecret, collidingSecret]);

  assert.equal(getterCalls, 0);
  assert.equal(evidence.resultPreview.includes(exactSecret), false);
  assert.equal(evidence.resultPreview.includes(collidingSecret), false);
  assert.equal(evidence.resultPreview.includes("key-material"), false);
  assert.match(evidence.resultPreview, /REDACTED/);
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

test("result projection debits escaped object keys before canonicalization", () => {
  const base: Record<string, unknown> = {};
  for (let index = 0; index < 1_024; index += 1) {
    base[`key-${String(index).padStart(4, "0")}-\"\\\u0001界-${"x".repeat(300)}`] = null;
  }

  const bounded = sanitizeOutcomeResult(base);
  const withUnreachableTail = sanitizeOutcomeResult({ ...base, zzTail: "must-not-affect-digest" });

  assert.equal(withUnreachableTail.resultDigest, bounded.resultDigest);
  assert.ok(bounded.projectionBytes <= 256 * 1024);
  assert.ok(withUnreachableTail.projectionBytes <= 256 * 1024);
});

test("diagnostic sanitizer redacts an unterminated private key marker", () => {
  const diagnostic = sanitizeOutcomeDiagnostic([
    "tool failed",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "private-material-that-must-not-survive",
  ].join("\n"));

  assert.equal(diagnostic.includes("private-material-that-must-not-survive"), false);
  assert.match(diagnostic, /REDACTED PRIVATE KEY/);

  const pkcs8 = sanitizeOutcomeDiagnostic(
    "prefix\r\n-----BEGIN PRIVATE KEY-----\r\nactual-pkcs8-private-material",
  );
  assert.equal(pkcs8.includes("actual-pkcs8-private-material"), false);
});

test("large outcome strings are bounded before scrubbing and redact a boundary secret", () => {
  const secret = "boundary-secret-value";
  const prefix = "x".repeat(32 * 1024 - 8);
  const evidence = sanitizeOutcomeResult(`${prefix}${secret}${"tail".repeat(1_000_000)}`, [secret]);

  assert.ok(evidence.projectionBytes <= 256 * 1024);
  assert.equal(evidence.resultPreview.includes(secret), false);
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

test("a spool directory has exactly one live owner", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
  });
  const second = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => second.stop());
  stopBeforeRemove(directory, () => first.stop());

  assert.equal(await first.enqueue(outcomeEvent({ eventId: "first-owner" })), true);
  await assert.rejects(
    second.enqueue(outcomeEvent({ eventId: "second-owner" })),
    /spool ownership is unavailable/i,
  );
});

test("concurrent spool claims have exactly one winner and one persisted event", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  const second = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => second.stop());
  stopBeforeRemove(directory, () => first.stop());

  const outcomes = await Promise.allSettled([
    first.enqueue(outcomeEvent({ eventId: "claim-first" })),
    second.enqueue(outcomeEvent({ eventId: "claim-second" })),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await persistedEventIds(directory)).length, 1);
});

test("spool ownership is released on stop and pending state is loaded once", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  await first.enqueue(outcomeEvent({ eventId: "handoff-pending" }));
  await first.stop();

  const uploaded: string[] = [];
  const second = createEventSpool({
    directory,
    upload: async (_lease, events) => {
      uploaded.push(...events.map(({ eventId }) => eventId));
    },
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => second.stop());
  await second.flushNow();

  assert.deepEqual(uploaded, ["handoff-pending"]);
  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
});

test("failed owner hardening rolls back the claim for a new spool", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    hardenOwnerFile: async () => {
      throw new Error("owner hardening failed");
    },
  });
  stopBeforeRemove(directory, () => first.stop());

  await assert.rejects(first.acquire(), /owner hardening failed/i);
  await assert.rejects(
    readFile(join(directory, "owner.lock"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const second = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
  });
  stopBeforeRemove(directory, () => second.stop());
  await second.acquire();
});

test("failed acquisition cleanup remains incomplete until stop retries it", async (t) => {
  const directory = await temporaryDirectory(t);
  let removeAttempts = 0;
  let releasePath: string | undefined;
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    hardenOwnerFile: async () => {
      throw new Error("owner hardening failed");
    },
    renameOwnerFile: async (source, destination) => {
      releasePath = destination;
      await rename(source, destination);
    },
    removeOwnerFile: async (path) => {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        throw Object.assign(new Error("owner remove busy"), { code: "EBUSY" });
      }
      await rm(path);
    },
  });
  stopBeforeRemove(directory, () => spool.stop());

  await assert.rejects(spool.acquire(), /owner hardening failed/i);
  assert.ok(releasePath);
  assert.match(await readFile(releasePath, "utf8"), /native-event-spool-owner-1/);
  await assert.rejects(readFile(join(directory, "owner.lock"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(spool.acquire(), /ownership acquisition is incomplete/i);
  assert.equal(removeAttempts, 1);

  await spool.stop();
  assert.equal(removeAttempts, 2);
  await assert.rejects(
    readFile(join(directory, "owner.lock"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("owner read failure retries its private quarantine without touching a replacement owner", async (t) => {
  const directory = await temporaryDirectory(t);
  let releasePath: string | undefined;
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    renameOwnerFile: async (source, destination) => {
      await rename(source, destination);
      releasePath = destination;
    },
  });
  stopBeforeRemove(directory, () => spool.stop());
  await spool.acquire();
  const ownerPath = join(directory, "owner.lock");
  const originalOwner = await readFile(ownerPath, "utf8");
  await writeFile(ownerPath, "unsafe-owner\n");

  await assert.rejects(spool.stop(), /spool ownership is unsafe/i);
  assert.ok(releasePath);
  const replacementToken = "00000000-0000-4000-8000-000000000098";
  await writeFile(ownerPath, `${JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: process.pid,
    token: replacementToken,
  })}\n`, { mode: 0o600 });
  await writeFile(releasePath, originalOwner);
  await spool.stop();

  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, replacementToken);
  const blocked = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => blocked.stop());
  await assert.rejects(blocked.acquire(), /spool ownership is unavailable/i);
});

test("repeated stop retries a transient owner removal failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const ownerPath = join(directory, "owner.lock");
  let removeAttempts = 0;
  let renameAttempts = 0;
  let releasePath: string | undefined;
  const transient = Object.assign(new Error("owner remove busy"), { code: "EBUSY" });
  const first = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    renameOwnerFile: async (source, destination) => {
      renameAttempts += 1;
      releasePath = destination;
      await rename(source, destination);
    },
    removeOwnerFile: async (path) => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw transient;
      await rm(path);
    },
  });
  stopBeforeRemove(directory, () => first.stop());
  await first.acquire();

  await assert.rejects(first.stop(), (error) => error === transient);
  assert.equal(removeAttempts, 1);
  assert.ok(releasePath);
  assert.match(await readFile(releasePath, "utf8"), /native-event-spool-owner-1/);
  await assert.rejects(readFile(ownerPath, "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await first.stop();
  assert.equal(removeAttempts, 2);
  assert.equal(renameAttempts, 1);
  const second = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => second.stop());
  await second.acquire();
});

test("owner release never removes a replacement owner after the canonical path is renamed", async (t) => {
  const directory = await temporaryDirectory(t);
  const ownerPath = join(directory, "owner.lock");
  const replacement = JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: process.pid + 1,
    token: "00000000-0000-4000-8000-000000000099",
  });
  let renamed = false;
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    renameOwnerFile: async (source, destination) => {
      await rename(source, destination);
      if (!renamed && source === ownerPath) {
        renamed = true;
        await writeFile(ownerPath, `${replacement}\n`, { mode: 0o600 });
      }
    },
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.acquire();
  await spool.stop();

  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token,
    "00000000-0000-4000-8000-000000000099");
  const blocked = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => blocked.stop());
  await assert.rejects(blocked.acquire(), /spool ownership is unavailable/i);
});

test("owner removal retry stays on its private quarantine when a replacement owner exists", async (t) => {
  const directory = await temporaryDirectory(t);
  const ownerPath = join(directory, "owner.lock");
  const replacementToken = "00000000-0000-4000-8000-000000000097";
  const replacement = JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: process.pid,
    token: replacementToken,
  });
  const transient = Object.assign(new Error("owner remove busy"), { code: "EBUSY" });
  let renameAttempts = 0;
  let removeAttempts = 0;
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    renameOwnerFile: async (source, destination) => {
      renameAttempts += 1;
      await rename(source, destination);
      if (renameAttempts === 1) {
        await writeFile(ownerPath, `${replacement}\n`, { mode: 0o600 });
      }
    },
    removeOwnerFile: async (path) => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw transient;
      await rm(path);
    },
  });
  stopBeforeRemove(directory, () => spool.stop());
  await spool.acquire();

  await assert.rejects(spool.stop(), (error) => error === transient);
  await spool.stop();

  assert.equal(renameAttempts, 1);
  assert.equal(removeAttempts, 2);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, replacementToken);
  const blocked = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => blocked.stop());
  await assert.rejects(blocked.acquire(), /spool ownership is unavailable/i);
});

test("owner release restores and preserves a mismatched quarantined owner", async (t) => {
  const directory = await temporaryDirectory(t);
  const replacement = JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: process.pid,
    token: "00000000-0000-4000-8000-0000000000aa",
  });
  let tampered = false;
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    renameOwnerFile: async (source, destination) => {
      await rename(source, destination);
      if (!tampered) {
        tampered = true;
        await writeFile(destination, `${replacement}\n`, { mode: 0o600 });
      }
    },
  });
  t.after(() => spool.stop());

  await spool.acquire();
  await assert.rejects(spool.stop(), /ownership changed during release/i);
  assert.equal(JSON.parse(await readFile(join(directory, "owner.lock"), "utf8")).token,
    "00000000-0000-4000-8000-0000000000aa");
});

test("failed owner sync keeps an incomplete claim retryable through stop", async (t) => {
  const directory = await temporaryDirectory(t);
  let removeAttempts = 0;
  let releasePath: string | undefined;
  const transient = Object.assign(new Error("owner remove busy"), { code: "EBUSY" });
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    syncOwnerFile: async () => { throw new Error("owner sync failed"); },
    renameOwnerFile: async (source, destination) => {
      releasePath = destination;
      await rename(source, destination);
    },
    removeOwnerFile: async (path) => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw transient;
      await rm(path);
    },
  });
  stopBeforeRemove(directory, () => spool.stop());

  await assert.rejects(spool.acquire(), /owner sync failed/i);
  assert.ok(releasePath);
  assert.match(await readFile(releasePath, "utf8"), /native-event-spool-owner-1/);
  await assert.rejects(readFile(join(directory, "owner.lock"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(spool.acquire(), /ownership acquisition is incomplete/i);
  await spool.stop();
  assert.equal(removeAttempts, 2);
  await assert.rejects(readFile(join(directory, "owner.lock"), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("activation rollback retains a spool reference when owner release is transiently unavailable", async (t) => {
  const directory = await temporaryDirectory(t);
  const markerStore = memoryMarkerStore();
  markerStore.write = async () => { throw new Error("activation failed"); };
  let removeAttempts = 0;
  const transient = Object.assign(new Error("owner remove busy"), { code: "EBUSY" });
  const runtime = new AgentGuardRuntime({
    markerStore,
    now: () => new Date(NOW),
    spoolDir: directory,
    createEventSpool: (options: EventSpoolOptions) => createEventSpool({
      ...options,
      removeOwnerFile: async (path) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw transient;
        await rm(path);
      },
    }),
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  const { publicKey } = generateKeyPairSync("ed25519");

  await assert.rejects(runtime.activate(activation(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  )), /activation failed/);
  await runtime.stop();
  assert.equal(removeAttempts, 2);

  const second = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => second.stop());
  await second.acquire();
});

test("runtime stop exposes a spool release failure and retries it on repeated stop", async () => {
  const transient = Object.assign(new Error("spool release busy"), { code: "EBUSY" });
  let stopCalls = 0;
  const spool = fakeEventSpool(async () => {
    stopCalls += 1;
    if (stopCalls === 1) throw transient;
  });
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    createEventSpool: () => spool,
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  const { publicKey } = generateKeyPairSync("ed25519");
  await runtime.activate(activation(publicKey.export({ type: "spki", format: "pem" }).toString()));

  await assert.rejects(runtime.stop(), (error) => error === transient);
  await runtime.stop();

  assert.equal(stopCalls, 2);
});

test("runtime restart retries a failed spool release before discarding the spool", async () => {
  const transient = Object.assign(new Error("spool release busy"), { code: "EBUSY" });
  let stopCalls = 0;
  const spool = fakeEventSpool(async () => {
    stopCalls += 1;
    if (stopCalls === 1) throw transient;
  });
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    createEventSpool: () => spool,
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  const { publicKey } = generateKeyPairSync("ed25519");
  await runtime.activate(activation(publicKey.export({ type: "spki", format: "pem" }).toString()));

  await assert.rejects(runtime.stop(), (error) => error === transient);
  await runtime.start();

  assert.equal(stopCalls, 2);
  await runtime.stop();
});

test("unsafe owner symlink fails before spool data is loaded", async (t) => {
  const directory = await temporaryDirectory(t);
  const target = join(directory, "owner-target");
  await writeFile(target, "not-an-owner", { mode: 0o600 });
  try {
    await symlink(target, join(directory, "owner.lock"), "file");
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows symlink creation requires Developer Mode or elevation");
      return;
    }
    throw error;
  }
  await writeFile(join(directory, "events.jsonl"), "not-json\n", { mode: 0o600 });
  const spool = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  stopBeforeRemove(directory, () => spool.stop());

  await assert.rejects(spool.flushNow(), /spool ownership is unsafe/i);
});

test("runtime acquires profile spool ownership before committing activation", async (t) => {
  const directory = await temporaryDirectory(t);
  const decisionKeys = generateKeyPairSync("ed25519");
  const lease = activation(
    decisionKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  const first = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
  });
  const second = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
  });
  first.finalizeRegistrationAttestation(true);
  second.finalizeRegistrationAttestation(true);
  await first.start();
  await second.start();
  stopBeforeRemove(directory, () => second.stop());
  stopBeforeRemove(directory, () => first.stop());

  await first.activate(lease);
  await assert.rejects(second.activate({ ...lease, leaseId: "lease-second" }), /spool ownership/i);
  assert.deepEqual(await second.lookup(lease.rootSessionKey), { state: "off" });
});

test("an independent process excludes the parent until ownership is released", async (t) => {
  const directory = await temporaryDirectory(t);
  const script = `
    import { createEventSpool } from './plugins/agent-guard-supervision/src/eventSpool.ts';
    const spool = createEventSpool({
      directory: ${JSON.stringify(directory)},
      upload: async () => undefined,
      autoFlush: false,
    });
    await spool.acquire();
    process.stdout.write('acquired\\n');
    process.stdin.resume();
    process.stdin.once('end', async () => {
      await spool.stop();
      process.exit(0);
    });
  `;
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
  ], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { if (!child.killed) child.kill(); });
  const [chunk] = await once(child.stdout, "data") as [Buffer];
  assert.match(chunk.toString("utf8"), /acquired/);

  const parent = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
  await assert.rejects(parent.acquire(), /spool ownership is unavailable/i);

  child.stdin.end();
  const [exitCode] = await once(child, "exit") as [number | null];
  assert.equal(exitCode, 0);
  await parent.acquire();
  await parent.stop();
});

test("dead owner recovery is bounded while a live PID fails before spool loading", async (t) => {
  const staleDirectory = await temporaryDirectory(t);
  await writeFile(join(staleDirectory, "owner.lock"), `${JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: 2_147_483_647,
    token: "00000000-0000-4000-8000-000000000001",
  })}\n`, { mode: 0o600 });
  const recovered = createEventSpool({
    directory: staleDirectory,
    upload: async () => undefined,
    autoFlush: false,
  });
  stopBeforeRemove(staleDirectory, () => recovered.stop());
  await recovered.acquire();
  const recoveredOwner = JSON.parse(
    await readFile(join(staleDirectory, "owner.lock"), "utf8"),
  ) as { pid: number };
  assert.equal(recoveredOwner.pid, process.pid);

  const liveDirectory = await temporaryDirectory(t);
  await writeFile(join(liveDirectory, "owner.lock"), `${JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: process.pid,
    token: "00000000-0000-4000-8000-000000000002",
  })}\n`, { mode: 0o600 });
  await writeFile(join(liveDirectory, "events.jsonl"), "not-json\n", { mode: 0o600 });
  const blocked = createEventSpool({
    directory: liveDirectory,
    upload: async () => undefined,
    autoFlush: false,
  });
  stopBeforeRemove(liveDirectory, () => blocked.stop());
  await assert.rejects(blocked.flushNow(), /spool ownership is unavailable/i);
});

test("dead owner recovery rejects empty or oversized recovery gates", async (t) => {
  for (const [label, gateContents] of [
    ["empty", ""],
    ["oversized", "x".repeat(2_049)],
  ] as const) {
    const directory = await temporaryDirectory(t);
    await writeFile(join(directory, "owner.lock"), `${JSON.stringify({
      schemaVersion: "native-event-spool-owner-1",
      pid: 2_147_483_647,
      token: "00000000-0000-4000-8000-000000000004",
    })}\n`, { mode: 0o600 });
    await writeFile(join(directory, "owner.lock.recovery"), gateContents, { mode: 0o600 });
    const spool = createEventSpool({ directory, upload: async () => undefined, autoFlush: false });
    stopBeforeRemove(directory, () => spool.stop());
    await assert.rejects(spool.acquire(), /spool ownership is unsafe/i, label);
  }
});

test("N-way stale owner recovery elects exactly one claimant", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, "owner.lock"), `${JSON.stringify({
    schemaVersion: "native-event-spool-owner-1",
    pid: 2_147_483_647,
    token: "00000000-0000-4000-8000-000000000003",
  })}\n`, { mode: 0o600 });
  const contenders = Array.from({ length: 8 }, () => createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
  }));
  t.after(async () => {
    await Promise.allSettled(contenders.map((spool) => spool.stop()));
  });

  const outcomes = await Promise.allSettled(contenders.map((spool) => spool.acquire()));
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 7);
  const owner = JSON.parse(await readFile(join(directory, "owner.lock"), "utf8")) as {
    pid: number;
  };
  assert.equal(owner.pid, process.pid);
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

  const ancestorTarget = join(root, "ancestor-target");
  const ancestorLink = join(root, "ancestor-link");
  await mkdir(ancestorTarget);
  await symlink(ancestorTarget, ancestorLink, "junction");
  const ancestorSpool = createEventSpool({
    directory: join(ancestorLink, "nested-spool"),
    upload: async () => undefined,
    autoFlush: false,
  });
  await assert.rejects(ancestorSpool.enqueue(outcomeEvent()), /symlink|directory/i);
  await assert.rejects(lstat(join(ancestorTarget, "nested-spool")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT");

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
    onCorruptData: (reason) => { assert.equal(reason, "oversized"); },
  });
  stopBeforeRemove(oversizedDirectory, () => oversized.stop());
  await oversized.flushNow();
  assert.equal(await readFile(join(oversizedDirectory, "events.jsonl"), "utf8"), "");
});

test("complete corrupt event data is quarantined into an empty spool with a fixed alert", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, "events.jsonl"), "{\"secret\":\"must-not-escape\"}\n");
  const alerts: string[] = [];
  const spool = createEventSpool({
    directory,
    upload: async () => undefined,
    autoFlush: false,
    onCorruptData: (reason) => { alerts.push(reason); },
  });
  stopBeforeRemove(directory, () => spool.stop());

  await spool.flushNow();

  const files = await readdir(directory);
  assert.equal(files.some((name) => /^events\.jsonl\.corrupt-[0-9a-f-]{36}$/.test(name)), true);
  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
  assert.deepEqual(alerts, ["corrupt"]);
  assert.equal(files.join(" ").includes("must-not-escape"), false);
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

test("unsigned forged event acknowledgement cannot remove persisted evidence", async (t) => {
  const directory = await temporaryDirectory(t);
  const decisionKeys = generateKeyPairSync("ed25519");
  const evidenceKeys = generateKeyPairSync("ed25519");
  const uploadEntered = deferred();
  const releaseUpload = deferred();
  let spool: EventSpool | undefined;
  let proofVerified = false;
  const proofIds: string[] = [];
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    fetch: async (_input, init) => {
      uploadEntered.resolve();
      await releaseUpload.promise;
      const body = JSON.parse(String(init?.body)) as { events: NativeGuardEvent[] };
      const proof = decodeEvidenceProof(init);
      proofIds.push(proof.proofId);
      const { signature, ...unsignedProof } = proof;
      proofVerified = verifyNativeGuardPayload(unsignedProof, signature, evidenceKeys.publicKey);
      return new Response(JSON.stringify({
        ok: true,
        data: {
          schemaVersion: "native-guard-1",
          signatureContext: "native_guard.evidence_ack.v1",
          ackId: "ack.forged-event",
          ackType: "events_accepted",
          proofId: proof.proofId,
          leaseId: proof.leaseId,
          leaseEpoch: proof.leaseEpoch,
          bodyDigest: digestJson(body),
          accepted: body.events.length,
          eventIdsDigest: digestJson(body.events.map(({ eventId }) => eventId)),
          acknowledgedAt: NOW,
        },
        requestId: "forged-event-ack",
      }), { headers: { "content-type": "application/json" } });
    },
    createEventSpool: (options) => {
      spool = createEventSpool(options);
      return spool;
    },
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(activation(
    decisionKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    {
      evidenceSigningKeyId: "evidence.event-test",
      evidenceSigningPrivateKey: evidenceKeys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString(),
    },
  ));
  stopBeforeRemove(directory, () => runtime.stop());

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-forged-ack", result: "ok" },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-forged-ack" },
  );
  await uploadEntered.promise;
  assert.ok(spool);
  releaseUpload.resolve();
  await spool.flushNow();

  assert.equal(proofVerified, true);
  assert.ok(proofIds.length >= 2);
  assert.equal(new Set(proofIds).size, proofIds.length);
  assert.match(await readFile(join(directory, "events.jsonl"), "utf8"), /call-forged-ack/);
});

test("valid signed event acknowledgement removes exactly the acknowledged evidence", async (t) => {
  const directory = await temporaryDirectory(t);
  const decisionKeys = generateKeyPairSync("ed25519");
  const evidenceKeys = generateKeyPairSync("ed25519");
  let proofVerified = false;
  let spool: EventSpool | undefined;
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { events: NativeGuardEvent[] };
      const proof = decodeEvidenceProof(init);
      const { signature: proofSignature, ...unsignedProof } = proof;
      proofVerified = verifyNativeGuardPayload(unsignedProof, proofSignature, evidenceKeys.publicKey);
      const unsignedAck = {
        schemaVersion: "native-guard-1" as const,
        signatureContext: "native_guard.evidence_ack.v1" as const,
        ackId: "ack.event.valid",
        ackType: "events_accepted" as const,
        proofId: proof.proofId,
        leaseId: proof.leaseId,
        leaseEpoch: proof.leaseEpoch,
        bodyDigest: digestJson(body),
        accepted: body.events.length,
        eventIdsDigest: digestJson(body.events.map(({ eventId }) => eventId)),
        acknowledgedAt: NOW,
      };
      return new Response(JSON.stringify({
        ok: true,
        data: {
          ...unsignedAck,
          signature: signNativeGuardPayload(unsignedAck, decisionKeys.privateKey),
        },
        requestId: "event-ack-valid",
      }), { headers: { "content-type": "application/json" } });
    },
    createEventSpool: (options) => {
      spool = createEventSpool(options);
      return spool;
    },
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(activation(
    decisionKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    {
      evidenceSigningKeyId: "evidence.event-valid",
      evidenceSigningPrivateKey: evidenceKeys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString(),
    },
  ));
  stopBeforeRemove(directory, () => runtime.stop());

  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-valid-ack", result: "ok" },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-valid-ack" },
  );
  await waitFor(() => proofVerified);
  assert.ok(spool);
  await spool.flushNow();

  assert.equal(await readFile(join(directory, "events.jsonl"), "utf8"), "");
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
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
      const proof = decodeEvidenceProof(init);
      const unsignedAck = {
        schemaVersion: "native-guard-1" as const,
        signatureContext: "native_guard.evidence_ack.v1" as const,
        ackId: "ack.event-renewed",
        ackType: "events_accepted" as const,
        proofId: proof.proofId,
        leaseId: proof.leaseId,
        leaseEpoch: proof.leaseEpoch,
        bodyDigest: proof.bodyDigest,
        accepted: body.events.length,
        eventIdsDigest: digestJson(body.events.map(({ eventId }) => eventId)),
        acknowledgedAt: NOW,
      };
      return new Response(JSON.stringify({
        ok: true,
        data: {
          ...unsignedAck,
          signature: signNativeGuardPayload(unsignedAck, privateKey),
        },
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
    ...renewedEvidenceIdentity("evidence.event-renewed"),
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
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
      const proof = decodeEvidenceProof(init);
      const unsignedAck = {
        schemaVersion: "native-guard-1" as const,
        signatureContext: "native_guard.evidence_ack.v1" as const,
        ackId: "ack.event-child-ended",
        ackType: "events_accepted" as const,
        proofId: proof.proofId,
        leaseId: proof.leaseId,
        leaseEpoch: proof.leaseEpoch,
        bodyDigest: proof.bodyDigest,
        accepted: body.events.length,
        eventIdsDigest: digestJson(body.events.map(({ eventId }) => eventId)),
        acknowledgedAt: NOW,
      };
      return new Response(JSON.stringify({
        ok: true,
        data: {
          ...unsignedAck,
          signature: signNativeGuardPayload(unsignedAck, privateKey),
        },
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
    ...renewedEvidenceIdentity("evidence.child-renewed"),
    issuedAt: NOW,
    expiresAt: "2026-08-02T10:06:00.000Z",
  });
  await waitFor(() => uploads.length === 2);

  assert.equal(uploads[1].authorization, "Bearer rotated-child-evidence-credential");
  assert.equal(uploads[1].event.sessionKey, "agent:child");
  assert.equal(uploads[1].event.leaseEpoch, 1);
});

test("late root outcome drains through the in-memory evidence tombstone", async (t) => {
  const directory = await temporaryDirectory(t);
  const decisionKeys = generateKeyPairSync("ed25519");
  const evidenceKeys = generateKeyPairSync("ed25519");
  const uploaded: NativeGuardEvent[] = [];
  let proofVerified = false;
  const lease = activation(
    decisionKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    {
      evidenceSigningKeyId: "evidence.root-late",
      evidenceSigningPrivateKey: evidenceKeys.privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString(),
    },
  );
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
    spoolDir: directory,
    decisionClient: {
      async decide({ request }) {
        return {
          schemaVersion: "native-guard-1",
          decisionId: "decision.root-late",
          requestId: request.requestId,
          leaseId: request.leaseId,
          leaseEpoch: request.leaseEpoch,
          policyPackId: lease.policyPackId,
          policyPackDigest: lease.policyPackDigest,
          action: "allow",
          reasonCode: "policy_allow",
          reason: "allowed",
          evaluatedParamsDigest: request.paramsDigest,
          decidedAt: NOW,
          signature: "trusted-test-client",
        } satisfies NativeToolDecisionResponse;
      },
    },
    lifecycleClient: {
      async bindChild() { return; },
      async endSession() { return; },
    },
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { events: NativeGuardEvent[] };
      uploaded.push(...body.events);
      const proof = decodeEvidenceProof(init);
      const { signature: proofSignature, ...unsignedProof } = proof;
      proofVerified = verifyNativeGuardPayload(unsignedProof, proofSignature, evidenceKeys.publicKey);
      const unsignedAck = {
        schemaVersion: "native-guard-1" as const,
        signatureContext: "native_guard.evidence_ack.v1" as const,
        ackId: "ack.root-late",
        ackType: "events_accepted" as const,
        proofId: proof.proofId,
        leaseId: proof.leaseId,
        leaseEpoch: proof.leaseEpoch,
        bodyDigest: digestJson(body),
        accepted: body.events.length,
        eventIdsDigest: digestJson(body.events.map(({ eventId }) => eventId)),
        acknowledgedAt: NOW,
      };
      return new Response(JSON.stringify({
        ok: true,
        data: {
          ...unsignedAck,
          signature: signNativeGuardPayload(unsignedAck, decisionKeys.privateKey),
        },
        requestId: "request.root-late",
      }), { headers: { "content-type": "application/json" } });
    },
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(lease);
  stopBeforeRemove(directory, () => runtime.stop());

  assert.equal(await runtime.beforeToolCall(
    { toolName: "read", params: {}, toolCallId: "call-root-late" },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-root-late" },
  ), undefined);
  await waitFor(() => uploaded.some(({ type }) => type === "decision"));
  uploaded.length = 0;
  assert.equal(await runtime.endSession("agent:main"), true);
  assert.equal((await runtime.lookup("agent:main")).state, "root_ended");
  runtime.afterToolCall(
    { toolName: "read", params: {}, toolCallId: "call-root-late", result: "ok", durationMs: 3 },
    { toolName: "read", sessionKey: "agent:main", toolCallId: "call-root-late" },
  );
  await waitFor(() => uploaded.some(({ type }) => type === "tool_outcome"));

  assert.equal(proofVerified, true);
  const outcome = uploaded.find(({ type }) => type === "tool_outcome");
  assert.equal(outcome?.leaseEpoch, lease.leaseEpoch);
  await waitFor(async () => (await readFile(join(directory, "events.jsonl"), "utf8")) === "");
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

function fakeEventSpool(stop: () => Promise<void>): EventSpool {
  return {
    async acquire() { return; },
    async enqueue() { return true; },
    async flushNow() { return; },
    leaseRenewed() { return; },
    cancelLease() { return; },
    stop,
  };
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

function activation(
  decisionPublicKey: string,
  overrides: Partial<NativeGuardLeaseActivation> = {},
): NativeGuardLeaseActivation {
  const { privateKey: evidencePrivateKey } = generateKeyPairSync("ed25519");
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
    evidenceSigningKeyId: "evidence.event-default",
    evidenceSigningPrivateKey: evidencePrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ...overrides,
  };
}

function renewedEvidenceIdentity(keyId: string): Pick<
  NativeGuardLeaseActivation,
  "evidenceSigningKeyId" | "evidenceSigningPrivateKey"
> {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    evidenceSigningKeyId: keyId,
    evidenceSigningPrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function decodeEvidenceProof(init: RequestInit | undefined): NativeGuardEvidenceProof {
  const headers = init?.headers as Record<string, string> | undefined;
  const encoded = headers?.["X-Agent-Guard-Evidence-Proof"] ??
    headers?.["x-agent-guard-evidence-proof"] ?? "";
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as NativeGuardEvidenceProof;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
