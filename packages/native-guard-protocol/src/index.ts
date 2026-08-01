import { createHash, sign, verify, type KeyObject } from "node:crypto";

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw new TypeError("Canonical JSON requires well-formed Unicode strings");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("Canonical JSON requires well-formed Unicode strings");
    }
  }
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return JSON.stringify(value);
    case "string":
      assertWellFormedUnicode(value);
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
          const entries: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
              throw new TypeError("Canonical JSON does not support sparse arrays");
            }
            entries.push(canonicalize(value[index], ancestors));
          }
          return `[${entries.join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Canonical JSON supports only plain objects and arrays");
        }

        return `{${Object.keys(value)
          .sort()
          .map((key) => {
            assertWellFormedUnicode(key);
            return `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], ancestors)}`;
          })
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
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("Native guard payloads require an Ed25519 private key");
  }
  return sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url");
}

export function verifyNativeGuardPayload(payload: unknown, signature: string, publicKey: KeyObject): boolean {
  try {
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      return false;
    }

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
