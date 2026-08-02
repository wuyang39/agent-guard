import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type {
  NativeGuardLeaseActivation,
  NativeGuardMode,
  NativeGuardStatus,
  NativeToolDecisionResponse,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  signNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAX_TTL_MS = 15 * 60 * 1_000;

type FailurePolicy = NativeGuardLeaseActivation["failurePolicy"];

export type CreateLeaseInput = {
  rootSessionKey: string;
  mode: NativeGuardMode;
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  backendUrl: string;
  ttlMs?: number;
};

export type ActiveNativeGuardLease = Omit<
  NativeGuardLeaseActivation,
  "credential" | "evidenceCredential"
> & {
  state: "active";
  policyPack: SupervisionPolicyPack;
};

export type NativeGuardChildBindingInput = {
  leaseId: string;
  leaseEpoch: number;
  parentSessionKey: string;
  childSessionKey: string;
};

export type NativeGuardSessionEndInput = {
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
};

export type NativeGuardLeaseService = {
  create(input: CreateLeaseInput): { activation: NativeGuardLeaseActivation; status: NativeGuardStatus };
  renew(leaseId: string, ttlMs?: number): NativeGuardLeaseActivation;
  revoke(leaseId: string): boolean;
  authenticate(leaseId: string, credential: string): ActiveNativeGuardLease | undefined;
  authenticateEvidence(leaseId: string, credential: string): ActiveNativeGuardLease | undefined;
  authorizeEvidence(
    leaseId: string,
    leaseEpoch: number,
    sessionKey: string,
    credential: string,
  ): boolean;
  resolveBySession(sessionKey: string): ActiveNativeGuardLease | undefined;
  bindChild(leaseId: string, parentSessionKey: string, childSessionKey: string): boolean;
  bindChildWithEvidence(input: NativeGuardChildBindingInput, credential: string): boolean;
  endSession(sessionKey: string): void;
  endSessionWithEvidence(input: NativeGuardSessionEndInput, credential: string): boolean;
  signDecision(leaseId: string, response: Omit<NativeToolDecisionResponse, "signature">): string;
  status(): NativeGuardStatus;
};

export type NativeGuardLeaseServiceOptions = {
  now?: () => number | Date;
};

type StoredLease = {
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  mode: NativeGuardMode;
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  backendUrl: string;
  decisionPublicKey: string;
  privateKey: KeyObject;
  credentialHash: Buffer;
  evidenceCredentialHash: Buffer;
  issuedAtMs: number;
  expiresAtMs: number;
  policyExpiresAtMs?: number;
};

type SessionBinding = {
  leaseId: string;
  boundEpoch: number;
  parentSessionKey?: string;
  children: Set<string>;
};

type HistoricalSessionBinding = {
  leaseId: string;
  boundEpoch: number;
  endedEpoch: number;
};

export function createNativeGuardLeaseService(
  options: NativeGuardLeaseServiceOptions = {},
): NativeGuardLeaseService {
  const now = options.now ?? (() => new Date());
  const leases = new Map<string, StoredLease>();
  const sessions = new Map<string, SessionBinding>();
  const historicalSessions = new Map<string, HistoricalSessionBinding[]>();

  function currentTimeMs(): number {
    const value = now();
    const timeMs = value instanceof Date ? value.getTime() : value;
    if (
      !Number.isFinite(timeMs) ||
      !Number.isInteger(timeMs) ||
      Math.abs(timeMs) > 8_640_000_000_000_000
    ) {
      throw new RangeError("Native guard clock returned an invalid time");
    }
    return timeMs;
  }

  function cleanExpired(): void {
    const currentMs = currentTimeMs();
    for (const lease of leases.values()) {
      if (lease.expiresAtMs <= currentMs) {
        removeLease(lease.leaseId);
      }
    }
  }

  function removeLease(leaseId: string): boolean {
    const lease = leases.get(leaseId);
    if (!lease) return false;

    lease.leaseEpoch += 1;
    leases.delete(leaseId);
    for (const [sessionKey, binding] of sessions) {
      if (binding.leaseId === leaseId) {
        sessions.delete(sessionKey);
      }
    }
    for (const [sessionKey, bindings] of historicalSessions) {
      const retained = bindings.filter((binding) => binding.leaseId !== leaseId);
      if (retained.length === 0) historicalSessions.delete(sessionKey);
      else historicalSessions.set(sessionKey, retained);
    }
    return true;
  }

  function createCredential(): { credential: string; credentialHash: Buffer } {
    const credential = randomBytes(32).toString("base64url");
    return { credential, credentialHash: hashCredential(credential) };
  }

  function serviceForEvidence(
    leaseId: string,
    credential: string,
  ): StoredLease | undefined {
    if (typeof leaseId !== "string" || typeof credential !== "string") return undefined;
    const lease = leases.get(leaseId);
    if (lease === undefined) return undefined;
    const candidateHash = hashCredential(credential);
    return timingSafeEqual(candidateHash, lease.evidenceCredentialHash)
      ? lease
      : undefined;
  }

  function bindChildAtEpoch(
    lease: StoredLease,
    parentSessionKey: string,
    childSessionKey: string,
  ): boolean {
    if (
      !validSessionKey(parentSessionKey) ||
      !validSessionKey(childSessionKey) ||
      parentSessionKey === childSessionKey
    ) return false;
    const existing = sessions.get(childSessionKey);
    if (existing !== undefined) {
      return existing.leaseId === lease.leaseId &&
        existing.parentSessionKey === parentSessionKey;
    }
    const parent = sessions.get(parentSessionKey);
    if (!parent || parent.leaseId !== lease.leaseId) return false;
    parent.children.add(childSessionKey);
    sessions.set(childSessionKey, {
      leaseId: lease.leaseId,
      boundEpoch: lease.leaseEpoch,
      parentSessionKey,
      children: new Set(),
    });
    return true;
  }

  function activationFor(
    lease: StoredLease,
    credential: string,
    evidenceCredential: string,
  ): NativeGuardLeaseActivation {
    return {
      schemaVersion: "native-guard-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      rootSessionKey: lease.rootSessionKey,
      mode: lease.mode,
      scope: "session_tree",
      policyPackId: lease.policyPack.policyPackId,
      policyPackDigest: lease.policyPackDigest,
      backendUrl: lease.backendUrl,
      decisionPublicKey: lease.decisionPublicKey,
      failurePolicy: createFailurePolicy(),
      issuedAt: new Date(lease.issuedAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      credential,
      evidenceCredential,
    };
  }

  function activeLeaseFor(lease: StoredLease): ActiveNativeGuardLease {
    return {
      state: "active",
      schemaVersion: "native-guard-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      rootSessionKey: lease.rootSessionKey,
      mode: lease.mode,
      scope: "session_tree",
      policyPackId: lease.policyPack.policyPackId,
      policyPackDigest: lease.policyPackDigest,
      backendUrl: lease.backendUrl,
      decisionPublicKey: lease.decisionPublicKey,
      failurePolicy: createFailurePolicy(),
      issuedAt: new Date(lease.issuedAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      policyPack: lease.policyPack,
    };
  }

  function status(): NativeGuardStatus {
    cleanExpired();
    const activeLease = leases.values().next().value as StoredLease | undefined;
    return {
      coverage: activeLease ? "conditional" : "ready",
      finalizerAssurance: "unverified",
      activeLeaseCount: leases.size,
      ...(activeLease
        ? {
            activeLease: {
              leaseId: activeLease.leaseId,
              leaseEpoch: activeLease.leaseEpoch,
              rootSessionKey: activeLease.rootSessionKey,
              mode: activeLease.mode,
              policyPackId: activeLease.policyPack.policyPackId,
              policyPackDigest: activeLease.policyPackDigest,
              expiresAt: new Date(activeLease.expiresAtMs).toISOString(),
            },
          }
        : {}),
      ...(activeLease
        ? { reasonCode: "NATIVE_GUARD_FINALIZER_UNVERIFIED" }
        : {}),
    };
  }

  return {
    create(input: CreateLeaseInput): {
      activation: NativeGuardLeaseActivation;
      status: NativeGuardStatus;
    } {
      cleanExpired();
      const issuedAtMs = currentTimeMs();
      const ttlMs = validateTtl(input.ttlMs ?? DEFAULT_TTL_MS);
      if (sessions.has(input.rootSessionKey)) {
        throw new Error("Native guard root session is already bound");
      }
      const policyPack = deepFreeze(structuredClone(input.policyPack));
      if (digestJson(policyPack) !== input.policyPackDigest) {
        throw new Error("Native guard policy pack digest does not match its snapshot");
      }
      const policyExpiresAtMs = readPolicyExpiry(policyPack, issuedAtMs);
      const leaseId = randomUUID();
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const { credential, credentialHash } = createCredential();
      const {
        credential: evidenceCredential,
        credentialHash: evidenceCredentialHash,
      } = createCredential();
      const lease: StoredLease = {
        leaseId,
        leaseEpoch: 1,
        rootSessionKey: input.rootSessionKey,
        mode: input.mode,
        policyPack,
        policyPackDigest: input.policyPackDigest,
        backendUrl: input.backendUrl,
        decisionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKey,
        credentialHash,
        evidenceCredentialHash,
        issuedAtMs,
        expiresAtMs: clampExpiry(issuedAtMs, ttlMs, policyExpiresAtMs),
        policyExpiresAtMs,
      };
      leases.set(leaseId, lease);
      sessions.set(input.rootSessionKey, { leaseId, boundEpoch: 1, children: new Set() });
      return {
        activation: activationFor(lease, credential, evidenceCredential),
        status: status(),
      };
    },

    renew(leaseId: string, ttlMs = DEFAULT_TTL_MS): NativeGuardLeaseActivation {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease) throw new Error("Native guard lease is not active");

      const validTtlMs = validateTtl(ttlMs);
      const issuedAtMs = currentTimeMs();
      const { credential, credentialHash } = createCredential();
      const {
        credential: evidenceCredential,
        credentialHash: evidenceCredentialHash,
      } = createCredential();
      lease.leaseEpoch += 1;
      lease.credentialHash = credentialHash;
      lease.evidenceCredentialHash = evidenceCredentialHash;
      lease.issuedAtMs = issuedAtMs;
      lease.expiresAtMs = clampExpiry(
        issuedAtMs,
        validTtlMs,
        lease.policyExpiresAtMs,
      );
      return activationFor(lease, credential, evidenceCredential);
    },

    revoke(leaseId: string): boolean {
      cleanExpired();
      return removeLease(leaseId);
    },

    authenticate(
      leaseId: string,
      credential: string,
    ): ActiveNativeGuardLease | undefined {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease) return undefined;

      const candidateHash = hashCredential(credential);
      return timingSafeEqual(candidateHash, lease.credentialHash)
        ? activeLeaseFor(lease)
        : undefined;
    },

    authenticateEvidence(
      leaseId: string,
      credential: string,
    ): ActiveNativeGuardLease | undefined {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease || typeof credential !== "string") return undefined;
      const candidateHash = hashCredential(credential);
      return timingSafeEqual(candidateHash, lease.evidenceCredentialHash)
        ? activeLeaseFor(lease)
        : undefined;
    },

    authorizeEvidence(
      leaseId: string,
      leaseEpoch: number,
      sessionKey: string,
      credential: string,
    ): boolean {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (
        !lease ||
        !Number.isSafeInteger(leaseEpoch) ||
        leaseEpoch <= 0 ||
        leaseEpoch > lease.leaseEpoch ||
        typeof sessionKey !== "string" ||
        serviceForEvidence(leaseId, credential) === undefined
      ) return false;
      const live = sessions.get(sessionKey);
      if (
        live?.leaseId === leaseId &&
        live.boundEpoch <= leaseEpoch
      ) return true;
      return historicalSessions.get(sessionKey)?.some((binding) =>
        binding.leaseId === leaseId &&
        binding.boundEpoch <= leaseEpoch &&
        leaseEpoch <= binding.endedEpoch) === true;
    },

    resolveBySession(sessionKey: string): ActiveNativeGuardLease | undefined {
      cleanExpired();
      const binding = sessions.get(sessionKey);
      if (!binding) return undefined;
      const lease = leases.get(binding.leaseId);
      return lease ? activeLeaseFor(lease) : undefined;
    },

    bindChild(
      leaseId: string,
      parentSessionKey: string,
      childSessionKey: string,
    ): boolean {
      cleanExpired();
      const lease = leases.get(leaseId);
      return lease === undefined
        ? false
        : bindChildAtEpoch(lease, parentSessionKey, childSessionKey);
    },

    bindChildWithEvidence(
      input: NativeGuardChildBindingInput,
      credential: string,
    ): boolean {
      cleanExpired();
      const lease = serviceForEvidence(input.leaseId, credential);
      if (
        lease === undefined ||
        input.leaseEpoch !== lease.leaseEpoch ||
        !validSessionKey(input.parentSessionKey) ||
        !validSessionKey(input.childSessionKey)
      ) return false;
      return bindChildAtEpoch(lease, input.parentSessionKey, input.childSessionKey);
    },

    endSession(sessionKey: string): void {
      cleanExpired();
      const binding = sessions.get(sessionKey);
      if (!binding) return;
      const lease = leases.get(binding.leaseId);
      if (lease?.rootSessionKey === sessionKey) {
        removeLease(binding.leaseId);
        return;
      }
      archiveAndRemoveSessionTree(
        sessionKey,
        binding.leaseId,
        lease!.leaseEpoch,
        sessions,
        historicalSessions,
      );
    },

    endSessionWithEvidence(
      input: NativeGuardSessionEndInput,
      credential: string,
    ): boolean {
      cleanExpired();
      const lease = serviceForEvidence(input.leaseId, credential);
      if (
        lease === undefined ||
        input.leaseEpoch !== lease.leaseEpoch ||
        !validSessionKey(input.sessionKey)
      ) return false;
      const binding = sessions.get(input.sessionKey);
      if (binding === undefined) {
        return historicalSessions.get(input.sessionKey)?.some((historical) =>
          historical.leaseId === input.leaseId) === true;
      }
      if (binding.leaseId !== input.leaseId) return false;
      if (lease.rootSessionKey === input.sessionKey) return removeLease(input.leaseId);
      archiveAndRemoveSessionTree(
        input.sessionKey,
        input.leaseId,
        lease.leaseEpoch,
        sessions,
        historicalSessions,
      );
      return true;
    },

    signDecision(
      leaseId: string,
      response: Omit<NativeToolDecisionResponse, "signature">,
    ): string {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease) throw new Error("Native guard lease is not active");
      if (
        response.leaseId !== lease.leaseId ||
        response.leaseEpoch !== lease.leaseEpoch ||
        response.policyPackId !== lease.policyPack.policyPackId ||
        response.policyPackDigest !== lease.policyPackDigest
      ) {
        throw new Error("Native guard decision does not match the active lease");
      }
      return signNativeGuardPayload(response, lease.privateKey);
    },

    status,
  };
}

