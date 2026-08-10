import type {
  NativeGuardCoverageStatus,
  NativeGuardLeaseSummary,
  NativeGuardStatus,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { loadStoredOpenClawPolicyPack as loadStoredPolicyPack } from "../policy/policyPackRepository";
import type { NativeGuardCoordinator } from "./nativeGuardCoordinator";

const MAIN_ROOT_SESSION_KEY = "agent:main:main";
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAIN_SCOPE = { kind: "agent", agentId: "main" } as const;

type LoadedOpenClawPolicyPack = {
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  runGroupId: string;
};

type MainCoordinator = Pick<
  NativeGuardCoordinator,
  "activate" | "renew" | "revoke" | "status" | "isLeaseUsable"
>;

export type MainAgentSupervisionStatus = {
  coverage: NativeGuardCoverageStatus;
  scope: { kind: "agent"; agentId: "main" };
  policyPackId?: string;
  leaseId?: string;
  leaseEpoch?: number;
  expiresAt?: string;
  gatewayInstanceId?: string;
  activeLeaseCount: number;
  mainLeaseCount: 0 | 1;
  reasonCode?: string;
  detail?: string;
};

export type MainAgentSupervisionService = {
  start(policyPackId: string): Promise<MainAgentSupervisionStatus>;
  stop(): Promise<MainAgentSupervisionStatus>;
  status(): Promise<MainAgentSupervisionStatus>;
  close(): Promise<void>;
};

export type MainAgentSupervisionServiceOptions = {
  coordinator: MainCoordinator;
  loadStoredOpenClawPolicyPack?: (
    policyPackId: string,
  ) => Promise<LoadedOpenClawPolicyPack | undefined>;
  ttlMs?: number;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (timer: unknown) => void;
};

export class MainAgentSupervisionServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "MainAgentSupervisionServiceError";
  }
}

type ManagedMainLease = {
  policyPackId: string;
  policyPackDigest: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  gatewayInstanceId: string;
  activeLeaseCount: number;
  failure?: {
    coverage: "recovery" | "conditional";
    reasonCode: string;
    detail: string;
  };
};

