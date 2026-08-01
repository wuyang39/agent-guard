import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { findMatchingPolicies } from "../supervisor/policyEngine";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";
import { normalizeNativeToolAction } from "./nativeToolDecisionService";
import {
  NativeGuardCoordinatorError,
  createDetectionBaselinePolicyPack,
  createNativeGuardCoordinator,
  type NativeGuardCapability,
} from "./nativeGuardCoordinator";

test("revokes the backend lease when plugin activation fails", async () => {
  const fixture = coordinatorFixture({ activateError: new Error("plugin leaked credential-secret") });

  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_ACTIVATION_FAILED" &&
      !error.message.includes("credential-secret"),
  );

  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.revokeCalls.length, 1);
});

test("fails activation before capability, plugin, or lease creation when backend status is unavailable", async () => {
  const fixture = coordinatorFixture();
  let createCalls = 0;
  const createLease = fixture.leaseService.create.bind(fixture.leaseService);
  fixture.leaseService.create = (input) => {
    createCalls += 1;
    return createLease(input);
  };
  fixture.leaseService.status = () => {
    throw new Error("backend-status-secret");
  };

  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE" &&
      !error.message.includes("backend-status-secret"),
  );

  assert.equal(createCalls, 0);
  assert.equal(fixture.inspectCalls, 0);
  assert.equal(fixture.activationCalls.length, 0);
  assert.equal(fixture.coordinator.getLastStatus().coverage, "misconfigured");
  assert.equal(
    fixture.coordinator.getLastStatus().reasonCode,
    "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE",
  );
});

test("reports backend status unavailability without querying or promoting the plugin", async () => {
  const fixture = coordinatorFixture();
  fixture.leaseService.status = () => {
    throw new Error("backend-health-secret");
  };

  const result = await fixture.coordinator.status();

  assert.equal(result.coverage, "misconfigured");
  assert.equal(result.reasonCode, "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("backend-health-secret"), false);
  assert.equal(fixture.inspectCalls, 0);
  assert.equal(fixture.statusCalls, 0);
});

test("does not turn post-cleanup or unknown-revoke backend failures into ready", async () => {
  const managed = coordinatorFixture();
  await managed.coordinator.activate(supervisionInput());
  const revokeBackend = managed.leaseService.revoke.bind(managed.leaseService);
  managed.leaseService.revoke = (leaseId) => {
    const result = revokeBackend(leaseId);
    managed.leaseService.status = () => { throw new Error("post-cleanup-secret"); };
    return result;
  };
  const cleaned = await managed.coordinator.revoke(managed.activationCalls[0].leaseId);
  assert.notEqual(cleaned.coverage, "ready");
  assert.equal(cleaned.reasonCode, "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE");

  const unknown = coordinatorFixture();
  unknown.leaseService.status = () => { throw new Error("unknown-status-secret"); };
  const unknownResult = await unknown.coordinator.revoke("unknown-lease");
  assert.equal(unknownResult.coverage, "misconfigured");
  assert.equal(unknownResult.reasonCode, "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE");
});

test("keeps coordinator errors credential-free when rollback dependencies also fail", async () => {
  const fixture = coordinatorFixture({ activateError: new Error("plugin failure") });
  const revokeBackend = fixture.leaseService.revoke.bind(fixture.leaseService);
  fixture.leaseService.revoke = () => {
    throw new Error("backend exposed rollback-secret");
  };

  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_ACTIVATION_FAILED" &&
      !error.message.includes("rollback-secret"),
  );
  assert.equal(fixture.revokeCalls.length, 1);
  assert.equal(fixture.coordinator.isLeaseRevoking(fixture.activationCalls[0].leaseId), true);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 1);

  fixture.leaseService.revoke = revokeBackend;
  await fixture.coordinator.revoke(fixture.activationCalls[0].leaseId);
  assert.equal(fixture.coordinator.isLeaseRevoking(fixture.activationCalls[0].leaseId), false);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("activates only after verified preflight and renews the plugin with rotated credentials", async () => {
  const fixture = coordinatorFixture();
  const activated = await fixture.coordinator.activate(supervisionInput());
  const first = fixture.activationCalls[0];
  assert.equal(activated.coverage, "active");
  assert.equal(first.leaseEpoch, 1);

  const renewed = await fixture.coordinator.renew(first.leaseId);
  const second = fixture.renewCalls[0];
  assert.equal(renewed.coverage, "active");
  assert.equal(second.leaseEpoch, 2);
  assert.notEqual(second.credential, first.credential);
  assert.equal(fixture.leaseService.authenticate(first.leaseId, first.credential), undefined);
  assert.ok(fixture.leaseService.authenticate(second.leaseId, second.credential));
});

test("fails closed and clears state when plugin renewal cannot confirm the new epoch", async () => {
  const fixture = coordinatorFixture({ renewMismatch: true });
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;

  await assert.rejects(
    () => fixture.coordinator.renew(leaseId),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_RENEW_FAILED",
  );

  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.getLastStatus().coverage, "ready");
  assert.equal(fixture.revokeCalls.at(-1), leaseId);
});

