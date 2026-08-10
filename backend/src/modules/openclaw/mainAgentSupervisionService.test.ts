import assert from "node:assert/strict";
import test from "node:test";
import type {
  NativeGuardLeaseSummary,
  NativeGuardStatus,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import {
  createMainAgentSupervisionService,
  MainAgentSupervisionServiceError,
  type MainAgentSupervisionStatus,
} from "./mainAgentSupervisionService";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");
const TTL_MS = 3_000;

test("start activates exact main-agent supervision and separates main from system lease counts", async () => {
  const fixture = createFixture({ unrelatedLease: true });

  const status = await fixture.service.start("policy.main");

  assert.deepEqual(fixture.activateInputs, [{
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
    mode: "supervision",
    policyPackId: "policy.main",
    ttlMs: TTL_MS,
  }]);
  assert.deepEqual(status, {
    coverage: "active",
    scope: { kind: "agent", agentId: "main" },
    policyPackId: "policy.main",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-10T00:00:03.000Z",
    gatewayInstanceId: "gateway.host.test",
    activeLeaseCount: 2,
    mainLeaseCount: 1,
  });
  assert.equal(fixture.scheduled[0]?.delayMs, 2_000);
});

test("binds main lifecycle to its per-lease Gateway while sandbox leases change", async () => {
  const fixture = createFixture({ unrelatedLease: true });

  const started = await fixture.service.start("policy.main");
  assert.equal(started.gatewayInstanceId, "gateway.host.test");
  assert.equal((await fixture.service.status()).coverage, "active");

  fixture.setUnrelatedActive(false);
  assert.deepEqual(
    pickCoverage(await fixture.service.status()),
    { coverage: "active", activeLeaseCount: 1, mainLeaseCount: 1 },
  );
  fixture.setUnrelatedActive(true);
  fixture.nowMs += 2_000;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);

  assert.deepEqual(
    pickCoverage(await fixture.service.status()),
    { coverage: "active", activeLeaseCount: 2, mainLeaseCount: 1 },
  );
  assert.equal(fixture.scheduled[1]?.delayMs, 2_000);
});

test("status rejects a changed main per-lease Gateway identity", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");

  fixture.setMainGatewayInstanceId("gateway.changed.test");
  const status = await fixture.service.status();

  assert.equal(status.coverage, "recovery");
  assert.equal(status.reasonCode, "MAIN_AGENT_SUPERVISION_STATUS_MISMATCH");
  assert.equal(status.gatewayInstanceId, "gateway.host.test");
});

test("same-policy start is idempotent while its lease is usable", async () => {
  const fixture = createFixture();

  const first = await fixture.service.start("policy.main");
  const second = await fixture.service.start("policy.main");

  assert.deepEqual(second, first);
  assert.equal(fixture.activateInputs.length, 1);
  assert.equal(fixture.loadedPolicyIds.length, 1);
  assert.equal(fixture.revokeLeaseIds.length, 0);
});

test("invalid replacement policy never revokes the current main lease", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.invalidPolicyIds.add("policy.missing");

  await assert.rejects(
    fixture.service.start("policy.missing"),
    isServiceError("MAIN_AGENT_SUPERVISION_POLICY_INVALID", 400),
  );

  assert.equal(fixture.revokeLeaseIds.length, 0);
  assert.equal(fixture.activateInputs.length, 1);
  assert.equal((await fixture.service.status()).policyPackId, "policy.main");
});

test("policy prevalidation rejects malformed shapes, mismatched ids, digests, and sources", async () => {
  for (const invalid of ["shape", "id", "digest", "source"] as const) {
    const fixture = createFixture();
    fixture.invalidLoadedPolicy = invalid;

    await assert.rejects(
      fixture.service.start("policy.main"),
      isServiceError("MAIN_AGENT_SUPERVISION_POLICY_INVALID", 400),
    );
    assert.equal(fixture.activateInputs.length, 0, invalid);
  }
});

test("valid replacement validates before cancelling and revoking the old lease", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.order.length = 0;

  const status = await fixture.service.start("policy.next");

  assert.deepEqual(fixture.order, [
    "load:policy.next",
    "cancel:timer-1",
    "revoke:lease-1",
    "activate:policy.next",
    "schedule:timer-2",
  ]);
  assert.equal(status.policyPackId, "policy.next");
  assert.equal(status.leaseId, "lease-2");
});