export function createMainAgentSupervisionService(
  options: MainAgentSupervisionServiceOptions,
): MainAgentSupervisionService {
  const ttlMs = validTtl(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) =>
    setTimeout(callback, delayMs));
  const cancelTimeout = options.cancelTimeout ?? ((timer) =>
    clearTimeout(timer as ReturnType<typeof setTimeout>));
  const loadPolicyPack = options.loadStoredOpenClawPolicyPack ?? loadStoredPolicyPack;
  let current: ManagedMainLease | undefined;
  let renewalTimer: unknown;
  let operationTail: Promise<void> = Promise.resolve();
  let lastStatus = idleStatus("off", 0);

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  function cancelRenewal(): void {
    if (renewalTimer === undefined) return;
    const timer = renewalTimer;
    renewalTimer = undefined;
    cancelTimeout(timer);
  }

  function scheduleRenewal(lease: ManagedMainLease): void {
    cancelRenewal();
    const expiresAtMs = Date.parse(lease.expiresAt);
    const delayMs = Number.isFinite(expiresAtMs)
      ? Math.max(0, expiresAtMs - now() - ttlMs / 3)
      : Math.floor(ttlMs * 2 / 3);
    renewalTimer = scheduleTimeout(() => {
      renewalTimer = undefined;
      void serialize(() => renewCurrent(lease.leaseId));
    }, delayMs);
  }

  async function loadExactPolicy(policyPackId: string): Promise<LoadedOpenClawPolicyPack> {
    if (!validPolicyPackId(policyPackId)) throw policyInvalid();
    let loaded: LoadedOpenClawPolicyPack | undefined;
    try {
      loaded = await loadPolicyPack(policyPackId);
    } catch {
      loaded = undefined;
    }
    if (!isExactLoadedPolicy(loaded, policyPackId)) throw policyInvalid();
    return loaded;
  }

  async function startInternal(policyPackId: string): Promise<MainAgentSupervisionStatus> {
    if (
      current?.policyPackId === policyPackId &&
      current.failure === undefined &&
      options.coordinator.isLeaseUsable(current.leaseId)
    ) {
      return cloneStatus(lastStatus);
    }

    const loaded = await loadExactPolicy(policyPackId);
    const previous = current && current.policyPackId !== policyPackId
      ? { ...current, failure: undefined }
      : undefined;
    let beforeActivation: NativeGuardStatus | undefined;
    if (!current) {
      beforeActivation = await readCoordinatorStatusForStart();
      const unmanaged = findMainLeases(beforeActivation);
      if (unmanaged.length > 0) {
        lastStatus = unmanagedLeaseStatus(beforeActivation, unmanaged);
        throw serviceError(
          "MAIN_AGENT_SUPERVISION_UNMANAGED_LEASE",
          409,
          "An unmanaged main-agent supervision lease is already active.",
        );
      }
    }
    if (current) {
      await stopInternal();
      if (current) {
        throw serviceError(
          "MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT",
          409,
          "The current main-agent supervision lease could not be replaced.",
        );
      }
      beforeActivation = await readCoordinatorStatusForStart();
    }
    beforeActivation ??= await readCoordinatorStatusForStart();

    const activated = await activateOwnedPolicy(
      policyPackId,
      loaded.policyPackDigest,
      beforeActivation,
    );
    if (activated) return cloneStatus(lastStatus);

    if (previous && current === undefined) {
      await restorePrevious(previous);
    }
    throw activationFailed();
  }

  async function activateOwnedPolicy(
    policyPackId: string,
    policyPackDigest: string,
    before: NativeGuardStatus,
    expectedGatewayInstanceId?: string,
  ): Promise<boolean> {
    const beforeIds = new Set(statusLeases(before).map((lease) => lease.leaseId));
    let aggregate: NativeGuardStatus;
    try {
      aggregate = await options.coordinator.activate({
        rootSessionKey: MAIN_ROOT_SESSION_KEY,
        scope: { ...MAIN_SCOPE },
        mode: "supervision",
        policyPackId,
        ttlMs,
      });
    } catch {
      let after: NativeGuardStatus | undefined;
      try {
        after = await options.coordinator.status();
      } catch {
        // A missing post-failure snapshot leaves ownership unconfirmed.
      }
      if (
        after &&
        newlyAddedActivationCandidates(after, beforeIds, policyPackId).length > 0
      ) {
        await rollbackInvalidActivation(after, beforeIds, policyPackId);
      } else {
        current = undefined;
        lastStatus = idleStatus("conditional", after?.activeLeaseCount ?? before.activeLeaseCount, {
          reasonCode: "MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED",
          detail: "Main-agent supervision could not be activated.",
        });
      }
      return false;
    }

    const newlyAdded = newlyAddedMainLeases(aggregate, beforeIds);
    const exact = newlyAdded.length === 1
      ? findExactMainLease(aggregate, {
          leaseId: newlyAdded[0].leaseId,
          policyPackId,
          policyPackDigest,
        })
      : undefined;
    if (
      aggregate.coverage !== "active" ||
      !exact ||
      !nonEmpty(exact.gatewayInstanceId) ||
      (expectedGatewayInstanceId !== undefined &&
        exact.gatewayInstanceId !== expectedGatewayInstanceId) ||
      !options.coordinator.isLeaseUsable(exact.leaseId)
    ) {
      await rollbackInvalidActivation(aggregate, beforeIds, policyPackId);
      return false;
    }

    current = managedLease(exact, exact.gatewayInstanceId, aggregate.activeLeaseCount);
    lastStatus = activeStatus(current);
    try {
      scheduleRenewal(current);
      return true;
    } catch {
      await rollbackInvalidActivation(aggregate, beforeIds, policyPackId);
      return false;
    }
  }

  async function rollbackInvalidActivation(
    aggregate: NativeGuardStatus,
    beforeIds: ReadonlySet<string>,
    requestedPolicyPackId: string,
  ): Promise<boolean> {
    cancelRenewal();
    const candidates = newlyAddedActivationCandidates(
      aggregate,
      beforeIds,
      requestedPolicyPackId,
    );
    if (candidates.length !== 1) {
      current = undefined;
      lastStatus = idleStatus("recovery", aggregate.activeLeaseCount, {
        reasonCode: "MAIN_AGENT_SUPERVISION_ROLLBACK_UNCONFIRMED",
        detail: "Main-agent supervision activation ownership could not be confirmed.",
      });
      return false;
    }
    const candidate = candidates[0];
    try {
      const revoked = await options.coordinator.revoke(candidate.leaseId);
      if (
        revoked.reasonCode === "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED" ||
        statusLeases(revoked).some((lease) => lease.leaseId === candidate.leaseId)
      ) {
        retainCleanupCandidate(candidate, aggregate, revoked.activeLeaseCount);
        return false;
      }
      current = undefined;
      lastStatus = publicWithoutMain(revoked);
      return true;
    } catch {
      retainCleanupCandidate(candidate, aggregate, aggregate.activeLeaseCount);
      return false;
    }
  }

  function retainCleanupCandidate(
    candidate: NativeGuardLeaseSummary,
    aggregate: NativeGuardStatus,
    activeLeaseCount: number,
  ): void {
    current = {
      ...managedLease(
        candidate,
        candidate.gatewayInstanceId ?? (
          aggregate.activeLeaseCount === 1 ? aggregate.gatewayInstanceId : undefined
        ) ?? "unconfirmed",
        activeLeaseCount,
      ),
      failure: {
        coverage: "recovery",
        reasonCode: "MAIN_AGENT_SUPERVISION_ACTIVATION_ROLLBACK_FAILED",
        detail: "Main-agent supervision activation rollback could not be confirmed.",
      },
    };
    lastStatus = degradedStatus(current);
  }

  async function restorePrevious(previous: ManagedMainLease): Promise<void> {
    let before: NativeGuardStatus;
    try {
      before = await options.coordinator.status();
    } catch {
      markRestoreFailed(lastStatus.activeLeaseCount);
      return;
    }
    const restored = await activateOwnedPolicy(
      previous.policyPackId,
      previous.policyPackDigest,
      before,
      previous.gatewayInstanceId,
    );
    if (!restored) {
      if (current) {
        current.failure = {
          coverage: "recovery",
          reasonCode: "MAIN_AGENT_SUPERVISION_RESTORE_FAILED",
          detail: "The prior main-agent supervision policy could not be restored.",
        };
        lastStatus = degradedStatus(current);
      } else {
        markRestoreFailed(lastStatus.activeLeaseCount);
      }
    }
  }

  function markRestoreFailed(activeLeaseCount: number): void {
    current = undefined;
    cancelRenewal();
    lastStatus = idleStatus("recovery", activeLeaseCount, {
      reasonCode: "MAIN_AGENT_SUPERVISION_RESTORE_FAILED",
      detail: "The prior main-agent supervision policy could not be restored.",
    });
  }

  async function readCoordinatorStatusForStart(): Promise<NativeGuardStatus> {
    try {
      return await options.coordinator.status();
    } catch {
      throw serviceError(
        "MAIN_AGENT_SUPERVISION_STATUS_UNAVAILABLE",
        503,
        "Main-agent supervision status is unavailable.",
      );
    }
  }

  async function renewCurrent(expectedLeaseId: string): Promise<void> {
    const lease = current;
    if (!lease || lease.leaseId !== expectedLeaseId || lease.failure) return;
    let aggregate: NativeGuardStatus;
    try {
      aggregate = await options.coordinator.renew(lease.leaseId, ttlMs);
    } catch {
      markRenewFailure(lease);
      return;
    }
    const renewed = findExactMainLease(aggregate, {
      leaseId: lease.leaseId,
      policyPackId: lease.policyPackId,
      policyPackDigest: lease.policyPackDigest,
    });
    if (
      aggregate.coverage !== "active" ||
      !renewed ||
      !nonEmpty(renewed.gatewayInstanceId) ||
      renewed.gatewayInstanceId !== lease.gatewayInstanceId ||
      !options.coordinator.isLeaseUsable(lease.leaseId)
    ) {
      lease.activeLeaseCount = aggregate.activeLeaseCount;
      markRenewFailure(lease);
      return;
    }
    current = managedLease(renewed, renewed.gatewayInstanceId, aggregate.activeLeaseCount);
    lastStatus = activeStatus(current);
    try {
      scheduleRenewal(current);
    } catch {
      markRenewFailure(current);
    }
  }

  function markRenewFailure(lease: ManagedMainLease): void {
    cancelRenewal();
    lease.failure = {
      coverage: "recovery",
      reasonCode: "MAIN_AGENT_SUPERVISION_RENEW_FAILED",
      detail: "Main-agent supervision lease renewal failed.",
    };
    current = lease;
    lastStatus = degradedStatus(lease);
  }

  async function stopInternal(): Promise<MainAgentSupervisionStatus> {
    const lease = current;
    if (!lease) return cloneStatus(lastStatus);
    cancelRenewal();
    let aggregate: NativeGuardStatus;
    try {
      aggregate = await options.coordinator.revoke(lease.leaseId);
    } catch {
      lease.failure = {
        coverage: "recovery",
        reasonCode: "MAIN_AGENT_SUPERVISION_STOP_FAILED",
        detail: "Main-agent supervision lease revocation could not be confirmed.",
      };
      current = lease;
      lastStatus = degradedStatus(lease);
      return cloneStatus(lastStatus);
    }
    if (aggregate.reasonCode === "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED") {
      lease.activeLeaseCount = aggregate.activeLeaseCount;
      lease.failure = {
        coverage: "recovery",
        reasonCode: "NATIVE_GUARD_PLUGIN_REVOKE_UNCONFIRMED",
        detail: "OpenClaw plugin lease revocation could not be confirmed.",
      };
      current = lease;
      lastStatus = degradedStatus(lease);
      return cloneStatus(lastStatus);
    }
    if (
      options.coordinator.isLeaseUsable(lease.leaseId) ||
      statusLeases(aggregate).some((candidate) => candidate.leaseId === lease.leaseId)
    ) {
      lease.activeLeaseCount = aggregate.activeLeaseCount;
      lease.failure = {
        coverage: "recovery",
        reasonCode: "MAIN_AGENT_SUPERVISION_STOP_FAILED",
        detail: "Main-agent supervision lease revocation could not be confirmed.",
      };
      current = lease;
      lastStatus = degradedStatus(lease);
      return cloneStatus(lastStatus);
    }
    current = undefined;
    lastStatus = publicWithoutMain(aggregate);
    return cloneStatus(lastStatus);
  }

  async function statusInternal(): Promise<MainAgentSupervisionStatus> {
    if (current?.failure) return cloneStatus(lastStatus);
    if (
      !current &&
      (lastStatus.reasonCode === "MAIN_AGENT_SUPERVISION_RESTORE_FAILED" ||
        lastStatus.reasonCode === "MAIN_AGENT_SUPERVISION_ROLLBACK_UNCONFIRMED")
    ) {
      return cloneStatus(lastStatus);
    }
    let aggregate: NativeGuardStatus;
    try {
      aggregate = await options.coordinator.status();
    } catch {
      throw serviceError(
        "MAIN_AGENT_SUPERVISION_STATUS_UNAVAILABLE",
        503,
        "Main-agent supervision status is unavailable.",
      );
    }

    if (!current) {
      const unmanaged = findMainLeases(aggregate);
      if (unmanaged.length > 0) {
        lastStatus = unmanagedLeaseStatus(aggregate, unmanaged);
        return cloneStatus(lastStatus);
      }
      lastStatus = publicWithoutMain(aggregate);
      return cloneStatus(lastStatus);
    }

    const exact = findExactMainLease(aggregate, {
      leaseId: current.leaseId,
      policyPackId: current.policyPackId,
      policyPackDigest: current.policyPackDigest,
    });
    if (
      aggregate.coverage === "active" &&
      exact &&
      nonEmpty(exact.gatewayInstanceId) &&
      exact.gatewayInstanceId === current.gatewayInstanceId &&
      options.coordinator.isLeaseUsable(current.leaseId)
    ) {
      current = managedLease(exact, exact.gatewayInstanceId, aggregate.activeLeaseCount);
      lastStatus = activeStatus(current);
      return cloneStatus(lastStatus);
    }
    cancelRenewal();
    current.activeLeaseCount = aggregate.activeLeaseCount;
    current.failure = {
      coverage: aggregate.coverage === "conditional" ? "conditional" : "recovery",
      reasonCode: "MAIN_AGENT_SUPERVISION_STATUS_MISMATCH",
      detail: "Main-agent supervision lease status could not be confirmed.",
    };
    lastStatus = degradedStatus(current);
    return cloneStatus(lastStatus);
  }

  return {
    start(policyPackId) {
      return serialize(() => startInternal(policyPackId));
    },
    stop() {
      return serialize(stopInternal);
    },
    status() {
      return serialize(statusInternal);
    },
    async close() {
      try {
        await serialize(stopInternal);
      } catch {
        cancelRenewal();
      }
    },
  };
}

