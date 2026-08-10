import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import test from "node:test";
import type { NativeGuardLeaseActivation } from "@agent-guard/contracts";
import {
  LeaseRegistry,
  FileMarkerStore,
  isTrustedPosixAncestorMetadata,
  type GuardedMarker,
  type MarkerStore,
} from "./leaseRegistry";

const NOW = "2026-08-02T00:00:00.000Z";
const MAX_MARKER_BYTES = 64 * 1024;

class MemoryMarkerStore implements MarkerStore {
  readonly markers = new Map<string, unknown>();
  writes: GuardedMarker[] = [];
  removes: string[] = [];
  removeAttempts: string[] = [];
  failWrite = false;
  failRemove = false;
  readonly failRemoveLeaseIds = new Set<string>();

  constructor(markers: unknown[] = []) {
    for (const marker of markers) {
      const leaseId = (marker as { leaseId?: unknown }).leaseId;
      const preferredKey = typeof leaseId === "string" ? leaseId : `invalid-${this.markers.size}`;
      const key = this.markers.has(preferredKey) ? `duplicate-${this.markers.size}` : preferredKey;
      this.markers.set(key, marker);
    }
  }

  async load(): Promise<unknown[]> {
    return [...this.markers.values()];
  }

  async write(marker: GuardedMarker): Promise<void> {
    if (this.failWrite) throw new Error("marker write failed");
    this.writes.push(structuredClone(marker));
    this.markers.set(marker.leaseId, structuredClone(marker));
  }

  async remove(leaseId: string): Promise<void> {
    this.removeAttempts.push(leaseId);
    if (this.failRemove || this.failRemoveLeaseIds.has(leaseId)) throw new Error("marker remove failed");
    this.removes.push(leaseId);
    this.markers.delete(leaseId);
  }
}

class QueueNamedTransientStore extends MemoryMarkerStore {
  readonly transientError = new Error("queue exceeds transient storage quota");
  failNextWrite = false;

  override async write(marker: GuardedMarker): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw this.transientError;
    }
    await super.write(marker);
  }
}

const DECISION_KEY_PAIR = generateKeyPairSync("ed25519");
const DECISION_PUBLIC_KEY = DECISION_KEY_PAIR.publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const DECISION_PRIVATE_KEY = DECISION_KEY_PAIR.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const EVIDENCE_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();
const RENEWED_EVIDENCE_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

const RENEWED_EVIDENCE_IDENTITY = {
  evidenceSigningKeyId: "evidence.registry-test.renewed",
  evidenceSigningPrivateKey: RENEWED_EVIDENCE_PRIVATE_KEY,
} as const;

function activation(
  overrides: Partial<NativeGuardLeaseActivation> = {},
): NativeGuardLeaseActivation {
  return {
    schemaVersion: "native-guard-1",
    leaseId: "lease.1",
    leaseEpoch: 1,
    rootSessionKey: "agent:guard:root.1",
    mode: "supervision",
    scope: "session_tree",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
    decisionPublicKey: DECISION_PUBLIC_KEY,
    failurePolicy: {
      lowRisk: "warn",
      highRisk: "deny",
      unknownRisk: "deny",
    },
    issuedAt: NOW,
    expiresAt: "2026-08-02T00:05:00.000Z",
    credential: "credential.1",
    evidenceCredential: "evidence-credential.1",
    evidenceSigningKeyId: "evidence.registry-test",
    evidenceSigningPrivateKey: EVIDENCE_PRIVATE_KEY,
    ...overrides,
  };
}

function marker(overrides: Partial<GuardedMarker> = {}): GuardedMarker {
  const rootSessionKey = overrides.rootSessionKey ?? "agent:guard:root.1";
  return {
    leaseId: "lease.1",
    rootSessionKey,
    childSessionKeys: [],
    mode: "supervision",
    scope: { kind: "session", sessionKey: rootSessionKey },
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T00:05:00.000Z",
    ...overrides,
  } as GuardedMarker;
}

function agentActivation(
  overrides: Partial<NativeGuardLeaseActivation> = {},
): NativeGuardLeaseActivation {
  return activation({
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
    ...overrides,
  });
}

function lifecycleMarkerBytes(value: GuardedMarker): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

function lifecycleMarkerBoundary(extraReservedBytes: 0 | 1): {
  baseQueue: NonNullable<GuardedMarker["lifecycleQueue"]>;
  baseMarker: GuardedMarker;
  candidate: Extract<NonNullable<GuardedMarker["lifecycleIntent"]>, { kind: "bind_child" }>;
  candidateMarker: GuardedMarker;
  reservedCandidateMarker: GuardedMarker;
} {
  const rootSessionKey = "agent:guard:root.1";
  const committedChildSessionKey = "agent:guard:committed";
  const committedTree = {
    childSessionKeys: [committedChildSessionKey],
    sessionBindings: [{
      childSessionKey: committedChildSessionKey,
      parentSessionKey: rootSessionKey,
    }],
  };
  const baseQueue = Array.from({ length: 110 }, (_, index) => ({
    kind: "bind_child" as const,
    parentSessionKey: rootSessionKey,
    childSessionKey: `agent:guard:queued-${String(index).padStart(3, "0")}-`.padEnd(500, "x"),
  }));
  const childPrefix = "agent:guard:boundary-";
  const minimumCandidate = {
    kind: "bind_child" as const,
    parentSessionKey: rootSessionKey,
    childSessionKey: childPrefix,
  };
  const minimumQueue = [...baseQueue, minimumCandidate];
  const minimumReservedMarker = marker({
    leaseEpoch: 1,
    ...committedTree,
    lifecycleIntent: minimumQueue[0],
    lifecycleQueue: minimumQueue,
    lifecycleOverflow: true,
  });
  const paddingLength = MAX_MARKER_BYTES + extraReservedBytes -
    lifecycleMarkerBytes(minimumReservedMarker);
  assert.ok(paddingLength >= 0);
  assert.ok(childPrefix.length + paddingLength <= 512);

  const candidate = {
    ...minimumCandidate,
    childSessionKey: `${childPrefix}${"x".repeat(paddingLength)}`,
  };
  const queue = [...baseQueue, candidate];
  const candidateMarker = marker({
    leaseEpoch: 1,
    ...committedTree,
    lifecycleIntent: queue[0],
    lifecycleQueue: queue,
  });
  const baseMarker = marker({
    leaseEpoch: 1,
    ...committedTree,
    lifecycleIntent: baseQueue[0],
    lifecycleQueue: baseQueue,
  });
  const reservedCandidateMarker = { ...candidateMarker, lifecycleOverflow: true as const };
  assert.equal(
    lifecycleMarkerBytes(reservedCandidateMarker),
    MAX_MARKER_BYTES + extraReservedBytes,
  );
  return { baseQueue, baseMarker, candidate, candidateMarker, reservedCandidateMarker };
}

test("missing lease lookup returns exact zero-effect OFF after start", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

  await registry.start();

  assert.deepEqual(await registry.lookup("agent:guard:missing"), { state: "off" });
  assert.equal(store.writes.length, 0);
  assert.equal(store.removes.length, 0);
});

test("restart with an unexpired marker returns recovery and never active", async () => {
  const store = new MemoryMarkerStore([marker()]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

  await registry.start();

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), {
    state: "recovery",
    leaseId: "lease.1",
    rootSessionKey: "agent:guard:root.1",
    mode: "supervision",
    scope: { kind: "session", sessionKey: "agent:guard:root.1" },
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T00:05:00.000Z",
  });
  assert.equal(store.writes.length, 0);
});

test("startup rejects an invalid injected clock instead of loading recovery indefinitely", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([marker()]),
    now: () => new Date(Number.NaN),
  });

  await assert.rejects(registry.start(), /clock/i);
  await assert.rejects(registry.lookup("agent:guard:root.1"), /has not started/);
});

test("active registry boundaries fail closed when the clock becomes invalid", async () => {
  let now = new Date(NOW);
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore(),
    now: () => now,
  });
  await registry.start();
  await registry.activate(activation());
  now = new Date(Number.NaN);

  await assert.rejects(registry.lookup("agent:guard:root.1"), /clock/i);
  await assert.rejects(registry.status(), /clock/i);
  await assert.rejects(registry.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  ), /clock/i);
});

test("activation clones and freezes secrets in memory and persists only the guarded marker", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  const input = activation();
  await registry.start();

  await registry.activate(input);
  input.credential = "mutated";
  input.failurePolicy.lowRisk = "allow";

  const active = await registry.lookup("agent:guard:root.1");
  assert.equal(active.state, "active");
  if (active.state !== "active") assert.fail("expected active lease");
  assert.equal(active.credential, "credential.1");
  assert.deepEqual(active.failurePolicy, {
    lowRisk: "warn",
    highRisk: "deny",
    unknownRisk: "deny",
  });
  assert.equal(Object.isFrozen(active), true);
  assert.equal(Object.isFrozen(active.failurePolicy), true);
  assert.deepEqual(store.writes, [marker({ leaseEpoch: 1 })]);
  assert.equal(JSON.stringify(store.writes).includes("credential"), false);
  assert.equal(JSON.stringify(store.writes).includes("PUBLIC KEY"), false);
  assert.deepEqual(await registry.status(), {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLeases: [{
      leaseId: "lease.1",
      leaseEpoch: 1,
      rootSessionKey: "agent:guard:root.1",
      scope: { kind: "session", sessionKey: "agent:guard:root.1" },
      mode: "supervision",
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    }],
    activeLease: {
      leaseId: "lease.1",
      leaseEpoch: 1,
      rootSessionKey: "agent:guard:root.1",
      scope: { kind: "session", sessionKey: "agent:guard:root.1" },
      mode: "supervision",
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    },
  });
});

