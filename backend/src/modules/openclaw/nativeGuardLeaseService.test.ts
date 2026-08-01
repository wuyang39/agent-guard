import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { describe, test } from "node:test";
import type {
  NativeGuardLeaseActivation,
  NativeToolDecisionResponse,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";

const ROOT_SESSION_KEY = "agent:guard:run.1";
const CHILD_SESSION_KEY = "agent:guard:run.1:child.1";
const BACKEND_URL = "http://127.0.0.1:3100";

test("manages a session-tree lease through authentication, renewal, and expiry", () => {
  let nowMs = Date.parse("2026-08-01T00:00:00.000Z");
  const service = createNativeGuardLeaseService({ now: () => new Date(nowMs) });
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
  assert.deepEqual(created.activation.failurePolicy, {
    lowRisk: "warn",
    highRisk: "deny",
    unknownRisk: "deny",
  });
  assert.deepEqual(created.status, {
    coverage: "active",
    finalizerAssurance: "unverified",
    activeLeaseCount: 1,
    activeLease: {
      leaseId: created.activation.leaseId,
      rootSessionKey: ROOT_SESSION_KEY,
      mode: "supervision",
      policyPackId: policyPack.policyPackId,
      expiresAt: "2026-08-01T00:05:00.000Z",
    },
  });

  const active = service.authenticate(
    created.activation.leaseId,
    created.activation.credential,
  );
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

  assert.equal(service.revoke(created.activation.leaseId), true);
  assert.equal(
    service.authenticate(created.activation.leaseId, created.activation.credential),
    undefined,
  );
  assert.equal(service.resolveBySession(ROOT_SESSION_KEY), undefined);
  assert.equal(service.revoke(created.activation.leaseId), false);
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

  test("ends only the requested session subtree", () => {
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
    service.endSession(ROOT_SESSION_KEY);
    assert.equal(service.resolveBySession(ROOT_SESSION_KEY), undefined);
    assert.equal(service.resolveBySession(child), undefined);
    assert.equal(service.resolveBySession(sibling), undefined);
    assert.equal(service.authenticate(root.leaseId, root.credential)?.leaseId, root.leaseId);
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