test("concurrent same-policy starts serialize to one activation", async () => {
  const activationGate = deferred<void>();
  const fixture = createFixture({ beforeActivate: () => activationGate.promise });

  const firstPromise = fixture.service.start("policy.main");
  const secondPromise = fixture.service.start("policy.main");
  await waitUntil(() => fixture.activateInputs.length === 1);
  assert.equal(fixture.loadedPolicyIds.length, 1);

  activationGate.resolve();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(fixture.activateInputs.length, 1);
  assert.equal(first.leaseId, second.leaseId);
});

test("start followed concurrently by stop has deterministic call order", async () => {
  const activationGate = deferred<void>();
  const fixture = createFixture({ beforeActivate: () => activationGate.promise });

  const startPromise = fixture.service.start("policy.main");
  const stopPromise = fixture.service.stop();
  await waitUntil(() => fixture.activateInputs.length === 1);
  activationGate.resolve();

  await startPromise;
  const stopped = await stopPromise;
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.equal(stopped.mainLeaseCount, 0);
});

test("an invalid activation result is revoked and never exposed as active", async () => {
  const fixture = createFixture({ activationCoverage: "conditional" });

  await assert.rejects(
    fixture.service.start("policy.main"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  const status = await fixture.service.status();
  assert.equal(status.mainLeaseCount, 0);
  assert.notEqual(status.coverage, "active");
});

test("activation requires an exact usable summary with its own Gateway identity", async () => {
  for (const invalid of ["scope", "usable", "gateway"] as const) {
    const fixture = createFixture({ invalidActivation: invalid });

    await assert.rejects(
      fixture.service.start("policy.main"),
      isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
    );
    assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"], invalid);
  }
});

test("renew runs at two-thirds TTL and reschedules from the renewed expiry", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  assert.equal(fixture.scheduled[0]?.delayMs, 2_000);

  fixture.nowMs += 2_000;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.renewLeaseIds.length === 1);
  await waitUntil(() => fixture.scheduled.length === 2);

  assert.deepEqual(fixture.renewLeaseIds, ["lease-1"]);
  assert.equal(fixture.renewTtls[0], TTL_MS);
  assert.equal(fixture.scheduled[1]?.delayMs, 2_000);
  const status = await fixture.service.status();
  assert.equal(status.leaseId, "lease-1");
  assert.equal(status.leaseEpoch, 2);
  assert.equal(status.expiresAt, "2026-08-10T00:00:05.000Z");
});

test("renew failure stops the timer and exposes stable recovery state", async () => {
  const fixture = createFixture({ renewError: new Error("secret renewal failure") });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_000;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.renewLeaseIds.length === 1);
  const status = await fixture.service.status();

  assert.equal(fixture.scheduled.length, 1);
  assert.equal(status.coverage, "recovery");
  assert.equal(status.reasonCode, "MAIN_AGENT_SUPERVISION_RENEW_FAILED");
  assert.equal(status.detail, "Main-agent supervision lease renewal failed.");
  assert.equal(status.leaseId, "lease-1");
  assert.doesNotMatch(JSON.stringify(status), /secret/);
});

test("stop cancels renewal before revoke and is idempotent after success", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.order.length = 0;

  const first = await fixture.service.stop();
  const second = await fixture.service.stop();

  assert.deepEqual(fixture.order, ["cancel:timer-1", "revoke:lease-1"]);
  assert.equal(first.mainLeaseCount, 0);
  assert.equal(first.activeLeaseCount, 0);
  assert.equal(first.leaseId, undefined);
  assert.deepEqual(second, first);
});

test("revoke failure returns recovery with identity retained for retry", async () => {
  const fixture = createFixture({ revokeFailures: 1 });
  await fixture.service.start("policy.main");

  const failed = await fixture.service.stop();
  assert.equal(failed.coverage, "recovery");
  assert.equal(failed.reasonCode, "MAIN_AGENT_SUPERVISION_STOP_FAILED");
  assert.equal(failed.detail, "Main-agent supervision lease revocation could not be confirmed.");
  assert.equal(failed.leaseId, "lease-1");
  assert.equal(failed.mainLeaseCount, 1);

  const retried = await fixture.service.stop();
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1", "lease-1"]);
  assert.equal(retried.mainLeaseCount, 0);
});

