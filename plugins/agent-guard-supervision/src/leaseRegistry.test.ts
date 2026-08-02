import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  failWrite = false;
  failRemove = false;

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
    if (this.failRemove) throw new Error("marker remove failed");
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

test("startup removes expired valid markers and keeps missing or corrupt entries OFF", async () => {
  const store = new MemoryMarkerStore([
    marker({ leaseId: "expired.1", expiresAt: NOW }),
    { ...marker({ leaseId: "corrupt.1" }), credential: "must-not-load" },
  ]);
  const registry = new LeaseRegistry({ markerStore: store, now: () => new Date(NOW) });

  await registry.start();

  assert.deepEqual(await registry.lookup("agent:guard:root.1"), { state: "off" });
  assert.deepEqual(store.removes, ["expired.1"]);
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
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  const restarted = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });
  await restarted.start();
  assert.equal((await restarted.lookup("agent:guard:root.1")).state, "recovery");
});

test("filesystem store ignores malformed and oversized JSON without hiding healthy markers", async () => {
  const markerDir = await mkdtemp(join(tmpdir(), "agent-guard-marker-"));
  await writeFile(join(markerDir, "broken.json"), "{", "utf8");
  await writeFile(join(markerDir, "oversized.json"), " ".repeat(70_000), "utf8");
  await writeFile(join(markerDir, "healthy.1.json"), JSON.stringify(marker({ leaseId: "healthy.1" })), "utf8");
  const registry = new LeaseRegistry({
    markerStore: new FileMarkerStore(markerDir),
    now: () => new Date(NOW),
  });

  await registry.start();

  assert.equal((await registry.lookup("agent:guard:root.1")).state, "recovery");
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

test("startup rejects duplicate lease and session identities without corrupting healthy recovery", async () => {
  const duplicateLeaseStore = new MemoryMarkerStore([
    marker(),
    marker({ rootSessionKey: "agent:guard:root.2" }),
  ]);
  const duplicateLeaseRegistry = new LeaseRegistry({
    markerStore: duplicateLeaseStore,
    now: () => new Date(NOW),
  });
  await duplicateLeaseRegistry.start();
  assert.equal((await duplicateLeaseRegistry.lookup("agent:guard:root.1")).state, "recovery");
  assert.deepEqual(await duplicateLeaseRegistry.lookup("agent:guard:root.2"), { state: "off" });

  const duplicateSessionRegistry = new LeaseRegistry({
    markerStore: new MemoryMarkerStore([
      marker(),
      marker({ leaseId: "lease.2", childSessionKeys: ["agent:guard:root.1"] }),
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
