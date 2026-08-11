import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type {
  NativeGuardLeaseActivation,
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
import { createNativeGuardCoordinator } from "./nativeGuardCoordinator";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";
import type { OpenClawControlClient } from "./openclawControlClient";

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

test("invalid replacement policy returns 400 without changing the current main lease", async () => {
  const fixture = createFixture();
  const first = await fixture.service.start("policy.main");
  fixture.invalidPolicyIds.add("policy.missing");
  fixture.order.length = 0;

  await assert.rejects(
    fixture.service.start("policy.missing"),
    isServiceError("MAIN_AGENT_SUPERVISION_POLICY_INVALID", 400),
  );

  assert.deepEqual(fixture.order, ["load:policy.missing"]);
  assert.equal(fixture.revokeLeaseIds.length, 0);
  assert.equal(fixture.activateInputs.length, 1);
  assert.deepEqual(await fixture.service.status(), first);
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

test("online policy replacement conflicts without changing the current main lease", async () => {
  const fixture = createFixture();
  const first = await fixture.service.start("policy.main");
  fixture.order.length = 0;

  await assert.rejects(
    fixture.service.start("policy.next"),
    (error: unknown) =>
      isServiceError("MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT", 409)(error) &&
      (error as MainAgentSupervisionServiceError).message ===
        "Stop main-agent supervision before starting a policy.",
  );

  assert.deepEqual(fixture.order, ["load:policy.next"]);
  assert.deepEqual(fixture.revokeLeaseIds, []);
  assert.equal(fixture.activateInputs.length, 1);
  assert.equal(fixture.scheduled.length, 1);
  assert.deepEqual(await fixture.service.status(), first);
});

test("explicit stop permits starting a different policy", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.order.length = 0;

  const stopped = await fixture.service.stop();
  const started = await fixture.service.start("policy.next");

  assert.deepEqual(fixture.order, [
    "cancel:timer-1",
    "revoke:lease-1",
    "load:policy.next",
    "activate:policy.next",
    "schedule:timer-2",
  ]);
  assert.equal(stopped.mainLeaseCount, 0);
  assert.equal(started.policyPackId, "policy.next");
  assert.equal(started.leaseId, "lease-2");
});

test("a degraded current lease requires explicit stop before the same policy can start", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.setMainGatewayInstanceId("gateway.changed.test");
  const degraded = await fixture.service.status();
  fixture.order.length = 0;

  await assert.rejects(
    fixture.service.start("policy.main"),
    isServiceError("MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT", 409),
  );

  assert.deepEqual(fixture.order, ["load:policy.main"]);
  assert.deepEqual(fixture.revokeLeaseIds, []);
  assert.equal(fixture.activateInputs.length, 1);
  assert.deepEqual(await fixture.service.status(), degraded);
});

test("status retries retained fresh-start cleanup and permits a later start", async () => {
  const fixture = createCleanupLivenessFixture(1);

  await assert.rejects(
    fixture.service.start("policy.next"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );
  const failedLeaseId = fixture.activationCalls.at(-1)!.leaseId;
  assert.equal(fixture.coordinator.hasManagedLeases(), true);
  assert.equal(fixture.coordinator.isLeaseRevoking(failedLeaseId), true);

  const healed = await fixture.service.status();
  assert.equal(healed.coverage, "ready");
  assert.equal(healed.mainLeaseCount, 0);
  assert.equal(fixture.coordinator.hasManagedLeases(), false);
  assert.deepEqual(fixture.revokeCalls.slice(-2), [
    { gatewayUrl: fixture.gatewayUrl, leaseId: failedLeaseId },
    { gatewayUrl: fixture.gatewayUrl, leaseId: failedLeaseId },
  ]);

  const restarted = await fixture.service.start("policy.next");
  assert.equal(restarted.coverage, "active");
  assert.equal(restarted.policyPackId, "policy.next");
});

test("close retries retained fresh-start cleanup when no current lease exists", async () => {
  const fixture = createCleanupLivenessFixture(1);
  await assert.rejects(
    fixture.service.start("policy.next"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );
  const failedLeaseId = fixture.activationCalls.at(-1)!.leaseId;
  assert.equal(fixture.coordinator.isLeaseRevoking(failedLeaseId), true);

  await assert.doesNotReject(fixture.service.close());

  assert.equal(fixture.coordinator.hasManagedLeases(), false);
  assert.deepEqual(fixture.revokeCalls.slice(-2), [
    { gatewayUrl: fixture.gatewayUrl, leaseId: failedLeaseId },
    { gatewayUrl: fixture.gatewayUrl, leaseId: failedLeaseId },
  ]);
});

test("repeated fresh-start cleanup failure stays recovery with ownership retained", async () => {
  const fixture = createCleanupLivenessFixture(3);
  await assert.rejects(
    fixture.service.start("policy.next"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );
  const failedLeaseId = fixture.activationCalls.at(-1)!.leaseId;

  const first = await fixture.service.status();
  const second = await fixture.service.status();

  for (const status of [first, second]) {
    assert.equal(status.coverage, "recovery");
    assert.equal(status.reasonCode, "MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED");
    assert.equal(status.mainLeaseCount, 0);
    assert.equal(status.leaseId, undefined);
  }
  assert.equal(fixture.coordinator.hasManagedLeases(), true);
  assert.equal(fixture.coordinator.isLeaseRevoking(failedLeaseId), true);
  assert.equal(
    fixture.revokeCalls.filter((call) => call.leaseId === failedLeaseId).length,
    3,
  );
});

test("invalid fresh activation rolls back only the newly-added main lease", async () => {
  const fixture = createFixture();
  fixture.setExternalMain({
    ...unrelatedLease(),
    leaseId: "lease.external",
    policyPackId: "policy.external",
    policyPackDigest: digestJson(policyPack("policy.external")),
    gatewayInstanceId: "gateway.external.test",
  });
  fixture.setCoordinatorPolicyDigest("policy.next", "f".repeat(64));

  await assert.rejects(
    fixture.service.start("policy.next"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.deepEqual(fixture.activeLeaseIds(), ["lease.external"]);
  const status = await fixture.service.status();
  assert.equal(status.policyPackId, undefined);
  assert.equal(status.activeLeaseCount, 1);
});

test("does not adopt or renew an unmanaged main lease and fresh start conflicts", async () => {
  const fixture = createFixture();
  fixture.setExternalMain(mainLease({ leaseId: "lease.external" }));

  const status = await fixture.service.status();
  assert.equal(status.coverage, "recovery");
  assert.equal(status.reasonCode, "MAIN_AGENT_SUPERVISION_UNMANAGED_LEASE");
  assert.equal(status.mainLeaseCount, 1);
  assert.equal(fixture.scheduled.length, 0);
  await assert.rejects(
    fixture.service.start("policy.main"),
    isServiceError("MAIN_AGENT_SUPERVISION_UNMANAGED_LEASE", 409),
  );
  assert.equal(fixture.activateInputs.length, 0);
});

test("projects unrelated sandbox coverage as main ready while preserving system count", async () => {
  const fixture = createFixture({ unrelatedLease: true });

  const status = await fixture.service.status();

  assert.equal(status.coverage, "ready");
  assert.equal(status.activeLeaseCount, 1);
  assert.equal(status.mainLeaseCount, 0);
  assert.equal(status.gatewayInstanceId, undefined);
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

test("activation requires an exact usable summary with its own Gateway identity and expiry", async () => {
  for (const invalid of ["policy", "root", "scope", "usable", "gateway", "expiresAt"] as const) {
    const fixture = createFixture({ invalidActivation: invalid });

    await assert.rejects(
      fixture.service.start("policy.main"),
      isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
    );
    assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"], invalid);
  }
});

test("malformed activation rollback ignores a concurrent new different-policy lease", async () => {
  const fixture = createFixture({ invalidActivation: "scope" });
  fixture.setConcurrentActivationLease({
    ...unrelatedLease(),
    leaseId: "lease.concurrent",
    policyPackId: "policy.concurrent",
  });

  await assert.rejects(
    fixture.service.start("policy.main"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.deepEqual(fixture.activeLeaseIds(), ["lease.concurrent"]);
});

test("explicit activation identity never revokes a concurrent new same-policy lease", async () => {
  const fixture = createFixture({ invalidActivation: "scope" });
  fixture.setConcurrentActivationLease(mainLease({
    leaseId: "lease.concurrent",
    gatewayInstanceId: "gateway.concurrent.test",
  }));

  await assert.rejects(
    fixture.service.start("policy.main"),
    isServiceError("MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED", 503),
  );

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.deepEqual(fixture.activeLeaseIds(), ["lease.concurrent"]);
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

test("a non-advancing near-expiry renewal schedules one expiry cleanup instead of a zero-delay loop", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.renewLeaseIds.length === 1);
  await waitUntil(() => fixture.scheduled.length === 2);

  assert.equal(fixture.scheduled[1]?.delayMs, 500);
  assert.ok(fixture.scheduled[1]!.delayMs > 0);
  assert.deepEqual(fixture.renewLeaseIds, ["lease-1"]);

  fixture.nowMs += 500;
  fixture.scheduled[1]!.callback();
  await waitUntil(() => fixture.revokeLeaseIds.length === 1);

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.deepEqual(fixture.renewLeaseIds, ["lease-1"]);
  assert.equal((await fixture.service.status()).coverage, "ready");
  assert.equal((await fixture.service.status()).mainLeaseCount, 0);
});

test("explicit stop cancels a pending expiry cleanup timer before starting a new policy", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  fixture.order.length = 0;

  await fixture.service.stop();
  await fixture.service.start("policy.next");

  assert.deepEqual(fixture.order, [
    "cancel:timer-2",
    "revoke:lease-1",
    "load:policy.next",
    "activate:policy.next",
    "schedule:timer-3",
  ]);
});

test("stop cancels a pending expiry cleanup timer", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  fixture.order.length = 0;

  await fixture.service.stop();

  assert.deepEqual(fixture.order, ["cancel:timer-2", "revoke:lease-1"]);
});

test("expiry cleanup revoke failure remains recovery instead of turning supervision off", async () => {
  const fixture = createFixture({
    renewReturnsUnchangedExpiry: true,
    revokeFailures: 1,
  });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  fixture.nowMs += 500;
  fixture.scheduled[1]!.callback();
  await waitUntil(() => fixture.revokeLeaseIds.length === 1);

  const status = await fixture.service.status();
  assert.equal(status.coverage, "recovery");
  assert.equal(status.reasonCode, "MAIN_AGENT_SUPERVISION_STOP_FAILED");
  assert.equal(status.leaseId, "lease-1");
  assert.equal(fixture.scheduled.length, 2);
});

test("a malformed renewed expiry is cleaned up once without scheduling another timer", async () => {
  const fixture = createFixture({ renewInvalidExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_000;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.revokeLeaseIds.length === 1);

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.equal(fixture.scheduled.length, 1);
  assert.equal((await fixture.service.status()).mainLeaseCount, 0);
});

test("a malformed status expiry is cleaned up without retaining the renewal timer", async () => {
  const fixture = createFixture();
  await fixture.service.start("policy.main");
  fixture.setMainExpiry("not-a-date");

  const status = await fixture.service.status();

  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);
  assert.equal(fixture.scheduled.length, 1);
  assert.equal(status.mainLeaseCount, 0);
});

test("a cancelled expiry callback cannot clear the explicitly restarted lease timer", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");
  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  const cancelledTimer = fixture.scheduled[1]!;
  await fixture.service.stop();
  await fixture.service.start("policy.next");
  fixture.order.length = 0;

  cancelledTimer.callback();
  await fixture.service.stop();

  assert.deepEqual(fixture.order, ["cancel:timer-3", "revoke:lease-2"]);
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1", "lease-2"]);
});

test("an expiry cleanup callback fired before expiry reschedules without revoking", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  fixture.nowMs -= 100;
  fixture.scheduled[1]!.callback();
  await waitUntil(() => fixture.scheduled.length === 3);

  assert.deepEqual(fixture.revokeLeaseIds, []);
  assert.equal(fixture.scheduled[2]?.delayMs, 600);
});

test("an expiry cleanup callback preserves a same-id lease renewed before it runs", async () => {
  const fixture = createFixture({ renewReturnsUnchangedExpiry: true });
  await fixture.service.start("policy.main");

  fixture.nowMs += 2_500;
  fixture.scheduled[0]!.callback();
  await waitUntil(() => fixture.scheduled.length === 2);
  fixture.advanceMainLease();
  await fixture.service.status();
  fixture.nowMs += 500;
  fixture.scheduled[1]!.callback();
  await waitUntil(() => fixture.scheduled.length === 3);

  assert.deepEqual(fixture.revokeLeaseIds, []);
  assert.equal(fixture.scheduled[2]?.delayMs, 1_500);
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

test("plugin-unconfirmed stop retains identity and requires explicit stop retries", async () => {
  const fixture = createFixture({ revokeUnconfirmedCount: 2 });
  await fixture.service.start("policy.main");

  const first = await fixture.service.stop();
  assert.equal(first.coverage, "recovery");
  assert.equal(first.reasonCode, "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED");
  assert.equal(first.leaseId, "lease-1");
  await assert.rejects(
    fixture.service.start("policy.next"),
    isServiceError("MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT", 409),
  );
  assert.equal(fixture.activateInputs.length, 1);
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1"]);

  const retried = await fixture.service.stop();
  assert.equal(retried.mainLeaseCount, 1);
  const stopped = await fixture.service.stop();
  assert.equal(stopped.mainLeaseCount, 0);
  assert.deepEqual(fixture.revokeLeaseIds, ["lease-1", "lease-1", "lease-1"]);
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
  invalidActivation?: "policy" | "root" | "scope" | "usable" | "gateway" | "expiresAt";
  renewError?: Error;
  renewInvalidExpiry?: boolean;
  renewReturnsUnchangedExpiry?: boolean;
  revokeFailures?: number;
  revokeUnconfirmedCount?: number;
};

function createFixture(options: FixtureOptions = {}) {
  let leaseSequence = 0;
  let timerSequence = 0;
  let activeMain: NativeGuardLeaseSummary | undefined;
  let externalMain: NativeGuardLeaseSummary | undefined;
  let concurrentActivationLease: NativeGuardLeaseSummary | undefined;
  let pendingConcurrentActivationLease: NativeGuardLeaseSummary | undefined;
  let unrelatedActive = options.unrelatedLease === true;
  let revokeFailures = options.revokeFailures ?? 0;
  let revokeUnconfirmedCount = options.revokeUnconfirmedCount ?? 0;
  const activationFailures = new Map<string, number>();
  const coordinatorPolicyDigests = new Map<string, string>();
  const coordinatorGateways = new Map<string, string>();
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
    setExternalMain(value: NativeGuardLeaseSummary | undefined) { externalMain = value; },
    setConcurrentActivationLease(value: NativeGuardLeaseSummary | undefined) {
      pendingConcurrentActivationLease = value;
    },
    failNextActivation(policyPackId: string) {
      activationFailures.set(policyPackId, (activationFailures.get(policyPackId) ?? 0) + 1);
    },
    setCoordinatorPolicyDigest(policyPackId: string, digest: string) {
      coordinatorPolicyDigests.set(policyPackId, digest);
    },
    setCoordinatorGateway(policyPackId: string, gatewayInstanceId: string) {
      coordinatorGateways.set(policyPackId, gatewayInstanceId);
    },
    activeLeaseIds() {
      return [externalMain, concurrentActivationLease, activeMain]
        .flatMap((lease) => lease ? [lease.leaseId] : []);
    },
    setMainGatewayInstanceId(value: string | undefined) {
      if (activeMain) activeMain = { ...activeMain, gatewayInstanceId: value };
    },
    setMainExpiry(value: string) {
      if (activeMain) activeMain = { ...activeMain, expiresAt: value };
    },
    advanceMainLease() {
      assert.ok(activeMain);
      activeMain = {
        ...activeMain,
        leaseEpoch: activeMain.leaseEpoch + 1,
        expiresAt: new Date(fixture.nowMs + TTL_MS).toISOString(),
      };
    },
    service: undefined as unknown as ReturnType<typeof createMainAgentSupervisionService>,
  };
  const unrelated = unrelatedLease();
  const aggregate = (
    main = activeMain,
    coverage: NativeGuardStatus["coverage"] = main || externalMain ||
        concurrentActivationLease || unrelatedActive
      ? "active"
      : "ready",
  ): NativeGuardStatus => {
    const activeLeases = [
      ...(unrelatedActive ? [unrelated] : []),
      ...(externalMain ? [externalMain] : []),
      ...(concurrentActivationLease ? [concurrentActivationLease] : []),
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
  async function activate(input: Record<string, unknown>) {
      activateInputs.push(structuredClone(input));
      order.push(`activate:${String(input.policyPackId)}`);
      await options.beforeActivate?.();
      const policyPackId = String(input.policyPackId);
      const failures = activationFailures.get(policyPackId) ?? 0;
      if (failures > 0) {
        activationFailures.set(policyPackId, failures - 1);
        throw new Error("activation failed");
      }
      const leaseId = `lease-${String(++leaseSequence)}`;
      const expiresAt = new Date(fixture.nowMs + TTL_MS).toISOString();
      activeMain = mainLease({
        leaseId,
        ...(options.invalidActivation === "root"
          ? { rootSessionKey: "agent:main:wrong" }
          : {}),
        policyPackId: options.invalidActivation === "policy"
          ? "policy.malformed"
          : policyPackId,
        policyPackDigest: coordinatorPolicyDigests.get(policyPackId) ??
          digestJson(policyPack(policyPackId)),
        gatewayInstanceId: coordinatorGateways.get(policyPackId) ?? "gateway.host.test",
        expiresAt: options.invalidActivation === "expiresAt" ? "not-a-date" : expiresAt,
        ...(options.invalidActivation === "scope"
          ? { scope: { kind: "session" as const, sessionKey: "agent:main:main" } }
          : {}),
        ...(options.invalidActivation === "gateway"
          ? { gatewayInstanceId: undefined }
          : {}),
      });
      if (options.invalidActivation !== "usable") usableLeaseIds.add(leaseId);
      concurrentActivationLease = pendingConcurrentActivationLease;
      pendingConcurrentActivationLease = undefined;
      return aggregate(activeMain, options.activationCoverage);
  }
  const coordinator = {
    activate,
    async activateWithIdentity(input: Record<string, unknown>) {
      const status = await activate(input);
      assert.ok(activeMain);
      return {
        status,
        leaseId: activeMain.leaseId,
        leaseEpoch: activeMain.leaseEpoch,
      };
    },
    async renew(leaseId: string, ttlMs?: number) {
      renewLeaseIds.push(leaseId);
      renewTtls.push(ttlMs);
      if (options.renewError) throw options.renewError;
      assert.equal(activeMain?.leaseId, leaseId);
      activeMain = {
        ...activeMain,
        leaseEpoch: activeMain.leaseEpoch + 1,
        expiresAt: options.renewInvalidExpiry
          ? "not-a-date"
          : options.renewReturnsUnchangedExpiry
          ? activeMain.expiresAt
          : new Date(fixture.nowMs + TTL_MS).toISOString(),
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
      if (revokeUnconfirmedCount > 0) {
        revokeUnconfirmedCount -= 1;
        usableLeaseIds.delete(leaseId);
        return {
          coverage: "recovery" as const,
          finalizerAssurance: "exclusive_before_hook" as const,
          activeLeaseCount: (unrelatedActive ? 1 : 0) + (externalMain ? 1 : 0),
          activeLeases: [
            ...(unrelatedActive ? [unrelated] : []),
            ...(externalMain ? [externalMain] : []),
          ],
          reasonCode: "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
        };
      }
      usableLeaseIds.delete(leaseId);
      if (activeMain?.leaseId === leaseId) activeMain = undefined;
      if (concurrentActivationLease?.leaseId === leaseId) {
        concurrentActivationLease = undefined;
      }
      return aggregate();
    },
    async status() {
      return aggregate();
    },
    isLeaseUsable(leaseId: string) {
      return usableLeaseIds.has(leaseId);
    },
    hasManagedLeases() {
      return activeMain !== undefined || unrelatedActive;
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

function createCleanupLivenessFixture(cleanupFailures: number) {
  const gatewayUrl = "http://127.0.0.1:18789";
  const gatewayInstanceId = "gateway.host.cleanup.test";
  const { publicKey } = generateKeyPairSync("ed25519");
  const leaseService = createNativeGuardLeaseService({ now: () => NOW });
  const activationCalls: NativeGuardLeaseActivation[] = [];
  const revokeCalls: Array<{ gatewayUrl: string; leaseId: string }> = [];
  let remainingCleanupFailures = cleanupFailures;
  let failNextReplacement = true;
  let pluginStatus = cleanupPluginStatus();
  const capability = {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance: "exclusive_before_hook" as const,
    conflictingPluginIds: [],
  };
  const controlClient: OpenClawControlClient = {
    async inspectCapabilities() {
      return capability;
    },
    async attestGateway(input) {
      return {
        contractVersion: "native-guard-gateway-1",
        signatureContext: "native_guard.gateway_attestation.v1",
        challenge: input.challenge,
        gatewayUrl: input.gatewayUrl,
        gatewayInstanceId,
        openclawVersion: capability.openclawVersion,
        nativeGuard: {
          contractVersion: "native-guard-1",
          registrarStatus: "live",
          finalBeforeToolCall: { pluginId: "agent-guard-supervision", exclusive: true },
          trustedToolPolicy: { policyId: "agent-guard-admission", exclusive: true },
          recoveryService: { serviceId: "agent-guard-runtime", live: true },
          postApprovalLeaseRecheck: true,
          paramsProvenance: "json-only",
        },
        signature: "test-signature",
      };
    },
    async status() {
      return pluginStatus;
    },
    async activate(_gatewayUrl, activation) {
      activationCalls.push(structuredClone(activation));
      if (activation.policyPackId === "policy.next" && failNextReplacement) {
        failNextReplacement = false;
        pluginStatus = cleanupPluginStatus({
          ...activation,
          policyPackDigest: "f".repeat(64),
        });
      } else {
        pluginStatus = cleanupPluginStatus(activation);
      }
      return pluginStatus;
    },
    async renew(_gatewayUrl, activation) {
      pluginStatus = cleanupPluginStatus(activation);
      return pluginStatus;
    },
    async revoke(revokeGatewayUrl, leaseId) {
      revokeCalls.push({ gatewayUrl: revokeGatewayUrl, leaseId });
      const replacement = activationCalls.at(-1);
      if (
        replacement?.policyPackId === "policy.next" &&
        replacement.leaseId === leaseId &&
        remainingCleanupFailures > 0
      ) {
        remainingCleanupFailures -= 1;
        throw new Error("plugin cleanup unavailable");
      }
      pluginStatus = cleanupPluginStatus();
      return pluginStatus;
    },
  };
  const loadPolicy = async (policyPackId: string) => {
    const pack = policyPack(policyPackId);
    return {
      policyPack: pack,
      policyPackDigest: digestJson(pack),
      runGroupId: "run-group.cleanup",
    };
  };
  const coordinator = createNativeGuardCoordinator({
    leaseService,
    controlClient,
    loadStoredOpenClawPolicyPack: loadPolicy,
    gatewayUrl,
    backendUrl: "http://127.0.0.1:3000/api/v1/openclaw/native-guard/decision",
    capabilityInput: { isolatedProfile: false },
    gatewayAttestationPublicKey: publicKey,
  });
  const service = createMainAgentSupervisionService({
    coordinator,
    loadStoredOpenClawPolicyPack: loadPolicy,
    ttlMs: TTL_MS,
    now: () => NOW,
    scheduleTimeout: () => "timer-cleanup",
    cancelTimeout: () => undefined,
  });
  return { service, coordinator, activationCalls, revokeCalls, gatewayUrl };
}

function cleanupPluginStatus(activation?: NativeGuardLeaseActivation): NativeGuardStatus {
  const activeLease = activation ? {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    rootSessionKey: activation.rootSessionKey,
    scope: structuredClone(activation.scope),
    mode: activation.mode,
    policyPackId: activation.policyPackId,
    policyPackDigest: activation.policyPackDigest,
    expiresAt: activation.expiresAt,
    gatewayInstanceId: "gateway.host.cleanup.test",
  } : undefined;
  return {
    coverage: activeLease ? "active" : "ready",
    finalizerAssurance: "exclusive_before_hook",
    openclawVersion: "2026.7.2",
    gatewayInstanceId: "gateway.host.cleanup.test",
    activeLeaseCount: activeLease ? 1 : 0,
    activeLeases: activeLease ? [activeLease] : [],
    ...(activeLease ? { activeLease } : {}),
    conflictingPluginIds: [],
  };
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
