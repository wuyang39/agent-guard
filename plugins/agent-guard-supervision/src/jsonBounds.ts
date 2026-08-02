import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalJson } from "@agent-guard/native-guard-protocol";

export const MAX_NATIVE_TOOL_PARAM_BYTES = 256 * 1024;
export const MAX_NATIVE_TOOL_PARAM_DEPTH = 32;
export const MAX_NATIVE_TOOL_PARAM_KEYS = 4_096;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type BoundedParams = {
  canonical: string;
  digest: string;
};

export function inspectBoundedParams(value: unknown): BoundedParams {
  assertBoundedStructure(value);
  const canonical = canonicalJson(value);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { canonical, digest };
}

function assertBoundedStructure(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidParams();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let keyCount = 0;
  let canonicalBytes = 0;
  const addBytes = (count: number): void => {
    if (count > MAX_NATIVE_TOOL_PARAM_BYTES - canonicalBytes) throw invalidParams();
    canonicalBytes += count;
  };

  while (stack.length > 0) {
    const current = stack.pop()!;
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
      const ownKeys = Reflect.ownKeys(current.value);
      if (ownKeys.length !== current.value.length + 1 || !ownKeys.includes("length")) {
        throw invalidParams();
      }
      addBytes(2);
      if (current.value.length > 1) addBytes(current.value.length - 1);
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      for (let index = 0; index < current.value.length; index += 1) {
        const descriptor = descriptors[index];
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

    if (!isPlainObject(current.value)) throw invalidParams();
    const keys = Object.keys(current.value);
    if (Reflect.ownKeys(current.value).length !== keys.length) throw invalidParams();
    keyCount += keys.length;
    if (keyCount > MAX_NATIVE_TOOL_PARAM_KEYS) throw invalidParams();
    addBytes(2);
    if (keys.length > 1) addBytes(keys.length - 1);
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        DANGEROUS_KEYS.has(key) ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw invalidParams();
      }
      addCanonicalStringBytes(key, addBytes);
      addBytes(1);
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidParams(): TypeError {
  return new TypeError("Native guard tool parameters are invalid");
}
