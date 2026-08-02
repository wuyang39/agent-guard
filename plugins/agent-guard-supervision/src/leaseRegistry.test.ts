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
  type GuardedMarker,
  type MarkerStore,
} from "./leaseRegistry";

const NOW = "2026-08-02T00:00:00.000Z";

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

const DECISION_KEY_PAIR = generateKeyPairSync("ed25519");
const DECISION_PUBLIC_KEY = DECISION_KEY_PAIR.publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const DECISION_PRIVATE_KEY = DECISION_KEY_PAIR.privateKey.export({
  type: "pkcs8",
  format: "pem",
}).toString();

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
    ...overrides,
  };
}

function marker(overrides: Partial<GuardedMarker> = {}): GuardedMarker {
  return {
    leaseId: "lease.1",
    rootSessionKey: "agent:guard:root.1",
    childSessionKeys: [],
    mode: "supervision",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-02T00:05:00.000Z",
    ...overrides,
  };
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
  assert.deepEqual(store.writes, [marker()]);
  assert.equal(JSON.stringify(store.writes).includes("credential"), false);
  assert.equal(JSON.stringify(store.writes).includes("PUBLIC KEY"), false);
  assert.deepEqual(await registry.status(), {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLease: {
      leaseId: "lease.1",
      leaseEpoch: 1,
      rootSessionKey: "agent:guard:root.1",
      mode: "supervision",
      policyPackId: "policy.1",
      policyPackDigest: "a".repeat(64),
      expiresAt: "2026-08-02T00:05:00.000Z",
    },
  });
});

test("activation rejects malformed security fields without writing a marker", async () => {
  const invalidInputs: NativeGuardLeaseActivation[] = [
    { ...activation(), policyPack: { secret: "must-not-enter-plugin-state" } } as NativeGuardLeaseActivation,
    activation({ schemaVersion: "other" as "native-guard-1" }),
    activation({ leaseEpoch: 0 }),
    activation({ scope: "other" as "session_tree" }),
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
  assert.deepEqual(store.writes.at(-1), marker({
    childSessionKeys: ["agent:guard:child.1", "agent:guard:child.2"],
  }));
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
  }));

  const current = await registry.lookup("agent:guard:root.1");
  assert.equal(current.state, "active");
  if (current.state !== "active") assert.fail("expected active lease");
  assert.equal(current.leaseEpoch, 2);
  assert.equal(current.credential, "credential.2");
  assert.equal(JSON.stringify(await registry.status()).includes("credential"), false);
  assert.deepEqual(store.writes.at(-1), marker({ expiresAt: "2026-08-02T00:06:00.000Z" }));
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

  await assert.rejects(registry.renew(activation({ leaseEpoch: 2, credential: "credential.2" })), /marker write failed/);

  const current = await registry.lookup("agent:guard:root.1");
  assert.equal(current.state, "active");
  if (current.state === "active") {
    assert.equal(current.leaseEpoch, 1);
    assert.equal(current.credential, "credential.1");
  }
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

test("ending the root revokes the lease and deletes its marker", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  await registry.bindChild("lease.1", "agent:guard:root.1", "agent:guard:child");

  assert.equal(await registry.endSession("agent:guard:root.1"), true);

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(await registry.lookup("agent:guard:child"), { state: "off" });
  assert.deepEqual(store.removes, ["lease.1"]);
});

test("ending an active root preserves active state when marker removal fails", async () => {
  const store = new MemoryMarkerStore();
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  await registry.activate(activation());
  store.failRemoveLeaseIds.add("lease.1");

  await assert.rejects(registry.endSession("agent:guard:root.1"), /marker remove failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "active");
  store.failRemoveLeaseIds.clear();
  assert.equal(await registry.endSession("agent:guard:root.1"), true);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
});

test("ending a recovery root preserves recovery state when marker removal fails", async () => {
  const store = new MemoryMarkerStore([marker()]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });
  await registry.start();
  store.failRemoveLeaseIds.add("lease.1");

  await assert.rejects(registry.endSession("agent:guard:root.1"), /marker remove failed/);

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
  store.failRemoveLeaseIds.clear();
  assert.equal(await registry.endSession("agent:guard:root.1"), true);
  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
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
  }));

  assert.deepEqual(await registry.status(), {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 2,
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
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), marker());
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
    expiresAt: "2026-08-02T00:06:00.000Z",
  }));

  assert.deepEqual(await readdir(markerDir), ["lease.1.json"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(markerDir, "lease.1.json"), "utf8")),
    marker({ expiresAt: "2026-08-02T00:06:00.000Z" }),
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