test("rejects a plugin activation status for another lease and rolls back", async () => {
  const fixture = coordinatorFixture({ activationMismatch: true });
  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    hasCoordinatorCode("NATIVE_GUARD_ACTIVATION_FAILED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("requires activation acknowledgements to match every credential-free lease field", async () => {
  const mismatches: Array<Record<string, unknown>> = [
    { leaseEpoch: 99 },
    { rootSessionKey: "agent:wrong-root" },
    { mode: "detection" },
    { policyPackId: "wrong-policy" },
    { policyPackDigest: "wrong-digest" },
    { expiresAt: "2026-08-02T00:04:00.000Z" },
  ];
  for (const activationAckOverrides of mismatches) {
    const fixture = coordinatorFixture({ activationAckOverrides });
    await assert.rejects(
      () => fixture.coordinator.activate(supervisionInput()),
      hasCoordinatorCode("NATIVE_GUARD_ACTIVATION_FAILED"),
    );
    assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  }
});

test("requires renewed acknowledgements to match the rotated epoch and digest", async () => {
  for (const renewAckOverrides of [{ leaseEpoch: 1 }, { policyPackDigest: "stale-digest" }]) {
    const fixture = coordinatorFixture({ renewAckOverrides });
    await fixture.coordinator.activate(supervisionInput());
    await assert.rejects(
      () => fixture.coordinator.renew(fixture.activationCalls[0].leaseId),
      hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
    );
    assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  }
});

test("re-inspects capability after activation ACK and compensates any change", async () => {
  for (const capabilityAfterActivate of [
    {
      ...verifiedCapability(),
      finalizerAssurance: "unverified" as const,
      conflictingPluginIds: ["late-hook"],
    },
    {
      ...verifiedCapability(),
      finalizerAssurance: "isolated_profile" as const,
    },
  ]) {
    const fixture = coordinatorFixture({ capabilityAfterActivate });
    await assert.rejects(
      () => fixture.coordinator.activate(supervisionInput()),
      hasCoordinatorCode("NATIVE_GUARD_ACTIVATION_FAILED"),
    );
    assert.equal(fixture.inspectCalls, 2);
    assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  }
});

test("fails activation closed when the backend lease expires while plugin ACK is pending", async () => {
  const fixture = coordinatorFixture();
  const ackStarted = deferred<void>();
  const releaseAck = deferred<void>();
  fixture.controlClient.activate = async (_gatewayUrl, activation) => {
    fixture.activationCalls.push(activation);
    ackStarted.resolve();
    await releaseAck.promise;
    return status("active", activation.leaseId, activation);
  };

  const activating = fixture.coordinator.activate({ ...supervisionInput(), ttlMs: 1 });
  await ackStarted.promise;
  fixture.advanceTime(2);
  releaseAck.resolve();

  await assert.rejects(
    () => activating,
    hasCoordinatorCode("NATIVE_GUARD_ACTIVATION_FAILED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.isLeaseRevoking(fixture.activationCalls[0].leaseId), false);
});

test("keeps the lease unusable after plugin activation ACK until final backend commit", async () => {
  const fixture = coordinatorFixture();
  const ackStarted = deferred<void>();
  const releaseAck = deferred<void>();
  fixture.controlClient.activate = async (_gatewayUrl, activation) => {
    fixture.activationCalls.push(activation);
    ackStarted.resolve();
    await releaseAck.promise;
    return status("active", activation.leaseId, activation);
  };

  const activating = fixture.coordinator.activate(supervisionInput());
  await ackStarted.promise;
  const leaseId = fixture.activationCalls[0].leaseId;
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), false);
  releaseAck.resolve();
  await activating;
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), true);
});