function managedLease(
  summary: NativeGuardLeaseSummary,
  gatewayInstanceId: string,
  activeLeaseCount: number,
): ManagedMainLease {
  return {
    policyPackId: summary.policyPackId,
    policyPackDigest: summary.policyPackDigest,
    leaseId: summary.leaseId,
    leaseEpoch: summary.leaseEpoch,
    expiresAt: summary.expiresAt,
    gatewayInstanceId,
    activeLeaseCount,
  };
}

function activeStatus(lease: ManagedMainLease): MainAgentSupervisionStatus {
  return {
    coverage: "active",
    scope: { ...MAIN_SCOPE },
    policyPackId: lease.policyPackId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    expiresAt: lease.expiresAt,
    gatewayInstanceId: lease.gatewayInstanceId,
    activeLeaseCount: lease.activeLeaseCount,
    mainLeaseCount: 1,
  };
}

function degradedStatus(lease: ManagedMainLease): MainAgentSupervisionStatus {
  const failure = lease.failure ?? {
    coverage: "recovery" as const,
    reasonCode: "MAIN_AGENT_SUPERVISION_STATUS_MISMATCH",
    detail: "Main-agent supervision lease status could not be confirmed.",
  };
  return {
    coverage: failure.coverage,
    scope: { ...MAIN_SCOPE },
    policyPackId: lease.policyPackId,
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    expiresAt: lease.expiresAt,
    ...(lease.gatewayInstanceId === "unconfirmed"
      ? {}
      : { gatewayInstanceId: lease.gatewayInstanceId }),
    activeLeaseCount: lease.activeLeaseCount,
    mainLeaseCount: 1,
    reasonCode: failure.reasonCode,
    detail: failure.detail,
  };
}