test("agent activation persists canonical scope and protects every canonical main session", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  const status = await registry.activate(agentActivation());

  for (const sessionKey of [
    "agent:main:main",
    "agent:main:dashboard:alpha",
    "agent:main:cli:beta",
  ]) {
    const lookup = await registry.lookup(sessionKey);
    assert.equal(lookup.state, "active");
    if (lookup.state === "active") {
      assert.equal(lookup.leaseId, "lease.1");
      assert.deepEqual(lookup.scope, { kind: "agent", agentId: "main" });
    }
  }
  assert.deepEqual(store.writes, [{
    ...marker({ rootSessionKey: "agent:main:main", leaseEpoch: 1 }),
    scope: { kind: "agent", agentId: "main" },
  }]);
  assert.deepEqual(status.activeLeases, [{
    leaseId: "lease.1",
    leaseEpoch: 1,
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
    mode: "supervision",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T00:05:00.000Z",
  }]);
});

test("agent lookup fails closed only for malformed claimed-main session identities", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  await registry.start();
  await registry.activate(agentActivation());

  assert.deepEqual(await registry.lookup("agent:main"), { state: "identity_mismatch" });
  assert.deepEqual(await registry.lookup("agent:main:"), { state: "identity_mismatch" });
  assert.deepEqual(await registry.lookup("agent:main:bad..key"), { state: "identity_mismatch" });
  assert.deepEqual(await registry.lookup("agent:worker:"), { state: "off" });
  assert.deepEqual(await registry.lookup("not-an-agent-key"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:worker:dashboard"), { state: "off" });
});

test("exact session lease shadows an agent lease and revocation falls back to agent scope", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  await registry.start();
  await registry.activate(agentActivation());
  await registry.activate(activation({
    leaseId: "lease.exact",
    rootSessionKey: "agent:main:dashboard:alpha",
    scope: { kind: "session", sessionKey: "agent:main:dashboard:alpha" },
    credential: "credential.exact",
    evidenceCredential: "evidence-credential.exact",
  }));

  const exact = await registry.lookup("agent:main:dashboard:alpha");
  assert.equal(exact.state, "active");
  if (exact.state === "active") assert.equal(exact.leaseId, "lease.exact");

  assert.equal(await registry.revoke("lease.exact"), true);
  const fallback = await registry.lookup("agent:main:dashboard:alpha");
  assert.equal(fallback.state, "active");
  if (fallback.state === "active") assert.equal(fallback.leaseId, "lease.1");
});

test("agent marker restart recovery covers all canonical main sessions and exact recovery shadows it", async () => {
  const store = new MemoryMarkerStore([{
    ...marker({ rootSessionKey: "agent:main:main" }),
    scope: { kind: "agent", agentId: "main" },
  }, marker({
    leaseId: "lease.exact",
    rootSessionKey: "agent:main:dashboard:alpha",
  })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  const exact = await registry.lookup("agent:main:dashboard:alpha");
  assert.equal(exact.state, "recovery");
  if (exact.state === "recovery") assert.equal(exact.leaseId, "lease.exact");
  const fallback = await registry.lookup("agent:main:cli:new");
  assert.equal(fallback.state, "recovery");
  if (fallback.state === "recovery") {
    assert.equal(fallback.leaseId, "lease.1");
    assert.deepEqual(fallback.scope, { kind: "agent", agentId: "main" });
  }
  assert.deepEqual(await registry.lookup("agent:main"), { state: "identity_mismatch" });
  assert.deepEqual(await registry.lookup("agent:main:"), { state: "identity_mismatch" });
  assert.deepEqual(await registry.lookup("agent:worker:cli:new"), { state: "off" });
});

test("session end honors exact recovery before active agent fallback across restart", async () => {
  const exactSessionKey = "agent:main:dashboard:exact-recovery";
  const store = new MemoryMarkerStore([marker({
    leaseId: "lease.exact",
    leaseEpoch: 1,
    rootSessionKey: exactSessionKey,
  })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(agentActivation());

  assert.equal(await registry.endSession(exactSessionKey), true);
  const ended = await registry.lookup(exactSessionKey);
  assert.equal(ended.state, "root_ended");
  if (ended.state === "root_ended") assert.equal(ended.leaseId, "lease.exact");
  assert.equal(store.writes.at(-1)?.leaseId, "lease.exact");
  assert.equal(store.writes.at(-1)?.rootTombstone?.leaseEpoch, 1);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  const recovered = await restarted.lookup(exactSessionKey);
  assert.equal(recovered.state, "root_ended");
  if (recovered.state === "root_ended") assert.equal(recovered.leaseId, "lease.exact");
  assert.equal((await restarted.lookup("agent:main:cli:other")).state, "recovery");
});

test("old missing-scope marker recovers as a legacy exact session without becoming agent-wide", async () => {
  const scoped = marker();
  const { scope: _scope, ...legacyMarker } = scoped as GuardedMarker & { scope: unknown };
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([legacyMarker]),
    now: () => new Date(NOW),
  });

  await registry.start();

  const recovery = await registry.lookup("agent:guard:root.1");
  assert.equal(recovery.state, "recovery");
  if (recovery.state === "recovery") {
    assert.deepEqual(recovery.scope, {
      kind: "session",
      sessionKey: "agent:guard:root.1",
    });
  }
  assert.deepEqual(await registry.lookup("agent:guard:other"), { state: "off" });
});

test("agent renewal preserves scope and rejects a scope downgrade", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(agentActivation());

  await assert.rejects(registry.renew(agentActivation({
    leaseEpoch: 2,
    scope: { kind: "session", sessionKey: "agent:main:main" },
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    ...RENEWED_EVIDENCE_IDENTITY,
  })), /does not match/);
  await registry.renew(agentActivation({
    leaseEpoch: 2,
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    ...RENEWED_EVIDENCE_IDENTITY,
  }));

  const current = await registry.lookup("agent:main:cli:renewed");
  assert.equal(current.state, "active");
  if (current.state === "active") {
    assert.equal(current.leaseEpoch, 2);
    assert.deepEqual(current.scope, { kind: "agent", agentId: "main" });
  }
  assert.deepEqual(store.writes.at(-1)?.scope, { kind: "agent", agentId: "main" });
});

test("agent recovery reactivation requires the same scope and preserves lineage", async () => {
  const store = new MemoryMarkerStore([{
    ...marker({
      rootSessionKey: "agent:main:main",
      childSessionKeys: ["agent:main:cli:child"],
      sessionBindings: [{
        parentSessionKey: "agent:main:dashboard:parent",
        childSessionKey: "agent:main:cli:child",
      }],
    }),
    scope: { kind: "agent", agentId: "main" },
  }]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await assert.rejects(registry.activate(activation({
    rootSessionKey: "agent:main:main",
    scope: { kind: "session", sessionKey: "agent:main:main" },
  })), /does not match/);
  await registry.activate(agentActivation());

  const active = await registry.lookup("agent:main:new:session");
  assert.equal(active.state, "active");
  if (active.state === "active") {
    assert.deepEqual(active.childSessionKeys, ["agent:main:cli:child"]);
    assert.deepEqual(active.scope, { kind: "agent", agentId: "main" });
  }
});

test("agent lifecycle records canonical main lineage without creating exact authorization", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(agentActivation());

  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:main:dashboard:parent",
    "agent:main:cli:child",
  ), true);
  assert.equal((await registry.lookup("agent:main:unrelated:new")).state, "lifecycle_pending");
  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:main:dashboard:parent",
    "agent:main:cli:child",
  ), true);
  assert.equal((await registry.lookup("agent:main:cli:child")).state, "active");
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:worker:parent",
    "agent:main:cli:other",
  ), false);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:main:dashboard:parent",
    "agent:worker:child",
  ), false);

  await registry.activate(activation({
    leaseId: "lease.exact-child",
    rootSessionKey: "agent:main:cli:child",
    scope: { kind: "session", sessionKey: "agent:main:cli:child" },
    credential: "credential.exact-child",
    evidenceCredential: "evidence-credential.exact-child",
  }));
  const exact = await registry.lookup("agent:main:cli:child");
  assert.equal(exact.state, "active");
  if (exact.state === "active") assert.equal(exact.leaseId, "lease.exact-child");
});

test("agent session end acknowledges canonical main identities without ending the lease", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(agentActivation());

  const intent = await registry.prepareSessionEnd("agent:main:dashboard:ended");
  assert.deepEqual(intent, { kind: "end_session", sessionKey: "agent:main:dashboard:ended" });
  assert.equal(await registry.completeSessionEnd(
    "lease.1",
    "agent:main:dashboard:ended",
  ), true);
  assert.equal((await registry.lookup("agent:main:cli:future")).state, "active");
  assert.equal(await registry.prepareSessionEnd("agent:worker:dashboard:ended"), undefined);
  assert.equal(await registry.endSession("agent:main:main"), true);
  assert.equal((await registry.lookup("agent:main:dashboard:after-root-end")).state, "active");
});