test("does not let activation reclaim active phase after public revoke takes ownership", async () => {
  const fixture = coordinatorFixture();
  const activateStarted = deferred<void>();
  const releaseActivate = deferred<void>();
  const revokeStarted = deferred<void>();
  const releaseRevoke = deferred<void>();
  fixture.controlClient.activate = async (_gatewayUrl, activation) => {
    fixture.activationCalls.push(activation);
    activateStarted.resolve();
    await releaseActivate.promise;
    return status("active", activation.leaseId, activation);
  };
  fixture.controlClient.revoke = async () => {
    revokeStarted.resolve();
    await releaseRevoke.promise;
    return status("ready");
  };

  const activating = fixture.coordinator.activate(supervisionInput());
  await activateStarted.promise;
  const leaseId = fixture.activationCalls[0].leaseId;
  const revoking = fixture.coordinator.revoke(leaseId);
  await revokeStarted.promise;
  releaseActivate.resolve();
  const outcome = await operationOutcome(activating);
  const usableWhileRevoking = isLeaseUsable(fixture.coordinator, leaseId);
  releaseRevoke.resolve();
  await revoking;

  assert.equal(outcome.resolved, false);
  assert.equal(outcome.code, "NATIVE_GUARD_ACTIVATION_FAILED");
  assert.equal(usableWhileRevoking, false);
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), false);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("re-inspects renewal capability before rotation and fails closed before plugin renew", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.capability = {
    ...verifiedCapability(),
    finalizerAssurance: "unverified",
    conflictingPluginIds: ["pre-renew-hook"],
  };

  await assert.rejects(
    () => fixture.coordinator.renew(fixture.activationCalls[0].leaseId),
    hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
  );

  assert.equal(fixture.renewCalls.length, 0);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("re-inspects capability after renewal ACK and revokes the rotated lease on change", async () => {
  const fixture = coordinatorFixture({
    capabilityAfterRenew: {
      ...verifiedCapability(),
      supportsNativeGuard: false,
      finalizerAssurance: "unverified",
    },
  });
  await fixture.coordinator.activate(supervisionInput());

  await assert.rejects(
    () => fixture.coordinator.renew(fixture.activationCalls[0].leaseId),
    hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
  );

  assert.equal(fixture.renewCalls.length, 1);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.isLeaseRevoking(fixture.activationCalls[0].leaseId), false);
});

test("fails renewal closed when a second backend lease appears while plugin ACK is pending", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;
  const ackStarted = deferred<void>();
  const releaseAck = deferred<void>();
  fixture.controlClient.renew = async (_gatewayUrl, activation) => {
    fixture.renewCalls.push(activation);
    ackStarted.resolve();
    await releaseAck.promise;
    return status("active", activation.leaseId, activation);
  };

  const renewing = fixture.coordinator.renew(leaseId);
  await ackStarted.promise;
  createUnmanagedLease(fixture.leaseService, "agent:ack-race-second");
  releaseAck.resolve();

  await assert.rejects(
    () => renewing,
    hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 1);
  assert.equal(fixture.coordinator.isLeaseRevoking(leaseId), false);
  assert.equal(fixture.coordinator.getLastStatus().coverage, "conditional");
});

test("marks renewal unusable before awaits and rejects a concurrent renew without side effects", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;
  const ackStarted = deferred<void>();
  const releaseAck = deferred<void>();
  fixture.controlClient.renew = async (_gatewayUrl, activation) => {
    fixture.renewCalls.push(activation);
    if (fixture.renewCalls.length === 1) {
      ackStarted.resolve();
      await releaseAck.promise;
    }
    return status("active", activation.leaseId, activation);
  };

  const firstRenew = fixture.coordinator.renew(leaseId);
  await ackStarted.promise;
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), false);
  let assertionError: unknown;
  try {
    await assert.rejects(
      () => fixture.coordinator.renew(leaseId),
      hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
    );
  } catch (error) {
    assertionError = error;
  } finally {
    releaseAck.resolve();
  }
  await Promise.allSettled([firstRenew]);
  if (assertionError) throw assertionError;

  assert.equal(fixture.renewCalls.length, 1);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 1);
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), true);
});

test("does not let renewal overwrite revoking phase or return active", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;
  const renewStarted = deferred<void>();
  const releaseRenew = deferred<void>();
  const revokeStarted = deferred<void>();
  const releaseRevoke = deferred<void>();
  fixture.controlClient.renew = async (_gatewayUrl, activation) => {
    fixture.renewCalls.push(activation);
    renewStarted.resolve();
    await releaseRenew.promise;
    return status("active", activation.leaseId, activation);
  };
  fixture.controlClient.revoke = async () => {
    revokeStarted.resolve();
    await releaseRevoke.promise;
    return status("ready");
  };

  const renewing = fixture.coordinator.renew(leaseId);
  await renewStarted.promise;
  const revoking = fixture.coordinator.revoke(leaseId);
  await revokeStarted.promise;
  releaseRenew.resolve();
  const outcome = await operationOutcome(renewing);
  const usableWhileRevoking = isLeaseUsable(fixture.coordinator, leaseId);
  releaseRevoke.resolve();
  await revoking;

  assert.equal(outcome.resolved, false);
  assert.equal(outcome.code, "NATIVE_GUARD_RENEW_FAILED");
  assert.equal(usableWhileRevoking, false);
  assert.equal(isLeaseUsable(fixture.coordinator, leaseId), false);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("enforces one managed lease and refuses activation over unmanaged backend state", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  await assert.rejects(
    () => fixture.coordinator.activate({
      ...supervisionInput(),
      rootSessionKey: "agent:second",
    }),
    hasCoordinatorCode("NATIVE_GUARD_ALREADY_ACTIVE"),
  );
  assert.equal(fixture.activationCalls.length, 1);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 1);

  const unmanaged = coordinatorFixture();
  createUnmanagedLease(unmanaged.leaseService, "agent:unmanaged");
  await assert.rejects(
    () => unmanaged.coordinator.activate(supervisionInput()),
    hasCoordinatorCode("NATIVE_GUARD_ALREADY_ACTIVE"),
  );
  assert.equal(unmanaged.activationCalls.length, 0);
  assert.equal(unmanaged.leaseService.status().activeLeaseCount, 1);
});

