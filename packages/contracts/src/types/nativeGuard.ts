export type NativeGuardMode = "detection" | "supervision";

export type NativeGuardLeaseScope =
  | "session_tree"
  | { kind: "session"; sessionKey: string }
  | { kind: "agent"; agentId: "main" };

export type NativeGuardCoverageStatus =
  | "off"
  | "ready"
  | "active"
  | "recovery"
  | "conditional"
  | "unsupported"
  | "misconfigured";

export type NativeGuardAction = "allow" | "warn" | "deny" | "ask" | "redact";

export type NativeGuardLeaseActivation = {
  schemaVersion: "native-guard-1";
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  mode: NativeGuardMode;
  scope: NativeGuardLeaseScope;
  policyPackId: string;
  policyPackDigest: string;
  backendUrl: string;
  decisionPublicKey: string;
  failurePolicy: {
    lowRisk: "allow" | "warn";
    highRisk: "deny";
    unknownRisk: "deny";
  };
  issuedAt: string;
  expiresAt: string;
  credential: string;
  evidenceCredential: string;
  evidenceSigningKeyId: string;
  evidenceSigningPrivateKey: string;
};

export type NativeGuardEvidenceProof = {
  schemaVersion: "native-guard-1";
  signatureContext: "native_guard.evidence_request.v1";
  proofId: string;
  leaseId: string;
  leaseEpoch: number;
  method: "POST";
  path: string;
  bodyDigest: string;
  issuedAt: string;
  keyId: string;
  signature: string;
};

export type NativeGuardLifecycleAcknowledgement = {
  schemaVersion: "native-guard-1";
  signatureContext: "native_guard.evidence_ack.v1";
  ackId: string;
  ackType: "child_bound" | "session_ended";
  proofId: string;
  leaseId: string;
  leaseEpoch: number;
  bodyDigest: string;
  acknowledgedAt: string;
  signature: string;
};

export type NativeGuardEventAcknowledgement = {
  schemaVersion: "native-guard-1";
  signatureContext: "native_guard.evidence_ack.v1";
  ackId: string;
  ackType: "events_accepted";
  proofId: string;
  leaseId: string;
  leaseEpoch: number;
  bodyDigest: string;
  accepted: number;
  eventIdsDigest: string;
  acknowledgedAt: string;
  signature: string;
};

export type NativeGuardEvidenceAcknowledgement =
  | NativeGuardLifecycleAcknowledgement
  | NativeGuardEventAcknowledgement;

export type NativeToolDecisionRequest = {
  schemaVersion: "native-guard-1";
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  toolKind?: string;
  toolInputKind?: string;
  providerId?: string;
  params: Record<string, unknown>;
  paramsDigest: string;
  derivedPaths?: string[];
  requestedAt: string;
};

export type NativeToolDecisionResponse = {
  schemaVersion: "native-guard-1";
  decisionId: string;
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  policyPackId: string;
  policyPackDigest: string;
  action: NativeGuardAction;
  reasonCode: string;
  reason: string;
  evaluatedParamsDigest: string;
  rewrittenParams?: Record<string, unknown>;
  rewrittenParamsDigest?: string;
  decidedAt: string;
  signature: string;
};

export type NativeGuardEvent = {
  schemaVersion: "native-guard-1";
  eventId: string;
  type:
    | "lease_activated"
    | "lease_renewed"
    | "lease_recovery"
    | "lease_revoked"
    | "decision"
    | "approval_requested"
    | "approval_resolved"
    | "tool_outcome"
    | "sandbox_attested"
    | "coverage_changed";
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
  runId?: string;
  toolCallId?: string;
  decisionId?: string;
  timestamp: string;
  detail: Record<string, unknown>;
};

export type NativeGuardDurationSource =
  | "host"
  | "guard_elapsed"
  | "legacy_unspecified"
  | "unavailable";

export type NativeGuardLeaseSummary = {
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  scope: NativeGuardLeaseScope;
  gatewayInstanceId?: string;
  mode: NativeGuardMode;
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
};

type LegacyNativeGuardLeaseSummary = Omit<NativeGuardLeaseSummary, "scope"> & {
  scope?: undefined;
};

type NativeGuardStatusBase = {
  coverage: NativeGuardCoverageStatus;
  finalizerAssurance: "isolated_profile" | "exclusive_before_hook" | "unverified";
  pluginVersion?: string;
  openclawVersion?: string;
  gatewayInstanceId?: string;
  activeLeaseCount: number;
  conflictingPluginIds?: string[];
  reasonCode?: string;
  detail?: string;
};

export type NativeGuardStatus = NativeGuardStatusBase & (
  | {
      activeLeases: NativeGuardLeaseSummary[];
      activeLease?: NativeGuardLeaseSummary;
    }
  | {
      activeLeases?: undefined;
      activeLease?: NativeGuardLeaseSummary | LegacyNativeGuardLeaseSummary;
    }
);

export type OpenClawSandboxEvidence = {
  schemaVersion: "native-guard-1";
  runGroupId: string;
  sessionKey?: string;
  status: "preflight_passed" | "attested" | "failed" | "cleaned";
  openclawVersion: string;
  imageId: string;
  containerId?: string;
  networkMode: string;
  readOnlyRoot: boolean;
  workspaceAccess: "none" | "ro" | "rw";
  capDrop: string[];
  pidsLimit: number;
  memory: string | number;
  cpus: number;
  configDigest: string;
  checkedAt: string;
  failureReason?: string;
};