test("agent session end prunes descendants of an external canonical parent", async () => {
  const parentSessionKey = "agent:main:dashboard:external-parent";
  const childSessionKey = "agent:main:cli:child";
  const grandchildSessionKey = "agent:main:cli:grandchild";

  const buildRegistry = async () => {
    const store = new MemoryMarkerStore();
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await registry.start();
    await registry.activate(agentActivation());
    assert.equal(await registry.bindChild("lease.1", parentSessionKey, childSessionKey), true);
    assert.equal(await registry.bindChild("lease.1", childSessionKey, grandchildSessionKey), true);
    return { registry, store };
  };

  const queued = await buildRegistry();
  assert.deepEqual(await queued.registry.prepareSessionEnd(parentSessionKey), {
    kind: "end_session",
    sessionKey: parentSessionKey,
  });
  assert.equal(await queued.registry.completeSessionEnd("lease.1", parentSessionKey), true);
  assert.deepEqual(queued.store.writes.at(-1)?.childSessionKeys, []);
  assert.equal(queued.store.writes.at(-1)?.sessionBindings, undefined);
  const queuedActive = await queued.registry.lookup("agent:main:cli:unrelated");
  assert.equal(queuedActive.state, "active");
  if (queuedActive.state === "active") assert.deepEqual(queuedActive.childSessionKeys, []);
  assert.equal(await queued.registry.bindChild("lease.1", parentSessionKey, childSessionKey), true);

  const direct = await buildRegistry();
  assert.equal(await direct.registry.endSession(parentSessionKey), true);
  assert.deepEqual(direct.store.writes.at(-1)?.childSessionKeys, []);
  assert.equal(direct.store.writes.at(-1)?.sessionBindings, undefined);
  const directActive = await direct.registry.lookup("agent:main:dashboard:unrelated");
  assert.equal(directActive.state, "active");
  if (directActive.state === "active") assert.deepEqual(directActive.childSessionKeys, []);
  assert.equal(await direct.registry.bindChild("lease.1", parentSessionKey, childSessionKey), true);
});

test("agent expiry removes fallback and malformed-main fail-closed state", async () => {
  let now = new Date(NOW);
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => now });
  await registry.start();
  await registry.activate(agentActivation());
  now = new Date("2026-08-02T00:05:00.000Z");

  assert.deepEqual(await registry.lookup("agent:main:cli:expired"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:main:"), { state: "off" });
  assert.deepEqual(store.removes, ["lease.1"]);
});

test("activation rejects malformed security fields without writing a marker", async () => {
  const invalidInputs: NativeGuardLeaseActivation[] = [
    { ...activation(), policyPack: { secret: "must-not-enter-plugin-state" } } as NativeGuardLeaseActivation,
    activation({ schemaVersion: "other" as "native-guard-1" }),
    activation({ leaseEpoch: 0 }),
    activation({ scope: "other" as "session_tree" }),
    activation({
      scope: { kind: "session", sessionKey: "agent:guard:other" },
    }),
    activation({
      scope: {
        kind: "session",
        sessionKey: "agent:guard:root.1",
        extra: true,
      } as NativeGuardLeaseActivation["scope"],
    }),
    activation({
      rootSessionKey: "agent:guard:root.1",
      scope: { kind: "agent", agentId: "main" },
    }),
    activation({
      rootSessionKey: "agent:main:main",
      scope: {
        kind: "agent",
        agentId: "main",
        extra: true,
      } as NativeGuardLeaseActivation["scope"],
    }),
    activation({ policyPackDigest: "A".repeat(64) }),
    activation({ backendUrl: "http://example.com/api/v1/openclaw/native-guard/decision" }),
    activation({ backendUrl: "http://127.0.0.1:3100/wrong" }),
    activation({ decisionPublicKey: "not-a-key" }),
    activation({ decisionPublicKey: DECISION_PRIVATE_KEY }),
    activation({ leaseId: "CON" }),
    activation({ leaseId: "lease." }),
    activation({ rootSessionKey: "agent:guard:\troot" }),
    activation({ issuedAt: "not-a-date" }),
    activation({ expiresAt: NOW }),
    activation({ credential: " " }),
    activation({ failurePolicy: { lowRisk: "allow", highRisk: "deny", unknownRisk: "allow" as "deny" } }),
  ];

  for (const input of invalidInputs) {
    const store = new MemoryMarkerStore();
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await registry.start();
    await assert.rejects(registry.activate(input));
    assert.deepEqual(await registry.lookup(input.rootSessionKey), { state: "off" });
    assert.equal(store.writes.length, 0);
  }
});

test("activation accepts legacy and structured exact session scopes as one identity", async () => {
  for (const scope of [
    "session_tree" as const,
    { kind: "session" as const, sessionKey: "agent:guard:root.1" },
  ]) {
    const registry = new LeaseRegistry({
      markerStore: new MemoryMarkerStore(),
      now: () => new Date(NOW),
    });
    await registry.start();

    await registry.activate(activation({ scope }));

    const lookup = await registry.lookup("agent:guard:root.1");
    assert.equal(lookup.state, "active");
    if (lookup.state === "active") {
      assert.deepEqual(lookup.scope, {
        kind: "session",
        sessionKey: "agent:guard:root.1",
      });
    }
  }
});

test("startup rejects malformed scoped markers", async () => {
  const invalidMarkers = [{
      ...marker(),
      scope: {
        kind: "session",
        sessionKey: "agent:guard:root.1",
        extra: true,
      },
    }, {
      ...marker({
        rootSessionKey: "agent:main:main",
        childSessionKeys: ["agent:worker:child"],
      }),
      scope: { kind: "agent", agentId: "main" },
    }];

  for (const invalidMarker of invalidMarkers) {
    const registry = new LeaseRegistry({
      markerStore: new MemoryMarkerStore([invalidMarker]),
      now: () => new Date(NOW),
    });
    await assert.rejects(registry.start(), /invalid marker/);
  }
});

test("activation marker failure leaves the registry OFF", async () => {
  const store = new MemoryMarkerStore();
  store.failWrite = true;
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await assert.rejects(registry.activate(activation()), /marker write failed/);

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(await registry.status(), {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  });
});

test("activation accepts the canonical localhost decision endpoint", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore(),
    now: () => new Date(NOW),
  });
  await registry.start();

  await registry.activate(activation({
    backendUrl: "http://localhost:3100/api/v1/openclaw/native-guard/decision",
  }));

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
});