test("reserves the single managed lease slot across concurrent activation preflight", async () => {
  const fixture = coordinatorFixture();
  const inspectStarted = deferred<void>();
  const releaseInspect = deferred<void>();
  let inspectCall = 0;
  fixture.controlClient.inspectCapabilities = async () => {
    inspectCall += 1;
    if (inspectCall === 1) {
      inspectStarted.resolve();
      await releaseInspect.promise;
    }
    return verifiedCapability();
  };

  const first = fixture.coordinator.activate(supervisionInput());
  await inspectStarted.promise;
  let assertionError: unknown;
  try {
    await assert.rejects(
      () => fixture.coordinator.activate({
        ...supervisionInput(),
        rootSessionKey: "agent:concurrent-second",
      }),
      hasCoordinatorCode("NATIVE_GUARD_ALREADY_ACTIVE"),
    );
  } catch (error) {
    assertionError = error;
  } finally {
    releaseInspect.resolve();
  }
  await Promise.allSettled([first]);
  if (assertionError) throw assertionError;

  assert.equal(fixture.activationCalls.length, 1);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 1);
});

test("deletes the backend lease after an offline plugin revoke and keeps repeats idempotent", async () => {
  const fixture = coordinatorFixture({ revokeError: new Error("offline") });
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;

  const first = await fixture.coordinator.revoke(leaseId);
  const second = await fixture.coordinator.revoke(leaseId);

  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(first.coverage, "ready");
  assert.equal(first.reasonCode, "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED");
  assert.equal(second.coverage, "ready");
  assert.equal(fixture.revokeCalls.length, 1);
});

test("marks a lease revoking before awaiting the plugin, then deletes the backend secret", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const activation = fixture.activationCalls[0];
  const pluginStarted = deferred<void>();
  const releasePlugin = deferred<void>();
  const order: string[] = [];
  const revokeBackend = fixture.leaseService.revoke.bind(fixture.leaseService);
  fixture.leaseService.revoke = (leaseId) => {
    order.push("backend");
    return revokeBackend(leaseId);
  };
  fixture.controlClient.revoke = async (_gatewayUrl, leaseId) => {
    order.push("plugin");
    pluginStarted.resolve();
    assert.equal(
      typeof fixture.coordinator.isLeaseRevoking === "function" &&
        fixture.coordinator.isLeaseRevoking(leaseId),
      true,
    );
    await releasePlugin.promise;
    return status("ready");
  };

  const revoking = fixture.coordinator.revoke(activation.leaseId);
  await pluginStarted.promise;

  assert.deepEqual(order, ["plugin"]);
  assert.equal(fixture.coordinator.isLeaseRevoking(activation.leaseId), true);
  assert.ok(fixture.leaseService.authenticate(activation.leaseId, activation.credential));

  releasePlugin.resolve();
  const result = await revoking;
  assert.deepEqual(order, ["plugin", "backend"]);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.isLeaseRevoking(activation.leaseId), false);
  assert.equal(result.coverage, "ready");
});

test("deletes the backend lease and warns when plugin revoke still reports active", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const activation = fixture.activationCalls[0];
  fixture.controlClient.revoke = async () => status("active", activation.leaseId, activation);

  const result = await fixture.coordinator.revoke(activation.leaseId);

  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(result.coverage, "ready");
  assert.equal(result.reasonCode, "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED");
});

test("treats an already expired backend lease as an idempotent revoke success", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate({ ...supervisionInput(), ttlMs: 1 });
  const leaseId = fixture.activationCalls[0].leaseId;
  fixture.advanceTime(2);

  const result = await fixture.coordinator.revoke(leaseId);

  assert.equal(result.coverage, "ready");
  assert.equal(fixture.coordinator.isLeaseRevoking(leaseId), false);
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("keeps the revoking gate set when backend deletion throws", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  const leaseId = fixture.activationCalls[0].leaseId;
  fixture.leaseService.revoke = () => {
    throw new Error("backend-revoke-secret");
  };

  await assert.rejects(
    () => fixture.coordinator.revoke(leaseId),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_REVOKE_FAILED" &&
      !error.message.includes("backend-revoke-secret"),
  );
  assert.equal(fixture.coordinator.isLeaseRevoking(leaseId), true);
});

