import { createHash, sign, verify, type KeyObject } from "node:crypto";

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON requires finite numbers");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("Canonical JSON does not support circular values");
      }

      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Canonical JSON supports only plain objects and arrays");
        }

        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], ancestors)}`)
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value} values`);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function signNativeGuardPayload(payload: unknown, privateKey: KeyObject): string {
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url");
}

export function verifyNativeGuardPayload(payload: unknown, signature: string, publicKey: KeyObject): boolean {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
      return false;
    }

    const decodedSignature = Buffer.from(signature, "base64url");
    if (decodedSignature.length !== 64 || decodedSignature.toString("base64url") !== signature) {
      return false;
    }

    return verify(null, Buffer.from(canonicalJson(payload), "utf8"), publicKey, decodedSignature);
  } catch {
    return false;
  }
}
