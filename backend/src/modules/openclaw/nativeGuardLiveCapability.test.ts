import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import test from "node:test";
import { signNativeGuardPayload } from "@agent-guard/native-guard-protocol";
import {
  isCompatibleNativeGuardVersion,
  parseNativeGuardGatewayAttestation,
  parseNativeGuardLiveCapability,
  type NativeGuardLiveCapability,
} from "./nativeGuardLiveCapability";

export const COMPLETE_LIVE_CAPABILITY: NativeGuardLiveCapability = {
  contractVersion: "native-guard-1",
  registrarStatus: "live",
  finalBeforeToolCall: {
    pluginId: "agent-guard-supervision",
    exclusive: true,
  },
  trustedToolPolicy: {
    policyId: "agent-guard-admission",
    exclusive: true,
  },
  recoveryService: {
    serviceId: "agent-guard-runtime",
    live: true,
  },
  postApprovalLeaseRecheck: true,
  paramsProvenance: "json-only",
};

function inventory(capability: unknown, liveAttestation: unknown = true): unknown {
  return {
    registry: {
      liveAttestation,
      nativeGuard: capability,
    },
  };
}

test("accepts only the complete host-produced native guard live capability", () => {
  assert.deepEqual(
    parseNativeGuardLiveCapability(inventory(COMPLETE_LIVE_CAPABILITY)),
    COMPLETE_LIVE_CAPABILITY,
  );
});

test("accepts only official minimum versions or the exact controlled fork identifier", () => {
  for (const version of [
    "2026.7.1-agentguard.1",
    "2026.7.2",
    "2026.8.0",
    "2027.1.0",
  ]) {
    assert.equal(isCompatibleNativeGuardVersion(version), true, version);
  }
  for (const version of [
    "2026.7.1",
    "2026.7.1-agentguard",
    "2026.7.1-agentguard.2",
    "2026.7.1-agentguard.evil",
    "2026.7.2-agentguard.1",
    "2026.8.0-agentguard.1",
    "2026.7.2-beta.1",
    "2026.7.1-evilagentguard.1",
    "not-a-version",
  ]) {
    assert.equal(isCompatibleNativeGuardVersion(version), false, version);
  }
});

test("rejects non-canonical or unsafe official version segments", () => {
  for (const version of [
    "2026.07.002",
    "2026.7.02",
    "2026.9007199254740992.0",
    "9007199254740992.7.2",
  ]) {
    assert.equal(isCompatibleNativeGuardVersion(version), false, version);
  }
});

test("rejects a boolean attestation without structured capability proof", () => {
  assert.equal(parseNativeGuardLiveCapability(inventory(undefined)), undefined);
});

test("rejects missing or weakened native guard capability fields", () => {
  for (const weakened of [
    { ...COMPLETE_LIVE_CAPABILITY, registrarStatus: "partial" },
    { ...COMPLETE_LIVE_CAPABILITY, postApprovalLeaseRecheck: false },
    { ...COMPLETE_LIVE_CAPABILITY, paramsProvenance: "manifest-claimed" },
    {
      ...COMPLETE_LIVE_CAPABILITY,
      finalBeforeToolCall: {
        ...COMPLETE_LIVE_CAPABILITY.finalBeforeToolCall,
        exclusive: false,
      },
    },
    {
      ...COMPLETE_LIVE_CAPABILITY,
      trustedToolPolicy: {
        ...COMPLETE_LIVE_CAPABILITY.trustedToolPolicy,
        policyId: "untrusted-policy",
      },
    },
    {
      ...COMPLETE_LIVE_CAPABILITY,
      recoveryService: {
        ...COMPLETE_LIVE_CAPABILITY.recoveryService,
        live: false,
      },
    },
  ]) {
    assert.equal(parseNativeGuardLiveCapability(inventory(weakened)), undefined);
  }
});

test("rejects structured capability proof when the registry did not attest it live", () => {
  assert.equal(
    parseNativeGuardLiveCapability(inventory(COMPLETE_LIVE_CAPABILITY, false)),
    undefined,
  );
});

test("rejects extra keys at every native guard proof object level", () => {
  const extraKeyProofs: Array<[string, unknown]> = [
    ["nativeGuard", { ...COMPLETE_LIVE_CAPABILITY, untrustedClaim: true }],
    [
      "finalBeforeToolCall",
      {
        ...COMPLETE_LIVE_CAPABILITY,
        finalBeforeToolCall: {
          ...COMPLETE_LIVE_CAPABILITY.finalBeforeToolCall,
          priority: "final",
        },
      },
    ],
    [
      "trustedToolPolicy",
      {
        ...COMPLETE_LIVE_CAPABILITY,
        trustedToolPolicy: {
          ...COMPLETE_LIVE_CAPABILITY.trustedToolPolicy,
          source: "manifest",
        },
      },
    ],
    [
      "recoveryService",
      {
        ...COMPLETE_LIVE_CAPABILITY,
        recoveryService: {
          ...COMPLETE_LIVE_CAPABILITY.recoveryService,
          recoverable: true,
        },
      },
    ],
  ];

  for (const [level, proof] of extraKeyProofs) {
    assert.equal(
      parseNativeGuardLiveCapability(inventory(proof)),
      undefined,
      level,
    );
  }
});

test("accepts only a Gateway attestation signed by the bootstrap Ed25519 key", () => {
  const bootstrap = generateKeyPairSync("ed25519");
  const expected = {
    gatewayUrl: "http://127.0.0.1:18789",
    challenge: "A".repeat(32),
    attestationPublicKey: bootstrap.publicKey,
  };
  const proof = signedGatewayAttestation(
    expected.gatewayUrl,
    expected.challenge,
    bootstrap.privateKey,
  );

  assert.deepEqual(
    parseNativeGuardGatewayAttestation(proof, expected),
    proof,
  );
});

test("rejects unsigned, wrong-key, altered, and non-exact Gateway attestations", () => {
  const bootstrap = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const gatewayUrl = "http://127.0.0.1:18789";
  const challenge = "A".repeat(32);
  const expected = {
    gatewayUrl,
    challenge,
    attestationPublicKey: bootstrap.publicKey,
  };
  const valid = signedGatewayAttestation(gatewayUrl, challenge, bootstrap.privateKey);
  const unsigned = { ...valid } as Record<string, unknown>;
  delete unsigned.signature;

  for (const [name, value] of [
    ["unsigned", unsigned],
    ["wrong key", signedGatewayAttestation(gatewayUrl, challenge, attacker.privateKey)],
    ["altered", { ...valid, gatewayInstanceId: "gateway.instance.2" }],
    ["extra", { ...valid, pluginClaim: true }],
  ] as const) {
    assert.equal(
      parseNativeGuardGatewayAttestation(value, expected),
      undefined,
      name,
    );
  }
});

function signedGatewayAttestation(
  gatewayUrl: string,
  challenge: string,
  privateKey: KeyObject,
) {
  const unsigned = {
    contractVersion: "native-guard-gateway-1" as const,
    signatureContext: "native_guard.gateway_attestation.v1" as const,
    challenge,
    gatewayUrl,
    gatewayInstanceId: "gateway.instance.1",
    openclawVersion: "2026.7.2",
    nativeGuard: COMPLETE_LIVE_CAPABILITY,
  };
  return {
    ...unsigned,
    signature: signNativeGuardPayload(unsigned, privateKey),
  };
}
