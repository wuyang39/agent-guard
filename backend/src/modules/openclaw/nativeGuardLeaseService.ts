import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type {
  NativeGuardEvidenceAcknowledgement,
  NativeGuardEventAcknowledgement,
  NativeGuardEvidenceProof,
  NativeGuardLifecycleAcknowledgement,
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeGuardMode,
  NativeGuardStatus,
  NativeToolDecisionResponse,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  normalizeNativeGuardLeaseScope,
  parseCanonicalOpenClawSessionKey,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
  type NormalizedNativeGuardLeaseScope,
} from "@agent-guard/native-guard-protocol";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const MAX_TTL_MS = 15 * 60 * 1_000;
const MAX_EVIDENCE_PROOFS = 4_096;
const MAX_EVIDENCE_PROOF_SKEW_MS = 30_000;
const SAFE_PROOF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const EVIDENCE_PATHS = new Set([
  "/api/v1/openclaw/native-guard/lifecycle/bind-child",
  "/api/v1/openclaw/native-guard/lifecycle/end-session",
  "/api/v1/openclaw/native-guard/events/batch",
]);

type FailurePolicy = NativeGuardLeaseActivation["failurePolicy"];

export type CreateLeaseInput = {
  rootSessionKey: string;
  scope?: NativeGuardLeaseScope;
  mode: NativeGuardMode;
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  backendUrl: string;
  ttlMs?: number;
};

export type ActiveNativeGuardLease = Omit<
  NativeGuardLeaseActivation,
  "credential" | "evidenceCredential" | "evidenceSigningPrivateKey"
> & {
  state: "active";
  policyPack: SupervisionPolicyPack;
};

export type EvidenceNativeGuardLease = Omit<
  ActiveNativeGuardLease,
  "state"
> & {
  state: "active" | "root_ended";
};

export type VerifiedEvidenceRequest = {
  leaseId: string;
  leaseEpoch: number;
  proofId: string;
  bodyDigest: string;
  path: string;
  proofDigest: string;
};