test("keeps activation and renewal rollback records revoking until backend cleanup retries", async () => {
  const renewal = coordinatorFixture({ renewMismatch: true });
  await renewal.coordinator.activate(supervisionInput());
  const leaseId = renewal.activationCalls[0].leaseId;
  const revokeBackend = renewal.leaseService.revoke.bind(renewal.leaseService);
  renewal.leaseService.revoke = () => {
    throw new Error("rollback-delete-failed");
  };

  await assert.rejects(
    () => renewal.coordinator.renew(leaseId),
    hasCoordinatorCode("NATIVE_GUARD_RENEW_FAILED"),
  );
  assert.equal(renewal.coordinator.isLeaseRevoking(leaseId), true);
  assert.equal(renewal.leaseService.status().activeLeaseCount, 1);

  renewal.leaseService.revoke = revokeBackend;
  const retried = await renewal.coordinator.revoke(leaseId);
  assert.equal(retried.coverage, "ready");
  assert.equal(renewal.coordinator.isLeaseRevoking(leaseId), false);
  assert.equal(renewal.leaseService.status().activeLeaseCount, 0);
});

test("redacts dependency errors while revoking an unknown lease", async () => {
  const fixture = coordinatorFixture();
  fixture.leaseService.revoke = () => {
    throw new Error("unknown-revoke-secret");
  };

  await assert.rejects(
    () => fixture.coordinator.revoke("unknown-lease"),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_REVOKE_FAILED" &&
      !error.message.includes("unknown-revoke-secret"),
  );
});

test("blocks activation for an unsupported version without creating a lease", async () => {
  const fixture = coordinatorFixture({ capability: { ...verifiedCapability(), supportsNativeGuard: false } });
  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    hasCoordinatorCode("NATIVE_GUARD_UNSUPPORTED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.getLastStatus().coverage, "unsupported");
});

test("blocks a second enabled before hook and keeps status conditional with zero leases", async () => {
  const fixture = coordinatorFixture({
    capability: {
      ...verifiedCapability(),
      finalizerAssurance: "unverified",
      conflictingPluginIds: ["second-before-hook"],
    },
  });

  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    hasCoordinatorCode("NATIVE_GUARD_HOOK_ORDER_UNVERIFIED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
  assert.equal(fixture.coordinator.getLastStatus().coverage, "conditional");
  assert.deepEqual(fixture.coordinator.getLastStatus().conflictingPluginIds, ["second-before-hook"]);
});

test("defensively rejects contradictory verified capability data that still lists a conflict", async () => {
  const fixture = coordinatorFixture({
    capability: {
      ...verifiedCapability(),
      conflictingPluginIds: ["contradictory-conflict"],
    },
  });

  await assert.rejects(
    () => fixture.coordinator.activate(supervisionInput()),
    hasCoordinatorCode("NATIVE_GUARD_HOOK_ORDER_UNVERIFIED"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);
});

test("does not promote backend conditional status unless plugin and lease identities match", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.pluginStatus = status("active", "different-lease");

  const combined = await fixture.coordinator.status();

  assert.equal(combined.coverage, "conditional");
  assert.equal(combined.reasonCode, "NATIVE_GUARD_STATUS_MISMATCH");
});

test("reports anomalous backend multiplicity honestly and never promotes it active", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  createUnmanagedLease(fixture.leaseService, "agent:unexpected-second");

  const combined = await fixture.coordinator.status();

  assert.equal(combined.coverage, "conditional");
  assert.equal(combined.activeLeaseCount, 2);
});

test("uses the real backend count after managed and unknown revocations", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  createUnmanagedLease(fixture.leaseService, "agent:unexpected-second");
  const managedLeaseId = fixture.activationCalls[0].leaseId;

  const managedResult = await fixture.coordinator.revoke(managedLeaseId);
  assert.notEqual(managedResult.coverage, "ready");
  assert.equal(managedResult.activeLeaseCount, 1);

  const unknownResult = await fixture.coordinator.revoke("unknown-lease");
  assert.notEqual(unknownResult.coverage, "ready");
  assert.equal(unknownResult.activeLeaseCount, 1);
});

