import assert from "node:assert/strict";
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

test("keeps coordinator errors credential-free when rollback dependencies also fail", async () => {
  const fixture = coordinatorFixture({ activateError: new Error("plugin failure") });
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

test("revokes the backend first and treats offline repeated plugin revocation as idempotent", async () => {
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
} = {}) {
  const leaseService = createNativeGuardLeaseService({ now: () => Date.parse("2026-08-02T00:00:00.000Z") });
  const policyPack = storedPolicyPack();
  const activationCalls: NativeGuardLeaseActivation[] = [];
  const renewCalls: NativeGuardLeaseActivation[] = [];
  const revokeCalls: string[] = [];
  let pluginStatus = status("ready");
  const controlClient = {
    inspectCapabilities: async () => options.capability ?? verifiedCapability(),
    status: async () => pluginStatus,
    activate: async (_gatewayUrl: string, activation: NativeGuardLeaseActivation) => {
      activationCalls.push(activation);
      if (options.activateError) throw options.activateError;
      pluginStatus = status("active", options.activationMismatch ? "other-lease" : activation.leaseId, activation);
      return pluginStatus;
    },
    renew: async (_gatewayUrl: string, activation: NativeGuardLeaseActivation) => {
      renewCalls.push(activation);
      pluginStatus = status("active", options.renewMismatch ? "stale-lease" : activation.leaseId, activation);
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
    leaseService,
    activationCalls,
    renewCalls,
    revokeCalls,
    get pluginStatus() { return pluginStatus; },
    set pluginStatus(value: NativeGuardStatus) { pluginStatus = value; },
  };
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
            rootSessionKey: activation?.rootSessionKey ?? "agent:supervision",
            mode: activation?.mode ?? "supervision",
            policyPackId: activation?.policyPackId ?? "stored-policy",
            expiresAt: activation?.expiresAt ?? "2026-08-02T00:05:00.000Z",
          },
        }
      : {}),
  };
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