function publicWithoutMain(status: NativeGuardStatus): MainAgentSupervisionStatus {
  const coverage = status.coverage === "active" ? "ready" : status.coverage;
  return idleStatus(coverage, status.activeLeaseCount, {
    ...(status.coverage !== "active" && status.gatewayInstanceId
      ? { gatewayInstanceId: status.gatewayInstanceId }
      : {}),
    ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}),
    ...(status.detail ? { detail: status.detail } : {}),
  });
}

function unmanagedLeaseStatus(
  aggregate: NativeGuardStatus,
  leases: NativeGuardLeaseSummary[],
): MainAgentSupervisionStatus {
  const lease = leases.length === 1 ? leases[0] : undefined;
  return {
    coverage: aggregate.coverage === "conditional" ? "conditional" : "recovery",
    scope: { ...MAIN_SCOPE },
    ...(lease ? {
      policyPackId: lease.policyPackId,
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      expiresAt: lease.expiresAt,
      ...(lease.gatewayInstanceId ? { gatewayInstanceId: lease.gatewayInstanceId } : {}),
    } : {}),
    activeLeaseCount: aggregate.activeLeaseCount,
    mainLeaseCount: 1,
    reasonCode: "MAIN_AGENT_SUPERVISION_UNMANAGED_LEASE",
    detail: "A main-agent supervision lease exists outside this service instance.",
  };
}

