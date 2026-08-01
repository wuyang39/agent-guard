import type {
  NativeGuardLeaseActivation,
  NativeGuardMode,
  NativeGuardStatus,
  SupervisionPolicy,
  SupervisionPolicyPack,
  SupervisionTargetType,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import {
  loadStoredOpenClawPolicyPack as loadStoredPolicyPack,
} from "../policy/policyPackRepository";
import type { NativeGuardLeaseService } from "./nativeGuardLeaseService";
import type {
  InspectOpenClawCapabilitiesInput,
  NativeGuardCapability,
  OpenClawControlClient,
} from "./openclawControlClient";

export type { NativeGuardCapability } from "./openclawControlClient";

const BASELINE_CREATED_AT = "2026-07-02T00:00:00.000Z";
const BASELINE_POLICY_PACK_ID = "policy_pack.openclaw.detection-baseline.v1";

type LoadedPolicyPack = {
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
};

export type NativeGuardCoordinatorOptions = {
  leaseService: NativeGuardLeaseService;
  controlClient: OpenClawControlClient;
  loadStoredOpenClawPolicyPack?: (
    policyPackId: string,
  ) => Promise<LoadedPolicyPack | undefined>;
  gatewayUrl: string;
  backendUrl: string;
  capabilityInput: InspectOpenClawCapabilitiesInput;
};

export type ActivateNativeGuardInput = {
  rootSessionKey: string;
  mode: NativeGuardMode;
  policyPackId?: string;
  ttlMs?: number;
};

export type NativeGuardCoordinator = {
  activate(input: ActivateNativeGuardInput): Promise<NativeGuardStatus>;
  renew(leaseId: string, ttlMs?: number): Promise<NativeGuardStatus>;
  revoke(leaseId: string): Promise<NativeGuardStatus>;
  status(): Promise<NativeGuardStatus>;
  getLastStatus(): NativeGuardStatus;
};

export class NativeGuardCoordinatorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeGuardCoordinatorError";
  }
}

type ManagedLease = {
  activation: NativeGuardLeaseActivation;
  gatewayUrl: string;
  capability: NativeGuardCapability;
  phase: "active" | "revoking";
};

