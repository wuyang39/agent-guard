import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenClawHostCapabilityCache,
} from "./openclawHostCapabilityCache";
import type {
  NativeGuardCapability,
  OpenClawControlClient,
} from "./openclawControlClient";

const CAPABILITY: NativeGuardCapability = {
  openclawVersion: "2026.7.2",
  supportsNativeGuard: true,
  finalizerAssurance: "exclusive_before_hook",
  conflictingPluginIds: [],
};

test("coalesces concurrent host probes and returns isolated cached values", async () => {
  const probe = deferred<NativeGuardCapability>();
  let inspections = 0;
  const client = controlClient({
    inspectCapabilities: async () => {
      inspections += 1;
      return probe.promise;
    },
  });
  const cache = createOpenClawHostCapabilityCache();
  const cached = cache.wrap("agent-a", client);
  const input = { cliPath: "openclaw", isolatedProfile: false };

  const firstPending = cached.inspectCapabilities(input);
  const secondPending = cached.inspectCapabilities(input);
  assert.equal(inspections, 1);

  probe.resolve(CAPABILITY);
  const [first, second] = await Promise.all([firstPending, secondPending]);
  first.conflictingPluginIds.push("mutated");

  assert.deepEqual(second.conflictingPluginIds, []);
  assert.deepEqual((await cached.inspectCapabilities(input)).conflictingPluginIds, []);
  assert.equal(inspections, 1);
});

test("separates entries by runtime identity and capability profile", async () => {
  let inspections = 0;
  const client = controlClient({
    inspectCapabilities: async () => {
      inspections += 1;
      return CAPABILITY;
    },
  });
  const cache = createOpenClawHostCapabilityCache();
  const firstIdentity = cache.wrap("agent-a|gateway-a", client);
  const secondIdentity = cache.wrap("agent-b|gateway-a", client);

  await firstIdentity.inspectCapabilities({
    cliPath: "openclaw-a",
    env: { OPENCLAW_HOME: "home-a", OPENCLAW_STATE_DIR: "state-a" },
    isolatedProfile: false,
  });
  await firstIdentity.inspectCapabilities({
    cliPath: "openclaw-a",
    env: { OPENCLAW_HOME: "home-b", OPENCLAW_STATE_DIR: "state-a" },
    isolatedProfile: false,
  });
  await secondIdentity.inspectCapabilities({
    cliPath: "openclaw-a",
    env: { OPENCLAW_HOME: "home-a", OPENCLAW_STATE_DIR: "state-a" },
    isolatedProfile: false,
  });

  assert.equal(inspections, 3);
});

test("refreshes an expired host capability entry", async () => {
  let now = 1_000;
  let inspections = 0;
  const client = controlClient({
    inspectCapabilities: async () => ({
      ...CAPABILITY,
      openclawVersion: `2026.7.${String(++inspections)}`,
    }),
  });
  const cached = createOpenClawHostCapabilityCache({
    ttlMs: 5_000,
    now: () => now,
  }).wrap("agent-a", client);
  const input = { isolatedProfile: false };

  assert.equal((await cached.inspectCapabilities(input)).openclawVersion, "2026.7.1");
  now += 4_999;
  assert.equal((await cached.inspectCapabilities(input)).openclawVersion, "2026.7.1");
  now += 1;
  assert.equal((await cached.inspectCapabilities(input)).openclawVersion, "2026.7.2");
  assert.equal(inspections, 2);
});

test("does not retain transient unsupported or unverified host capabilities", async () => {
  let inspections = 0;
  const responses: NativeGuardCapability[] = [
    {
      ...CAPABILITY,
      supportsNativeGuard: false,
      finalizerAssurance: "unverified",
    },
    {
      ...CAPABILITY,
      finalizerAssurance: "unverified",
      conflictingPluginIds: ["plugin.starting"],
    },
    CAPABILITY,
  ];
  const cached = createOpenClawHostCapabilityCache().wrap(
    "agent-a",
    controlClient({
      inspectCapabilities: async () => responses[inspections++]!,
    }),
  );
  const input = { isolatedProfile: false };

  assert.equal((await cached.inspectCapabilities(input)).supportsNativeGuard, false);
  assert.equal(
    (await cached.inspectCapabilities(input)).finalizerAssurance,
    "unverified",
  );
  assert.equal((await cached.inspectCapabilities(input)).supportsNativeGuard, true);
  assert.equal((await cached.inspectCapabilities(input)).supportsNativeGuard, true);

  assert.equal(inspections, 3);
});

test("invalidates the identity after a failed Gateway control operation", async () => {
  let inspections = 0;
  const client = controlClient({
    inspectCapabilities: async () => {
      inspections += 1;
      return CAPABILITY;
    },
    status: async () => {
      throw new Error("gateway unavailable");
    },
  });
  const cached = createOpenClawHostCapabilityCache().wrap("agent-a", client);
  const input = { isolatedProfile: false };

  await cached.inspectCapabilities(input);
  await assert.rejects(() => cached.status("http://127.0.0.1:18789"));
  await cached.inspectCapabilities(input);

  assert.equal(inspections, 2);
});

function controlClient(
  overrides: Partial<OpenClawControlClient>,
): OpenClawControlClient {
  const unused = async () => {
    throw new Error("not called");
  };
  return {
    status: unused,
    inspectCapabilities: unused,
    attestGateway: unused,
    activate: unused,
    renew: unused,
    revoke: unused,
    ...overrides,
  } as OpenClawControlClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