test("does not reuse a stale zero lastStatus when an unknown revoke finds backend state", async () => {
  const fixture = coordinatorFixture();
  createUnmanagedLease(fixture.leaseService, "agent:unmanaged-only");

  const result = await fixture.coordinator.revoke("unknown-lease");

  assert.equal(result.coverage, "conditional");
  assert.equal(result.activeLeaseCount, 1);
});

test("re-inspects hook order on every status and keeps the actual backend count", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.capability = {
    ...verifiedCapability(),
    finalizerAssurance: "unverified",
    conflictingPluginIds: ["late-before-hook"],
  };

  const combined = await fixture.coordinator.status();

  assert.equal(combined.coverage, "conditional");
  assert.equal(combined.finalizerAssurance, "unverified");
  assert.equal(combined.activeLeaseCount, 1);
  assert.deepEqual(combined.conflictingPluginIds, ["late-before-hook"]);
  assert.equal(fixture.statusCalls, 0);
  assert.equal(fixture.inspectCalls, 3);
});

test("reports a fresh unsupported capability without hiding an existing backend lease", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.capability = {
    ...verifiedCapability(),
    openclawVersion: "2026.6.1",
    supportsNativeGuard: false,
    finalizerAssurance: "unverified",
  };

  const combined = await fixture.coordinator.status();

  assert.equal(combined.coverage, "unsupported");
  assert.equal(combined.activeLeaseCount, 1);
  assert.equal(fixture.statusCalls, 0);
});

test("returns conditional with the backend count when fresh CLI inspection is unavailable", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.capabilityError = new Error("CLI leaked fresh-capability-secret");

  const combined = await fixture.coordinator.status();

  assert.equal(combined.coverage, "conditional");
  assert.equal(combined.activeLeaseCount, 1);
  assert.equal(combined.reasonCode, "NATIVE_GUARD_CAPABILITY_UNAVAILABLE");
  assert.equal(JSON.stringify(combined).includes("fresh-capability-secret"), false);
  assert.equal(fixture.statusCalls, 0);
});

test("uses fresh verified metadata and resolves backend state without retaining credentials", async () => {
  const fixture = coordinatorFixture();
  await fixture.coordinator.activate(supervisionInput());
  fixture.capability = { ...verifiedCapability(), openclawVersion: "2026.8.0" };
  const resolveBySession = fixture.leaseService.resolveBySession.bind(fixture.leaseService);
  let resolveCalls = 0;
  fixture.leaseService.resolveBySession = (sessionKey) => {
    resolveCalls += 1;
    return resolveBySession(sessionKey);
  };
  fixture.leaseService.authenticate = () => {
    throw new Error("status must not retain or authenticate with a raw credential");
  };

  const combined = await fixture.coordinator.status();
  const source = await readFile(new URL("./nativeGuardCoordinator.ts", import.meta.url), "utf8");
  const managedLeaseType = /type ManagedLease = \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";

  assert.equal(combined.coverage, "active");
  assert.equal(combined.openclawVersion, "2026.8.0");
  assert.equal(resolveCalls, 1);
  assert.doesNotMatch(managedLeaseType, /\bactivation\b|\bcredential\b/);
});