test("activation reactivates a matching recovery marker with the same lease ID and children", async () => {
  const store = new MemoryMarkerStore([marker({
    childSessionKeys: ["agent:guard:child.2", "agent:guard:child.1"],
  })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await registry.activate(activation());

  const root = await registry.lookup("agent:guard:root.1");
  assert.equal(root.state, "active");
  if (root.state === "active") {
    assert.equal(root.credential, "credential.1");
    assert.deepEqual(root.childSessionKeys, ["agent:guard:child.1", "agent:guard:child.2"]);
  }
  assert.equal((await registry.lookup("agent:guard:child.1")).state, "active");
  assert.deepEqual(store.removeAttempts, []);
  assert.deepEqual(store.writes.at(-1), {
    ...marker({
      leaseEpoch: 1,
      childSessionKeys: ["agent:guard:child.1", "agent:guard:child.2"],
    }),
    sessionBindings: [
      {
        childSessionKey: "agent:guard:child.1",
        parentSessionKey: "agent:guard:root.1",
      },
      {
        childSessionKey: "agent:guard:child.2",
        parentSessionKey: "agent:guard:root.1",
      },
    ],
  });
});

test("activation rekeys matching recovery only after writing new and removing old marker", async () => {
  const store = new MemoryMarkerStore([marker({ childSessionKeys: ["agent:guard:child"] })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await registry.activate(activation({ leaseId: "lease.new" }));

  const child = await registry.lookup("agent:guard:child");
  assert.equal(child.state, "active");
  if (child.state === "active") assert.equal(child.leaseId, "lease.new");
  assert.deepEqual(store.removeAttempts, ["lease.1"]);
  assert.equal(store.markers.has("lease.1"), false);
  assert.equal(store.markers.has("lease.new"), true);
});

test("recovery reactivation rejects policy identity mismatches without marker changes", async () => {
  const mismatches = [
    activation({ mode: "detection" }),
    activation({ policyPackId: "policy.other" }),
    activation({ policyPackDigest: "b".repeat(64) }),
  ];
  for (const candidate of mismatches) {
    const store = new MemoryMarkerStore([marker()]);
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await registry.start();

    await assert.rejects(registry.activate(candidate));

    assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
    assert.equal(store.writes.length, 0);
    assert.equal(store.removeAttempts.length, 0);
  }
});

test("recovery reactivation write failure preserves recovery state", async () => {
  const store = new MemoryMarkerStore([marker({ childSessionKeys: ["agent:guard:child"] })]);
  store.failWrite = true;
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await assert.rejects(registry.activate(activation()), /marker write failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  assert.equal((await registry.lookup("agent:guard:child")).state, "recovery");
  assert.equal((await registry.status()).activeLeaseCount, 0);
});

test("rekey remove failure deletes the new marker best-effort and preserves recovery", async () => {
  const store = new MemoryMarkerStore([marker({ childSessionKeys: ["agent:guard:child"] })]);
  store.failRemoveLeaseIds.add("lease.1");
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await assert.rejects(registry.activate(activation({ leaseId: "lease.new" })), /marker remove failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  assert.equal((await registry.lookup("agent:guard:child")).state, "recovery");
  assert.deepEqual(store.removeAttempts, ["lease.1", "lease.new"]);
  assert.equal(store.markers.has("lease.1"), true);
  assert.equal(store.markers.has("lease.new"), false);
});

test("startup detects session conflicts deterministically and revokes the entire conflict group", async () => {
  const candidates = [
    marker({
      leaseId: "lease.a",
      rootSessionKey: "agent:guard:root.a",
      childSessionKeys: ["agent:guard:shared"],
    }),
    marker({
      leaseId: "lease.b",
      rootSessionKey: "agent:guard:root.b",
      childSessionKeys: ["agent:guard:shared"],
    }),
  ];
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const store = new MemoryMarkerStore(ordered);
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

    await registry.start();

    assert.deepEqual(await registry.lookup("agent:guard:shared"), {
      state: "recovery",
      leaseId: "lease.a",
      rootSessionKey: "agent:guard:root.a",
      mode: "supervision",
      scope: { kind: "session", sessionKey: "agent:guard:root.a" },
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    });
    assert.equal((await registry.status()).coverage, "recovery");
    assert.equal(await registry.revoke("lease.b"), true);
    assert.deepEqual(store.removeAttempts, ["lease.a", "lease.b"]);
    assert.deepEqual(await registry.lookup("agent:guard:root.a"), { state: "off" });
    assert.deepEqual(await registry.lookup("agent:guard:root.b"), { state: "off" });
  }
});

test("startup rejects duplicate lease IDs independent of candidate order", async () => {
  const candidates = [
    marker({ rootSessionKey: "agent:guard:root.a" }),
    marker({ rootSessionKey: "agent:guard:root.b" }),
  ];
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const registry = new LeaseRegistry({
      markerStore: new MemoryMarkerStore(ordered),
      now: () => new Date(NOW),
    });
    await assert.rejects(registry.start(), /duplicate lease/i);
  }
});

test("double rollback failure restarts as one conflict group and revoke cannot leave a marker to revive", async () => {
  const store = new MemoryMarkerStore([marker()]);
  store.failRemoveLeaseIds.add("lease.1");
  store.failRemoveLeaseIds.add("lease.new");
  const first = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await first.start();
  await assert.rejects(first.activate(activation({ leaseId: "lease.new" })), /marker remove failed/);
  assert.equal(store.markers.has("lease.1"), true);
  assert.equal(store.markers.has("lease.new"), true);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  assert.equal((await restarted.status()).coverage, "recovery");
  store.failRemoveLeaseIds.clear();

  assert.equal(await restarted.revoke("lease.new"), true);
  assert.equal(store.markers.has("lease.1"), false);
  assert.equal(store.markers.has("lease.new"), false);

  const cleanRestart = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await cleanRestart.start();
  assert.deepEqual(await cleanRestart.lookup("agent:guard:root.1"), { state: "off" });
});

test("renew requires a greater epoch and rotated credential then replaces active state", async () => {
  let nowMs = Date.parse(NOW);
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(nowMs) });
  await registry.start();
  await registry.activate(activation());
  nowMs += 60_000;

  await registry.renew(activation({
    leaseEpoch: 2,
    issuedAt: "2026-08-02T00:01:00.000Z",
    expiresAt: "2026-08-02T00:06:00.000Z",
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    ...RENEWED_EVIDENCE_IDENTITY,
  }));

  const current = await registry.lookup("agent:guard:root.1");
  assert.equal(current.state, "active");
  if (current.state !== "active") assert.fail("expected active lease");
  assert.equal(current.leaseEpoch, 2);
  assert.equal(current.credential, "credential.2");
  assert.equal(JSON.stringify(await registry.status()).includes("credential"), false);
  assert.deepEqual(store.writes.at(-1), marker({ leaseEpoch: 2, expiresAt: "2026-08-02T00:06:00.000Z" }));
});

test("renew rejects identity changes, stale epochs, and reused credentials without changing state", async () => {
  const invalidRenewals = [
    activation({ leaseEpoch: 1, credential: "credential.2" }),
    activation({ leaseEpoch: 2, credential: "credential.1" }),
    activation({ leaseEpoch: 2, credential: "credential.2", rootSessionKey: "agent:guard:other" }),
    activation({ leaseEpoch: 2, credential: "credential.2", mode: "detection" }),
    activation({ leaseEpoch: 2, credential: "credential.2", policyPackId: "policy.2" }),
    activation({ leaseEpoch: 2, credential: "credential.2", policyPackDigest: "b".repeat(64) }),
  ];

  for (const renewal of invalidRenewals) {
    const store = new MemoryMarkerStore();
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await registry.start();
    await registry.activate(activation());
    await assert.rejects(registry.renew(renewal));
    const current = await registry.lookup("agent:guard:root.1");
    assert.equal(current.state, "active");
    if (current.state === "active") {
      assert.equal(current.leaseEpoch, 1);
      assert.equal(current.credential, "credential.1");
    }
    assert.equal(store.writes.length, 1);
  }
});

test("renew marker failure rolls back to the prior active lease", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failWrite = true;

  await assert.rejects(registry.renew(activation({
    leaseEpoch: 2,
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    ...RENEWED_EVIDENCE_IDENTITY,
  })), /marker write failed/);

  const current = await registry.lookup("agent:guard:root.1");
  assert.equal(current.state, "active");
  if (current.state === "active") {
    assert.equal(current.leaseEpoch, 1);
    assert.equal(current.credential, "credential.1");
  }
});

test("renew refuses to rotate evidence identity while lifecycle work is pending", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:pending-renew",
  ), true);

  await assert.rejects(registry.renew(activation({
    leaseEpoch: 2,
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    ...RENEWED_EVIDENCE_IDENTITY,
  })), /lifecycle/i);

  const pending = await registry.pendingLifecycle("lease.1");
  assert.equal(pending?.kind, "bind_child");
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal(store.writes.at(-1)?.lifecycleQueue?.length, 1);
});

test("explicit revoke deletes the marker, turns sessions OFF, and is idempotent", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.equal(await registry.revoke("lease.1"), true);
  assert.equal(await registry.revoke("lease.1"), false);

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(store.removes, ["lease.1"]);
});

test("active revoke remove failure preserves active state until retry succeeds", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failRemoveLeaseIds.add("lease.1");

  await assert.rejects(registry.revoke("lease.1"), /marker remove failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.equal((await registry.status()).activeLeaseCount, 1);
  store.failRemoveLeaseIds.clear();
  assert.equal(await registry.revoke("lease.1"), true);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
});

test("recovery revoke remove failure preserves recovery state until retry succeeds", async () => {
  const store = new MemoryMarkerStore([marker()]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  store.failRemoveLeaseIds.add("lease.1");

  await assert.rejects(registry.revoke("lease.1"), /marker remove failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  assert.equal((await registry.status()).coverage, "recovery");
  store.failRemoveLeaseIds.clear();
  assert.equal(await registry.revoke("lease.1"), true);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
});

test("expiry on lookup transitions active lease OFF and deletes its marker", async () => {
  let nowMs = Date.parse(NOW);
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(nowMs) });
  await registry.start();
  await registry.activate(activation());
  nowMs = Date.parse("2026-08-02T00:05:00.000Z");

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(store.removes, ["lease.1"]);
  assert.equal((await registry.status()).activeLeaseCount, 0);
});

test("expired marker deletion is retried after a transient failure while lookup stays OFF", async () => {
  let nowMs = Date.parse(NOW);
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(nowMs) });
  await registry.start();
  await registry.activate(activation());
  store.failRemoveLeaseIds.add("lease.1");
  nowMs = Date.parse("2026-08-02T00:05:00.000Z");

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.equal(store.markers.has("lease.1"), true);
  assert.deepEqual(store.removeAttempts, ["lease.1"]);
  store.failRemoveLeaseIds.clear();

  assert.equal((await registry.status()).activeLeaseCount, 0);
  assert.deepEqual(store.removeAttempts, ["lease.1", "lease.1"]);
  assert.equal(store.markers.has("lease.1"), false);
});

test("startup removes expired valid markers and keeps missing entries OFF", async () => {
  const store = new MemoryMarkerStore([
    marker({ leaseId: "expired.1", expiresAt: NOW }),
  ]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

  await registry.start();

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(store.removes, ["expired.1"]);
});

test("registry fails closed when an injected marker store returns an invalid candidate shape", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([{ ...marker(), credential: "must-not-load" }]),
    now: () => new Date(NOW),
  });

  await assert.rejects(registry.start(), /marker/i);
});

test("session binding markers are canonicalized and invalid graphs fail closed", async () => {
  const valid = {
    ...marker({
      childSessionKeys: ["agent:guard:parent", "agent:guard:grandchild"],
    }),
    sessionBindings: [
      {
        childSessionKey: "agent:guard:parent",
        parentSessionKey: "agent:guard:root.1",
      },
      {
        childSessionKey: "agent:guard:grandchild",
        parentSessionKey: "agent:guard:parent",
      },
    ],
  };
  const validStore = new MemoryMarkerStore([valid]);
  const validRegistry = new LeaseRegistry({ markerStore: validStore, now: () => new Date(NOW) });
  await validRegistry.start();
  await validRegistry.activate(activation());
  assert.deepEqual(
    (validStore.markers.get("lease.1") as typeof valid).sessionBindings,
    [valid.sessionBindings[1], valid.sessionBindings[0]],
  );

  const invalidBindings = [
    [valid.sessionBindings[0]],
    [
      valid.sessionBindings[0],
      {
        childSessionKey: "agent:guard:grandchild",
        parentSessionKey: "agent:guard:missing",
      },
    ],
    [
      {
        childSessionKey: "agent:guard:parent",
        parentSessionKey: "agent:guard:grandchild",
      },
      {
        childSessionKey: "agent:guard:grandchild",
        parentSessionKey: "agent:guard:parent",
      },
    ],
  ];
  for (const sessionBindings of invalidBindings) {
    const registry = new LeaseRegistry({
      markerStore: new MemoryMarkerStore([{ ...valid, sessionBindings }]),
      now: () => new Date(NOW),
    });
    await assert.rejects(registry.start(), /marker/i);
  }
});