export function createNativeGuardCoordinator(
  options: NativeGuardCoordinatorOptions,
): NativeGuardCoordinator {
  const loadPolicyPack = options.loadStoredOpenClawPolicyPack ?? loadStoredPolicyPack;
  const leases = new Map<string, ManagedLease>();
  let lastStatus: NativeGuardStatus = {
    coverage: "off",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
  };

  function setLastStatus(status: NativeGuardStatus): NativeGuardStatus {
    lastStatus = structuredClone(status);
    return structuredClone(status);
  }

  function readyStatus(
    capability: NativeGuardCapability,
    warning?: boolean,
  ): NativeGuardStatus {
    return {
      coverage: "ready",
      finalizerAssurance: capability.finalizerAssurance,
      openclawVersion: capability.openclawVersion,
      activeLeaseCount: 0,
      conflictingPluginIds: [...capability.conflictingPluginIds],
      ...(warning
        ? {
            reasonCode: "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
            detail: "The backend lease was revoked, but plugin acknowledgement was unavailable.",
          }
        : {}),
    };
  }

  async function inspectForActivation(): Promise<NativeGuardCapability> {
    let capability: NativeGuardCapability;
    try {
      capability = await options.controlClient.inspectCapabilities(options.capabilityInput);
    } catch {
      setLastStatus({
        coverage: "unsupported",
        finalizerAssurance: "unverified",
        activeLeaseCount: 0,
        reasonCode: "NATIVE_GUARD_UNSUPPORTED",
      });
      throw coordinatorError(
        "NATIVE_GUARD_UNSUPPORTED",
        "OpenClaw native guard capability could not be verified.",
      );
    }
    if (!capability.supportsNativeGuard) {
      setLastStatus({
        coverage: "unsupported",
        finalizerAssurance: capability.finalizerAssurance,
        openclawVersion: capability.openclawVersion,
        activeLeaseCount: 0,
        conflictingPluginIds: [...capability.conflictingPluginIds],
        reasonCode: "NATIVE_GUARD_UNSUPPORTED",
      });
      throw coordinatorError(
        "NATIVE_GUARD_UNSUPPORTED",
        "This OpenClaw installation does not support the native guard contract.",
      );
    }
    if (
      capability.finalizerAssurance === "unverified" ||
      capability.conflictingPluginIds.length > 0
    ) {
      setLastStatus({
        coverage: "conditional",
        finalizerAssurance: "unverified",
        openclawVersion: capability.openclawVersion,
        activeLeaseCount: 0,
        conflictingPluginIds: [...capability.conflictingPluginIds],
        reasonCode: "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED",
      });
      throw coordinatorError(
        "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED",
        "OpenClaw before-tool hook ordering is not verified.",
      );
    }
    return capability;
  }

  async function resolvePolicy(input: ActivateNativeGuardInput): Promise<{
    policyPack: SupervisionPolicyPack;
    policyPackDigest: string;
  }> {
    if (input.mode === "detection") return createDetectionBaselinePolicyPack();
    const policyPackId = input.policyPackId?.trim();
    if (!policyPackId) {
      throw coordinatorError(
        "NATIVE_GUARD_POLICY_NOT_FOUND",
        "An exact stored supervision policy pack is required.",
      );
    }
    let loaded: LoadedPolicyPack | undefined;
    try {
      loaded = await loadPolicyPack(policyPackId);
    } catch {
      loaded = undefined;
    }
    if (
      !loaded ||
      loaded.policyPack.policyPackId !== policyPackId ||
      digestJson(loaded.policyPack) !== loaded.policyPackDigest
    ) {
      throw coordinatorError(
        "NATIVE_GUARD_POLICY_NOT_FOUND",
        "The exact stored supervision policy pack was not available.",
      );
    }
    return {
      policyPack: loaded.policyPack,
      policyPackDigest: loaded.policyPackDigest,
    };
  }

  async function compensateActivation(leaseId: string): Promise<boolean> {
    let backendRevoked = false;
    try {
      backendRevoked = options.leaseService.revoke(leaseId);
    } catch {
      // Keep cleanup errors contained so no dependency message can expose credentials.
    }
    try {
      await options.controlClient.revoke(options.gatewayUrl, leaseId);
    } catch {
      // The backend credential is already invalid; plugin cleanup is best effort.
    }
    leases.delete(leaseId);
    return backendRevoked;
  }

  return {
    async activate(input: ActivateNativeGuardInput): Promise<NativeGuardStatus> {
      const capability = await inspectForActivation();
      let policy: Awaited<ReturnType<typeof resolvePolicy>>;
      try {
        policy = await resolvePolicy(input);
      } catch (error) {
        setLastStatus(readyStatus(capability));
        throw error;
      }

      let activation: NativeGuardLeaseActivation;
      try {
        activation = options.leaseService.create({
          rootSessionKey: input.rootSessionKey,
          mode: input.mode,
          policyPack: policy.policyPack,
          policyPackDigest: policy.policyPackDigest,
          backendUrl: options.backendUrl,
          ttlMs: input.ttlMs,
        }).activation;
      } catch {
        setLastStatus(readyStatus(capability));
        throw coordinatorError(
          "NATIVE_GUARD_ACTIVATION_FAILED",
          "Native guard backend lease activation failed.",
        );
      }

      try {
        const pluginStatus = await options.controlClient.activate(options.gatewayUrl, activation);
        if (!pluginConfirmsActivation(pluginStatus, activation)) {
          throw coordinatorError(
            "NATIVE_GUARD_ACTIVATION_FAILED",
            "OpenClaw did not confirm the native guard lease.",
          );
        }
        leases.set(activation.leaseId, {
          activation,
          gatewayUrl: options.gatewayUrl,
          capability,
          phase: "active",
        });
        return setLastStatus(activeStatus(capability, pluginStatus));
      } catch {
        const backendRevoked = await compensateActivation(activation.leaseId);
        setLastStatus(backendRevoked
          ? readyStatus(capability)
          : rollbackFailedStatus(capability, safeBackendLeaseCount(options.leaseService)));
        throw coordinatorError(
          "NATIVE_GUARD_ACTIVATION_FAILED",
          "OpenClaw native guard activation failed and was rolled back.",
        );
      }
    },

    async renew(leaseId: string, ttlMs?: number): Promise<NativeGuardStatus> {
      const managed = leases.get(leaseId);
      if (!managed || managed.phase !== "active") {
        throw coordinatorError("NATIVE_GUARD_RENEW_FAILED", "Native guard lease is not managed.");
      }
      let activation: NativeGuardLeaseActivation | undefined;
      try {
        activation = options.leaseService.renew(leaseId, ttlMs);
        const pluginStatus = await options.controlClient.renew(managed.gatewayUrl, activation);
        if (!pluginConfirmsActivation(pluginStatus, activation)) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "OpenClaw did not confirm the renewed native guard lease.",
          );
        }
        managed.activation = activation;
        return setLastStatus(activeStatus(managed.capability, pluginStatus));
      } catch {
        // Deleting the backend secret first invalidates both the old and rotated credentials.
        let backendRevoked = false;
        try {
          backendRevoked = options.leaseService.revoke(leaseId);
        } catch {
          // Remote cleanup still runs, and the public error remains credential-free.
        }
        try {
          await options.controlClient.revoke(managed.gatewayUrl, leaseId);
        } catch {
          // The remote plugin may be offline; backend revocation remains authoritative.
        }
        leases.delete(leaseId);
        setLastStatus(backendRevoked
          ? readyStatus(managed.capability)
          : rollbackFailedStatus(
              managed.capability,
              safeBackendLeaseCount(options.leaseService),
            ));
        throw coordinatorError(
          "NATIVE_GUARD_RENEW_FAILED",
          "Native guard renewal failed closed and the lease was revoked.",
        );
      }
    },

    async revoke(leaseId: string): Promise<NativeGuardStatus> {
      const managed = leases.get(leaseId);
      if (!managed) {
        try {
          options.leaseService.revoke(leaseId);
        } catch {
          throw coordinatorError(
            "NATIVE_GUARD_REVOKE_FAILED",
            "Native guard backend revocation could not be confirmed.",
          );
        }
        if (lastStatus.activeLeaseCount === 0) return setLastStatus(lastStatus);
        const { activeLease: _activeLease, ...withoutActiveLease } = lastStatus;
        return setLastStatus({
          ...withoutActiveLease,
          coverage: "ready",
          activeLeaseCount: 0,
        });
      }
      managed.phase = "revoking";
      // This is the fail-closed mark: deleting the backend secret precedes remote cleanup.
      let backendRevoked = false;
      try {
        backendRevoked = options.leaseService.revoke(leaseId);
      } catch {
        // Still ask the plugin to revoke, then surface only a stable coordinator error.
      }
      if (backendRevoked) leases.delete(leaseId);
      let warning = false;
      try {
        await options.controlClient.revoke(managed.gatewayUrl, leaseId);
      } catch {
        warning = true;
      }
      if (!backendRevoked) {
        setLastStatus(rollbackFailedStatus(
          managed.capability,
          safeBackendLeaseCount(options.leaseService),
        ));
        throw coordinatorError(
          "NATIVE_GUARD_REVOKE_FAILED",
          "Native guard backend revocation could not be confirmed.",
        );
      }
      return setLastStatus(readyStatus(managed.capability, warning));
    },

    async status(): Promise<NativeGuardStatus> {
      const managed = firstManagedLease(leases);
      let capability: NativeGuardCapability;
      try {
        capability = managed?.capability ??
          await options.controlClient.inspectCapabilities(options.capabilityInput);
      } catch {
        return setLastStatus({
          coverage: managed ? "conditional" : "unsupported",
          finalizerAssurance: "unverified",
          activeLeaseCount: options.leaseService.status().activeLeaseCount,
          reasonCode: "NATIVE_GUARD_CAPABILITY_UNAVAILABLE",
        });
      }
      if (!capability.supportsNativeGuard) {
        return setLastStatus({
          coverage: "unsupported",
          finalizerAssurance: capability.finalizerAssurance,
          openclawVersion: capability.openclawVersion,
          activeLeaseCount: 0,
          conflictingPluginIds: [...capability.conflictingPluginIds],
          reasonCode: "NATIVE_GUARD_UNSUPPORTED",
        });
      }
      const backendStatus = options.leaseService.status();
      if (
        capability.finalizerAssurance === "unverified" ||
        capability.conflictingPluginIds.length > 0
      ) {
        return setLastStatus({
          coverage: "conditional",
          finalizerAssurance: "unverified",
          openclawVersion: capability.openclawVersion,
          activeLeaseCount: backendStatus.activeLeaseCount,
          conflictingPluginIds: [...capability.conflictingPluginIds],
          reasonCode: "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED",
        });
      }

      let pluginStatus: NativeGuardStatus;
      try {
        pluginStatus = await options.controlClient.status(options.gatewayUrl);
      } catch {
        return setLastStatus({
          coverage: backendStatus.activeLeaseCount > 0 ? "conditional" : "misconfigured",
          finalizerAssurance: capability.finalizerAssurance,
          openclawVersion: capability.openclawVersion,
          activeLeaseCount: backendStatus.activeLeaseCount,
          conflictingPluginIds: [...capability.conflictingPluginIds],
          reasonCode: "NATIVE_GUARD_PLUGIN_UNAVAILABLE",
        });
      }

      if (managed) {
        const backendLease = options.leaseService.authenticate(
          managed.activation.leaseId,
          managed.activation.credential,
        );
        if (
          managed.phase === "active" &&
          backendLease &&
          pluginConfirmsActivation(pluginStatus, managed.activation)
        ) {
          return setLastStatus(activeStatus(capability, pluginStatus));
        }
        return setLastStatus(mismatchStatus(capability, backendStatus.activeLeaseCount));
      }

      if (backendStatus.activeLeaseCount > 0 || pluginStatus.activeLeaseCount > 0) {
        return setLastStatus(mismatchStatus(capability, backendStatus.activeLeaseCount));
      }
      if (pluginStatus.coverage === "ready") {
        return setLastStatus({
          ...readyStatus(capability),
          pluginVersion: pluginStatus.pluginVersion,
        });
      }
      return setLastStatus({
        coverage: "misconfigured",
        finalizerAssurance: capability.finalizerAssurance,
        openclawVersion: capability.openclawVersion,
        pluginVersion: pluginStatus.pluginVersion,
        activeLeaseCount: 0,
        conflictingPluginIds: [...capability.conflictingPluginIds],
        reasonCode: "NATIVE_GUARD_PLUGIN_NOT_READY",
      });
    },

    getLastStatus(): NativeGuardStatus {
      return structuredClone(lastStatus);
    },
  };
}