function hashCredential(credential: string): Buffer {
  return createHash("sha256").update(credential, "utf8").digest();
}

function createFailurePolicy(): FailurePolicy {
  return { lowRisk: "warn", highRisk: "deny", unknownRisk: "deny" };
}

function validateTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new RangeError(`Native guard lease TTL must be an integer from 1 to ${MAX_TTL_MS}`);
  }
  return ttlMs;
}

function readPolicyExpiry(
  policyPack: SupervisionPolicyPack,
  currentTimeMs: number,
): number | undefined {
  if (policyPack.expiresAt === undefined) return undefined;
  if (typeof policyPack.expiresAt !== "string") {
    throw new TypeError("Native guard policy pack expiry must be an ISO timestamp");
  }
  const expiresAtMs = Date.parse(policyPack.expiresAt);
  if (
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== policyPack.expiresAt ||
    expiresAtMs <= currentTimeMs
  ) {
    throw new RangeError("Native guard policy pack must expire in the future");
  }
  return expiresAtMs;
}

function clampExpiry(
  issuedAtMs: number,
  ttlMs: number,
  policyExpiresAtMs?: number,
): number {
  const leaseExpiresAtMs = issuedAtMs + ttlMs;
  return policyExpiresAtMs === undefined
    ? leaseExpiresAtMs
    : Math.min(leaseExpiresAtMs, policyExpiresAtMs);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function archiveAndRemoveSessionTree(
  sessionKey: string,
  leaseId: string,
  endedEpoch: number,
  sessions: Map<string, SessionBinding>,
  historicalSessions: Map<string, HistoricalSessionBinding[]>,
): void {
  const rootBinding = sessions.get(sessionKey);
  if (!rootBinding) return;

  if (rootBinding.parentSessionKey) {
    sessions.get(rootBinding.parentSessionKey)?.children.delete(sessionKey);
  }
  const pending = [sessionKey];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const currentSessionKey = pending.pop();
    if (currentSessionKey === undefined || visited.has(currentSessionKey)) continue;
    visited.add(currentSessionKey);
    const binding = sessions.get(currentSessionKey);
    if (!binding || binding.leaseId !== leaseId) continue;
    for (const childSessionKey of binding.children) {
      pending.push(childSessionKey);
    }
    const history = historicalSessions.get(currentSessionKey) ?? [];
    if (!history.some((entry) =>
      entry.leaseId === leaseId &&
      entry.boundEpoch === binding.boundEpoch &&
      entry.endedEpoch === endedEpoch)) {
      history.push({ leaseId, boundEpoch: binding.boundEpoch, endedEpoch });
      historicalSessions.set(currentSessionKey, history);
    }
    sessions.delete(currentSessionKey);
  }
}

function validSessionKey(value: string): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\x00-\x1f\x7f]/.test(value);
}