test("bindChild requires a bound parent and persists sorted unique child keys", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.equal(await registry.bindChild("lease.1", "agent:guard:missing", "agent:guard:child.2"), false);
  assert.equal(await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child.2"), true);
  assert.equal(await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child.1"), true);
  assert.equal(await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child.1"), false);
  assert.equal((await registry.lookup("agent:guard:child.1")).state, "active");
  assert.deepEqual(store.writes.at(-1)?.childSessionKeys, [
    "agent:guard:child.1",
    "agent:guard:child.2",
  ]);
});

test("child binding intent blocks the whole lease until backend acknowledgement commits", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  ), true);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal((await registry.lookup("agent:guard:child")).state, "lifecycle_pending");
  assert.deepEqual(await registry.pendingLifecycle("lease.1"), {
    kind: "bind_child",
    parentSessionKey: "agent:guard:root.1",
    childSessionKey: "agent:guard:child",
  });
  assert.deepEqual(store.writes.at(-1)?.lifecycleIntent, {
    kind: "bind_child",
    parentSessionKey: "agent:guard:root.1",
    childSessionKey: "agent:guard:child",
  });

  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  ), true);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.equal((await registry.lookup("agent:guard:child")).state, "active");
  assert.equal(await registry.pendingLifecycle("lease.1"), undefined);
});

test("binding intent write failure leaves no child window and commit failure stays blocking", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failWrite = true;
  await assert.rejects(registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  ), /marker write failed/);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.deepEqual(await registry.lookup("agent:guard:child"), { state: "off" });

  store.failWrite = false;
  await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  );
  store.failWrite = true;
  await assert.rejects(registry.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  ), /marker write failed/);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal((await registry.lookup("agent:guard:child")).state, "lifecycle_pending");
});

test("lifecycle intent survives restart and reactivation without a low-risk recovery window", async () => {
  const store = new MemoryMarkerStore();
  const active = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await active.start();
  await active.activate(activation());
  await active.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:child",
  );

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal((await restarted.lookup("agent:guard:child")).state, "lifecycle_pending");
  await restarted.activate(activation());
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.deepEqual(await restarted.pendingLifecycle("lease.1"), {
    kind: "bind_child",
    parentSessionKey: "agent:guard:root.1",
    childSessionKey: "agent:guard:child",
  });
});

test("session ending intent blocks before backend history acknowledgement and commits removal", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child");

  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:child"), {
    kind: "end_session",
    sessionKey: "agent:guard:child",
  });
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal((await registry.lookup("agent:guard:child")).state, "lifecycle_pending");
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:child"), true);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.deepEqual(await registry.lookup("agent:guard:child"), { state: "off" });
});

test("multiple lifecycle operations survive restart and commit strictly FIFO", async () => {
  const store = new MemoryMarkerStore();
  const first = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await first.start();
  await first.activate(activation());
  assert.equal(await first.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:queued-child",
  ), true);
  assert.deepEqual(await first.prepareSessionEnd("agent:guard:queued-child"), {
    kind: "end_session",
    sessionKey: "agent:guard:queued-child",
  });
  assert.equal(store.writes.at(-1)?.lifecycleQueue?.length, 2);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  await restarted.activate(activation());
  assert.deepEqual(await restarted.pendingLifecycle("lease.1"), {
    kind: "bind_child",
    parentSessionKey: "agent:guard:root.1",
    childSessionKey: "agent:guard:queued-child",
  });
  assert.equal(await restarted.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:queued-child",
  ), true);
  assert.deepEqual(await restarted.pendingLifecycle("lease.1"), {
    kind: "end_session",
    sessionKey: "agent:guard:queued-child",
  });
  assert.equal(await restarted.completeSessionEnd("lease.1", "agent:guard:queued-child"), true);
  assert.equal(await restarted.pendingLifecycle("lease.1"), undefined);
  assert.deepEqual(await restarted.lookup("agent:guard:queued-child"), { state: "off" });
});

test("head commit failure preserves the full lifecycle tail for retry", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:commit-child",
  );
  await registry.prepareSessionEnd("agent:guard:commit-child");
  store.failWrite = true;

  await assert.rejects(registry.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:commit-child",
  ), /marker write failed/);
  assert.equal(store.writes.at(-1)?.lifecycleQueue?.length, 2);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");

  store.failWrite = false;
  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:commit-child",
  ), true);
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:commit-child"), true);
});

test("queued ancestor end covers later descendant lifecycle operations", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);

  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:parent"), {
    kind: "end_session",
    sessionKey: "agent:guard:parent",
  });
  assert.equal(await registry.prepareSessionEnd("agent:guard:grandchild"), undefined);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:grandchild",
    "agent:guard:covered-child",
  ), false);
  assert.equal(
    (store.markers.get("lease.1") as GuardedMarker).lifecycleQueue?.length,
    1,
  );

  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(await registry.lookup("agent:guard:parent"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:guard:grandchild"), { state: "off" });
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.equal(await registry.pendingLifecycle("lease.1"), undefined);
});

test("exact session bindings survive restart for queued ancestor end", async () => {
  const store = new MemoryMarkerStore();
  const active = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await active.start();
  await active.activate(activation());
  assert.equal(await active.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await active.bindChild(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);
  await active.prepareSessionEnd("agent:guard:parent");
  assert.deepEqual(
    (store.markers.get("lease.1") as GuardedMarker & {
      sessionBindings?: unknown;
    }).sessionBindings,
    [
      {
        childSessionKey: "agent:guard:grandchild",
        parentSessionKey: "agent:guard:parent",
      },
      {
        childSessionKey: "agent:guard:parent",
        parentSessionKey: "agent:guard:root.1",
      },
    ],
  );

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  await restarted.activate(activation());
  assert.equal(await restarted.completeSessionEnd("lease.1", "agent:guard:parent"), true);

  assert.deepEqual(await restarted.lookup("agent:guard:parent"), { state: "off" });
  assert.deepEqual(await restarted.lookup("agent:guard:grandchild"), { state: "off" });
});

test("queued root end covers descendant lifecycle operations and clears its indexes", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:parent");
  await registry.bindChild("lease.1", "agent:guard:parent", "agent:guard:grandchild");

  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:root.1"), {
    kind: "end_session",
    sessionKey: "agent:guard:root.1",
  });
  assert.equal(await registry.prepareSessionEnd("agent:guard:grandchild"), undefined);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:grandchild",
    "agent:guard:covered-child",
  ), false);
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:root.1"), true);

  assert.equal((await registry.lookup("agent:guard:parent")).state, "root_ended");
  assert.equal((await registry.lookup("agent:guard:grandchild")).state, "root_ended");
  assert.deepEqual(await registry.lookup("agent:guard:covered-child"), { state: "off" });
});

test("FIFO projection allows binding a descendant before ending its ancestor", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);

  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);
  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:parent"), {
    kind: "end_session",
    sessionKey: "agent:guard:parent",
  });

  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(await registry.lookup("agent:guard:grandchild"), { state: "off" });
});

test("FIFO projection allows ending a descendant before ending its ancestor", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);

  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:grandchild"), {
    kind: "end_session",
    sessionKey: "agent:guard:grandchild",
  });
  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:parent"), {
    kind: "end_session",
    sessionKey: "agent:guard:parent",
  });

  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:grandchild"), true);
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(await registry.lookup("agent:guard:parent"), { state: "off" });
});

test("ancestor completion atomically prunes covered legacy tail intents and bind indexes", async () => {
  const lifecycleQueue: NonNullable<GuardedMarker["lifecycleQueue"]> = [
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:root.1",
      childSessionKey: "agent:guard:parent",
    },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:parent",
      childSessionKey: "agent:guard:grandchild",
    },
    { kind: "end_session", sessionKey: "agent:guard:parent" },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:grandchild",
      childSessionKey: "agent:guard:covered-child",
    },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:covered-child",
      childSessionKey: "agent:guard:covered-grandchild",
    },
    { kind: "end_session", sessionKey: "agent:guard:covered-grandchild" },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:root.1",
      childSessionKey: "agent:guard:survivor",
    },
  ];
  const store = new MemoryMarkerStore([marker({
    lifecycleIntent: lifecycleQueue[0],
    lifecycleQueue,
  })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await registry.completeChildBinding(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:grandchild",
  ), true);

  store.failWrite = true;
  await assert.rejects(
    registry.completeSessionEnd("lease.1", "agent:guard:parent"),
    /marker write failed/,
  );
  assert.equal((await registry.lookup("agent:guard:covered-child")).state, "lifecycle_pending");
  assert.equal(
    (store.markers.get("lease.1") as GuardedMarker).lifecycleQueue?.length,
    5,
  );

  store.failWrite = false;
  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(await registry.pendingLifecycle("lease.1"), {
    kind: "bind_child",
    parentSessionKey: "agent:guard:root.1",
    childSessionKey: "agent:guard:survivor",
  });
  assert.deepEqual(await registry.lookup("agent:guard:covered-child"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:guard:covered-grandchild"), { state: "off" });
  assert.equal(
    (store.markers.get("lease.1") as GuardedMarker).lifecycleQueue?.length,
    1,
  );
});

test("ancestor completion retains unrelated invalid legacy tail fail closed", async () => {
  const lifecycleQueue: NonNullable<GuardedMarker["lifecycleQueue"]> = [
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:root.1",
      childSessionKey: "agent:guard:parent",
    },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:parent",
      childSessionKey: "agent:guard:grandchild",
    },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:root.1",
      childSessionKey: "agent:guard:sibling-parent",
    },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:sibling-parent",
      childSessionKey: "agent:guard:sibling-grandchild",
    },
    { kind: "end_session", sessionKey: "agent:guard:parent" },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:grandchild",
      childSessionKey: "agent:guard:covered-child",
    },
    { kind: "end_session", sessionKey: "agent:guard:sibling-parent" },
    {
      kind: "bind_child",
      parentSessionKey: "agent:guard:sibling-grandchild",
      childSessionKey: "agent:guard:unrelated-child",
    },
  ];
  const store = new MemoryMarkerStore([marker({
    lifecycleIntent: lifecycleQueue[0],
    lifecycleQueue,
  })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  for (const intent of lifecycleQueue.slice(0, 4)) {
    assert.equal(intent.kind, "bind_child");
    if (intent.kind !== "bind_child") continue;
    assert.equal(await registry.completeChildBinding(
      "lease.1",
      intent.parentSessionKey,
      intent.childSessionKey,
    ), true);
  }

  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(
    (store.markers.get("lease.1") as GuardedMarker).lifecycleQueue,
    lifecycleQueue.slice(6),
  );
  assert.equal((await registry.lookup("agent:guard:unrelated-child")).state, "lifecycle_pending");

  assert.equal(await registry.completeSessionEnd(
    "lease.1",
    "agent:guard:sibling-parent",
  ), true);
  assert.equal(await registry.pendingLifecycle("lease.1"), undefined);
  assert.deepEqual(await registry.lookup("agent:guard:unrelated-child"), { state: "off" });
});

