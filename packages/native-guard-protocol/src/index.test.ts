import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type {
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeGuardLeaseSummary,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import {
  canonicalJson,
  digestJson,
  nativeGuardScopesEqual,
  normalizeNativeGuardLeaseScope,
  parseCanonicalOpenClawSessionKey,
  signNativeGuardPayload,
  verifyNativeGuardPayload,
} from "./index";

const INVALID_SCOPE_ERROR = "Native guard lease scope is invalid";

test("native guard contracts retain legacy scope and expose scoped lease summaries", () => {
  const legacyScope: NativeGuardLeaseActivation["scope"] = "session_tree";
  const agentScope: NativeGuardLeaseScope = { kind: "agent", agentId: "main" };
  const summary = {
    leaseId: "lease.1",
    leaseEpoch: 1,
    rootSessionKey: "agent:main:main",
    scope: agentScope,
    mode: "supervision",
    policyPackId: "policy.1",
    policyPackDigest: "a".repeat(64),
    expiresAt: "2026-08-10T12:00:00.000Z",
  } satisfies NativeGuardLeaseSummary;
  const status = {
    coverage: "active",
    finalizerAssurance: "exclusive_before_hook",
    activeLeaseCount: 1,
    activeLease: summary,
    activeLeases: [summary],
  } satisfies NativeGuardStatus;
  const legacyStatus = {
    coverage: "active",
    finalizerAssurance: "exclusive_before_hook",
    activeLeaseCount: 1,
    activeLease: {
      leaseId: "lease.legacy",
      leaseEpoch: 1,
      rootSessionKey: "agent:main:cli:legacy",
      mode: "detection",
      policyPackId: "policy.legacy",
      policyPackDigest: "b".repeat(64),
      expiresAt: "2026-08-10T12:00:00.000Z",
    },
  } satisfies NativeGuardStatus;
  // @ts-expect-error Scoped status collections cannot contain a scope-less active lease.
  const invalidMixedStatus: NativeGuardStatus = { ...legacyStatus, activeLeases: [summary] };

  assert.equal(legacyScope, "session_tree");
  assert.deepEqual(status.activeLeases, [summary]);
  assert.equal(legacyStatus.activeLease.rootSessionKey, "agent:main:cli:legacy");
  assert.equal(invalidMixedStatus.activeLeases?.length, 1);
});

test("canonical OpenClaw session keys expose their agent identity", () => {
  for (const sessionKey of [
    "agent:main:main",
    "agent:main:dashboard:abc",
    "agent:main:cli:abc",
    "agent:main:channel:abc",
    "agent:main:subagent:abc",
    "agent:worker.prod:channel:abc",
  ]) {
    assert.deepEqual(parseCanonicalOpenClawSessionKey(sessionKey), {
      agentId: sessionKey === "agent:worker.prod:channel:abc" ? "worker.prod" : "main",
      sessionKey,
    });
  }

  assert.deepEqual(parseCanonicalOpenClawSessionKey("agent:worker:channel:abc"), {
    agentId: "worker",
    sessionKey: "agent:worker:channel:abc",
  });
});

test("canonical OpenClaw session key parsing rejects malformed and unsafe keys", () => {
  for (const sessionKey of [
    "",
    "main",
    "session:main:abc",
    "agent::abc",
    "agent:main:",
    "agent:main",
    "agent:main!:dashboard:abc",
    "agent:main/dashboard:abc",
    "agent:worker/prod:dashboard:abc",
    "agent:worker..prod:dashboard:abc",
    "agent:main:dashboard/abc",
    "agent:main:<dashboard>",
    "agent:main:run..escape",
    `agent:${"a".repeat(65)}:dashboard`,
    `agent:main:${"a".repeat(181)}`,
    " agent:main:dashboard:abc",
    "agent:main:dashboard:abc ",
    "agent:ma in:dashboard:abc",
    "agent:main:dashboard:abc\tdef",
    "agent:main:dashboard:abc\ndef",
    "agent:main:dashboard:abc\u0000def",
    "agent:main:dashboard:abc\u007fdef",
    "agent:main:dashboard:äbc",
  ]) {
    assert.equal(parseCanonicalOpenClawSessionKey(sessionKey), undefined, sessionKey);
  }
});

test("native guard lease scope normalization supports legacy and explicit sessions", () => {
  for (const rootSessionKey of [
    "agent:main",
    "agent:guard:root.1",
    "session.fastify",
    "not-a-canonical-session key",
    "x".repeat(512),
  ]) {
    assert.deepEqual(normalizeNativeGuardLeaseScope(undefined, rootSessionKey), {
      kind: "session",
      sessionKey: rootSessionKey,
    });
    assert.deepEqual(normalizeNativeGuardLeaseScope("session_tree", rootSessionKey), {
      kind: "session",
      sessionKey: rootSessionKey,
    });
    assert.deepEqual(
      normalizeNativeGuardLeaseScope({ kind: "session", sessionKey: rootSessionKey }, rootSessionKey),
      { kind: "session", sessionKey: rootSessionKey },
    );
  }
});

test("native guard lease scope normalization supports the anchored main agent", () => {
  assert.deepEqual(
    normalizeNativeGuardLeaseScope(
      { kind: "agent", agentId: "main" },
      "agent:main:main",
    ),
    { kind: "agent", agentId: "main" },
  );
});

test("native guard lease scope normalization rejects session mismatches", () => {
  assert.throws(
    () => normalizeNativeGuardLeaseScope(
      { kind: "session", sessionKey: "agent:main:cli:other" },
      "agent:main:cli:abc",
    ),
    { name: "TypeError", message: INVALID_SCOPE_ERROR },
  );
});

test("native guard lease scope normalization rejects unsafe exact sessions", () => {
  for (const rootSessionKey of [
    "",
    "x".repeat(513),
    "agent:main\u0000",
    "agent:main\u001f",
    "agent:main\u007f",
  ]) {
    assert.throws(
      () => normalizeNativeGuardLeaseScope("session_tree", rootSessionKey),
      { name: "TypeError", message: INVALID_SCOPE_ERROR },
    );
    assert.throws(
      () => normalizeNativeGuardLeaseScope(
        { kind: "session", sessionKey: rootSessionKey },
        rootSessionKey,
      ),
      { name: "TypeError", message: INVALID_SCOPE_ERROR },
    );
  }
});

test("native guard agent scope normalization rejects wrong anchors and non-main agents", () => {
  assert.throws(
    () => normalizeNativeGuardLeaseScope(
      { kind: "agent", agentId: "main" },
      "agent:main:dashboard:abc",
    ),
    { name: "TypeError", message: INVALID_SCOPE_ERROR },
  );
  assert.throws(
    () => normalizeNativeGuardLeaseScope(
      { kind: "agent", agentId: "worker" } as unknown as NativeGuardLeaseScope,
      "agent:worker:main",
    ),
    { name: "TypeError", message: INVALID_SCOPE_ERROR },
  );
});

test("invalid lease scope errors do not reflect untrusted input", () => {
  const untrusted = "<untrusted-session>\n";

  assert.throws(
    () => normalizeNativeGuardLeaseScope(
      { kind: "session", sessionKey: untrusted },
      untrusted,
    ),
    (error: unknown) => error instanceof TypeError &&
      error.message === INVALID_SCOPE_ERROR &&
      !error.message.includes(untrusted),
  );
});

test("native guard scope equality normalizes each activation identity", () => {
  const rootSessionKey = "agent:main";
  const legacy = { scope: "session_tree" as const, rootSessionKey };
  const missing = { rootSessionKey };
  const structured = {
    scope: { kind: "session" as const, sessionKey: rootSessionKey },
    rootSessionKey,
  };

  assert.equal(nativeGuardScopesEqual(legacy, { ...legacy }), true);
  assert.equal(
    nativeGuardScopesEqual(legacy, { scope: "session_tree", rootSessionKey: "agent:other" }),
    false,
  );
  assert.equal(nativeGuardScopesEqual(missing, structured), true);
  assert.equal(nativeGuardScopesEqual(structured, missing), true);
  assert.equal(
    nativeGuardScopesEqual(missing, {
      scope: { kind: "session", sessionKey: "agent:other" },
      rootSessionKey: "agent:other",
    }),
    false,
  );
});

test("native guard scope equality compares normalized structured scopes", () => {
  assert.equal(
    nativeGuardScopesEqual(
      {
        scope: { kind: "session", sessionKey: "agent:main:cli:abc" },
        rootSessionKey: "agent:main:cli:abc",
      },
      {
        scope: { sessionKey: "agent:main:cli:abc", kind: "session" },
        rootSessionKey: "agent:main:cli:abc",
      },
    ),
    true,
  );
  assert.equal(
    nativeGuardScopesEqual(
      { scope: { kind: "agent", agentId: "main" }, rootSessionKey: "agent:main:main" },
      { scope: { agentId: "main", kind: "agent" }, rootSessionKey: "agent:main:main" },
    ),
    true,
  );
  assert.equal(
    nativeGuardScopesEqual(
      {
        scope: { kind: "session", sessionKey: "agent:main:main" },
        rootSessionKey: "agent:main:main",
      },
      { scope: { kind: "agent", agentId: "main" }, rootSessionKey: "agent:main:main" },
    ),
    false,
  );
});

test("native guard scope equality returns false for invalid identities before comparison", () => {
  const invalidIdentity = { scope: "session_tree" as const, rootSessionKey: "" };

  assert.equal(nativeGuardScopesEqual(invalidIdentity, invalidIdentity), false);
});

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ z: 1, nested: { b: true, a: "x" } }), canonicalJson({ nested: { a: "x", b: true }, z: 1 }));
  assert.equal(digestJson({ z: 1, nested: { b: true, a: "x" } }), digestJson({ nested: { a: "x", b: true }, z: 1 }));
});

