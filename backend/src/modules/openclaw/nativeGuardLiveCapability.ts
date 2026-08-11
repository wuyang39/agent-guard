import { timingSafeEqual, type KeyObject } from "node:crypto";
import { verifyNativeGuardPayload } from "@agent-guard/native-guard-protocol";

export type NativeGuardLiveCapability = {
  contractVersion: "native-guard-1";
  registrarStatus: "live";
  finalBeforeToolCall: {
    pluginId: "agent-guard-supervision";
    exclusive: true;
  };
  trustedToolPolicy: {
    policyId: "agent-guard-admission";
    exclusive: true;
  };
  recoveryService: {
    serviceId: "agent-guard-runtime";
    live: true;
  };
  postApprovalLeaseRecheck: true;
  paramsProvenance: "json-only";
};

export type NativeGuardGatewayAttestation = {
  contractVersion: "native-guard-gateway-1";
  signatureContext: "native_guard.gateway_attestation.v1";
  challenge: string;
  gatewayUrl: string;
  gatewayInstanceId: string;
  openclawVersion: string;
  nativeGuard: NativeGuardLiveCapability;
  signature: string;
};

export function isCompatibleNativeGuardVersion(version: string): boolean {
  if (version === "2026.7.1-agentguard.1") return true;
  const match = version.match(/^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/);
  if (!match) return false;
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger)) return false;
  return versionTupleAtLeast(core, [2026, 7, 2]);
}

export function parseNativeGuardLiveCapability(
  inventory: unknown,
): NativeGuardLiveCapability | undefined {
  if (!isRecord(inventory) || !isRecord(inventory.registry)) return undefined;
  const registry = inventory.registry;
  if (registry.liveAttestation !== true || !isRecord(registry.nativeGuard)) {
    return undefined;
  }
  const capability = registry.nativeGuard;
  if (
    !hasExactKeys(capability, [
      "contractVersion",
      "registrarStatus",
      "finalBeforeToolCall",
      "trustedToolPolicy",
      "recoveryService",
      "postApprovalLeaseRecheck",
      "paramsProvenance",
    ]) ||
    capability.contractVersion !== "native-guard-1" ||
    capability.registrarStatus !== "live" ||
    capability.postApprovalLeaseRecheck !== true ||
    capability.paramsProvenance !== "json-only" ||
    !isRecord(capability.finalBeforeToolCall) ||
    !hasExactKeys(capability.finalBeforeToolCall, ["pluginId", "exclusive"]) ||
    capability.finalBeforeToolCall.pluginId !== "agent-guard-supervision" ||
    capability.finalBeforeToolCall.exclusive !== true ||
    !isRecord(capability.trustedToolPolicy) ||
    !hasExactKeys(capability.trustedToolPolicy, ["policyId", "exclusive"]) ||
    capability.trustedToolPolicy.policyId !== "agent-guard-admission" ||
    capability.trustedToolPolicy.exclusive !== true ||
    !isRecord(capability.recoveryService) ||
    !hasExactKeys(capability.recoveryService, ["serviceId", "live"]) ||
    capability.recoveryService.serviceId !== "agent-guard-runtime" ||
    capability.recoveryService.live !== true
  ) {
    return undefined;
  }

  return {
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
}

export function parseNativeGuardGatewayAttestation(
  value: unknown,
  expected: {
    gatewayUrl: string;
    challenge: string;
    attestationPublicKey: KeyObject;
  },
): NativeGuardGatewayAttestation | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "signatureContext",
      "challenge",
      "gatewayUrl",
      "gatewayInstanceId",
      "openclawVersion",
      "nativeGuard",
      "signature",
    ]) ||
    value.contractVersion !== "native-guard-gateway-1" ||
    value.signatureContext !== "native_guard.gateway_attestation.v1" ||
    typeof value.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/.test(value.challenge) ||
    !sameChallenge(value.challenge, expected.challenge) ||
    value.gatewayUrl !== expected.gatewayUrl ||
    typeof value.gatewayInstanceId !== "string" ||
    !/^[A-Za-z0-9._-]{8,128}$/.test(value.gatewayInstanceId) ||
    typeof value.openclawVersion !== "string" ||
    typeof value.signature !== "string" ||
    !isCompatibleNativeGuardVersion(value.openclawVersion)
  ) {
    return undefined;
  }
  const nativeGuard = parseNativeGuardLiveCapability({
    registry: {
      liveAttestation: true,
      nativeGuard: value.nativeGuard,
    },
  });
  if (!nativeGuard) return undefined;
  const unsigned: Omit<NativeGuardGatewayAttestation, "signature"> = {
    contractVersion: "native-guard-gateway-1",
    signatureContext: "native_guard.gateway_attestation.v1",
    challenge: value.challenge,
    gatewayUrl: expected.gatewayUrl,
    gatewayInstanceId: value.gatewayInstanceId,
    openclawVersion: value.openclawVersion,
    nativeGuard,
  };
  if (!verifyNativeGuardPayload(unsigned, value.signature, expected.attestationPublicKey)) {
    return undefined;
  }
  return { ...unsigned, signature: value.signature };
}

function sameChallenge(actual: string, expected: string): boolean {
  if (!/^[A-Za-z0-9_-]{32}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function versionTupleAtLeast(
  actual: number[],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}