export function createDetectionBaselinePolicyPack(): {
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
} {
  const policies: SupervisionPolicy[] = [
    policy(
      "deny-network-browser",
      "api_call",
      "deny",
      "Network and browser access are outside the isolated detection contract.",
    ),
    policy(
      "deny-cross-session-send",
      "agent_message",
      "deny",
      "Cross-session messages are outside the isolated detection contract.",
    ),
    policy(
      "deny-gateway-cron-host-tools",
      "tool_call",
      "deny",
      "Gateway mutation, scheduling, elevated control, and cross-session tools are denied.",
      [{
        fieldPath: "payload.toolName",
        operator: "in",
        value: [
          "gateway", "gateway_config", "gateway_restart", "plugin_install",
          "cron", "schedule", "task_schedule", "session_send", "sessions_send",
          "host_control", "elevated_exec", "browser", "web_fetch", "http_request",
        ],
      }],
      "any",
    ),
    policy(
      "deny-sensitive-file-mutation",
      "file_write",
      "deny",
      "OpenClaw configuration, gateway state, and scheduled task mutation are denied.",
      [".openclaw", "openclaw.json", "gateway", "cron"].map((value) => ({
        fieldPath: "payload.path",
        operator: "contains" as const,
        value,
        normalize: "lowercase" as const,
      })),
      "any",
    ),
    policy(
      "deny-elevated-host-code",
      "code_execution",
      "deny",
      "Elevated or host-control command execution is denied.",
      [
        "sudo ", "--privileged", "nsenter", "host-control", "docker.sock",
        "crontab", "cron ", "curl ", "wget ", "http://", "https://",
        "openclaw gateway", "gateway restart", "sessions_send", "session_send",
      ].map((value) => ({
        fieldPath: "payload.codePreview",
        operator: "contains" as const,
        value,
        normalize: "lowercase" as const,
      })),
      "any",
    ),
    policy(
      "allow-detection-file-read",
      "resource_access",
      "allow",
      "Read-only file observation is permitted inside the detection container.",
    ),
    policy(
      "allow-detection-read-tools",
      "tool_call",
      "allow",
      "An exact allowlist of read-only file tools is permitted for detection.",
      [{
        fieldPath: "payload.toolName",
        operator: "in",
        value: ["read", "read_file", "list", "list_files", "stat"],
      }],
      "all",
    ),
    policy(
      "allow-detection-file-write",
      "file_write",
      "allow",
      "File writes are observed inside the isolated detection workspace.",
    ),
    policy(
      "allow-detection-code-observation",
      "code_execution",
      "allow",
      "Shell and code intent are observed inside the isolated detection container.",
    ),
  ];
  const policyPack: SupervisionPolicyPack = {
    schemaVersion: "p3-a-1",
    policyPackId: BASELINE_POLICY_PACK_ID,
    agentId: "openclaw-detection-baseline",
    sourceDetectionReportId: "detection-baseline",
    sourceRiskProfileId: "risk-profile.detection-baseline",
    policies,
    defaultAction: "deny",
    createdAt: BASELINE_CREATED_AT,
  };
  return { policyPack, policyPackDigest: digestJson(policyPack) };
}

