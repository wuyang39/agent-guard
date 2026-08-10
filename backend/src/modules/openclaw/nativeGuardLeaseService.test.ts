import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { describe, test } from "node:test";
import type {
  NativeGuardEvidenceProof,
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeToolDecisionResponse,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";

const ROOT_SESSION_KEY = "agent:guard:run.1";
const CHILD_SESSION_KEY = "agent:guard:run.1:child.1";
const BACKEND_URL = "http://127.0.0.1:3100";

test("manages a session-tree lease through authentication, renewal, and expiry", () => {
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => nowMs });
  const policyPack = buildPolicyPack();
  const policyPackDigest = digestJson(policyPack);

  const created = service.create({
    rootSessionKey: ROOT_SESSION_KEY,
    mode: "supervision",
    policyPack,
    policyPackDigest,
    backendUrl: BACKEND_URL,
    ttlMs: 300_000,
  });

  assert.equal(created.activation.schemaVersion, "native-guard-1");
  assert.equal(created.activation.leaseEpoch, 1);
  assert.equal(created.activation.rootSessionKey, ROOT_SESSION_KEY);
  assert.equal(created.activation.scope, "session_tree");
  assert.equal(created.activation.policyPackId, policyPack.policyPackId);
  assert.equal(created.activation.policyPackDigest, policyPackDigest);
  assert.equal(created.activation.backendUrl, BACKEND_URL);
  assert.equal(created.activation.issuedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(created.activation.expiresAt, "2026-08-01T00:05:00.000Z");
  assert.match(created.activation.credential, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.activation.decisionPublicKey, /BEGIN PUBLIC KEY/);
  assert.match(created.activation.evidenceSigningKeyId, /^[A-Za-z0-9][A-Za-z0-9._-]+$/);
  assert.match(created.activation.evidenceSigningPrivateKey, /BEGIN PRIVATE KEY/);
  assert.equal(
    createPrivateKey(created.activation.evidenceSigningPrivateKey).asymmetricKeyType,
    "ed25519",
  );
  assert.deepEqual(created.activation.failurePolicy, {
    lowRisk: "warn",
    highRisk: "deny",
    unknownRisk: "deny",
  });
  assert.deepEqual(created.status, {
    coverage: "conditional",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLease: {
      leaseId: created.activation.leaseId,
      leaseEpoch: created.activation.leaseEpoch,
      rootSessionKey: ROOT_SESSION_KEY,
      scope: "session_tree",
      mode: "supervision",
      policyPackId: policyPack.policyPackId,
      policyPackDigest,
      expiresAt: "2026-08-01T00:05:00.000Z",
    },
    activeLeases: [{
      leaseId: created.activation.leaseId,
      leaseEpoch: created.activation.leaseEpoch,
      rootSessionKey: ROOT_SESSION_KEY,
      scope: "session_tree",
      mode: "supervision",
      policyPackId: policyPack.policyPackId,
      policyPackDigest,
      expiresAt: "2026-08-01T00:05:00.000Z",
    }],
    reasonCode: "NATIVE_GUARD_FINALIZER_UNVERIFIED",
  });

  const active = service.authenticate(
    created.activation.leaseId,
    created.activation.credential,
  );
  assert.equal(active?.state, "active");
  assert.equal(active?.leaseEpoch, 1);
  assert.notEqual(active?.policyPack, policyPack);
  assert.deepEqual(active?.policyPack, policyPack);
  assert.equal(Object.isFrozen(active?.policyPack), true);
  assert.equal(Object.isFrozen(active?.policyPack.policies[0]), true);
  policyPack.policies[0].name = "mutated by caller";
  created.activation.failurePolicy.lowRisk = "allow";
  assert.equal(service.bindChild(created.activation.leaseId, "unbound", CHILD_SESSION_KEY), false);
  assert.equal(
    service.bindChild(created.activation.leaseId, ROOT_SESSION_KEY, CHILD_SESSION_KEY),
    true,
  );
  assert.equal(service.resolveBySession(CHILD_SESSION_KEY)?.leaseId, created.activation.leaseId);
  assert.equal(service.resolveBySession(CHILD_SESSION_KEY)?.state, "active");

  nowMs += 60_000;
  const renewed = service.renew(created.activation.leaseId, 300_000);
  assert.equal(renewed.leaseEpoch, 2);
  assert.notEqual(renewed.credential, created.activation.credential);
  assert.equal(renewed.failurePolicy.lowRisk, "warn");
  assert.equal(service.authenticate(renewed.leaseId, renewed.credential)?.policyPack.policies[0].name,
    "Deny dangerous shell calls",
  );
  assert.equal(
    service.authenticate(created.activation.leaseId, created.activation.credential),
    undefined,
  );
  assert.equal(service.authenticate(renewed.leaseId, renewed.credential)?.leaseEpoch, 2);

  nowMs += 300_000;
  assert.equal(service.resolveBySession(ROOT_SESSION_KEY), undefined);
  assert.equal(service.resolveBySession(CHILD_SESSION_KEY), undefined);
  assert.deepEqual(service.status(), {
    coverage: "ready",
    finalizerAssurance: "unverified",
    activeLeaseCount: 0,
    activeLeases: [],
  });
});