test("ancestor completion preserves accepted subtree rebind intents", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  assert.equal(await registry.bindChild(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);

  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:parent"), {
    kind: "end_session",
    sessionKey: "agent:guard:parent",
  });
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:new-child",
  ), true);

  assert.equal(await registry.completeSessionEnd("lease.1", "agent:guard:parent"), true);
  assert.deepEqual(
    (store.markers.get("lease.1") as GuardedMarker).lifecycleQueue,
    [
      {
        kind: "bind_child",
        parentSessionKey: "agent:guard:root.1",
        childSessionKey: "agent:guard:parent",
      },
      {
        kind: "bind_child",
        parentSessionKey: "agent:guard:parent",
        childSessionKey: "agent:guard:new-child",
      },
    ],
  );

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  await restarted.activate(activation());
  assert.equal((await restarted.lookup("agent:guard:new-child")).state, "lifecycle_pending");
  assert.equal(await restarted.completeChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:parent",
  ), true);
  assert.equal(await restarted.completeChildBinding(
    "lease.1",
    "agent:guard:parent",
    "agent:guard:new-child",
  ), true);
  assert.equal((await restarted.lookup("agent:guard:new-child")).state, "active");
});

test("covered duplicate lifecycle intents are not reported as prepared", async () => {
  const buildRegistry = async (tail: NonNullable<GuardedMarker["lifecycleQueue"]>) => {
    const prefix: NonNullable<GuardedMarker["lifecycleQueue"]> = [
      {
        kind: "bind_child",
        parentSessionKey: "agent:guard:root.1",
        childSessionKey: "agent:guard:parent",
      },
      {
        kind: "bind_child",
        parentSessionKey: "agent:guard:parent",
        childSessionKey: "agent:guard:grandchild",
      },
    ];
    const lifecycleQueue = [...prefix, { kind: "end_session" as const, sessionKey: "agent:guard:parent" }, ...tail];
    const store = new MemoryMarkerStore([marker({
      lifecycleIntent: lifecycleQueue[0],
      lifecycleQueue,
    })]);
    const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await registry.start();
    await registry.activate(activation());
    assert.equal(await registry.completeChildBinding(
      "lease.1",
      "agent:guard:root.1",
      "agent:guard:parent",
    ), true);
    assert.equal(await registry.completeChildBinding(
      "lease.1",
      "agent:guard:parent",
      "agent:guard:grandchild",
    ), true);
    return registry;
  };

  const endRegistry = await buildRegistry([
    { kind: "end_session", sessionKey: "agent:guard:grandchild" },
  ]);
  assert.equal(await endRegistry.prepareSessionEnd("agent:guard:grandchild"), undefined);

  const bindRegistry = await buildRegistry([{
    kind: "bind_child",
    parentSessionKey: "agent:guard:grandchild",
    childSessionKey: "agent:guard:covered-child",
  }]);
  assert.equal(await bindRegistry.prepareChildBinding(
    "lease.1",
    "agent:guard:grandchild",
    "agent:guard:covered-child",
  ), false);
});

test("lifecycle queue overflow stays fail-closed after the accepted head drains", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  for (let index = 0; index < 128; index += 1) {
    assert.equal(await registry.prepareChildBinding(
      "lease.1",
      "agent:guard:root.1",
      `agent:guard:overflow-${String(index).padStart(3, "0")}`,
    ), true);
  }
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:overflow-rejected",
  ), false);
  assert.equal(store.writes.at(-1)?.lifecycleOverflow, true);

  for (let index = 0; index < 128; index += 1) {
    assert.equal(await registry.completeChildBinding(
      "lease.1",
      "agent:guard:root.1",
      `agent:guard:overflow-${String(index).padStart(3, "0")}`,
    ), true);
  }
  assert.equal(await registry.pendingLifecycle("lease.1"), undefined);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.equal((await registry.status()).reasonCode, "NATIVE_GUARD_LIFECYCLE_OVERFLOW");
  assert.equal(await registry.revoke("lease.1"), true);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
});

test("lifecycle marker reserve accepts the exact limit and can persist sticky overflow", async () => {
  const { baseMarker, candidate, candidateMarker, reservedCandidateMarker } =
    lifecycleMarkerBoundary(0);
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const path = join(markerDir, "lease.1.json");
  const store = new FileMarkerStore(markerDir);
  await store.write(baseMarker);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.equal(lifecycleMarkerBytes(reservedCandidateMarker), MAX_MARKER_BYTES);
  assert.ok(lifecycleMarkerBytes(candidateMarker) < MAX_MARKER_BYTES);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    candidate.parentSessionKey,
    candidate.childSessionKey,
  ), true);
  assert.equal(Buffer.byteLength(await readFile(path)), lifecycleMarkerBytes(candidateMarker));

  assert.equal(await registry.prepareSessionEnd("agent:guard:root.1"), undefined);
  const persisted = JSON.parse(await readFile(path, "utf8")) as GuardedMarker;
  assert.equal(persisted.lifecycleOverflow, true);
  assert.equal(Buffer.byteLength(await readFile(path)), MAX_MARKER_BYTES);
});

test("lifecycle marker reserve rejects limit plus one and marks the prior state overflow", async () => {
  const { baseQueue, baseMarker, candidate, candidateMarker, reservedCandidateMarker } =
    lifecycleMarkerBoundary(1);
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const path = join(markerDir, "lease.1.json");
  const store = new FileMarkerStore(markerDir);
  await store.write(baseMarker);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.ok(lifecycleMarkerBytes(candidateMarker) <= MAX_MARKER_BYTES);
  assert.equal(lifecycleMarkerBytes(reservedCandidateMarker), MAX_MARKER_BYTES + 1);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    candidate.parentSessionKey,
    candidate.childSessionKey,
  ), false);
  const persisted = JSON.parse(await readFile(path, "utf8")) as GuardedMarker;
  assert.equal(persisted.lifecycleOverflow, true);
  assert.deepEqual(persisted.lifecycleQueue, baseQueue);
  assert.equal(
    Buffer.byteLength(await readFile(path)),
    lifecycleMarkerBytes({ ...baseMarker, lifecycleOverflow: true }),
  );
  assert.ok(Buffer.byteLength(await readFile(path)) <= MAX_MARKER_BYTES);
});

test("prepareChildBinding propagates queue-named marker store failures without setting overflow", async () => {
  const store = new QueueNamedTransientStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failNextWrite = true;

  await assert.rejects(
    registry.prepareChildBinding(
      "lease.1",
      "agent:guard:root.1",
      "agent:guard:transient-child",
    ),
    (error) => error === store.transientError,
  );

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.equal(store.writes.at(-1)?.lifecycleOverflow, undefined);
  assert.equal(store.writes.at(-1)?.lifecycleQueue, undefined);
  assert.equal(await registry.prepareChildBinding(
    "lease.1",
    "agent:guard:root.1",
    "agent:guard:transient-child",
  ), true);
});

test("prepareSessionEnd propagates queue-named marker store failures without setting overflow", async () => {
  const store = new QueueNamedTransientStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failNextWrite = true;

  await assert.rejects(
    registry.prepareSessionEnd("agent:guard:root.1"),
    (error) => error === store.transientError,
  );

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  assert.equal(store.writes.at(-1)?.lifecycleOverflow, undefined);
  assert.equal(store.writes.at(-1)?.lifecycleQueue, undefined);
  assert.deepEqual(await registry.prepareSessionEnd("agent:guard:root.1"), {
    kind: "end_session",
    sessionKey: "agent:guard:root.1",
  });
});

test("legacy unreserved near-limit marker remains quarantined when activation cannot reserve overflow", async () => {
  const { candidateMarker, reservedCandidateMarker } = lifecycleMarkerBoundary(1);
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const path = join(markerDir, "lease.1.json");
  const store = new FileMarkerStore(markerDir);
  await store.write(candidateMarker);
  const original = await readFile(path);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

  assert.equal(original.byteLength, lifecycleMarkerBytes(candidateMarker));
  assert.ok(original.byteLength <= MAX_MARKER_BYTES);
  assert.equal(lifecycleMarkerBytes(reservedCandidateMarker), MAX_MARKER_BYTES + 1);
  await registry.start();
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  await assert.rejects(registry.activate(activation()), /marker limit/i);

  assert.equal(await registry.lookupActiveLease("lease.1"), undefined);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "lifecycle_pending");
  assert.deepEqual(await readFile(path), original);
  assert.deepEqual(await readdir(markerDir), ["lease.1.json"]);
});