test("close best-effort stops the lease without leaking revoke errors", async () => {
  const fixture = createFixture({ revokeFailures: 1 });
  await fixture.service.start("policy.main");

  await assert.doesNotReject(fixture.service.close());
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
});

type FixtureOptions = {
  unrelatedLease?: boolean;
  beforeActivate?: () => Promise<void>;
  activationCoverage?: NativeGuardStatus["coverage"];
  invalidActivation?: "scope" | "usable" | "gateway";
  renewError?: Error;
  revokeFailures?: number;
};

function createFixture(options: FixtureOptions = {}) {
  let leaseSequence = 0;
  let timerSequence = 0;
  let activeMain: NativeGuardLeaseSummary | undefined;
  let unrelatedActive = options.unrelatedLease === true;
  let revokeFailures = options.revokeFailures ?? 0;
  const usableLeaseIds = new Set<string>();
  const activateInputs: unknown[] = [];
  const renewLeaseIds: string[] = [];
  const renewTtls: Array<number | undefined> = [];
  const revokeLeaseIds: string[] = [];
  const loadedPolicyIds: string[] = [];
  const invalidPolicyIds = new Set<string>();
  const order: string[] = [];
  const scheduled: Array<{ id: string; callback: () => void; delayMs: number }> = [];
  const fixture = {
    nowMs: NOW,
    invalidLoadedPolicy: undefined as "shape" | "id" | "digest" | "source" | undefined,
    activateInputs,
    renewLeaseIds,
    renewTtls,
    revokeLeaseIds,
    loadedPolicyIds,
    invalidPolicyIds,
    order,
    scheduled,
    setUnrelatedActive(value: boolean) { unrelatedActive = value; },
    setMainGatewayInstanceId(value: string | undefined) {
      if (activeMain) activeMain = { ...activeMain, gatewayInstanceId: value };
    },
    service: undefined as unknown as ReturnType<typeof createMainAgentSupervisionService>,
  };
  const unrelated = unrelatedLease();
  const aggregate = (
    main = activeMain,
    coverage: NativeGuardStatus["coverage"] = main ? "active" : unrelatedActive ? "active" : "ready",
  ): NativeGuardStatus => {
    const activeLeases = [
      ...(unrelatedActive ? [unrelated] : []),
      ...(main ? [main] : []),
    ];
    return {
      coverage,
      finalizerAssurance: "exclusive_before_hook",
      ...(activeLeases.length === 1
        ? { gatewayInstanceId: activeLeases[0].gatewayInstanceId }
        : {}),
      activeLeaseCount: activeLeases.length,
      activeLeases,
      ...(activeLeases.length === 1 ? { activeLease: activeLeases[0] } : {}),
    };
  };
  const coordinator = {
    async activate(input: Record<string, unknown>) {
      activateInputs.push(structuredClone(input));
      order.push(`activate:${String(input.policyPackId)}`);
      await options.beforeActivate?.();
      const leaseId = `lease-${String(++leaseSequence)}`;
      const expiresAt = new Date(fixture.nowMs + TTL_MS).toISOString();
      activeMain = mainLease({
        leaseId,
        policyPackId: String(input.policyPackId),
        policyPackDigest: digestJson(policyPack(String(input.policyPackId))),
        expiresAt,
        ...(options.invalidActivation === "scope"
          ? { scope: { kind: "session" as const, sessionKey: "agent:main:main" } }
          : {}),
        ...(options.invalidActivation === "gateway"
          ? { gatewayInstanceId: undefined }
          : {}),
      });
      if (options.invalidActivation !== "usable") usableLeaseIds.add(leaseId);
      return aggregate(activeMain, options.activationCoverage);
    },
    async renew(leaseId: string, ttlMs?: number) {
      renewLeaseIds.push(leaseId);
      renewTtls.push(ttlMs);
      if (options.renewError) throw options.renewError;
      assert.equal(activeMain?.leaseId, leaseId);
      activeMain = {
        ...activeMain,
        leaseEpoch: activeMain.leaseEpoch + 1,
        expiresAt: new Date(fixture.nowMs + TTL_MS).toISOString(),
      };
      return aggregate();
    },
    async revoke(leaseId: string) {
      revokeLeaseIds.push(leaseId);
      order.push(`revoke:${leaseId}`);
      if (revokeFailures > 0) {
        revokeFailures -= 1;
        throw new Error("secret revoke failure");
      }
      usableLeaseIds.delete(leaseId);
      if (activeMain?.leaseId === leaseId) activeMain = undefined;
      return aggregate();
    },
    async status() {
      return aggregate();
    },
    isLeaseUsable(leaseId: string) {
      return usableLeaseIds.has(leaseId);
    },
  };
  fixture.service = createMainAgentSupervisionService({
    coordinator,
    ttlMs: TTL_MS,
    now: () => fixture.nowMs,
    async loadStoredOpenClawPolicyPack(policyPackId) {
      loadedPolicyIds.push(policyPackId);
      order.push(`load:${policyPackId}`);
      if (invalidPolicyIds.has(policyPackId)) return undefined;
      if (fixture.invalidLoadedPolicy === "shape") {
        return { policyPack: null, policyPackDigest: "", runGroupId: "" } as never;
      }
      const pack = policyPack(
        fixture.invalidLoadedPolicy === "id" ? `${policyPackId}.other` : policyPackId,
      );
      return {
        policyPack: fixture.invalidLoadedPolicy === "source"
          ? { ...pack, sourceDetectionReportId: "" }
          : pack,
        policyPackDigest: fixture.invalidLoadedPolicy === "digest"
          ? "0".repeat(64)
          : digestJson(pack),
        runGroupId: fixture.invalidLoadedPolicy === "source" ? "" : "run-group.detection",
      };
    },
    scheduleTimeout(callback, delayMs) {
      const timer = { id: `timer-${String(++timerSequence)}`, callback, delayMs };
      scheduled.push(timer);
      order.push(`schedule:${timer.id}`);
      return timer.id;
    },
    cancelTimeout(timerId) {
      order.push(`cancel:${String(timerId)}`);
    },
  });
  return fixture;
}