describe("main agent lease scope", () => {
  test("resolves current and future canonical main sessions while excluding other identities", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const main = createAgentLease(service);

    assert.deepEqual(main.scope, { kind: "agent", agentId: "main" });
    for (const sessionKey of [
      "agent:main:dashboard:existing",
      "agent:main:cli:future",
      "agent:main:subagent:child",
    ]) {
      const active = service.resolveBySession(sessionKey);
      assert.equal(active?.leaseId, main.leaseId);
      assert.deepEqual(active?.scope, { kind: "agent", agentId: "main" });
    }
    for (const sessionKey of [
      "agent:worker:dashboard:existing",
      "agent:main",
      "agent:main:dashboard:bad..tail",
      "session.main.dashboard",
    ]) {
      assert.equal(service.resolveBySession(sessionKey), undefined, sessionKey);
    }
  });

  test("allows exact main sessions to coexist and take lookup precedence", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const main = createAgentLease(service);
    const exact = createLease(service, "agent:main:dashboard:exact");

    assert.equal(
      service.resolveBySession("agent:main:dashboard:exact")?.leaseId,
      exact.leaseId,
    );
    assert.equal(
      service.resolveBySession("agent:main:dashboard:other")?.leaseId,
      main.leaseId,
    );
  });

  test("rejects a duplicate main agent lease without conflicting with session leases", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    createLease(service, "agent:main:main");
    createAgentLease(service);

    assert.throws(() => createAgentLease(service), /already bound/i);
  });

  test("keeps the agent lease active across session lifecycle acknowledgements", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const main = createAgentLease(service);
    const binding = {
      leaseId: main.leaseId,
      leaseEpoch: main.leaseEpoch,
      parentSessionKey: "agent:main:dashboard:parent",
      childSessionKey: "agent:main:subagent:child",
    };

    assert.equal(service.bindChildWithEvidence(binding, main.evidenceCredential), true);
    assert.equal(service.bindChildWithEvidence({
      ...binding,
      childSessionKey: "agent:worker:subagent:child",
    }, main.evidenceCredential), false);
    assert.equal(service.bindChildWithEvidence({
      ...binding,
      parentSessionKey: "agent:main",
    }, main.evidenceCredential), false);

    assert.doesNotThrow(() => createLease(service, binding.childSessionKey));
    service.endSession("agent:main:dashboard:parent");
    assert.equal(service.endSessionWithEvidence({
      leaseId: main.leaseId,
      leaseEpoch: main.leaseEpoch,
      sessionKey: "agent:main:cli:current",
    }, main.evidenceCredential), true);
    assert.equal(service.endSessionWithEvidence({
      leaseId: main.leaseId,
      leaseEpoch: main.leaseEpoch,
      sessionKey: "agent:worker:cli:current",
    }, main.evidenceCredential), false);
    assert.equal(service.authenticate(main.leaseId, main.credential)?.state, "active");
    assert.equal(
      service.resolveBySession("agent:main:dashboard:future")?.leaseId,
      main.leaseId,
    );
  });

  test("preserves agent scope on renewal and cleans its index on revoke and expiry", () => {
    let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const service = createNativeGuardLeaseService({ now: () => nowMs });
    const first = createAgentLease(service, 1_000);
    const renewed = service.renew(first.leaseId, 1_000);

    assert.deepEqual(renewed.scope, { kind: "agent", agentId: "main" });
    assert.deepEqual(
      service.authenticate(renewed.leaseId, renewed.credential)?.scope,
      { kind: "agent", agentId: "main" },
    );
    assert.equal(service.revoke(renewed.leaseId), true);
    const afterRevoke = createAgentLease(service, 1_000);

    nowMs += 1_000;
    assert.equal(service.resolveBySession("agent:main:dashboard:expired"), undefined);
    const afterExpiry = createAgentLease(service);
    assert.notEqual(afterExpiry.leaseId, afterRevoke.leaseId);
  });

  test("reports every active scope and only exposes the singular compatibility field", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const main = createAgentLease(service);
    const exact = createLease(service, "agent:main:dashboard:detection");
    const status = service.status();

    assert.equal(status.activeLeaseCount, 2);
    assert.equal(status.activeLease, undefined);
    assert.deepEqual(status.activeLeases?.map((lease) => ({
      leaseId: lease.leaseId,
      scope: lease.scope,
    })), [
      { leaseId: main.leaseId, scope: { kind: "agent", agentId: "main" } },
      { leaseId: exact.leaseId, scope: "session_tree" },
    ]);
  });

  test("authorizes agent evidence by scope without falling back from stale exact callers", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const main = createAgentLease(service);
    const exactSessionKey = "agent:main:dashboard:exact-evidence";
    const exact = createLease(service, exactSessionKey);

    assert.equal(service.authorizeEvidence(
      main.leaseId,
      main.leaseEpoch,
      "agent:main:cli:future-evidence",
      main.evidenceCredential,
    ), true);
    assert.equal(service.authorizeEvidence(
      main.leaseId,
      main.leaseEpoch,
      "agent:worker:cli:future-evidence",
      main.evidenceCredential,
    ), false);
    assert.equal(service.authorizeEvidence(
      exact.leaseId,
      exact.leaseEpoch,
      exactSessionKey,
      main.evidenceCredential,
    ), false);
    assert.equal(service.authorizeEvidence(
      exact.leaseId,
      exact.leaseEpoch + 1,
      exactSessionKey,
      exact.evidenceCredential,
    ), false);

    assert.equal(service.revoke(exact.leaseId), true);
    assert.equal(service.resolveBySession(exactSessionKey)?.leaseId, main.leaseId);
    assert.equal(service.authorizeEvidence(
      exact.leaseId,
      exact.leaseEpoch,
      exactSessionKey,
      exact.evidenceCredential,
    ), false);
    assert.equal(service.authorizeEvidence(
      main.leaseId,
      main.leaseEpoch,
      exactSessionKey,
      main.evidenceCredential,
    ), true);
  });
});