test("bindChild rejects cross-lease collisions and marker failure rolls back", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.activate(activation({
    leaseId: "lease.2",
    rootSessionKey: "agent:guard:root.2",
    credential: "credential.other",
  }));

  assert.equal(await registry.bindChild("lease.1", "agent:guard:root.2", "agent:guard:child"), false);
  assert.equal(await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:root.2"), false);
  store.failWrite = true;
  await assert.rejects(
    registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child"),
    /marker write failed/,
  );
  assert.deepEqual(await registry.lookup("agent:guard:child"), { state: "off" });
});

test("ending a child removes its full subtree while siblings remain active", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child");
  await registry.bindChild("lease.1", "agent:guard:child", "agent:guard:grandchild");
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:sibling");

  assert.equal(await registry.endSession("agent:guard:child"), true);

  assert.deepEqual(await registry.lookup("agent:guard:child"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:guard:grandchild"), { state: "off" });
  assert.equal((await registry.lookup("agent:guard:sibling")).state, "active");
  assert.deepEqual(store.writes.at(-1)?.childSessionKeys, ["agent:guard:sibling"]);
});

test("ending the root writes a durable non-renewable evidence tombstone", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child");

  assert.equal(await registry.endSession("agent:guard:root.1"), true);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "root_ended");
  assert.equal((await registry.lookup("agent:guard:child")).state, "root_ended");
  assert.equal((await registry.lookupEvidenceLease("lease.1"))?.state, "root_ended");
  assert.equal(store.writes.at(-1)?.rootTombstone?.leaseEpoch, 1);
  assert.deepEqual(store.removes, []);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "root_ended");
  assert.equal(await restarted.lookupEvidenceLease("lease.1"), undefined);
  await restarted.activate(activation());
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "root_ended");
  assert.equal((await restarted.lookupEvidenceLease("lease.1"))?.state, "root_ended");
  await assert.rejects(restarted.renew(activation({ leaseEpoch: 2 })), /not active/i);
  assert.equal(await restarted.revoke("lease.1"), true);
  assert.deepEqual(await restarted.lookup("agent:guard:root.1"), { state: "off" });
});

test("ending an active root preserves active state when tombstone commit fails", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failWrite = true;

  await assert.rejects(registry.endSession("agent:guard:root.1"), /marker write failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  store.failWrite = false;
  assert.equal(await registry.endSession("agent:guard:root.1"), true);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "root_ended");
});

test("ending a recovery root with an epoch writes a durable root tombstone", async () => {
  const childSessionKey = "agent:guard:child";
  const store = new MemoryMarkerStore([{
    ...marker({
      childSessionKeys: [childSessionKey],
      sessionBindings: [{
        childSessionKey,
        parentSessionKey: "agent:guard:root.1",
      }],
    }),
    leaseEpoch: 1,
  }]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  store.failWrite = true;

  await assert.rejects(registry.endSession("agent:guard:root.1"), /marker write failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  store.failWrite = false;
  assert.equal(await registry.endSession("agent:guard:root.1"), true);
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "root_ended");
  assert.equal((await registry.lookup(childSessionKey)).state, "root_ended");
  assert.equal((await registry.status()).coverage, "recovery");
  assert.equal(store.writes.at(-1)?.rootTombstone?.leaseEpoch, 1);
  assert.deepEqual(store.removes, []);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "root_ended");
  assert.equal((await restarted.lookup(childSessionKey)).state, "root_ended");
  assert.equal((await restarted.status()).coverage, "recovery");
});

test("ending a legacy recovery root without an epoch remains fail-closed recovery", async () => {
  const store = new MemoryMarkerStore([marker({ childSessionKeys: ["agent:guard:child"] })]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  assert.equal(await registry.endSession("agent:guard:root.1"), false);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  assert.equal((await registry.lookup("agent:guard:child")).state, "recovery");
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.removes, []);

  const restarted = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "recovery");
  assert.equal((await restarted.lookup("agent:guard:child")).state, "recovery");
});

test("restart removes only the explicitly ended flat child and keeps unknown relationships guarded", async () => {
  const buildStore = async (): Promise<MemoryMarkerStore> => {
    const store = new MemoryMarkerStore();
    const active = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
    await active.start();
    await active.activate(activation());
    await active.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child");
    await active.bindChild("lease.1", "agent:guard:child", "agent:guard:grandchild");
    await active.bindChild("lease.1", "agent:guard:root.1", "agent:guard:sibling");
    const persisted = store.markers.get("lease.1") as GuardedMarker;
    const { sessionBindings: _sessionBindings, ...legacyMarker } = persisted;
    store.markers.set("lease.1", legacyMarker);
    return store;
  };

  const recoveryStore = await buildStore();
  const recovery = new LeaseRegistry({ markerStore: recoveryStore, now: () => new Date(NOW) });
  await recovery.start();
  assert.equal(await recovery.endSession("agent:guard:child"), true);
  assert.equal((await recovery.lookup("agent:guard:root.1")).state, "recovery");
  assert.deepEqual(await recovery.lookup("agent:guard:child"), { state: "off" });
  assert.equal((await recovery.lookup("agent:guard:grandchild")).state, "recovery");
  assert.equal((await recovery.lookup("agent:guard:sibling")).state, "recovery");
  assert.deepEqual(recoveryStore.writes.at(-1)?.childSessionKeys, [
    "agent:guard:grandchild",
    "agent:guard:sibling",
  ]);

  const reactivatedStore = await buildStore();
  const reactivated = new LeaseRegistry({ markerStore: reactivatedStore, now: () => new Date(NOW) });
  await reactivated.start();
  await reactivated.activate(activation());
  assert.equal(await reactivated.endSession("agent:guard:child"), true);
  assert.equal((await reactivated.lookup("agent:guard:root.1")).state, "active");
  assert.deepEqual(await reactivated.lookup("agent:guard:child"), { state: "off" });
  assert.equal((await reactivated.lookup("agent:guard:grandchild")).state, "active");
  assert.equal((await reactivated.lookup("agent:guard:sibling")).state, "active");
  assert.deepEqual(reactivatedStore.writes.at(-1)?.childSessionKeys, [
    "agent:guard:grandchild",
    "agent:guard:sibling",
  ]);
});

test("multiple independent session trees report a truthful count without singular detail", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.activate(activation({
    leaseId: "lease.2",
    rootSessionKey: "agent:guard:root.2",
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
  }));

  assert.deepEqual(await registry.status(), {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 2,
    activeLeases: [
      {
        leaseId: "lease.1",
        leaseEpoch: 1,
        rootSessionKey: "agent:guard:root.1",
        scope: { kind: "session", sessionKey: "agent:guard:root.1" },
        mode: "supervision",
        policyPackId: "policy.1",
        policyPackDigest: "a".repeat(64),
        expiresAt: "2026-08-02T00:05:00.000Z",
      },
      {
        leaseId: "lease.2",
        leaseEpoch: 1,
        rootSessionKey: "agent:guard:root.2",
        scope: { kind: "session", sessionKey: "agent:guard:root.2" },
        mode: "supervision",
        policyPackId: "policy.1",
        policyPackDigest: "a".repeat(64),
        expiresAt: "2026-08-02T00:05:00.000Z",
      },
    ],
  });
});

test("any recovery marker dominates mixed coverage and suppresses singular active detail", async () => {
  const registry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([marker()]),
    now: () => new Date(NOW),
  });
  await registry.start();
  await registry.activate(activation({
    leaseId: "lease.active",
    rootSessionKey: "agent:guard:active-root",
    credential: "credential.active",
  }));

  assert.deepEqual(await registry.status(), {
    coverage: "recovery",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLeases: [{
      leaseId: "lease.active",
      leaseEpoch: 1,
      rootSessionKey: "agent:guard:active-root",
      scope: { kind: "session", sessionKey: "agent:guard:active-root" },
      mode: "supervision",
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    }],
  });
  assert.equal((await registry.lookup("agent:guard:active-root")).state, "active");
  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
});

test("serialized writes cannot resurrect a marker after a queued revoke", async () => {
  let releaseWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let unblockWrite!: () => void;
  const writeBlocked = new Promise<void>((resolve) => {
    unblockWrite = resolve;
  });
  class DelayedStore extends MemoryMarkerStore {
    override async write(value: GuardedMarker): Promise<void> {
      releaseWrite();
      await writeBlocked;
      await super.write(value);
    }
  }
  const store = new DelayedStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  const activating = registry.activate(activation());
  await writeStarted;
  const revoking = registry.revoke("lease.1");
  unblockWrite();

  await activating;
  assert.equal(await revoking, true);

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.equal(store.markers.has("lease.1"), false);
});

test("filesystem store keeps a missing marker directory absent while OFF", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const markerDir = join(parent, "missing");
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });

  await registry.start();

  await assert.rejects(stat(markerDir), { code: "ENOENT" });
  assert.deepEqual(await registry.lookup("agent:guard:missing"), { state: "off" });
});

test("filesystem store writes a sanitized atomic marker with restrictive permissions and restarts in recovery", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const markerDir = join(parent, "markers");
  const store = new FileMarkerStore(markerDir);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());

  assert.deepEqual(await readdir(markerDir), ["lease.1.json"]);
  const path = join(markerDir, "lease.1.json");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), marker({ leaseEpoch: 1 }));
  if (process.platform !== "win32") {
    assert.equal((await stat(markerDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  const restarted = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "recovery");
});

test("filesystem store atomically replaces the same lease marker during renew", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });
  await registry.start();
  await registry.activate(activation());

  await registry.renew(activation({
    leaseEpoch: 2,
    credential: "credential.2",
    evidenceCredential: "evidence-credential.2",
    expiresAt: "2026-08-02T00:06:00.000Z",
    ...RENEWED_EVIDENCE_IDENTITY,
  }));

  assert.deepEqual(await readdir(markerDir), ["lease.1.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(markerDir, "lease.1.json"), "utf8")),
    marker({ leaseEpoch: 2, expiresAt: "2026-08-02T00:06:00.000Z" }),
  );
  const restarted = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "recovery");
});