test("contains resolveBySession failures in final commit and public status gates", async () => {
  const activation = coordinatorFixture();
  activation.leaseService.resolveBySession = () => {
    throw new Error("resolve-activation-secret");
  };
  await assert.rejects(
    () => activation.coordinator.activate(supervisionInput()),
    (error: unknown) => error instanceof NativeGuardCoordinatorError &&
      error.code === "NATIVE_GUARD_ACTIVATION_FAILED" &&
      !error.message.includes("resolve-activation-secret"),
  );
  assert.equal(activation.leaseService.status().activeLeaseCount, 0);

  const health = coordinatorFixture();
  await health.coordinator.activate(supervisionInput());
  health.leaseService.resolveBySession = () => {
    throw new Error("resolve-health-secret");
  };
  const result = await health.coordinator.status();
  assert.equal(result.coverage, "conditional");
  assert.equal(result.reasonCode, "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("resolve-health-secret"), false);
});

test("loads an exact stored supervision pack and uses the deterministic baseline for detection", async () => {
  const fixture = coordinatorFixture();
  await assert.rejects(
    () => fixture.coordinator.activate({ ...supervisionInput(), policyPackId: "missing" }),
    hasCoordinatorCode("NATIVE_GUARD_POLICY_NOT_FOUND"),
  );
  assert.equal(fixture.leaseService.status().activeLeaseCount, 0);

  await fixture.coordinator.activate({ rootSessionKey: "agent:detection", mode: "detection" });
  assert.equal(fixture.activationCalls[0].policyPackId, "policy_pack.openclaw.detection-baseline.v1");
});

test("builds a stable default-deny detection baseline whose dangerous rules outrank observation", () => {
  const first = createDetectionBaselinePolicyPack();
  const second = createDetectionBaselinePolicyPack();
  assert.equal(first.policyPackDigest, second.policyPackDigest);
  assert.equal(first.policyPackDigest, digestJson(first.policyPack));
  assert.equal(first.policyPack.defaultAction, "deny");
  assert.equal(first.policyPack.expiresAt, undefined);

  const apiActions = findMatchingPolicies(first.policyPack, runtimeAction("api_call", {
    method: "GET",
    url: "https://example.com",
  })).map((policy) => policy.action);
  assert.ok(apiActions.includes("deny"));

  const dangerousWrite = findMatchingPolicies(first.policyPack, runtimeAction("file_write", {
    path: "/home/user/.openclaw/openclaw.json",
    contentPreview: "mutate gateway",
  })).map((policy) => policy.action);
  assert.ok(dangerousWrite.includes("allow"));
  assert.ok(dangerousWrite.includes("deny"));

  const safeShell = findMatchingPolicies(first.policyPack, runtimeAction("code_execution", {
    language: "shell",
    codePreview: "docker inspect agent-under-test",
  })).map((policy) => policy.action);
  assert.ok(safeShell.includes("allow"));

  const elevatedShell = findMatchingPolicies(first.policyPack, runtimeAction("code_execution", {
    language: "shell",
    codePreview: "sudo docker exec --privileged host-control",
  })).map((policy) => policy.action);
  assert.ok(elevatedShell.includes("deny"));

  for (const codePreview of [
    "curl https://example.com/exfiltrate",
    "openclaw gateway restart",
    "openclaw sessions_send other-session",
    "crontab -e",
  ]) {
    const actions = findMatchingPolicies(first.policyPack, runtimeAction("code_execution", {
      language: "shell",
      codePreview,
    })).map((policy) => policy.action);
    assert.ok(actions.includes("deny"), `${codePreview} must remain denied`);
  }

  const browserTarget = normalizeNativeToolAction({ toolName: "browser_navigate" }).targetType;
  assert.equal(browserTarget, "api_call");
  assert.ok(findMatchingPolicies(first.policyPack, runtimeAction(browserTarget, {
    method: "GET",
    url: "https://example.com",
  })).some((policy) => policy.action === "deny"));

  const disguisedUnknown = findMatchingPolicies(first.policyPack, {
    runtimeSessionId: "session",
    agentId: "agent",
    targetType: normalizeNativeToolAction({ toolName: "read_file_and_send" }).targetType,
    payload: {
      toolId: "read_file_and_send",
      toolName: "read_file_and_send",
      parameters: {},
    },
  });
  assert.equal(disguisedUnknown.some((policy) => policy.action === "allow"), false);
});

function coordinatorFixture(options: {
  capability?: NativeGuardCapability;
  activateError?: Error;
  revokeError?: Error;
  activationMismatch?: boolean;
  renewMismatch?: boolean;
  activationAckOverrides?: Record<string, unknown>;
  renewAckOverrides?: Record<string, unknown>;
  capabilityAfterActivate?: NativeGuardCapability;
  capabilityAfterRenew?: NativeGuardCapability;
} = {}) {
  let nowMs = Date.parse("2026-08-02T00:00:00.000Z");
  const leaseService = createNativeGuardLeaseService({ now: () => nowMs });
  const policyPack = storedPolicyPack();
  const activationCalls: NativeGuardLeaseActivation[] = [];
  const renewCalls: NativeGuardLeaseActivation[] = [];
  const revokeCalls: string[] = [];
  let pluginStatus = status("ready");
  let capability = options.capability ?? verifiedCapability();
  let capabilityError: Error | undefined;
  let inspectCalls = 0;
  let statusCalls = 0;
  const controlClient = {
    inspectCapabilities: async () => {
      inspectCalls += 1;
      if (capabilityError) throw capabilityError;
      return capability;
    },
    status: async () => {
      statusCalls += 1;
      return pluginStatus;
    },
    activate: async (_gatewayUrl: string, activation: NativeGuardLeaseActivation) => {
      activationCalls.push(activation);
      if (options.activateError) throw options.activateError;
      pluginStatus = status(
        "active",
        options.activationMismatch ? "other-lease" : activation.leaseId,
        activation,
        options.activationAckOverrides,
      );
      if (options.capabilityAfterActivate) capability = options.capabilityAfterActivate;
      return pluginStatus;
    },
    renew: async (_gatewayUrl: string, activation: NativeGuardLeaseActivation) => {
      renewCalls.push(activation);
      pluginStatus = status(
        "active",
        options.renewMismatch ? "stale-lease" : activation.leaseId,
        activation,
        options.renewAckOverrides,
      );
      if (options.capabilityAfterRenew) capability = options.capabilityAfterRenew;
      return pluginStatus;
    },
    revoke: async (_gatewayUrl: string, leaseId: string) => {
      revokeCalls.push(leaseId);
      if (options.revokeError) throw options.revokeError;
      pluginStatus = status("ready");
      return pluginStatus;
    },
  };
  const coordinator = createNativeGuardCoordinator({
    leaseService,
    controlClient,
    loadStoredOpenClawPolicyPack: async (policyPackId) => policyPackId === policyPack.policyPackId
      ? { policyPack, policyPackDigest: digestJson(policyPack), runGroupId: "run-group" }
      : undefined,
    gatewayUrl: "http://127.0.0.1:18789",
    backendUrl: "http://127.0.0.1:3000/api/v1/openclaw/native-guard/decision",
    capabilityInput: { isolatedProfile: false },
  });
  return {
    coordinator,
    controlClient,
    leaseService,
    activationCalls,
    renewCalls,
    revokeCalls,
    advanceTime(deltaMs: number) { nowMs += deltaMs; },
    get capability() { return capability; },
    set capability(value: NativeGuardCapability) { capability = value; },
    get capabilityError() { return capabilityError; },
    set capabilityError(value: Error | undefined) { capabilityError = value; },
    get inspectCalls() { return inspectCalls; },
    get statusCalls() { return statusCalls; },
    get pluginStatus() { return pluginStatus; },
    set pluginStatus(value: NativeGuardStatus) { pluginStatus = value; },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

function verifiedCapability(): NativeGuardCapability {
  return {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance: "exclusive_before_hook",
    conflictingPluginIds: [],
  };
}

function supervisionInput() {
  return { rootSessionKey: "agent:supervision", mode: "supervision" as const, policyPackId: "stored-policy" };
}

function status(
  coverage: NativeGuardStatus["coverage"],
  leaseId?: string,
  activation?: NativeGuardLeaseActivation,
  activeLeaseOverrides: Record<string, unknown> = {},
): NativeGuardStatus {
  return {
    coverage,
    finalizerAssurance: "exclusive_before_hook",
    openclawVersion: "2026.7.2",
    activeLeaseCount: leaseId ? 1 : 0,
    ...(leaseId
      ? {
          activeLease: {
            leaseId,
            leaseEpoch: activation?.leaseEpoch ?? 1,
            rootSessionKey: activation?.rootSessionKey ?? "agent:supervision",
            mode: activation?.mode ?? "supervision",
            policyPackId: activation?.policyPackId ?? "stored-policy",
            policyPackDigest: activation?.policyPackDigest ?? digestJson(storedPolicyPack()),
            expiresAt: activation?.expiresAt ?? "2026-08-02T00:05:00.000Z",
            ...activeLeaseOverrides,
          },
        }
      : {}),
  };
}

function createUnmanagedLease(
  leaseService: ReturnType<typeof createNativeGuardLeaseService>,
  rootSessionKey: string,
): NativeGuardLeaseActivation {
  const policyPack = storedPolicyPack();
  return leaseService.create({
    rootSessionKey,
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:3000/api/v1/openclaw/native-guard/decision",
  }).activation;
}

function storedPolicyPack(): SupervisionPolicyPack {
  return {
    schemaVersion: "p3-a-1",
    policyPackId: "stored-policy",
    agentId: "agent",
    sourceDetectionReportId: "detection",
    sourceRiskProfileId: "risk",
    policies: [{
      policyId: "deny-all",
      sourceWeaknessIds: [],
      name: "deny",
      description: "deny",
      targetType: "tool_call",
      action: "deny",
      riskLevel: "critical",
      match: { relation: "all" },
      reason: "deny",
    }],
    defaultAction: "deny",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function runtimeAction(targetType: "api_call" | "file_write" | "code_execution", payload: Record<string, unknown>) {
  return {
    runtimeSessionId: "session",
    agentId: "agent",
    targetType,
    payload,
  } as Parameters<typeof findMatchingPolicies>[1];
}

function hasCoordinatorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof NativeGuardCoordinatorError && error.code === code;
}

function isLeaseUsable(
  coordinator: ReturnType<typeof createNativeGuardCoordinator>,
  leaseId: string,
): boolean {
  const candidate = coordinator as unknown as {
    isLeaseUsable?: (candidateLeaseId: string) => boolean;
  };
  return candidate.isLeaseUsable?.(leaseId) === true;
}

async function operationOutcome(operation: Promise<unknown>): Promise<{
  resolved: boolean;
  code?: string;
}> {
  try {
    await operation;
    return { resolved: true };
  } catch (error) {
    return {
      resolved: false,
      ...(error instanceof NativeGuardCoordinatorError ? { code: error.code } : {}),
    };
  }
}