function idleStatus(
  coverage: NativeGuardCoverageStatus,
  activeLeaseCount: number,
  optional: Pick<
    MainAgentSupervisionStatus,
    "gatewayInstanceId" | "reasonCode" | "detail"
  > = {},
): MainAgentSupervisionStatus {
  return {
    coverage,
    scope: { ...MAIN_SCOPE },
    activeLeaseCount,
    mainLeaseCount: 0,
    ...optional,
  };
}

function findExactMainLease(
  status: NativeGuardStatus,
  expected: Partial<Pick<
    NativeGuardLeaseSummary,
    "leaseId" | "policyPackId" | "policyPackDigest"
  >> = {},
): NativeGuardLeaseSummary | undefined {
  const matches = statusLeases(status).filter((lease) =>
    lease.rootSessionKey === MAIN_ROOT_SESSION_KEY &&
    lease.mode === "supervision" &&
    isMainScope(lease.scope) &&
    (expected.leaseId === undefined || lease.leaseId === expected.leaseId) &&
    (expected.policyPackId === undefined || lease.policyPackId === expected.policyPackId) &&
    (expected.policyPackDigest === undefined ||
      lease.policyPackDigest === expected.policyPackDigest));
  return matches.length === 1 ? matches[0] : undefined;
}

function findMainLeases(status: NativeGuardStatus): NativeGuardLeaseSummary[] {
  return statusLeases(status).filter((lease) =>
    lease.rootSessionKey === MAIN_ROOT_SESSION_KEY &&
    lease.mode === "supervision" &&
    isMainScope(lease.scope));
}