test("filesystem store fails closed on truncated, malformed, or oversized marker candidates", async () => {
  const invalidContents = [
    "{",
    JSON.stringify({ leaseId: "lease.1" }),
    " ".repeat(70_000),
  ];
  for (const contents of invalidContents) {
    const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
    await writeFile(join(markerDir, "lease.1.json"), contents, "utf8");
    const registry = new LeaseRegistry({
      markerStore: new FileMarkerStore(markerDir),
      now: () => new Date(NOW),
    });

    await assert.rejects(registry.start(), /marker/i);
  }
});

test("filesystem store fails closed when a marker candidate cannot be read", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  await writeFile(join(markerDir, "lease.1.json"), JSON.stringify(marker()), "utf8");
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir, {
      readMarker: async () => {
        throw Object.assign(new Error("read denied"), { code: "EACCES" });
      },
    }),
    now: () => new Date(NOW),
  });

  await assert.rejects(registry.start(), /marker/i);
});

test("filesystem store ignores non-marker files in the dedicated directory", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  await writeFile(join(markerDir, "notes.txt"), "not a marker", "utf8");
  await writeFile(join(markerDir, ".lease.1.stale.tmp"), "{", "utf8");
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });

  await registry.start();
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
});

test("filesystem store rejects group or other writable POSIX directories and markers", async (t) => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("POSIX ownership and mode bits are unavailable on this host");
    return;
  }
  const insecureDirectory = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  await chmod(insecureDirectory, 0o770);
  await assert.rejects(new FileMarkerStore(insecureDirectory).load(), /permissions|owner/i);

  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const store = new FileMarkerStore(markerDir);
  await store.write(marker());
  await chmod(join(markerDir, "lease.1.json"), 0o660);
  await assert.rejects(store.load(), /permissions|owner/i);
});

test("filesystem store rejects non-sticky writable POSIX ancestors but allows trusted ancestors", async (t) => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("POSIX ancestor mode bits are unavailable on this host");
    return;
  }
  const insecureParent = await mkdtemp(join(tmpdir(), "agent-guard-parent-"));
  await chmod(insecureParent, 0o777);
  await assert.rejects(
    new FileMarkerStore(join(insecureParent, "markers")).write(marker()),
    /ancestor.*permissions/i,
  );

  const stickyParent = await mkdtemp(join(tmpdir(), "agent-guard-parent-"));
  await chmod(stickyParent, 0o1777);
  await new FileMarkerStore(join(stickyParent, "markers")).write(marker());

  const secureParent = await mkdtemp(join(tmpdir(), "agent-guard-parent-"));
  await chmod(secureParent, 0o755);
  await new FileMarkerStore(join(secureParent, "markers")).write(marker());
});

test("POSIX ancestor policy rejects sticky directories owned by an untrusted user", () => {
  const currentUid = 1000;
  const attackerUid = 1001;

  assert.equal(isTrustedPosixAncestorMetadata(0o1777, attackerUid, currentUid), false);
  assert.equal(isTrustedPosixAncestorMetadata(0o1777, currentUid, currentUid), true);
  assert.equal(isTrustedPosixAncestorMetadata(0o1777, 0, currentUid), true);
  assert.equal(isTrustedPosixAncestorMetadata(0o0755, attackerUid, currentUid), true);
  assert.equal(isTrustedPosixAncestorMetadata(0o0777, currentUid, currentUid), false);
});

test("Windows marker paths are anchored to OS-provided user roots", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows user-root policy is not used on this host");
    return;
  }
  const outsideUserRoots = join(parse(homedir()).root, "agent-guard-untrusted-root", "markers");
  assert.throws(() => new FileMarkerStore(outsideUserRoots), /user root/i);
  assert.doesNotThrow(() => new FileMarkerStore(join(homedir(), ".agent-guard", "markers")));
  assert.doesNotThrow(() => new FileMarkerStore(join(tmpdir(), "agent-guard-markers")));
});

test("filesystem store creates and syncs each fresh directory entry parent-to-child", async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const markerDir = join(base, "level-one", "level-two");
  const events: string[] = [];
  const store = new FileMarkerStore(markerDir, {
    createDirectory: async (directory) => {
      events.push(`mkdir:${basename(directory)}`);
      await mkdir(directory, { mode: 0o700 });
    },
    rename: async (source, destination) => {
      events.push("rename");
      await rename(source, destination);
    },
    syncDirectory: async (directory) => {
      events.push(`sync:${basename(directory)}`);
    },
  });

  await store.write(marker());

  assert.deepEqual(events, [
    "mkdir:level-one",
    `sync:${basename(base)}`,
    "mkdir:level-two",
    "sync:level-one",
    "rename",
    "sync:level-two",
  ]);
});

test("fresh directory parent sync failure stops nested creation and marker writes", async () => {
  const base = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const markerDir = join(base, "level-one", "level-two");
  const store = new FileMarkerStore(markerDir, {
    createDirectory: async (directory) => mkdir(directory, { mode: 0o700 }),
    syncDirectory: async () => {
      throw new Error("parent directory sync failed");
    },
  });

  await assert.rejects(store.write(marker()), /parent directory sync failed/);

  assert.equal((await stat(join(base, "level-one"))).isDirectory(), true);
  await assert.rejects(stat(markerDir), { code: "ENOENT" });
});

test("filesystem store syncs directory metadata after rename and remove", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const events: string[] = [];
  const store = new FileMarkerStore(markerDir, {
    rename: async (source, destination) => {
      events.push("rename");
      await rename(source, destination);
    },
    unlink: async (path) => {
      events.push("unlink");
      await unlink(path);
    },
    syncDirectory: async () => {
      events.push("sync-directory");
    },
  });

  await store.write(marker());
  assert.deepEqual(events, ["rename", "sync-directory"]);
  events.length = 0;

  await store.remove("lease.1");
  assert.deepEqual(events, ["unlink", "sync-directory"]);
});

test("directory sync failures propagate through activation and retryable revoke transactions", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  let syncCalls = 0;
  const store = new FileMarkerStore(markerDir, {
    syncDirectory: async () => {
      syncCalls += 1;
      if (syncCalls === 1 || syncCalls === 3) throw new Error("directory sync failed");
    },
  });
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();

  await assert.rejects(registry.activate(activation()), /directory sync failed/);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });

  const recovered = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await recovered.start();
  await recovered.activate(activation());
  await assert.rejects(recovered.revoke("lease.1"), /directory sync failed/);
  assert.equal((await recovered.lookup("agent:guard:root.1")).state, "active");
  assert.equal(await recovered.revoke("lease.1"), true);
  assert.deepEqual(await recovered.lookup("agent:guard:root.1"), { state: "off" });
});

test("filesystem store rejects a symlink marker directory", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const target = join(parent, "target");
  const linked = join(parent, "linked");
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(linked),
    now: () => new Date(NOW),
  });

  await assert.rejects(registry.start(), /symbolic link/);
});

test("filesystem store rejects a symlink ancestor without creating through it", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const target = join(parent, "target");
  const linked = join(parent, "linked");
  await mkdir(target);
  try {
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("symlink creation is unavailable on this host");
      return;
    }
    throw error;
  }
  const store = new FileMarkerStore(join(linked, "must-not-create"));

  await assert.rejects(store.write(marker()), /symbolic link/);

  await assert.rejects(stat(join(target, "must-not-create")), { code: "ENOENT" });
});

test("filesystem store canonicalizes child ordering even when called directly", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  const store = new FileMarkerStore(markerDir);

  await store.write(marker({
    childSessionKeys: ["agent:guard:z", "agent:guard:a"],
  }));

  const persisted = JSON.parse(await readFile(join(markerDir, "lease.1.json"), "utf8")) as GuardedMarker;
  assert.deepEqual(persisted.childSessionKeys, ["agent:guard:a", "agent:guard:z"]);
});

test("startup keeps session identity conflicts in conservative recovery", async () => {
  const duplicateSessionRegistry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([
      marker(),
      marker({
        leaseId: "lease.2",
        rootSessionKey: "agent:guard:root.2",
        childSessionKeys: ["agent:guard:root.1"],
      }),
    ]),
    now: () => new Date(NOW),
  });
  await duplicateSessionRegistry.start();
  assert.equal((await duplicateSessionRegistry.lookup("agent:guard:root.1")).state, "recovery");
});

test("runtime remains exact OFF without marker I/O until explicitly started", async () => {
  let calls = 0;
  const store: MarkerStore = {
    load: async () => {
      calls += 1;
      return [];
    },
    write: async () => {
      calls += 1;
    },
    remove: async () => {
      calls += 1;
    },
  };
  const { AgentGuardRuntime } = await import("./runtime");
  const runtime = new AgentGuardRuntime({ markerStore: store, now: () => new Date(NOW) });

  assert.deepEqual(await runtime.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(await runtime.status(), {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  });
  assert.equal(calls, 0);
});

test("desktop packaging builds the ignored OpenClaw bundle before electron-builder", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const buildDesktop = rootPackage.scripts?.["build:desktop"] ?? "";

  assert.match(buildDesktop, /npm run build:openclaw-plugin/);
  assert.ok(
    buildDesktop.indexOf("npm run build:openclaw-plugin") < buildDesktop.indexOf("electron-builder"),
  );
});