function mainLease(overrides: Partial<NativeGuardLeaseSummary> = {}): NativeGuardLeaseSummary {
  return {
    leaseId: "lease-1",
    leaseEpoch: 1,
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
    mode: "supervision",
    policyPackId: "policy.main",
    policyPackDigest: digestJson(policyPack("policy.main")),
    expiresAt: "2026-08-10T00:00:03.000Z",
    gatewayInstanceId: "gateway.host.test",
    ...overrides,
  };
}

function unrelatedLease(): NativeGuardLeaseSummary {
  return {
    leaseId: "lease-sandbox",
    leaseEpoch: 1,
    rootSessionKey: "agent:sandbox:run",
    scope: { kind: "session", sessionKey: "agent:sandbox:run" },
    mode: "detection",
    policyPackId: "policy.detection",
    policyPackDigest: "d".repeat(64),
    expiresAt: "2026-08-10T00:00:03.000Z",
    gatewayInstanceId: "gateway.sandbox.test",
  };
}

function pickCoverage(status: MainAgentSupervisionStatus) {
  return {
    coverage: status.coverage,
    activeLeaseCount: status.activeLeaseCount,
    mainLeaseCount: status.mainLeaseCount,
  };
}

function policyPack(policyPackId: string): SupervisionPolicyPack {
  return {
    schemaVersion: "p3-a-1",
    policyPackId,
    agentId: "main",
    sourceDetectionReportId: "detection.main",
    sourceRiskProfileId: "risk.main",
    policies: [{
      policyId: "policy-rule.main",
      sourceWeaknessIds: [],
      name: "Main supervision",
      description: "Main supervision",
      targetType: "tool_call",
      action: "deny",
      riskLevel: "high",
      match: { relation: "all" },
      reason: "Denied by test policy.",
    }],
    defaultAction: "deny",
    createdAt: "2026-08-10T00:00:00.000Z",
  };
}

function isServiceError(code: string, statusCode: number) {
  return (error: unknown) =>
    error instanceof MainAgentSupervisionServiceError &&
    error.code === code &&
    error.statusCode === statusCode;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for asynchronous service work.");
}