type UnsignedEvidenceAcknowledgement =
  | Omit<NativeGuardLifecycleAcknowledgement, "signature">
  | Omit<NativeGuardEventAcknowledgement, "signature">;

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
  authenticateEvidence(leaseId: string, credential: string): EvidenceNativeGuardLease | undefined;
  verifyEvidenceRequest(
    leaseId: string,
    credential: string,
    proof: NativeGuardEvidenceProof,
    path: string,
    bodyDigest: string,
  ): VerifiedEvidenceRequest | undefined;
  releaseEvidenceRequest(verified: VerifiedEvidenceRequest): boolean;
  signEvidenceAcknowledgement(
    leaseId: string,
    acknowledgement: UnsignedEvidenceAcknowledgement,
  ): NativeGuardEvidenceAcknowledgement;
  recoverEvidenceAcknowledgement(
    proof: NativeGuardEvidenceProof,
    path: string,
    bodyDigest: string,
    credential?: string,
  ): NativeGuardEvidenceAcknowledgement | undefined;
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
  scope: NativeGuardLeaseScope;
  normalizedScope: NormalizedNativeGuardLeaseScope;
  mode: NativeGuardMode;
  policyPack: SupervisionPolicyPack;
  policyPackDigest: string;
  backendUrl: string;
  decisionPublicKey: string;
  privateKey: KeyObject;
  evidencePublicKey: KeyObject;
  evidenceSigningKeyId: string;
  credentialHash: Buffer;
  evidenceCredentialHash: Buffer;
  evidenceProofs: Map<string, {
    rememberedAt: number;
    path: string;
    bodyDigest: string;
    proofDigest: string;
    state: "reserved" | "committed";
  }>;
  completedEvidenceAcknowledgements: Map<string, {
    path: string;
    bodyDigest: string;
    proofDigest: string;
    acknowledgement: NativeGuardEvidenceAcknowledgement;
    allowBearerless: boolean;
  }>;
  phase: "active" | "root_ended";
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
  const agents = new Map<string, string>();
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
    if (
      lease.normalizedScope.kind === "agent" &&
      agents.get(lease.normalizedScope.agentId) === leaseId
    ) {
      agents.delete(lease.normalizedScope.agentId);
    }
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

  function createEvidenceSigningIdentity(): {
    evidencePublicKey: KeyObject;
    evidenceSigningKeyId: string;
    evidenceSigningPrivateKey: string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      evidencePublicKey: publicKey,
      evidenceSigningKeyId: `evidence.${randomUUID()}`,
      evidenceSigningPrivateKey: privateKey.export({
        type: "pkcs8",
        format: "pem",
      }).toString(),
    };
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
    evidenceSigningPrivateKey: string,
  ): NativeGuardLeaseActivation {
    return {
      schemaVersion: "native-guard-1",
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      rootSessionKey: lease.rootSessionKey,
      mode: lease.mode,
      scope: emittedScopeFor(lease),
      policyPackId: lease.policyPack.policyPackId,
      policyPackDigest: lease.policyPackDigest,
      backendUrl: lease.backendUrl,
      decisionPublicKey: lease.decisionPublicKey,
      failurePolicy: createFailurePolicy(),
      issuedAt: new Date(lease.issuedAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      credential,
      evidenceCredential,
      evidenceSigningKeyId: lease.evidenceSigningKeyId,
      evidenceSigningPrivateKey,
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
      scope: emittedScopeFor(lease),
      policyPackId: lease.policyPack.policyPackId,
      policyPackDigest: lease.policyPackDigest,
      backendUrl: lease.backendUrl,
      decisionPublicKey: lease.decisionPublicKey,
      failurePolicy: createFailurePolicy(),
      issuedAt: new Date(lease.issuedAtMs).toISOString(),
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      evidenceSigningKeyId: lease.evidenceSigningKeyId,
      policyPack: lease.policyPack,
    };
  }

  function evidenceLeaseFor(lease: StoredLease): EvidenceNativeGuardLease {
    return { ...activeLeaseFor(lease), state: lease.phase };
  }

  function emittedScopeFor(lease: StoredLease): NativeGuardLeaseScope {
    return typeof lease.scope === "string" ? lease.scope : { ...lease.scope };
  }

  function matchesAgentScope(lease: StoredLease, sessionKey: string): boolean {
    if (lease.normalizedScope.kind !== "agent") return false;
    const parsed = parseCanonicalOpenClawSessionKey(sessionKey);
    return parsed?.agentId === lease.normalizedScope.agentId;
  }

  function verifyEvidenceRequest(
    leaseId: string,
    credential: string,
    proof: NativeGuardEvidenceProof,
    path: string,
    bodyDigest: string,
  ): VerifiedEvidenceRequest | undefined {
    cleanExpired();
    const lease = serviceForEvidence(leaseId, credential);
    if (
      lease === undefined ||
      !isEvidenceProof(proof) ||
      !EVIDENCE_PATHS.has(path) ||
      proof.leaseId !== lease.leaseId ||
      proof.leaseEpoch !== lease.leaseEpoch ||
      proof.method !== "POST" ||
      proof.path !== path ||
      proof.bodyDigest !== bodyDigest ||
      proof.keyId !== lease.evidenceSigningKeyId ||
      !DIGEST.test(bodyDigest)
    ) return undefined;
    const issuedAtMs = Date.parse(proof.issuedAt);
    const currentMs = currentTimeMs();
    const lifecycleProof = path !== "/api/v1/openclaw/native-guard/events/batch";
    if (
      issuedAtMs > currentMs + MAX_EVIDENCE_PROOF_SKEW_MS ||
      (lifecycleProof
        ? issuedAtMs < lease.issuedAtMs - MAX_EVIDENCE_PROOF_SKEW_MS ||
          issuedAtMs >= lease.expiresAtMs
        : currentMs - issuedAtMs > MAX_EVIDENCE_PROOF_SKEW_MS)
    ) return undefined;
    for (const [proofId, remembered] of lease.evidenceProofs) {
      if (currentMs - remembered.rememberedAt > MAX_EVIDENCE_PROOF_SKEW_MS * 2) {
        lease.evidenceProofs.delete(proofId);
      }
    }
    if (
      lease.evidenceProofs.has(proof.proofId) ||
      lease.evidenceProofs.size >= MAX_EVIDENCE_PROOFS ||
      (path !== "/api/v1/openclaw/native-guard/events/batch" &&
        lease.completedEvidenceAcknowledgements.size >= MAX_EVIDENCE_PROOFS)
    ) return undefined;
    const { signature, ...unsigned } = proof;
    if (!verifyNativeGuardPayload(unsigned, signature, lease.evidencePublicKey)) return undefined;
    lease.evidenceProofs.set(proof.proofId, {
      rememberedAt: currentMs,
      path,
      bodyDigest,
      proofDigest: digestJson(proof),
      state: "reserved",
    });
    return {
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      proofId: proof.proofId,
      bodyDigest: proof.bodyDigest,
      path,
      proofDigest: digestJson(proof),
    };
  }

  function releaseEvidenceRequest(verified: VerifiedEvidenceRequest): boolean {
    const lease = leases.get(verified.leaseId);
    const remembered = lease?.evidenceProofs.get(verified.proofId);
    if (
      lease === undefined ||
      remembered === undefined ||
      remembered.state !== "reserved" ||
      verified.leaseEpoch !== lease.leaseEpoch ||
      remembered.path !== verified.path ||
      remembered.bodyDigest !== verified.bodyDigest ||
      remembered.proofDigest !== verified.proofDigest
    ) return false;
    lease.evidenceProofs.delete(verified.proofId);
    return true;
  }

  function status(): NativeGuardStatus {
    cleanExpired();
    const activeStoredLeases = [...leases.values()].filter((lease) => lease.phase === "active");
    const activeLeases = activeStoredLeases.map((lease) => ({
      leaseId: lease.leaseId,
      leaseEpoch: lease.leaseEpoch,
      rootSessionKey: lease.rootSessionKey,
      scope: emittedScopeFor(lease),
      mode: lease.mode,
      policyPackId: lease.policyPack.policyPackId,
      policyPackDigest: lease.policyPackDigest,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
    }));
    const activeLease = activeLeases.length === 1 ? activeLeases[0] : undefined;
    return {
      coverage: activeLeases.length > 0 ? "conditional" : "ready",
      finalizerAssurance: "unverified",
      activeLeaseCount: activeLeases.length,
      activeLeases,
      ...(activeLease
        ? { activeLease }
        : {}),
      ...(activeLeases.length > 0
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
      const normalizedScope = normalizeNativeGuardLeaseScope(
        input.scope,
        input.rootSessionKey,
      );
      if (
        normalizedScope.kind === "session" &&
        sessions.has(normalizedScope.sessionKey)
      ) {
        throw new Error("Native guard root session is already bound");
      }
      if (
        normalizedScope.kind === "agent" &&
        agents.has(normalizedScope.agentId)
      ) {
        throw new Error("Native guard agent is already bound");
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
      const evidenceSigning = createEvidenceSigningIdentity();
      const lease: StoredLease = {
        leaseId,
        leaseEpoch: 1,
        rootSessionKey: input.rootSessionKey,
        scope: input.scope === undefined || input.scope === "session_tree"
          ? "session_tree"
          : normalizedScope,
        normalizedScope,
        mode: input.mode,
        policyPack,
        policyPackDigest: input.policyPackDigest,
        backendUrl: input.backendUrl,
        decisionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKey,
        evidencePublicKey: evidenceSigning.evidencePublicKey,
        evidenceSigningKeyId: evidenceSigning.evidenceSigningKeyId,
        credentialHash,
        evidenceCredentialHash,
        evidenceProofs: new Map(),
        completedEvidenceAcknowledgements: new Map(),
        phase: "active",
        issuedAtMs,
        expiresAtMs: clampExpiry(issuedAtMs, ttlMs, policyExpiresAtMs),
        policyExpiresAtMs,
      };
      const activation = activationFor(
        lease,
        credential,
        evidenceCredential,
        evidenceSigning.evidenceSigningPrivateKey,
      );
      try {
        leases.set(leaseId, lease);
        if (normalizedScope.kind === "session") {
          sessions.set(normalizedScope.sessionKey, {
            leaseId,
            boundEpoch: 1,
            children: new Set(),
          });
        } else {
          agents.set(normalizedScope.agentId, leaseId);
        }
        return { activation, status: status() };
      } catch (error) {
        removeLease(leaseId);
        throw error;
      }
    },

    renew(leaseId: string, ttlMs = DEFAULT_TTL_MS): NativeGuardLeaseActivation {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease || lease.phase !== "active") throw new Error("Native guard lease is not active");

      const validTtlMs = validateTtl(ttlMs);
      const issuedAtMs = currentTimeMs();
      const { credential, credentialHash } = createCredential();
      const {
        credential: evidenceCredential,
        credentialHash: evidenceCredentialHash,
      } = createCredential();
      const evidenceSigning = createEvidenceSigningIdentity();
      lease.leaseEpoch += 1;
      lease.credentialHash = credentialHash;
      lease.evidenceCredentialHash = evidenceCredentialHash;
      lease.evidencePublicKey = evidenceSigning.evidencePublicKey;
      lease.evidenceSigningKeyId = evidenceSigning.evidenceSigningKeyId;
      lease.evidenceProofs.clear();
      lease.completedEvidenceAcknowledgements.clear();
      lease.issuedAtMs = issuedAtMs;
      lease.expiresAtMs = clampExpiry(
        issuedAtMs,
        validTtlMs,
        lease.policyExpiresAtMs,
      );
      return activationFor(
        lease,
        credential,
        evidenceCredential,
        evidenceSigning.evidenceSigningPrivateKey,
      );
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
      if (!lease || lease.phase !== "active") return undefined;

      const candidateHash = hashCredential(credential);
      return timingSafeEqual(candidateHash, lease.credentialHash)
        ? activeLeaseFor(lease)
        : undefined;
    },

    authenticateEvidence(
      leaseId: string,
      credential: string,
    ): EvidenceNativeGuardLease | undefined {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (!lease || typeof credential !== "string") return undefined;
      const candidateHash = hashCredential(credential);
      return timingSafeEqual(candidateHash, lease.evidenceCredentialHash)
        ? evidenceLeaseFor(lease)
        : undefined;
    },

    verifyEvidenceRequest,
    releaseEvidenceRequest,

    signEvidenceAcknowledgement(
      leaseId: string,
      acknowledgement: UnsignedEvidenceAcknowledgement,
    ): NativeGuardEvidenceAcknowledgement {
      cleanExpired();
      const lease = leases.get(leaseId);
      if (
        lease === undefined ||
        acknowledgement.leaseId !== lease.leaseId ||
        acknowledgement.leaseEpoch !== lease.leaseEpoch ||
        acknowledgement.schemaVersion !== "native-guard-1" ||
        acknowledgement.signatureContext !== "native_guard.evidence_ack.v1"
      ) throw new Error("Native guard evidence acknowledgement does not match the lease");
      const signed = {
        ...acknowledgement,
        signature: signNativeGuardPayload(acknowledgement, lease.privateKey),
      } as NativeGuardEvidenceAcknowledgement;
      const rememberedProof = lease.evidenceProofs.get(acknowledgement.proofId);
      const lifecyclePath = acknowledgement.ackType === "child_bound"
        ? "/api/v1/openclaw/native-guard/lifecycle/bind-child"
        : acknowledgement.ackType === "session_ended"
          ? "/api/v1/openclaw/native-guard/lifecycle/end-session"
          : undefined;
      if (
        lifecyclePath !== undefined &&
        rememberedProof !== undefined &&
        rememberedProof.path === lifecyclePath &&
        rememberedProof.bodyDigest === acknowledgement.bodyDigest
      ) {
        rememberedProof.state = "committed";
        lease.completedEvidenceAcknowledgements.set(acknowledgement.proofId, {
          path: rememberedProof.path,
          bodyDigest: rememberedProof.bodyDigest,
          proofDigest: rememberedProof.proofDigest,
          acknowledgement: structuredClone(signed),
          allowBearerless: lease.phase === "root_ended" &&
            acknowledgement.ackType === "session_ended",
        });
      } else if (
        rememberedProof !== undefined &&
        rememberedProof.bodyDigest === acknowledgement.bodyDigest
      ) {
        rememberedProof.state = "committed";
      }
      return signed;
    },

    recoverEvidenceAcknowledgement(
      proof: NativeGuardEvidenceProof,
      path: string,
      bodyDigest: string,
      credential?: string,
    ): NativeGuardEvidenceAcknowledgement | undefined {
      cleanExpired();
      const lease = leases.get(proof?.leaseId);
      if (
        lease === undefined ||
        !isEvidenceProof(proof) ||
        ![
          "/api/v1/openclaw/native-guard/lifecycle/bind-child",
          "/api/v1/openclaw/native-guard/lifecycle/end-session",
        ].includes(path) ||
        proof.path !== path ||
        proof.leaseEpoch !== lease.leaseEpoch ||
        proof.keyId !== lease.evidenceSigningKeyId ||
        proof.bodyDigest !== bodyDigest
      ) return undefined;
      const cached = lease.completedEvidenceAcknowledgements.get(proof.proofId);
      if (
        cached === undefined ||
        cached.path !== path ||
        cached.bodyDigest !== bodyDigest ||
        cached.proofDigest !== digestJson(proof)
      ) return undefined;
      if (
        !cached.allowBearerless &&
        (lease.phase !== "active" ||
          credential === undefined ||
          serviceForEvidence(lease.leaseId, credential) === undefined)
      ) return undefined;
      const { signature, ...unsigned } = proof;
      if (!verifyNativeGuardPayload(unsigned, signature, lease.evidencePublicKey)) return undefined;
      return structuredClone(cached.acknowledgement);
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
      if (lease.normalizedScope.kind === "agent") {
        const exact = sessions.get(sessionKey);
        if (exact !== undefined && exact.leaseId !== leaseId) return false;
        return matchesAgentScope(lease, sessionKey);
      }
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
      if (binding) {
        const lease = leases.get(binding.leaseId);
        return lease?.phase === "active" ? activeLeaseFor(lease) : undefined;
      }
      const parsed = parseCanonicalOpenClawSessionKey(sessionKey);
      if (!parsed) return undefined;
      const leaseId = agents.get(parsed.agentId);
      if (!leaseId) return undefined;
      const lease = leases.get(leaseId);
      return lease?.phase === "active" ? activeLeaseFor(lease) : undefined;
    },

    bindChild(
      leaseId: string,
      parentSessionKey: string,
      childSessionKey: string,
    ): boolean {
      cleanExpired();
      const lease = leases.get(leaseId);
      return lease === undefined || lease.phase !== "active"
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
        lease.phase !== "active" ||
        input.leaseEpoch !== lease.leaseEpoch ||
        !validSessionKey(input.parentSessionKey) ||
        !validSessionKey(input.childSessionKey)
      ) return false;
      if (lease.normalizedScope.kind === "agent") {
        return input.parentSessionKey !== input.childSessionKey &&
          matchesAgentScope(lease, input.parentSessionKey) &&
          matchesAgentScope(lease, input.childSessionKey);
      }
      return bindChildAtEpoch(lease, input.parentSessionKey, input.childSessionKey);
    },

    endSession(sessionKey: string): void {
      cleanExpired();
      const binding = sessions.get(sessionKey);
      if (!binding) return;
      const lease = leases.get(binding.leaseId);
      if (lease?.rootSessionKey === sessionKey) {
        archiveAndRemoveSessionTree(
          sessionKey,
          binding.leaseId,
          lease.leaseEpoch,
          sessions,
          historicalSessions,
        );
        lease.phase = "root_ended";
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
      if (lease.normalizedScope.kind === "agent") {
        return lease.phase === "active" && matchesAgentScope(lease, input.sessionKey);
      }
      if (lease.phase === "root_ended") {
        return input.sessionKey === lease.rootSessionKey &&
          historicalSessions.get(input.sessionKey)?.some((historical) =>
            historical.leaseId === input.leaseId &&
            historical.endedEpoch === input.leaseEpoch) === true;
      }
      const binding = sessions.get(input.sessionKey);
      if (binding === undefined) {
        return historicalSessions.get(input.sessionKey)?.some((historical) =>
          historical.leaseId === input.leaseId) === true;
      }
      if (binding.leaseId !== input.leaseId) return false;
      if (lease.rootSessionKey === input.sessionKey) {
        archiveAndRemoveSessionTree(
          input.sessionKey,
          input.leaseId,
          lease.leaseEpoch,
          sessions,
          historicalSessions,
        );
        lease.phase = "root_ended";
        return true;
      }
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
      if (!lease || lease.phase !== "active") {
        throw new Error("Native guard lease is not active");
      }
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

function isEvidenceProof(value: unknown): value is NativeGuardEvidenceProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  if (Object.keys(proof).sort().join(",") !== [
    "bodyDigest",
    "issuedAt",
    "keyId",
    "leaseEpoch",
    "leaseId",
    "method",
    "path",
    "proofId",
    "schemaVersion",
    "signature",
    "signatureContext",
  ].join(",")) return false;
  return proof.schemaVersion === "native-guard-1" &&
    proof.signatureContext === "native_guard.evidence_request.v1" &&
    typeof proof.proofId === "string" && SAFE_PROOF_ID.test(proof.proofId) &&
    typeof proof.leaseId === "string" && proof.leaseId.length > 0 && proof.leaseId.length <= 128 &&
    Number.isSafeInteger(proof.leaseEpoch) && (proof.leaseEpoch as number) > 0 &&
    proof.method === "POST" &&
    typeof proof.path === "string" && EVIDENCE_PATHS.has(proof.path) &&
    typeof proof.bodyDigest === "string" && DIGEST.test(proof.bodyDigest) &&
    typeof proof.issuedAt === "string" && isCanonicalTimestamp(proof.issuedAt) &&
    typeof proof.keyId === "string" && SAFE_PROOF_ID.test(proof.keyId) &&
    typeof proof.signature === "string" && proof.signature.length > 0 && proof.signature.length <= 128;
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
