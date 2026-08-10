import { randomBytes, type KeyObject } from "node:crypto";
import type {
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeGuardLeaseSummary,
  NativeGuardMode,
  NativeGuardStatus,
  SupervisionPolicy,
  SupervisionPolicyPack,
  SupervisionTargetType,
} from "@agent-guard/contracts";
import {
  digestJson,
  normalizeNativeGuardLeaseScope,
  parseCanonicalOpenClawSessionKey,
  type NormalizedNativeGuardLeaseScope,
} from "@agent-guard/native-guard-protocol";
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
  gatewayAttestationPublicKey?: KeyObject;
};

export type ActivateNativeGuardInput = {
  rootSessionKey: string;
  scope?: NativeGuardLeaseScope;
  mode: NativeGuardMode;
  policyPackId?: string;
  ttlMs?: number;
  /** For sandbox detection: unified control context (controlClient,
   *  gatewayUrl, capabilityInput) used by all lifecycle operations.
   *  The lease is still tracked by this coordinator so PDP/evidence
   *  handlers see it. */
  sandbox?: SandboxControlContext;
};

export type NativeGuardCoordinator = {
  activate(input: ActivateNativeGuardInput): Promise<NativeGuardStatus>;
  renew(leaseId: string, ttlMs?: number): Promise<NativeGuardStatus>;
  revoke(leaseId: string): Promise<NativeGuardStatus>;
  status(): Promise<NativeGuardStatus>;
  isLeaseUsable(leaseId: string): boolean;
  isLeaseEvidenceUsable(leaseId: string): boolean;
  hasManagedLeases(): boolean;
  markLeaseRootEnded(leaseId: string): boolean;
  isLeaseRevoking(leaseId: string): boolean;
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

export type SandboxControlContext = {
  controlClient: OpenClawControlClient;
  gatewayUrl: string;
  capabilityInput: InspectOpenClawCapabilitiesInput;
};

type ManagedLease = {
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  scope: NativeGuardLeaseScope;
  normalizedScope: NormalizedNativeGuardLeaseScope;
  mode: NativeGuardMode;
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
  gatewayInstanceId: string;
  gatewayUrl: string;
  controlClient: OpenClawControlClient;
  capabilityInput: InspectOpenClawCapabilitiesInput;
  gatewayAttestationPublicKey?: KeyObject;
  trustCapabilityGatewayInstanceId: boolean;
  capability: NativeGuardCapability;
  pluginVersion?: string;
  phase: "activating" | "active" | "renewing" | "root_ended" | "revoking";
};

type LeaseControlContext = {
  controlClient: OpenClawControlClient;
  gatewayUrl: string;
  capabilityInput: InspectOpenClawCapabilitiesInput;
  gatewayAttestationPublicKey?: KeyObject;
  trustCapabilityGatewayInstanceId: boolean;
};

type ActivationReservation = {
  gatewayInstanceId: string;
  normalizedScope: NormalizedNativeGuardLeaseScope;
};

export function createNativeGuardCoordinator(
  options: NativeGuardCoordinatorOptions,
): NativeGuardCoordinator {
  const loadPolicyPack = options.loadStoredOpenClawPolicyPack ?? loadStoredPolicyPack;
  const leases = new Map<string, ManagedLease>();
  const activationReservations = new Set<ActivationReservation>();
  const legacyClientIds = new WeakMap<object, number>();
  let nextLegacyClientId = 1;
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
      ...(capability.gatewayInstanceId
        ? { gatewayInstanceId: capability.gatewayInstanceId }
        : {}),
      activeLeaseCount: 0,
      activeLeases: [],
      conflictingPluginIds: [...capability.conflictingPluginIds],
      ...(warning
        ? {
            reasonCode: "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
            detail: "The backend lease was revoked, but plugin acknowledgement was unavailable.",
          }
        : {}),
    };
  }

  function controlContext(input?: SandboxControlContext): LeaseControlContext {
    return input
      ? {
          controlClient: input.controlClient,
          gatewayUrl: input.gatewayUrl,
          capabilityInput: input.capabilityInput,
          trustCapabilityGatewayInstanceId: true,
        }
      : {
          controlClient: options.controlClient,
          gatewayUrl: options.gatewayUrl,
          capabilityInput: options.capabilityInput,
          gatewayAttestationPublicKey: options.gatewayAttestationPublicKey,
          trustCapabilityGatewayInstanceId: false,
        };
  }

  function legacyGatewayIdentity(context: LeaseControlContext): string {
    let clientId = legacyClientIds.get(context.controlClient as object);
    if (clientId === undefined) {
      clientId = nextLegacyClientId++;
      legacyClientIds.set(context.controlClient as object, clientId);
    }
    return `legacy:${String(clientId)}:${context.gatewayUrl}`;
  }

  function reserveActivation(
    gatewayInstanceId: string,
    normalizedScope: NormalizedNativeGuardLeaseScope,
  ): ActivationReservation {
    const overlapsManaged = [...leases.values()].some((managed) =>
      managed.gatewayInstanceId === gatewayInstanceId &&
      scopesOverlap(managed.normalizedScope, normalizedScope));
    const overlapsReserved = [...activationReservations].some((reservation) =>
      reservation.gatewayInstanceId === gatewayInstanceId &&
      scopesOverlap(reservation.normalizedScope, normalizedScope));
    if (overlapsManaged || overlapsReserved) {
      setLastStatus(aggregateManagedStatus("conditional", "NATIVE_GUARD_ALREADY_ACTIVE"));
      throw coordinatorError(
        "NATIVE_GUARD_ALREADY_ACTIVE",
        "An overlapping native guard lease is already managed on this Gateway.",
      );
    }
    const reservation = { gatewayInstanceId, normalizedScope };
    activationReservations.add(reservation);
    return reservation;
  }

  function aggregateManagedStatus(
    coverage?: NativeGuardStatus["coverage"],
    reasonCode?: string,
    warningDetail?: string,
  ): NativeGuardStatus {
    const active = [...leases.values()].filter((managed) => managed.phase === "active");
    const activeLeases = active.map(managedLeaseSummary);
    const capabilities = active.map((managed) => managed.capability);
    const firstCapability = capabilities[0] ?? firstManagedLease(leases)?.capability;
    const sameVersion = capabilities.length === 0 || capabilities.every((capability) =>
      capability.openclawVersion === firstCapability?.openclawVersion);
    const sameAssurance = capabilities.length === 0 || capabilities.every((capability) =>
      capability.finalizerAssurance === firstCapability?.finalizerAssurance);
    const gatewayInstanceIds = [...new Set(active.map((managed) => managed.gatewayInstanceId))];
    const pluginVersions = [...new Set(active.flatMap((managed) =>
      managed.pluginVersion ? [managed.pluginVersion] : []))];
    const activeLease = activeLeases.length === 1 ? activeLeases[0] : undefined;
    return {
      coverage: coverage ?? (activeLeases.length > 0 ? "active" : "ready"),
      finalizerAssurance: sameAssurance
        ? (firstCapability?.finalizerAssurance ?? "unverified")
        : "unverified",
      ...(sameVersion && firstCapability?.openclawVersion
        ? { openclawVersion: firstCapability.openclawVersion }
        : {}),
      ...(gatewayInstanceIds.length === 1 ? { gatewayInstanceId: gatewayInstanceIds[0] } : {}),
      ...(pluginVersions.length === 1 ? { pluginVersion: pluginVersions[0] } : {}),
      activeLeaseCount: activeLeases.length,
      activeLeases,
      ...(activeLease ? { activeLease } : {}),
      conflictingPluginIds: [...new Set(capabilities.flatMap((capability) =>
        capability.conflictingPluginIds))].sort(),
      ...(reasonCode ? { reasonCode } : {}),
      ...(warningDetail ? { detail: warningDetail } : {}),
    };
  }

  function postCleanupStatus(
    capability: NativeGuardCapability,
    warning = false,
  ): NativeGuardStatus {
    const backend = readBackendStatus(options.leaseService);
    if (!backend.available) {
      return backendUnavailableStatus(lastStatus, capability);
    }
    if ([...leases.values()].some((managed) => managed.phase === "active")) {
      return aggregateManagedStatus(
        "active",
        warning ? "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED" : undefined,
      );
    }
    return backend.status.activeLeaseCount === 0
      ? readyStatus(capability, warning)
      : mismatchStatus(capability, backend.status.activeLeaseCount, backend.status.activeLeases);
  }

  function rollbackStatus(capability: NativeGuardCapability): NativeGuardStatus {
    const backend = readBackendStatus(options.leaseService);
    return backend.available
      ? rollbackFailedStatus(capability, backend.status.activeLeaseCount)
      : backendUnavailableStatus(lastStatus, capability);
  }

  async function inspectForActivation(
    context: LeaseControlContext,
  ): Promise<NativeGuardCapability> {
    let capability: NativeGuardCapability;
    try {
      capability = await inspectControlCapability(context);
    } catch {
      setLastStatus([...leases.values()].some((managed) => managed.phase === "active")
        ? aggregateManagedStatus("conditional", "NATIVE_GUARD_UNSUPPORTED")
        : {
            coverage: "unsupported",
            finalizerAssurance: "unverified",
            activeLeaseCount: 0,
            activeLeases: [],
            reasonCode: "NATIVE_GUARD_UNSUPPORTED",
          });
      throw coordinatorError(
        "NATIVE_GUARD_UNSUPPORTED",
        "OpenClaw native guard capability could not be verified.",
      );
    }
    if (!capability.supportsNativeGuard) {
      setLastStatus([...leases.values()].some((managed) => managed.phase === "active")
        ? aggregateManagedStatus("conditional", "NATIVE_GUARD_UNSUPPORTED")
        : {
        coverage: "unsupported",
        finalizerAssurance: capability.finalizerAssurance,
        openclawVersion: capability.openclawVersion,
        activeLeaseCount: 0,
        activeLeases: [],
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
      setLastStatus([...leases.values()].some((managed) => managed.phase === "active")
        ? aggregateManagedStatus("conditional", "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED")
        : {
        coverage: "conditional",
        finalizerAssurance: "unverified",
        openclawVersion: capability.openclawVersion,
        activeLeaseCount: 0,
        activeLeases: [],
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

  async function compensateManagedLease(managed: ManagedLease): Promise<boolean> {
    managed.phase = "revoking";
    let backendRevocationCompleted = false;
    try {
      options.leaseService.revoke(managed.leaseId);
      backendRevocationCompleted = true;
    } catch {
      // Keep cleanup errors contained so no dependency message can expose credentials.
    }
    try {
      await managed.controlClient.revoke(managed.gatewayUrl, managed.leaseId);
    } catch {
      // Plugin cleanup is best effort; the return value records backend invalidation.
    }
    if (backendRevocationCompleted) leases.delete(managed.leaseId);
    return backendRevocationCompleted;
  }

  async function inspectCompatibleCapability(
    expected: NativeGuardCapability,
    context: LeaseControlContext,
  ): Promise<NativeGuardCapability> {
    let fresh: NativeGuardCapability;
    try {
      fresh = await inspectControlCapability(context);
    } catch {
      throw coordinatorError(
        "NATIVE_GUARD_CAPABILITY_CHANGED",
        "OpenClaw native guard capability changed during the lease operation.",
      );
    }
    if (!capabilitiesCompatible(expected, fresh)) {
      throw coordinatorError(
        "NATIVE_GUARD_CAPABILITY_CHANGED",
        "OpenClaw native guard capability changed during the lease operation.",
      );
    }
    return fresh;
  }

  async function inspectControlCapability(
    context: LeaseControlContext,
  ): Promise<NativeGuardCapability> {
    const inspected = await context.controlClient.inspectCapabilities(context.capabilityInput);
    if (!context.gatewayAttestationPublicKey) {
      return context.trustCapabilityGatewayInstanceId
        ? inspected
        : { ...inspected, gatewayInstanceId: undefined };
    }
    if (
      !inspected.supportsNativeGuard ||
      inspected.finalizerAssurance === "unverified" ||
      inspected.conflictingPluginIds.length > 0
    ) {
      return { ...inspected, gatewayInstanceId: undefined };
    }
    const challenge = randomBytes(24).toString("base64url");
    const attestation = await context.controlClient.attestGateway({
      gatewayUrl: context.gatewayUrl,
      challenge,
      attestationPublicKey: context.gatewayAttestationPublicKey,
    });
    if (
      attestation.challenge !== challenge ||
      attestation.gatewayUrl !== context.gatewayUrl ||
      !/^[A-Za-z0-9._-]{8,128}$/.test(attestation.gatewayInstanceId) ||
      attestation.openclawVersion !== inspected.openclawVersion ||
      attestation.nativeGuard.contractVersion !== "native-guard-1" ||
      attestation.nativeGuard.registrarStatus !== "live" ||
      attestation.nativeGuard.finalBeforeToolCall.pluginId !== "agent-guard-supervision" ||
      attestation.nativeGuard.finalBeforeToolCall.exclusive !== true ||
      attestation.nativeGuard.trustedToolPolicy.policyId !== "agent-guard-admission" ||
      attestation.nativeGuard.trustedToolPolicy.exclusive !== true ||
      attestation.nativeGuard.recoveryService.serviceId !== "agent-guard-runtime" ||
      attestation.nativeGuard.recoveryService.live !== true ||
      attestation.nativeGuard.postApprovalLeaseRecheck !== true ||
      attestation.nativeGuard.paramsProvenance !== "json-only"
    ) {
      throw coordinatorError(
        "NATIVE_GUARD_CAPABILITY_CHANGED",
        "OpenClaw Gateway attestation does not match its inspected capability.",
      );
    }
    return { ...inspected, gatewayInstanceId: attestation.gatewayInstanceId };
  }

  return {
    async activate(input: ActivateNativeGuardInput): Promise<NativeGuardStatus> {
      const backend = readBackendStatus(options.leaseService);
      if (!backend.available) {
        setLastStatus(backendUnavailableStatus(lastStatus));
        throw coordinatorError(
          "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE",
          "Native guard backend status is unavailable.",
        );
      }
      const context = controlContext(input.sandbox);
      let normalizedScope: NormalizedNativeGuardLeaseScope;
      try {
        normalizedScope = normalizeNativeGuardLeaseScope(input.scope, input.rootSessionKey);
      } catch {
        throw coordinatorError(
          "NATIVE_GUARD_ACTIVATION_FAILED",
          "Native guard lease scope is invalid.",
        );
      }
      const capability = await inspectForActivation(context);
      if (input.scope !== undefined && !capability.gatewayInstanceId) {
        throw coordinatorError(
          "NATIVE_GUARD_UNSUPPORTED",
          "Scoped native guard requires an attested live Gateway capability.",
        );
      }
      const gatewayInstanceId = capability.gatewayInstanceId ?? legacyGatewayIdentity(context);
      const reservation = reserveActivation(gatewayInstanceId, normalizedScope);
      try {
        let policy: Awaited<ReturnType<typeof resolvePolicy>>;
        try {
          policy = await resolvePolicy(input);
        } catch (error) {
          setLastStatus(leases.size > 0 ? aggregateManagedStatus() : readyStatus(capability));
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
            scope: input.scope,
          }).activation;
        } catch {
          setLastStatus(leases.size > 0 ? aggregateManagedStatus() : readyStatus(capability));
          throw coordinatorError(
            "NATIVE_GUARD_ACTIVATION_FAILED",
            "Native guard backend lease activation failed.",
          );
        }

        const managed: ManagedLease = {
          ...managedLeaseMetadata(
            activation,
            normalizedScope,
            gatewayInstanceId,
            context,
            capability,
          ),
          phase: "activating",
        };
        leases.set(activation.leaseId, managed);
        setLastStatus(aggregateManagedStatus());
        try {
          const pluginStatus = await context.controlClient.activate(context.gatewayUrl, activation);
          if (!ownsManagedPhase(leases, managed, "activating")) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw native guard activation lost lease ownership.",
            );
          }
          if (!pluginConfirmsActivation(pluginStatus, managed)) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw did not confirm the native guard lease.",
            );
          }
          const freshCapability = await inspectCompatibleCapability(capability, managed);
          if (!ownsManagedPhase(leases, managed, "activating")) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw native guard activation lost lease ownership.",
            );
          }
          managed.capability = freshCapability;
          if (!ownsManagedPhase(leases, managed, "activating")) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw native guard activation lost lease ownership.",
            );
          }
          if (!backendConfirmsSpecificManagedLease(options.leaseService, managed)) {
            throw coordinatorError(
              "NATIVE_GUARD_BACKEND_CHANGED",
              "Native guard backend lease changed before activation committed.",
            );
          }
          if (!ownsManagedPhase(leases, managed, "activating")) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw native guard activation lost lease ownership.",
            );
          }
          managed.phase = "active";
          managed.pluginVersion = pluginStatus.pluginVersion;
          return setLastStatus(aggregateManagedStatus());
        } catch {
          if (!ownsManagedPhase(leases, managed, "activating")) {
            throw coordinatorError(
              "NATIVE_GUARD_ACTIVATION_FAILED",
              "OpenClaw native guard activation lost lease ownership.",
            );
          }
          const backendRevocationCompleted = await compensateManagedLease(managed);
          setLastStatus(backendRevocationCompleted
            ? postCleanupStatus(capability)
            : rollbackStatus(capability));
          throw coordinatorError(
            "NATIVE_GUARD_ACTIVATION_FAILED",
            "OpenClaw native guard activation failed and was rolled back.",
          );
        }
      } finally {
        activationReservations.delete(reservation);
      }
    },

    async renew(leaseId: string, ttlMs?: number): Promise<NativeGuardStatus> {
      const managed = leases.get(leaseId);
      if (!managed || managed.phase !== "active") {
        throw coordinatorError("NATIVE_GUARD_RENEW_FAILED", "Native guard lease is not managed.");
      }
      managed.phase = "renewing";
      setLastStatus(aggregateManagedStatus(
        [...leases.values()].some((candidate) => candidate.phase === "active")
          ? "active"
          : "recovery",
        "NATIVE_GUARD_LIFECYCLE_PENDING",
      ));
      let activation: NativeGuardLeaseActivation | undefined;
      try {
        const preRenewCapability = await inspectCompatibleCapability(managed.capability, managed);
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        managed.capability = preRenewCapability;
        const renewClient = managed.controlClient;
        const preRenewPluginStatus = await renewClient.status(managed.gatewayUrl);
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        if (!pluginConfirmsManagedLease(preRenewPluginStatus, managed)) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "OpenClaw native guard lifecycle work must finish before renewal.",
          );
        }
        activation = options.leaseService.renew(leaseId, ttlMs);
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        const pluginStatus = await renewClient.renew(managed.gatewayUrl, activation);
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        if (!pluginConfirmsActivation(pluginStatus, {
          ...activation,
          gatewayInstanceId: managed.gatewayInstanceId,
        })) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "OpenClaw did not confirm the renewed native guard lease.",
          );
        }
        const postRenewCapability = await inspectCompatibleCapability(preRenewCapability, managed);
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        Object.assign(
          managed,
          managedLeaseMetadata(
            activation,
            managed.normalizedScope,
            managed.gatewayInstanceId,
            managed,
            postRenewCapability,
          ),
        );
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        if (!backendConfirmsSpecificManagedLease(options.leaseService, managed)) {
          throw coordinatorError(
            "NATIVE_GUARD_BACKEND_CHANGED",
            "Native guard backend lease changed before renewal committed.",
          );
        }
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        managed.phase = "active";
        managed.pluginVersion = pluginStatus.pluginVersion;
        return setLastStatus(aggregateManagedStatus());
      } catch {
        if (!ownsManagedPhase(leases, managed, "renewing")) {
          throw coordinatorError(
            "NATIVE_GUARD_RENEW_FAILED",
            "Native guard renewal lost lease ownership.",
          );
        }
        const backendRevocationCompleted = await compensateManagedLease(managed);
        setLastStatus(backendRevocationCompleted
          ? postCleanupStatus(managed.capability)
          : rollbackStatus(managed.capability));
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
        const backend = readBackendStatus(options.leaseService);
        if (!backend.available) {
          return setLastStatus(backendUnavailableStatus(lastStatus));
        }
        if (backend.status.activeLeaseCount > 0) {
          const activeLease = backend.status.activeLeases?.length === 1
            ? backend.status.activeLeases[0]
            : undefined;
          return setLastStatus({
            coverage: "conditional",
            finalizerAssurance: "unverified",
            openclawVersion: lastStatus.openclawVersion,
            activeLeaseCount: backend.status.activeLeaseCount,
            ...(backend.status.activeLeases
              ? { activeLeases: backend.status.activeLeases.map(cloneLeaseSummary) }
              : {}),
            ...(activeLease ? { activeLease: cloneLeaseSummary(activeLease) } : {}),
            reasonCode: "NATIVE_GUARD_STATUS_MISMATCH",
          });
        }
        const {
          activeLease: _activeLease,
          activeLeases: _activeLeases,
          ...withoutActiveLease
        } = lastStatus;
        return setLastStatus({
          ...withoutActiveLease,
          coverage: "ready",
          activeLeaseCount: 0,
          activeLeases: [],
        });
      }
      managed.phase = "revoking";
      setLastStatus(aggregateManagedStatus(
        [...leases.values()].some((candidate) => candidate.phase === "active")
          ? "active"
          : "recovery",
        "NATIVE_GUARD_LIFECYCLE_PENDING",
      ));
      let pluginConfirmed = false;
      let backendRevocationFailed = false;
      try {
        try {
          const pluginStatus = await managed.controlClient.revoke(managed.gatewayUrl, leaseId);
          pluginConfirmed = pluginConfirmsRevoke(pluginStatus, leaseId);
        } catch {
          // The revoking gate remains authoritative while acknowledgement is unavailable.
        }
      } finally {
        try {
          // False means the backend secret was already absent and is still a safe success.
          options.leaseService.revoke(leaseId);
        } catch {
          backendRevocationFailed = true;
        }
      }
      if (backendRevocationFailed) {
        setLastStatus(rollbackStatus(managed.capability));
        throw coordinatorError(
          "NATIVE_GUARD_REVOKE_FAILED",
          "Native guard backend revocation could not be confirmed.",
        );
      }
      if (!pluginConfirmed) {
        return setLastStatus(aggregateManagedStatus(
          "recovery",
          "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
          "OpenClaw plugin lease revocation could not be confirmed.",
        ));
      }
      leases.delete(leaseId);
      return setLastStatus(postCleanupStatus(managed.capability));
    },

    async status(): Promise<NativeGuardStatus> {
      const managed = firstManagedLease(leases);
      const backend = readBackendStatus(options.leaseService);
      if (!backend.available) {
        return setLastStatus(backendUnavailableStatus(lastStatus, managed?.capability));
      }
      const backendStatus = backend.status;
      if (managed) {
        if ([...leases.values()].some((candidate) => candidate.phase === "revoking")) {
          return setLastStatus(aggregateManagedStatus(
            "recovery",
            "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
            "OpenClaw plugin lease revocation could not be confirmed.",
          ));
        }
        const pluginStatuses = new Map<ManagedLease, NativeGuardStatus>();
        for (const candidate of leases.values()) {
          let capability: NativeGuardCapability;
          try {
            capability = await inspectControlCapability(candidate);
          } catch {
            return setLastStatus(aggregateManagedStatus(
              "conditional",
              "NATIVE_GUARD_CAPABILITY_UNAVAILABLE",
            ));
          }
          if (capability.gatewayInstanceId !== candidate.capability.gatewayInstanceId) {
            return setLastStatus(aggregateManagedStatus(
              "conditional",
              "NATIVE_GUARD_CAPABILITY_CHANGED",
            ));
          }
          candidate.capability = capability;
          if (!capability.supportsNativeGuard) {
            return setLastStatus(aggregateManagedStatus(
              "unsupported",
              "NATIVE_GUARD_UNSUPPORTED",
            ));
          }
          if (
            capability.finalizerAssurance === "unverified" ||
            capability.conflictingPluginIds.length > 0
          ) {
            return setLastStatus(aggregateManagedStatus(
              "conditional",
              "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED",
            ));
          }
          try {
            pluginStatuses.set(
              candidate,
              await candidate.controlClient.status(candidate.gatewayUrl),
            );
            candidate.pluginVersion = pluginStatuses.get(candidate)?.pluginVersion;
          } catch {
            return setLastStatus(aggregateManagedStatus(
              "conditional",
              "NATIVE_GUARD_PLUGIN_UNAVAILABLE",
            ));
          }
        }
        let statusMismatch: boolean;
        try {
          statusMismatch = backendStatus.activeLeaseCount !== leases.size ||
            [...leases.values()].some((candidate) =>
              candidate.phase !== "active" ||
              !backendConfirmsSpecificManagedLease(options.leaseService, candidate) ||
              !pluginConfirmsManagedLease(pluginStatuses.get(candidate)!, candidate));
        } catch {
          return setLastStatus(backendUnavailableStatus(lastStatus, managed.capability));
        }
        if (statusMismatch) {
          return setLastStatus(mismatchStatus(
            managed.capability,
            backendStatus.activeLeaseCount,
            backendStatus.activeLeases,
          ));
        }
        return setLastStatus(aggregateManagedStatus());
      }

      let capability: NativeGuardCapability;
      try {
        capability = await inspectControlCapability(controlContext());
      } catch {
        return setLastStatus({
          coverage: backendStatus.activeLeaseCount > 0 ? "conditional" : "unsupported",
          finalizerAssurance: "unverified",
          activeLeaseCount: backendStatus.activeLeaseCount,
          ...(backendStatus.activeLeases ? { activeLeases: backendStatus.activeLeases } : {}),
          reasonCode: "NATIVE_GUARD_CAPABILITY_UNAVAILABLE",
        });
      }
      if (!capability.gatewayInstanceId) {
        return setLastStatus({
          coverage: backendStatus.activeLeaseCount > 0 ? "conditional" : "unsupported",
          finalizerAssurance: capability.finalizerAssurance,
          openclawVersion: capability.openclawVersion,
          activeLeaseCount: backendStatus.activeLeaseCount,
          ...(backendStatus.activeLeases ? { activeLeases: backendStatus.activeLeases } : {}),
          conflictingPluginIds: [...capability.conflictingPluginIds],
          reasonCode: "NATIVE_GUARD_CAPABILITY_UNAVAILABLE",
        });
      }
      if (!capability.supportsNativeGuard) {
        return setLastStatus({
          ...mismatchStatus(capability, backendStatus.activeLeaseCount, backendStatus.activeLeases),
          coverage: "unsupported",
          reasonCode: "NATIVE_GUARD_UNSUPPORTED",
        });
      }
      if (
        capability.finalizerAssurance === "unverified" ||
        capability.conflictingPluginIds.length > 0
      ) {
        return setLastStatus({
          ...mismatchStatus(capability, backendStatus.activeLeaseCount, backendStatus.activeLeases),
          reasonCode: "NATIVE_GUARD_HOOK_ORDER_UNVERIFIED",
        });
      }
      let pluginStatus: NativeGuardStatus;
      try {
        pluginStatus = await options.controlClient.status(options.gatewayUrl);
      } catch {
        return setLastStatus({
          ...mismatchStatus(capability, backendStatus.activeLeaseCount, backendStatus.activeLeases),
          coverage: backendStatus.activeLeaseCount > 0 ? "conditional" : "misconfigured",
          reasonCode: "NATIVE_GUARD_PLUGIN_UNAVAILABLE",
        });
      }

      if (backendStatus.activeLeaseCount > 0 || pluginStatus.activeLeaseCount > 0) {
        return setLastStatus(mismatchStatus(
          capability,
          backendStatus.activeLeaseCount,
          backendStatus.activeLeases,
        ));
      }
      if (pluginIsIdle(pluginStatus)) {
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

    isLeaseUsable(leaseId: string): boolean {
      return leases.get(leaseId)?.phase === "active";
    },

    isLeaseEvidenceUsable(leaseId: string): boolean {
      const phase = leases.get(leaseId)?.phase;
      return phase === "activating" || phase === "active" ||
        phase === "renewing" || phase === "root_ended";
    },

    hasManagedLeases(): boolean {
      return leases.size > 0;
    },

    markLeaseRootEnded(leaseId: string): boolean {
      const managed = leases.get(leaseId);
      if (managed?.phase !== "active") return false;
      managed.phase = "root_ended";
      setLastStatus(aggregateManagedStatus("recovery", "NATIVE_GUARD_ROOT_ENDED"));
      return true;
    },

    isLeaseRevoking(leaseId: string): boolean {
      return leases.get(leaseId)?.phase === "revoking";
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
  expected: NativeGuardLeaseActivation | NativeGuardLeaseSummary | ManagedLease,
): boolean {
  const summary = findStatusLease(status, expected.leaseId);
  return status.coverage === "active" && Boolean(summary &&
    leaseSummaryMatches(summary, expected));
}

function capabilitiesCompatible(
  expected: NativeGuardCapability,
  fresh: NativeGuardCapability,
): boolean {
  return (
    expected.supportsNativeGuard &&
    fresh.supportsNativeGuard &&
    expected.finalizerAssurance !== "unverified" &&
    fresh.finalizerAssurance === expected.finalizerAssurance &&
    expected.openclawVersion === fresh.openclawVersion &&
    expected.gatewayInstanceId === fresh.gatewayInstanceId &&
    expected.conflictingPluginIds.length === 0 &&
    fresh.conflictingPluginIds.length === 0
  );
}

function managedLeaseMetadata(
  activation: NativeGuardLeaseActivation,
  normalizedScope: NormalizedNativeGuardLeaseScope,
  gatewayInstanceId: string,
  context: LeaseControlContext,
  capability: NativeGuardCapability,
): Omit<ManagedLease, "phase"> {
  return {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    rootSessionKey: activation.rootSessionKey,
    scope: cloneLeaseScope(activation.scope),
    normalizedScope: cloneNormalizedScope(normalizedScope),
    mode: activation.mode,
    policyPackId: activation.policyPackId,
    policyPackDigest: activation.policyPackDigest,
    expiresAt: activation.expiresAt,
    gatewayInstanceId,
    gatewayUrl: context.gatewayUrl,
    controlClient: context.controlClient,
    capabilityInput: context.capabilityInput,
    gatewayAttestationPublicKey: context.gatewayAttestationPublicKey,
    trustCapabilityGatewayInstanceId: context.trustCapabilityGatewayInstanceId,
    capability,
  };
}

function managedLeaseSummary(managed: ManagedLease): NativeGuardLeaseSummary {
  return {
    leaseId: managed.leaseId,
    leaseEpoch: managed.leaseEpoch,
    rootSessionKey: managed.rootSessionKey,
    scope: cloneLeaseScope(managed.scope),
    gatewayInstanceId: managed.gatewayInstanceId,
    mode: managed.mode,
    policyPackId: managed.policyPackId,
    policyPackDigest: managed.policyPackDigest,
    expiresAt: managed.expiresAt,
  };
}

function ownsManagedPhase(
  leases: Map<string, ManagedLease>,
  managed: ManagedLease,
  phase: "activating" | "renewing",
): boolean {
  return leases.get(managed.leaseId) === managed && managed.phase === phase;
}

function backendConfirmsSpecificManagedLease(
  leaseService: NativeGuardLeaseService,
  managed: ManagedLease,
): boolean {
  const status = leaseService.status();
  const summary = findStatusLease(status, managed.leaseId);
  return Boolean(summary && leaseSummaryMatches(summary, managed));
}

function pluginConfirmsManagedLease(
  status: NativeGuardStatus,
  managed: ManagedLease,
): boolean {
  const summary = findStatusLease(status, managed.leaseId);
  return status.coverage === "active" && Boolean(summary &&
    leaseSummaryMatches(summary, managed));
}

function pluginConfirmsRevoke(
  status: NativeGuardStatus,
  leaseId: string,
): boolean {
  if (status.activeLeases) {
    return status.activeLeases.every((lease) => lease.leaseId !== leaseId);
  }
  if (status.activeLeaseCount > 1) return false;
  return status.activeLease?.leaseId !== leaseId;
}

function pluginIsIdle(status: NativeGuardStatus): boolean {
  return (
    (status.coverage === "off" || status.coverage === "ready") &&
    status.activeLeaseCount === 0 &&
    (status.activeLeases === undefined || status.activeLeases.length === 0) &&
    status.activeLease === undefined
  );
}

function mismatchStatus(
  capability: NativeGuardCapability,
  activeLeaseCount: number,
  activeLeases?: NativeGuardLeaseSummary[],
): NativeGuardStatus {
  const singular = activeLeases?.length === 1 ? activeLeases[0] : undefined;
  return {
    coverage: "conditional",
    finalizerAssurance: capability.finalizerAssurance,
    openclawVersion: capability.openclawVersion,
    activeLeaseCount,
    ...(activeLeases ? { activeLeases: activeLeases.map(cloneLeaseSummary) } : {}),
    ...(singular ? { activeLease: cloneLeaseSummary(singular) } : {}),
    conflictingPluginIds: [...capability.conflictingPluginIds],
    reasonCode: "NATIVE_GUARD_STATUS_MISMATCH",
  };
}

function findStatusLease(
  status: NativeGuardStatus,
  leaseId: string,
): NativeGuardLeaseSummary | undefined {
  const candidates = status.activeLeases ?? (status.activeLease ? [status.activeLease] : []);
  const matches = candidates.filter((lease) => lease.leaseId === leaseId);
  return matches.length === 1 && matches[0].scope !== undefined
    ? matches[0] as NativeGuardLeaseSummary
    : undefined;
}

function leaseSummaryMatches(
  summary: NativeGuardLeaseSummary,
  expected: NativeGuardLeaseSummary | NativeGuardLeaseActivation | ManagedLease,
): boolean {
  return summary.leaseId === expected.leaseId &&
    summary.leaseEpoch === expected.leaseEpoch &&
    summary.rootSessionKey === expected.rootSessionKey &&
    scopesEqual(summary.scope, expected.scope) &&
    (summary.gatewayInstanceId === undefined ||
      summary.gatewayInstanceId === (
        "gatewayInstanceId" in expected ? expected.gatewayInstanceId : undefined
      )) &&
    summary.mode === expected.mode &&
    summary.policyPackId === expected.policyPackId &&
    summary.policyPackDigest === expected.policyPackDigest &&
    summary.expiresAt === expected.expiresAt;
}

function scopesEqual(left: NativeGuardLeaseScope, right: NativeGuardLeaseScope): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === "session"
    ? right.kind === "session" && left.sessionKey === right.sessionKey
    : right.kind === "agent" && left.agentId === right.agentId;
}

function scopesOverlap(
  left: NormalizedNativeGuardLeaseScope,
  right: NormalizedNativeGuardLeaseScope,
): boolean {
  if (left.kind === "session" && right.kind === "session") {
    return left.sessionKey === right.sessionKey;
  }
  if (left.kind === "agent" && right.kind === "agent") return true;
  const session = left.kind === "session" ? left : right as Extract<NormalizedNativeGuardLeaseScope, { kind: "session" }>;
  return parseCanonicalOpenClawSessionKey(session.sessionKey)?.agentId === "main";
}

function cloneLeaseScope(scope: NativeGuardLeaseScope): NativeGuardLeaseScope {
  return typeof scope === "string" ? scope : { ...scope };
}

function cloneNormalizedScope(
  scope: NormalizedNativeGuardLeaseScope,
): NormalizedNativeGuardLeaseScope {
  return { ...scope };
}

function cloneLeaseSummary(summary: NativeGuardLeaseSummary): NativeGuardLeaseSummary {
  return { ...summary, scope: cloneLeaseScope(summary.scope) };
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

type BackendStatusRead =
  | { available: true; status: NativeGuardStatus }
  | { available: false };

function readBackendStatus(leaseService: NativeGuardLeaseService): BackendStatusRead {
  try {
    return { available: true, status: leaseService.status() };
  } catch {
    return { available: false };
  }
}

function backendUnavailableStatus(
  previous: NativeGuardStatus,
  capability?: NativeGuardCapability,
): NativeGuardStatus {
  const activeLeases = previous.activeLeases?.map(cloneLeaseSummary);
  const activeLease = activeLeases?.length === 1
    ? activeLeases[0]
    : previous.activeLease && previous.activeLease.scope !== undefined
      ? cloneLeaseSummary(previous.activeLease as NativeGuardLeaseSummary)
      : undefined;
  return {
    coverage: previous.activeLeaseCount > 0 ? "conditional" : "misconfigured",
    finalizerAssurance: capability?.finalizerAssurance ?? "unverified",
    openclawVersion: capability?.openclawVersion ?? previous.openclawVersion,
    activeLeaseCount: previous.activeLeaseCount,
    ...(activeLeases ? { activeLeases } : {}),
    ...(activeLease ? { activeLease } : {}),
    conflictingPluginIds: capability
      ? [...capability.conflictingPluginIds]
      : previous.conflictingPluginIds,
    reasonCode: "NATIVE_GUARD_BACKEND_STATUS_UNAVAILABLE",
  };
}

function firstManagedLease(
  leases: Map<string, ManagedLease>,
): ManagedLease | undefined {
  return leases.values().next().value as ManagedLease | undefined;
}

function coordinatorError(code: string, message: string): NativeGuardCoordinatorError {
  return new NativeGuardCoordinatorError(code, message);
}