function policy(
  policyId: string,
  targetType: SupervisionTargetType,
  action: "allow" | "deny",
  reason: string,
  matchers: NonNullable<SupervisionPolicy["match"]["matchers"]> = [],
  relation: SupervisionPolicy["match"]["relation"] = "all",
): SupervisionPolicy {
  return {
    policyId: `native-detection-${policyId}`,
    sourcePolicyTemplateId: `native-detection-${policyId}`,
    sourceWeaknessIds: [],
    name: policyId,
    description: reason,
    targetType,
    action,
    riskLevel: action === "deny" ? "critical" : "low",
    match: { relation, ...(matchers.length > 0 ? { matchers } : {}) },
    reason,
  };
}

function pluginConfirmsActivation(
  status: NativeGuardStatus,
  activation: NativeGuardLeaseActivation,
): boolean {
  return (
    status.coverage === "active" &&
    status.activeLeaseCount === 1 &&
    status.activeLease?.leaseId === activation.leaseId &&
    status.activeLease.mode === activation.mode &&
    status.activeLease.policyPackId === activation.policyPackId
  );
}

function activeStatus(
  capability: NativeGuardCapability,
  pluginStatus: NativeGuardStatus,
): NativeGuardStatus {
  return {
    coverage: "active",
    finalizerAssurance: capability.finalizerAssurance,
    openclawVersion: capability.openclawVersion,
    pluginVersion: pluginStatus.pluginVersion,
    activeLeaseCount: 1,
    conflictingPluginIds: [...capability.conflictingPluginIds],
    activeLease: pluginStatus.activeLease,
  };
}

