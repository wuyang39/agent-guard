import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { types as utilTypes } from "node:util";
import type { NativeGuardLeaseScope } from "@agent-guard/contracts";

export const MAX_NATIVE_TOOL_PARAM_BYTES = 256 * 1024;
export const MAX_NATIVE_TOOL_PARAM_DEPTH = 32;
export const MAX_NATIVE_TOOL_PARAM_KEYS = 4_096;

const DANGEROUS_PARAM_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CANONICAL_OPENCLAW_SESSION_KEY = /^agent:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._:-]{1,180}$/;
const UNSAFE_EXACT_SESSION_KEY = /[\x00-\x1f\x7f]/;
const MAX_EXACT_SESSION_KEY_LENGTH = 512;
const MAIN_AGENT_ANCHOR_SESSION_KEY = "agent:main:main";
const INVALID_LEASE_SCOPE_MESSAGE = "Native guard lease scope is invalid";

export type CanonicalOpenClawSessionKey = {
  agentId: string;
  sessionKey: string;
};

export type NormalizedNativeGuardLeaseScope = Exclude<
  NativeGuardLeaseScope,
  "session_tree"
>;

export type NativeGuardScopeIdentity = {
  scope?: NativeGuardLeaseScope;
  rootSessionKey: string;
};

export type BoundedParams = {
  canonical: string;
  digest: string;
};

export function parseCanonicalOpenClawSessionKey(
  sessionKey: string,
): CanonicalOpenClawSessionKey | undefined {
  if (
    typeof sessionKey !== "string" ||
    sessionKey.includes("..") ||
    !CANONICAL_OPENCLAW_SESSION_KEY.test(sessionKey)
  ) {
    return undefined;
  }

  const agentIdEnd = sessionKey.indexOf(":", "agent:".length);
  const agentId = sessionKey.slice("agent:".length, agentIdEnd);

  return { agentId, sessionKey };
}

export function normalizeNativeGuardLeaseScope(
  scope: NativeGuardLeaseScope | undefined,
  rootSessionKey: string,
): NormalizedNativeGuardLeaseScope {
  if (scope === undefined || scope === "session_tree") {
    if (!isSafeExactSessionKey(rootSessionKey)) {
      throw invalidLeaseScope();
    }
    return { kind: "session", sessionKey: rootSessionKey };
  }

  if (typeof scope !== "object" || scope === null) {
    throw invalidLeaseScope();
  }

  if (scope.kind === "session") {
    if (
      scope.sessionKey !== rootSessionKey ||
      !isSafeExactSessionKey(scope.sessionKey)
    ) {
      throw invalidLeaseScope();
    }
    return { kind: "session", sessionKey: scope.sessionKey };
  }

  if (
    scope.kind === "agent" &&
    scope.agentId === "main" &&
    rootSessionKey === MAIN_AGENT_ANCHOR_SESSION_KEY
  ) {
    return { kind: "agent", agentId: "main" };
  }

  throw invalidLeaseScope();
}

export function nativeGuardScopesEqual(
  left: NativeGuardScopeIdentity,
  right: NativeGuardScopeIdentity,
): boolean {
  try {
    const normalizedLeft = normalizeNativeGuardLeaseScope(left.scope, left.rootSessionKey);
    const normalizedRight = normalizeNativeGuardLeaseScope(right.scope, right.rootSessionKey);
    if (normalizedLeft.kind === "session") {
      return normalizedRight.kind === "session" &&
        normalizedLeft.sessionKey === normalizedRight.sessionKey;
    }
    return normalizedRight.kind === "agent" &&
      normalizedLeft.agentId === normalizedRight.agentId;
  } catch {
    return false;
  }
}

function isSafeExactSessionKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_EXACT_SESSION_KEY_LENGTH &&
    !UNSAFE_EXACT_SESSION_KEY.test(value);
}

function invalidLeaseScope(): TypeError {
  return new TypeError(INVALID_LEASE_SCOPE_MESSAGE);
}

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

export function inspectBoundedParams(value: unknown): BoundedParams {
  assertBoundedParamStructure(value);
  const canonical = canonicalJson(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { canonical, digest };
}

function assertBoundedParamStructure(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainParamObject(value)) throw invalidParams();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let keyCount = 0;
  let canonicalBytes = 0;
  let reservedValueBytes = 1;
  const ensureBudget = (): void => {
    if (canonicalBytes > MAX_NATIVE_TOOL_PARAM_BYTES - reservedValueBytes) {
      throw invalidParams();
    }
  };
  const addBytes = (count: number): void => {
    if (count > MAX_NATIVE_TOOL_PARAM_BYTES - canonicalBytes - reservedValueBytes) {
      throw invalidParams();
    }
    canonicalBytes += count;
  };
  const reserveValues = (count: number): void => {
    if (count > MAX_NATIVE_TOOL_PARAM_BYTES - canonicalBytes - reservedValueBytes) {
      throw invalidParams();
    }
    reservedValueBytes += count;
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
    reservedValueBytes -= 1;
    if (current.depth > MAX_NATIVE_TOOL_PARAM_DEPTH) throw invalidParams();
    if (current.value === null) {
      addBytes(4);
      continue;
    }
    if (typeof current.value === "string") {
      addCanonicalStringBytes(current.value, addBytes);
      continue;
    }
    if (typeof current.value === "boolean") {
      addBytes(current.value ? 4 : 5);
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw invalidParams();
      addBytes(JSON.stringify(current.value).length);
      continue;
    }
    if (
      typeof current.value !== "object" ||
      utilTypes.isProxy(current.value) ||
      seen.has(current.value)
    ) {
      throw invalidParams();
    }
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (Object.getPrototypeOf(current.value) !== Array.prototype) throw invalidParams();
      const length = current.value.length;
      addBytes(2);
      if (length > 1) addBytes(length - 1);
      reserveValues(length);
      const ownKeys = Reflect.ownKeys(current.value);
      if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) {
        throw invalidParams();
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current.value, index);
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.enumerable !== true
        ) {
          throw invalidParams();
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }

    if (!isPlainParamObject(current.value)) throw invalidParams();
    addBytes(2);
    const keys: string[] = [];
    for (const key in current.value) {
      if (!Object.hasOwn(current.value, key) || DANGEROUS_PARAM_KEYS.has(key)) {
        throw invalidParams();
      }
      keyCount += 1;
      if (keyCount > MAX_NATIVE_TOOL_PARAM_KEYS) throw invalidParams();
      if (keys.length > 0) addBytes(1);
      addCanonicalStringBytes(key, addBytes);
      addBytes(1);
      reserveValues(1);
      keys.push(key);
    }
    const ownKeys = Reflect.ownKeys(current.value);
    const keySet = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keySet.has(key))
    ) {
      throw invalidParams();
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw invalidParams();
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  ensureBudget();
}

function addCanonicalStringBytes(value: string, addBytes: (count: number) => void): void {
  addBytes(2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      addBytes(2);
    } else if (codeUnit === 0x08 || codeUnit === 0x09 || codeUnit === 0x0a ||
      codeUnit === 0x0c || codeUnit === 0x0d) {
      addBytes(2);
    } else if (codeUnit < 0x20) {
      addBytes(6);
    } else if (codeUnit <= 0x7f) {
      addBytes(1);
    } else if (codeUnit <= 0x7ff) {
      addBytes(2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        throw invalidParams();
      }
      addBytes(4);
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw invalidParams();
    } else {
      addBytes(3);
    }
  }
}

function isPlainParamObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidParams(): TypeError {
  return new TypeError("Native guard tool parameters are invalid");
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
