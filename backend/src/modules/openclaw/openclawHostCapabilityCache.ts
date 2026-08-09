import { createHash } from "node:crypto";
import type {
  InspectOpenClawCapabilitiesInput,
  NativeGuardCapability,
  OpenClawControlClient,
} from "./openclawControlClient";

const DEFAULT_TTL_MS = 5 * 60_000;

type CacheEntry = {
  identityKey: string;
  expiresAt: number;
  result: Promise<NativeGuardCapability>;
};

export type OpenClawHostCapabilityCache = {
  wrap(identityKey: string, client: OpenClawControlClient): OpenClawControlClient;
  invalidate(identityKey: string): void;
};

export function createOpenClawHostCapabilityCache(options: {
  ttlMs?: number;
  now?: () => number;
} = {}): OpenClawHostCapabilityCache {
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  function invalidate(identityKey: string): void {
    for (const [key, entry] of entries) {
      if (entry.identityKey === identityKey) entries.delete(key);
    }
  }

  function wrap(
    identityKey: string,
    client: OpenClawControlClient,
  ): OpenClawControlClient {
    async function inspectCapabilities(
      input: InspectOpenClawCapabilitiesInput,
    ): Promise<NativeGuardCapability> {
      if (input.signal) return client.inspectCapabilities(input);

      const key = capabilityCacheKey(identityKey, input);
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) {
        return cloneCapability(await existing.result);
      }
      if (existing) entries.delete(key);

      let entry!: CacheEntry;
      const result = client.inspectCapabilities(input).then(
        (capability) => {
          const cached = cloneCapability(capability);
          if (entries.get(key) === entry) entry.expiresAt = now() + ttlMs;
          return cached;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entry = {
        identityKey,
        expiresAt: Number.POSITIVE_INFINITY,
        result,
      };
      entries.set(key, entry);
      return cloneCapability(await result);
    }

    async function invalidateOnFailure<T>(operation: () => Promise<T>): Promise<T> {
      try {
        return await operation();
      } catch (error) {
        invalidate(identityKey);
        throw error;
      }
    }

    return {
      status: (gatewayUrl) =>
        invalidateOnFailure(() => client.status(gatewayUrl)),
      inspectCapabilities,
      attestGateway: (input) =>
        invalidateOnFailure(() => client.attestGateway(input)),
      activate: (gatewayUrl, activation) =>
        invalidateOnFailure(() => client.activate(gatewayUrl, activation)),
      renew: (gatewayUrl, activation) =>
        invalidateOnFailure(() => client.renew(gatewayUrl, activation)),
      revoke: (gatewayUrl, leaseId) =>
        invalidateOnFailure(() => client.revoke(gatewayUrl, leaseId)),
    };
  }

  return { wrap, invalidate };
}

function capabilityCacheKey(
  identityKey: string,
  input: InspectOpenClawCapabilitiesInput,
): string {
  const env = Object.entries(input.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify([
    identityKey,
    input.cliPath ?? null,
    input.isolatedProfile,
    input.liveRegistry ?? !input.isolatedProfile,
    input.inheritProcessEnv ?? true,
    env,
  ])).digest("hex");
}

function cloneCapability(capability: NativeGuardCapability): NativeGuardCapability {
  return {
    ...capability,
    conflictingPluginIds: [...capability.conflictingPluginIds],
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}