test("revocation invalidates authentication", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => now });
  const policyPack = buildPolicyPack();
  const created = service.create({
    rootSessionKey: ROOT_SESSION_KEY,
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: BACKEND_URL,
  });

  assert.equal(
    service.authenticate(created.activation.leaseId, created.activation.credential)?.state,
    "active",
  );
  assert.equal(service.revoke(created.activation.leaseId), true);
  assert.equal(
    service.authenticate(created.activation.leaseId, created.activation.credential),
    undefined,
  );
  assert.equal(service.resolveBySession(ROOT_SESSION_KEY), undefined);
  assert.equal(service.revoke(created.activation.leaseId), false);
});

test("evidence identity is separate and exclusively authorizes exact lifecycle binding", () => {
  const service = createNativeGuardLeaseService({
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const activation = createLease(service, ROOT_SESSION_KEY);

  assert.match(activation.evidenceCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(activation.evidenceCredential, activation.credential);
  assert.equal(
    service.authenticateEvidence(activation.leaseId, activation.evidenceCredential)?.leaseEpoch,
    1,
  );
  assert.equal(
    service.authenticateEvidence(activation.leaseId, activation.credential),
    undefined,
  );
  const binding = {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  };
  assert.equal(service.bindChildWithEvidence(binding, activation.credential), false);
  assert.equal(service.bindChildWithEvidence({ ...binding, leaseEpoch: 2 }, activation.evidenceCredential), false);
  assert.equal(service.bindChildWithEvidence({ ...binding, parentSessionKey: "missing" }, activation.evidenceCredential), false);
  assert.equal(service.bindChildWithEvidence(binding, activation.evidenceCredential), true);
  assert.equal(service.resolveBySession(CHILD_SESSION_KEY)?.leaseId, activation.leaseId);
});

test("evidence proof binds request identity and produces a decision-key signed acknowledgement", () => {
  const service = createNativeGuardLeaseService({
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const activation = createLease(service, ROOT_SESSION_KEY);
  const path = "/api/v1/openclaw/native-guard/lifecycle/bind-child";
  const payload = {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  };
  const proof = evidenceProof(activation, path, payload, "proof.valid");

  const verified = service.verifyEvidenceRequest(
    activation.leaseId,
    activation.evidenceCredential,
    proof,
    path,
    digestJson(payload),
  );
  assert.deepEqual(verified, {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    proofId: proof.proofId,
    bodyDigest: proof.bodyDigest,
    path,
    proofDigest: digestJson(proof),
  });
  assert.equal(service.releaseEvidenceRequest(verified!), true);
  assert.notEqual(service.verifyEvidenceRequest(
    activation.leaseId,
    activation.evidenceCredential,
    proof,
    path,
    digestJson(payload),
  ), undefined);

  const unsignedAck = {
    schemaVersion: "native-guard-1" as const,
    signatureContext: "native_guard.evidence_ack.v1" as const,
    ackId: "ack.valid",
    ackType: "child_bound" as const,
    proofId: proof.proofId,
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    bodyDigest: proof.bodyDigest,
    acknowledgedAt: "2026-08-01T00:00:00.000Z",
  };
  const ack = service.signEvidenceAcknowledgement(activation.leaseId, unsignedAck);
  const { signature, ...signedPayload } = ack;
  assert.equal(verifyNativeGuardPayload(
    signedPayload,
    signature,
    createPublicKey(activation.decisionPublicKey),
  ), true);

  assert.equal(service.verifyEvidenceRequest(
    activation.leaseId,
    activation.evidenceCredential,
    proof,
    path,
    digestJson(payload),
  ), undefined);
});

test("evidence proof rejects tampering, stale time, replay, and rotated identities", () => {
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => nowMs });
  const first = createLease(service, ROOT_SESSION_KEY);
  const path = "/api/v1/openclaw/native-guard/events/batch";
  const payload = { events: [{ eventId: "event.old-epoch", leaseEpoch: 1 }] };
  const base = evidenceProof(first, path, payload, "proof.base");
  const mutations: Array<Partial<NativeGuardEvidenceProof>> = [
    { method: "GET" as "POST" },
    { path: "/api/v1/openclaw/native-guard/lifecycle/end-session" },
    { bodyDigest: "f".repeat(64) },
    { leaseEpoch: first.leaseEpoch + 1 },
    { keyId: `${first.evidenceSigningKeyId}.wrong` },
    { issuedAt: "2026-07-31T23:58:00.000Z" },
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.equal(service.verifyEvidenceRequest(
      first.leaseId,
      first.evidenceCredential,
      evidenceProof(first, path, payload, `proof.tampered.${String(index)}`, mutation),
      path,
      digestJson(payload),
    ), undefined);
  }

  const valid = evidenceProof(first, path, payload, "proof.before-renew");
  assert.notEqual(service.verifyEvidenceRequest(
    first.leaseId,
    first.evidenceCredential,
    valid,
    path,
    digestJson(payload),
  ), undefined);
  assert.equal(service.verifyEvidenceRequest(
    first.leaseId,
    first.evidenceCredential,
    valid,
    path,
    digestJson(payload),
  ), undefined);

  nowMs += 1_000;
  const renewed = service.renew(first.leaseId);
  const oldKeyFreshProof = evidenceProof(first, path, payload, "proof.old-key-after-renew", {
    leaseEpoch: renewed.leaseEpoch,
    issuedAt: renewed.issuedAt,
    keyId: renewed.evidenceSigningKeyId,
  });
  assert.equal(service.verifyEvidenceRequest(
    renewed.leaseId,
    renewed.evidenceCredential,
    oldKeyFreshProof,
    path,
    digestJson(payload),
  ), undefined);
  assert.equal(service.verifyEvidenceRequest(
    renewed.leaseId,
    first.evidenceCredential,
    evidenceProof(renewed, path, payload, "proof.old-bearer"),
    path,
    digestJson(payload),
  ), undefined);
  assert.notEqual(service.verifyEvidenceRequest(
    renewed.leaseId,
    renewed.evidenceCredential,
    evidenceProof(renewed, path, payload, "proof.current"),
    path,
    digestJson(payload),
  ), undefined);
});

test("a durable lifecycle proof remains valid within its lease while event proof freshness stays bounded", () => {
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => nowMs });
  const activation = createLease(service, ROOT_SESSION_KEY);
  const bindingPath = "/api/v1/openclaw/native-guard/lifecycle/bind-child";
  const binding = {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  };
  const eventPath = "/api/v1/openclaw/native-guard/events/batch";
  const batch = { events: [{ eventId: "event.stale-proof", leaseEpoch: activation.leaseEpoch }] };
  nowMs += 2 * 60_000;

  assert.notEqual(service.verifyEvidenceRequest(
    activation.leaseId,
    activation.evidenceCredential,
    evidenceProof(activation, bindingPath, binding, "proof.lifecycle-delayed"),
    bindingPath,
    digestJson(binding),
  ), undefined);
  assert.equal(service.verifyEvidenceRequest(
    activation.leaseId,
    activation.evidenceCredential,
    evidenceProof(activation, eventPath, batch, "proof.event-delayed"),
    eventPath,
    digestJson(batch),
  ), undefined);
});

test("ended child remains evidence-authorized for its original epoch but not for decisions", () => {
  const service = createNativeGuardLeaseService({
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const activation = createLease(service, ROOT_SESSION_KEY);
  assert.equal(service.bindChildWithEvidence({
    leaseId: activation.leaseId,
    leaseEpoch: 1,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  }, activation.evidenceCredential), true);

  assert.equal(service.endSessionWithEvidence({
    leaseId: activation.leaseId,
    leaseEpoch: 1,
    sessionKey: CHILD_SESSION_KEY,
  }, activation.evidenceCredential), true);

  assert.equal(service.resolveBySession(CHILD_SESSION_KEY), undefined);
  assert.equal(service.authorizeEvidence(
    activation.leaseId,
    1,
    CHILD_SESSION_KEY,
    activation.evidenceCredential,
  ), true);
  assert.equal(service.authorizeEvidence(
    activation.leaseId,
    2,
    CHILD_SESSION_KEY,
    activation.evidenceCredential,
  ), false);
  assert.equal(service.authorizeEvidence(
    activation.leaseId,
    1,
    "agent:guard:never-bound",
    activation.evidenceCredential,
  ), false);
});

test("renewal rotates both identities and current evidence identity uploads old-epoch history", () => {
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => nowMs });
  const first = createLease(service, ROOT_SESSION_KEY);
  assert.equal(service.bindChildWithEvidence({
    leaseId: first.leaseId,
    leaseEpoch: 1,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  }, first.evidenceCredential), true);
  assert.equal(service.endSessionWithEvidence({
    leaseId: first.leaseId,
    leaseEpoch: 1,
    sessionKey: CHILD_SESSION_KEY,
  }, first.evidenceCredential), true);

  nowMs += 1_000;
  const renewed = service.renew(first.leaseId);
  assert.notEqual(renewed.credential, first.credential);
  assert.notEqual(renewed.evidenceCredential, first.evidenceCredential);
  assert.equal(service.authenticate(first.leaseId, first.credential), undefined);
  assert.equal(service.authenticateEvidence(first.leaseId, first.evidenceCredential), undefined);
  assert.equal(service.authenticate(first.leaseId, renewed.credential)?.leaseEpoch, 2);
  assert.equal(service.authenticateEvidence(first.leaseId, renewed.evidenceCredential)?.leaseEpoch, 2);
  assert.equal(service.authorizeEvidence(
    first.leaseId,
    1,
    CHILD_SESSION_KEY,
    first.evidenceCredential,
  ), false);
  assert.equal(service.authorizeEvidence(
    first.leaseId,
    1,
    CHILD_SESSION_KEY,
    renewed.evidenceCredential,
  ), true);
  assert.equal(service.authorizeEvidence(
    first.leaseId,
    3,
    CHILD_SESSION_KEY,
    renewed.evidenceCredential,
  ), false);
});

test("ending the root retains evidence authorization in a non-renewable tombstone", () => {
  const service = createNativeGuardLeaseService({
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const activation = createLease(service, ROOT_SESSION_KEY);
  assert.equal(service.bindChildWithEvidence({
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    parentSessionKey: ROOT_SESSION_KEY,
    childSessionKey: CHILD_SESSION_KEY,
  }, activation.evidenceCredential), true);

  assert.equal(service.endSessionWithEvidence({
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    sessionKey: ROOT_SESSION_KEY,
  }, activation.evidenceCredential), true);

  assert.equal(service.authenticate(activation.leaseId, activation.credential), undefined);
  assert.notEqual(
    service.authenticateEvidence(activation.leaseId, activation.evidenceCredential),
    undefined,
  );
  assert.equal(service.authorizeEvidence(
    activation.leaseId,
    activation.leaseEpoch,
    ROOT_SESSION_KEY,
    activation.evidenceCredential,
  ), true);
  assert.equal(service.authorizeEvidence(
    activation.leaseId,
    activation.leaseEpoch,
    CHILD_SESSION_KEY,
    activation.evidenceCredential,
  ), true);
  assert.equal(service.endSessionWithEvidence({
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    sessionKey: ROOT_SESSION_KEY,
  }, activation.evidenceCredential), true);
  assert.throws(() => service.renew(activation.leaseId), /not active/i);
  assert.equal(service.revoke(activation.leaseId), true);
  assert.equal(
    service.authenticateEvidence(activation.leaseId, activation.evidenceCredential),
    undefined,
  );
});

describe("security and recovery boundaries", () => {
  test("rejects wrong credentials, unknown sessions, and unproven child relationships", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const service = createNativeGuardLeaseService({ now: () => now });
    const first = createLease(service, "agent:guard:first");
    const second = createLease(service, "agent:guard:second");

    assert.equal(service.authenticate(first.leaseId, "wrong-credential"), undefined);
    assert.equal(service.resolveBySession("agent:guard:unknown"), undefined);
    assert.equal(
      service.bindChild(first.leaseId, second.rootSessionKey, "agent:guard:child"),
      false,
    );
    assert.equal(
      service.bindChild(second.leaseId, second.rootSessionKey, "agent:guard:child"),
      true,
    );
    assert.equal(service.resolveBySession("agent:guard:child")?.state, "active");
    assert.equal(
      service.bindChild(first.leaseId, first.rootSessionKey, "agent:guard:child"),
      false,
    );
    assert.equal(
      service.bindChild(first.leaseId, "agent:guard:missing", "agent:guard:new-child"),
      false,
    );
    assert.throws(() => createLease(service, first.rootSessionKey));
  });

  test("rejects invalid lease TTL values without rotating a valid lease", () => {
    const invalidTtls = [0, -1, 900_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const ttlMs of invalidTtls) {
      const service = createNativeGuardLeaseService({
        now: () => new Date("2026-08-01T00:00:00.000Z"),
      });
      assert.throws(() => createLease(service, `agent:guard:ttl:${String(ttlMs)}`, ttlMs));
    }

    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const activation = createLease(service, "agent:guard:max-ttl", 900_000);
    assert.equal(activation.expiresAt, "2026-08-01T00:15:00.000Z");
    assert.throws(() => service.renew(activation.leaseId, 0));
    assert.equal(
      service.authenticate(activation.leaseId, activation.credential)?.leaseEpoch,
      1,
    );
  });

  test("rejects invalid or expired policy expiry and accepts a missing expiry", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    for (const expiresAt of [
      "not-a-date",
      "",
      "August 2, 2026 00:00:00 UTC",
      "2026-08-02T08:00:00+08:00",
      "2026-08-02T00:00:00Z",
      "2026-08-01T00:00:00.000Z",
      "2026-07-31T23:59:59.999Z",
    ]) {
      const service = createNativeGuardLeaseService({ now: () => now });
      const policyPack = buildPolicyPack({ expiresAt });
      assert.throws(() =>
        service.create({
          rootSessionKey: `agent:guard:expiry:${expiresAt}`,
          mode: "supervision",
          policyPack,
          policyPackDigest: digestJson(policyPack),
          backendUrl: BACKEND_URL,
        }),
      );
    }

    const service = createNativeGuardLeaseService({ now: () => now });
    const policyPack = buildPolicyPack();
    delete policyPack.expiresAt;
    assert.equal(
      service.create({
        rootSessionKey: "agent:guard:no-policy-expiry",
        mode: "supervision",
        policyPack,
        policyPackDigest: digestJson(policyPack),
        backendUrl: BACKEND_URL,
      }).activation.expiresAt,
      "2026-08-01T00:05:00.000Z",
    );
  });

  test("clamps creation and renewal to the policy pack expiry", () => {
    let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const service = createNativeGuardLeaseService({ now: () => new Date(nowMs) });
    const policyPack = buildPolicyPack({ expiresAt: "2026-08-01T00:10:00.000Z" });
    const created = service.create({
      rootSessionKey: ROOT_SESSION_KEY,
      mode: "supervision",
      policyPack,
      policyPackDigest: digestJson(policyPack),
      backendUrl: BACKEND_URL,
      ttlMs: 900_000,
    }).activation;
    assert.equal(created.expiresAt, "2026-08-01T00:10:00.000Z");

    nowMs += 4 * 60_000;
    assert.equal(
      service.renew(created.leaseId, 900_000).expiresAt,
      "2026-08-01T00:10:00.000Z",
    );
  });

  test("rejects a digest that does not describe the policy snapshot", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const policyPack = buildPolicyPack();
    assert.throws(() =>
      service.create({
        rootSessionKey: ROOT_SESSION_KEY,
        mode: "supervision",
        policyPack,
        policyPackDigest: "0".repeat(64),
        backendUrl: BACKEND_URL,
      }),
    );
  });

  test("rejects renewal of unknown, expired, and revoked leases", () => {
    let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const service = createNativeGuardLeaseService({ now: () => new Date(nowMs) });
    assert.throws(() => service.renew("unknown"));

    const expired = createLease(service, "agent:guard:expired", 1);
    nowMs += 1;
    assert.throws(() => service.renew(expired.leaseId));

    const revoked = createLease(service, "agent:guard:revoked");
    assert.equal(service.revoke(revoked.leaseId), true);
    assert.throws(() => service.renew(revoked.leaseId));
  });

  test("rejects invalid clock values before exposing lease state", () => {
    for (const now of [
      () => Number.NaN,
      () => 8_640_000_000_000_001,
      () => 1.5,
      () => new Date(Number.NaN),
    ]) {
      const service = createNativeGuardLeaseService({ now });
      assert.throws(() => service.status(), {
        name: "RangeError",
        message: "Native guard clock returned an invalid time",
      });
    }
  });

  test("ends a child subtree and tombstones the lease when the root session ends", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const root = createLease(service, ROOT_SESSION_KEY);
    const child = `${ROOT_SESSION_KEY}:child`;
    const grandchild = `${child}:grandchild`;
    const sibling = `${ROOT_SESSION_KEY}:sibling`;
    assert.equal(service.bindChild(root.leaseId, ROOT_SESSION_KEY, child), true);
    assert.equal(service.bindChild(root.leaseId, child, grandchild), true);
    assert.equal(service.bindChild(root.leaseId, ROOT_SESSION_KEY, sibling), true);

    service.endSession(child);
    assert.equal(service.resolveBySession(child), undefined);
    assert.equal(service.resolveBySession(grandchild), undefined);
    assert.equal(service.resolveBySession(ROOT_SESSION_KEY)?.leaseId, root.leaseId);
    assert.equal(service.resolveBySession(sibling)?.leaseId, root.leaseId);

    assert.equal(service.bindChild(root.leaseId, ROOT_SESSION_KEY, child), true);
    const response = buildDecisionResponse(root);
    assert.match(service.signDecision(root.leaseId, response), /^[A-Za-z0-9_-]+$/);
    service.endSession(ROOT_SESSION_KEY);
    assert.equal(service.resolveBySession(ROOT_SESSION_KEY), undefined);
    assert.equal(service.resolveBySession(child), undefined);
    assert.equal(service.resolveBySession(sibling), undefined);
    assert.equal(service.authenticate(root.leaseId, root.credential), undefined);
    assert.throws(() => service.signDecision(root.leaseId, response));
    assert.deepEqual(service.status(), {
      coverage: "ready",
      finalizerAssurance: "unverified",
      activeLeaseCount: 0,
      activeLeases: [],
    });
    assert.notEqual(service.authenticateEvidence(root.leaseId, root.evidenceCredential), undefined);
    assert.equal(service.revoke(root.leaseId), true);
    assert.equal(service.authenticateEvidence(root.leaseId, root.evidenceCredential), undefined);
  });

  test("ends a deeply nested child subtree without recursive stack overflow", () => {
    const service = createNativeGuardLeaseService({
      now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    });
    const root = createLease(service, "agent:guard:deep-root");
    const other = createLease(service, "agent:guard:other-root");
    const depth = 20_000;
    let parentSessionKey = root.rootSessionKey;

    for (let index = 0; index < depth; index += 1) {
      const childSessionKey = `agent:guard:deep-child:${index}`;
      assert.equal(
        service.bindChild(root.leaseId, parentSessionKey, childSessionKey),
        true,
      );
      parentSessionKey = childSessionKey;
    }

    service.endSession("agent:guard:deep-child:0");
    for (let index = 0; index < depth; index += 1) {
      assert.equal(service.resolveBySession(`agent:guard:deep-child:${index}`), undefined);
    }
    assert.equal(
      service.authenticate(root.leaseId, root.credential)?.state,
      "active",
    );
    assert.equal(
      service.authenticate(other.leaseId, other.credential)?.state,
      "active",
    );
    assert.equal(service.status().activeLeaseCount, 2);
    assert.equal(service.status().coverage, "conditional");
  });

  test("signs only decisions bound to the current active lease epoch and policy", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const activation = createLease(service, ROOT_SESSION_KEY);
    const response = buildDecisionResponse(activation);
    const signature = service.signDecision(activation.leaseId, response);
    const publicKey = createPublicKey(activation.decisionPublicKey);
    assert.equal(verifyNativeGuardPayload(response, signature, publicKey), true);

    for (const mismatch of [
      { ...response, leaseId: "wrong-lease" },
      { ...response, leaseEpoch: response.leaseEpoch + 1 },
      { ...response, policyPackId: "policy_pack.wrong" },
      { ...response, policyPackDigest: "f".repeat(64) },
    ]) {
      assert.throws(() => service.signDecision(activation.leaseId, mismatch));
    }

    const renewed = service.renew(activation.leaseId);
    assert.throws(() => service.signDecision(activation.leaseId, response));
    const renewedResponse = buildDecisionResponse(renewed);
    const renewedSignature = service.signDecision(renewed.leaseId, renewedResponse);
    assert.equal(verifyNativeGuardPayload(renewedResponse, renewedSignature, publicKey), true);
    assert.equal(service.revoke(renewed.leaseId), true);
    assert.throws(() => service.signDecision(renewed.leaseId, renewedResponse));
  });

  test("exposes only public lease material through active leases and status", () => {
    const service = createNativeGuardLeaseService({
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    const activation = createLease(service, ROOT_SESSION_KEY);
    const active = service.authenticate(activation.leaseId, activation.credential);
    assert.ok(active);
    assert.equal("credential" in active, false);
    assert.equal("credentialHash" in active, false);
    assert.equal("privateKey" in active, false);

    const serializedStatus = JSON.stringify(service.status());
    assert.equal(serializedStatus.includes(activation.credential), false);
    assert.equal(serializedStatus.includes("credentialHash"), false);
    assert.equal(serializedStatus.includes("privateKey"), false);
    assert.equal(serializedStatus.includes("Dangerous shell calls"), false);
  });
});