test("Ed25519 signature rejects changed payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = { requestId: "req.1", action: "allow" };
  const signature = signNativeGuardPayload(payload, privateKey);
  assert.equal(verifyNativeGuardPayload(payload, signature, publicKey), true);
  assert.equal(verifyNativeGuardPayload({ ...payload, action: "deny" }, signature, publicKey), false);
});

test("canonical JSON rejects non-finite numbers and unsupported values", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => canonicalJson({ value: undefined }), TypeError);
});

test("signature verification returns false for malformed signatures", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  assert.equal(verifyNativeGuardPayload({ requestId: "req.1" }, "not+a+signature", publicKey), false);
});

test("canonical JSON rejects sparse arrays", () => {
  assert.throws(() => canonicalJson(new Array(1)), TypeError);
  assert.equal(canonicalJson([null]), "[null]");
  assert.throws(() => canonicalJson([undefined]), TypeError);
});

test("canonical JSON rejects unpaired UTF-16 surrogates", () => {
  assert.throws(() => canonicalJson("\uD800"), TypeError);
  assert.throws(() => canonicalJson("\uDC00"), TypeError);
  assert.throws(() => canonicalJson({ ["\uD800"]: "value" }), TypeError);
  assert.throws(() => canonicalJson({ ["\uDC00"]: "value" }), TypeError);
  assert.equal(canonicalJson("\uD83D\uDE00"), JSON.stringify("\uD83D\uDE00"));
});

test("signing requires an Ed25519 private key", () => {
  const { privateKey: ed448PrivateKey } = generateKeyPairSync("ed448");
  const { publicKey: ed25519PublicKey } = generateKeyPairSync("ed25519");
  assert.throws(() => signNativeGuardPayload({ requestId: "req.1" }, ed448PrivateKey), TypeError);
  assert.throws(() => signNativeGuardPayload({ requestId: "req.1" }, ed25519PublicKey), TypeError);
});

test("verification requires an Ed25519 public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { publicKey: ed448PublicKey } = generateKeyPairSync("ed448");
  const payload = { requestId: "req.1", action: "allow" };
  const signature = signNativeGuardPayload(payload, privateKey);
  assert.equal(verifyNativeGuardPayload(payload, signature, ed448PublicKey), false);
  assert.equal(verifyNativeGuardPayload(payload, signature, privateKey), false);
  assert.equal(verifyNativeGuardPayload(payload, signature, publicKey), true);
});
