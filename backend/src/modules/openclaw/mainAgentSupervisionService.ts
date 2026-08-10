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
    if (current) {
      await stopInternal();
      if (current) {
        throw serviceError(
          "MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT",
          409,
          "The current main-agent supervision lease could not be replaced.",
        );
      }
    }

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
      lastStatus = idleStatus("conditional", lastStatus.activeLeaseCount, {
        reasonCode: "MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED",
        detail: "Main-agent supervision could not be activated.",
      });
      throw activationFailed();
    }

    const exact = findExactMainLease(aggregate, {
      policyPackId,
      policyPackDigest: loaded.policyPackDigest,
    });
    if (
      aggregate.coverage !== "active" ||
      !exact ||
      !nonEmpty(aggregate.gatewayInstanceId) ||
      !options.coordinator.isLeaseUsable(exact.leaseId)
    ) {
      await rollbackInvalidActivation(aggregate, loaded);
      throw activationFailed();
    }

    current = managedLease(exact, aggregate.gatewayInstanceId, aggregate.activeLeaseCount);
    lastStatus = activeStatus(current);
    try {
      scheduleRenewal(current);
    } catch {
      await rollbackInvalidActivation(aggregate, loaded);
      throw activationFailed();
    }
    return cloneStatus(lastStatus);
  }

  async function rollbackInvalidActivation(
    aggregate: NativeGuardStatus,
    loaded: LoadedOpenClawPolicyPack,
  ): Promise<void> {
    cancelRenewal();
    const candidate = findActivationCandidate(aggregate, {
      policyPackId: loaded.policyPack.policyPackId,
      policyPackDigest: loaded.policyPackDigest,
    });
    if (!candidate) {
      current = undefined;
      lastStatus = idleStatus("conditional", aggregate.activeLeaseCount, {
        reasonCode: "MAIN_AGENT_SUPERVISION_ACTIVATION_FAILED",
        detail: "Main-agent supervision activation could not be confirmed.",
      });
      return;
    }
    try {
      const revoked = await options.coordinator.revoke(candidate.leaseId);
      current = undefined;
      lastStatus = publicWithoutMain(revoked);
    } catch {
      current = {
        ...managedLease(
          { ...candidate, scope: { ...MAIN_SCOPE } },
          aggregate.gatewayInstanceId ?? "unconfirmed",
          aggregate.activeLeaseCount,
        ),
        failure: {
          coverage: "recovery",
          reasonCode: "MAIN_AGENT_SUPERVISION_ACTIVATION_ROLLBACK_FAILED",
          detail: "Main-agent supervision activation rollback could not be confirmed.",
        },
      };
      lastStatus = degradedStatus(current);
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
      !nonEmpty(aggregate.gatewayInstanceId) ||
      !options.coordinator.isLeaseUsable(lease.leaseId)
    ) {
      lease.activeLeaseCount = aggregate.activeLeaseCount;
      markRenewFailure(lease);
      return;
    }
    current = managedLease(renewed, aggregate.gatewayInstanceId, aggregate.activeLeaseCount);
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
      const discovered = findExactMainLease(aggregate);
      if (
        discovered &&
        aggregate.coverage === "active" &&
        nonEmpty(aggregate.gatewayInstanceId) &&
        options.coordinator.isLeaseUsable(discovered.leaseId)
      ) {
        current = managedLease(discovered, aggregate.gatewayInstanceId, aggregate.activeLeaseCount);
        lastStatus = activeStatus(current);
        try {
          scheduleRenewal(current);
        } catch {
          markRenewFailure(current);
        }
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
      nonEmpty(aggregate.gatewayInstanceId) &&
      options.coordinator.isLeaseUsable(current.leaseId)
    ) {
      current = managedLease(exact, aggregate.gatewayInstanceId, aggregate.activeLeaseCount);
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
  return idleStatus(status.coverage, status.activeLeaseCount, {
    ...(status.gatewayInstanceId ? { gatewayInstanceId: status.gatewayInstanceId } : {}),
    ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}),
    ...(status.detail ? { detail: status.detail } : {}),
  });
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

function findActivationCandidate(
  status: NativeGuardStatus,
  expected: Pick<NativeGuardLeaseSummary, "policyPackId" | "policyPackDigest">,
): NativeGuardLeaseSummary | undefined {
  const matches = statusLeases(status).filter((lease) =>
    lease.rootSessionKey === MAIN_ROOT_SESSION_KEY &&
    lease.mode === "supervision" &&
    lease.policyPackId === expected.policyPackId &&
    lease.policyPackDigest === expected.policyPackDigest);
  return matches.length === 1 ? matches[0] : undefined;
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