function buildPolicyPack(
  overrides: Partial<SupervisionPolicyPack> = {},
): SupervisionPolicyPack {
  return {
    schemaVersion: "mvp-1",
    policyPackId: "policy_pack.native-guard",
    agentId: "agent.native-guard",
    sourceDetectionReportId: "detection.native-guard",
    sourceRiskProfileId: "risk_profile.native-guard",
    policies: [
      {
        policyId: "policy.native-guard.deny-shell",
        sourceWeaknessIds: ["weakness.native-guard"],
        name: "Deny dangerous shell calls",
        description: "Native guard lease fixture.",
        targetType: "tool_call",
        action: "deny",
        riskLevel: "high",
        match: {
          relation: "all",
          eventTypes: ["tool_call"],
          attackEntryTypes: ["malicious_user_prompt"],
          riskTagIds: ["risk.native-guard"],
          matchers: [
            {
              fieldPath: "payload.toolName",
              operator: "equals",
              value: "shell",
              caseSensitive: true,
              normalize: "none",
            },
          ],
        },
        reason: "Dangerous shell calls require fail-closed handling.",
      },
    ],
    defaultAction: "allow",
    createdAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function createLease(
  service: ReturnType<typeof createNativeGuardLeaseService>,
  rootSessionKey: string,
  ttlMs?: number,
): NativeGuardLeaseActivation {
  const policyPack = buildPolicyPack();
  return service.create({
    rootSessionKey,
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: BACKEND_URL,
    ttlMs,
  }).activation;
}

function createAgentLease(
  service: ReturnType<typeof createNativeGuardLeaseService>,
  ttlMs?: number,
): NativeGuardLeaseActivation {
  const policyPack = buildPolicyPack();
  const scope: NativeGuardLeaseScope = { kind: "agent", agentId: "main" };
  return service.create({
    rootSessionKey: "agent:main:main",
    scope,
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: BACKEND_URL,
    ttlMs,
  }).activation;
}

function buildDecisionResponse(
  activation: NativeGuardLeaseActivation,
): Omit<NativeToolDecisionResponse, "signature"> {
  return {
    schemaVersion: "native-guard-1",
    decisionId: "decision.native-guard.1",
    requestId: "request.native-guard.1",
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    policyPackId: activation.policyPackId,
    policyPackDigest: activation.policyPackDigest,
    action: "deny",
    reasonCode: "policy_deny",
    reason: "The active policy denies this native tool call.",
    evaluatedParamsDigest: "a".repeat(64),
    decidedAt: "2026-08-01T00:00:00.000Z",
  };
}

function evidenceProof(
  activation: NativeGuardLeaseActivation,
  path: string,
  payload: unknown,
  proofId: string,
  overrides: Partial<Omit<NativeGuardEvidenceProof, "signature">> = {},
): NativeGuardEvidenceProof {
  const unsigned = {
    schemaVersion: "native-guard-1" as const,
    signatureContext: "native_guard.evidence_request.v1" as const,
    proofId,
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    method: "POST" as const,
    path,
    bodyDigest: digestJson(payload),
    issuedAt: activation.issuedAt,
    keyId: activation.evidenceSigningKeyId,
    ...overrides,
  };
  return {
    ...unsigned,
    signature: signNativeGuardPayload(
      unsigned,
      createPrivateKey(activation.evidenceSigningPrivateKey),
    ),
  };
}