function newlyAddedMainLeases(
  status: NativeGuardStatus,
  beforeIds: ReadonlySet<string>,
): NativeGuardLeaseSummary[] {
  return findMainLeases(status).filter((lease) => !beforeIds.has(lease.leaseId));
}

function newlyAddedActivationCandidates(
  status: NativeGuardStatus,
  beforeIds: ReadonlySet<string>,
  requestedPolicyPackId: string,
): NativeGuardLeaseSummary[] {
  return statusLeases(status).filter((lease) =>
    !beforeIds.has(lease.leaseId) &&
    lease.policyPackId === requestedPolicyPackId);
}

function statusLeases(status: NativeGuardStatus): NativeGuardLeaseSummary[] {
  const candidates = status.activeLeases ?? (status.activeLease ? [status.activeLease] : []);
  const byId = new Map<string, NativeGuardLeaseSummary>();
  for (const candidate of candidates) {
    if (candidate.scope !== undefined) byId.set(candidate.leaseId, candidate as NativeGuardLeaseSummary);
  }
  return [...byId.values()];
}

function isMainScope(scope: NativeGuardLeaseSummary["scope"]): boolean {
  return typeof scope === "object" && scope.kind === "agent" && scope.agentId === "main";
}

function cloneStatus(status: MainAgentSupervisionStatus): MainAgentSupervisionStatus {
  return { ...status, scope: { ...status.scope } };
}

function validPolicyPackId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validTtl(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isExactLoadedPolicy(
  loaded: LoadedOpenClawPolicyPack | undefined,
  policyPackId: string,
): loaded is LoadedOpenClawPolicyPack {
  try {
    return Boolean(
      loaded &&
      loaded.policyPack &&
      loaded.policyPack.policyPackId === policyPackId &&
      nonEmpty(loaded.runGroupId) &&
      nonEmpty(loaded.policyPack.sourceDetectionReportId) &&
      nonEmpty(loaded.policyPack.sourceRiskProfileId) &&
      digestJson(loaded.policyPack) === loaded.policyPackDigest,
    );
  } catch {
    return false;
  }
}

function policyInvalid(): MainAgentSupervisionServiceError {
  return serviceError(
    "MAIN_AGENT_SUPERVISION_POLICY_INVALID",
    400,
    "The requested stored OpenClaw detection policy pack is unavailable.",
  );
}

function activationFailed(): MainAgentSupervisionServiceError {
  return serviceError(
    "MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED",
    503,
    "Main-agent supervision could not be activated.",
  );
}

function serviceError(
  code: string,
  statusCode: 400 | 409 | 503,
  message: string,
): MainAgentSupervisionServiceError {
  return new MainAgentSupervisionServiceError(code, statusCode, message);
}