function mismatchStatus(
  capability: NativeGuardCapability,
  activeLeaseCount: number,
): NativeGuardStatus {
  return {
    coverage: "conditional",
    finalizerAssurance: capability.finalizerAssurance,
    openclawVersion: capability.openclawVersion,
    activeLeaseCount,
    conflictingPluginIds: [...capability.conflictingPluginIds],
    reasonCode: "NATIVE_GUARD_STATUS_MISMATCH",
  };
}

function rollbackFailedStatus(
  capability: NativeGuardCapability,
  activeLeaseCount: number,
): NativeGuardStatus {
  return {
    coverage: "misconfigured",
    finalizerAssurance: capability.finalizerAssurance,
    openclawVersion: capability.openclawVersion,
    activeLeaseCount,
    conflictingPluginIds: [...capability.conflictingPluginIds],
    reasonCode: "NATIVE_GUARD_BACKEND_REVOKE_UNCONFIRMED",
  };
}

function safeBackendLeaseCount(leaseService: NativeGuardLeaseService): number {
  try {
    return leaseService.status().activeLeaseCount;
  } catch {
    return 0;
  }
}

function firstManagedLease(
  leases: Map<string, ManagedLease>,
): ManagedLease | undefined {
  return leases.values().next().value as ManagedLease | undefined;
}

function coordinatorError(code: string, message: string): NativeGuardCoordinatorError {
  return new NativeGuardCoordinatorError(code, message);
}
