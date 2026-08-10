import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_LENGTH = 43;
const DEFAULT_BOOTSTRAP_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CONTROL_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_EVENT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_CONTROL_SESSIONS = 1_024;
const DEFAULT_MAX_EVENT_CAPABILITIES = 1_024;

type StoredCapability = {
  expiresAtMs: number;
  issuedAtMs: number;
};

export type NativeSupervisionAccessServiceOptions = {
  bootstrapToken: string;
  now?: () => number | Date;
  createToken?: () => string;
  bootstrapTtlMs?: number;
  controlTtlMs?: number;
  eventTtlMs?: number;
  maxControlSessions?: number;
  maxEventCapabilities?: number;
};

export type IssuedNativeSupervisionCapability = {
  token: string;
  expiresAtMs: number;
};

export type NativeSupervisionAccessService = {
  exchangeBootstrap(token: string): IssuedNativeSupervisionCapability | undefined;
  issueEventCapability(controlToken: string): IssuedNativeSupervisionCapability | undefined;
  authenticateControl(token: string): boolean;
  authenticateEvents(token: string): boolean;
};

/**
 * Holds browser-only credentials for this backend process. Stored session and
 * event capabilities are SHA-256 digests, so neither can be recovered from
 * the in-memory stores after it has been sent as an HttpOnly cookie.
 */
export function createNativeSupervisionAccessService(
  options: NativeSupervisionAccessServiceOptions,
): NativeSupervisionAccessService {
  assertToken(options.bootstrapToken, "bootstrapToken");
  const now = options.now ?? (() => Date.now());
  const createToken = options.createToken ?? defaultCreateToken;
  const bootstrapTtlMs = positiveInteger(options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS, "bootstrapTtlMs");
  const controlTtlMs = positiveInteger(options.controlTtlMs ?? DEFAULT_CONTROL_TTL_MS, "controlTtlMs");
  const eventTtlMs = positiveInteger(options.eventTtlMs ?? DEFAULT_EVENT_TTL_MS, "eventTtlMs");
  const maxControlSessions = positiveInteger(
    options.maxControlSessions ?? DEFAULT_MAX_CONTROL_SESSIONS,
    "maxControlSessions",
  );
  const maxEventCapabilities = positiveInteger(
    options.maxEventCapabilities ?? DEFAULT_MAX_EVENT_CAPABILITIES,
    "maxEventCapabilities",
  );
  const bootstrapExpiresAtMs = addTtl(readNow(now), bootstrapTtlMs);
  const controls = new Map<string, StoredCapability>();
  const events = new Map<string, StoredCapability>();
  const reservedDigests = new Set([digestToken(options.bootstrapToken)]);
  let bootstrapConsumed = false;

  function issue(
    store: Map<string, StoredCapability>,
    otherStore: ReadonlyMap<string, StoredCapability>,
    maximum: number,
    ttlMs: number,
  ): IssuedNativeSupervisionCapability {
    const issuedAtMs = readNow(now);
    purgeExpired(store, issuedAtMs);
    while (store.size >= maximum) {
      discardOldest(store);
    }
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const token = createAndValidateToken(createToken);
      const digest = digestToken(token);
      if (reservedDigests.has(digest) || store.has(digest) || otherStore.has(digest)) continue;
      const expiresAtMs = addTtl(issuedAtMs, ttlMs);
      store.set(digest, { issuedAtMs, expiresAtMs });
      return { token, expiresAtMs };
    }
    throw new Error("Unable to issue a unique native supervision capability");
  }

  return {
    exchangeBootstrap(token) {
      const currentMs = readNow(now);
      purgeExpired(controls, currentMs);
      purgeExpired(events, currentMs);
      if (
        bootstrapConsumed ||
        currentMs >= bootstrapExpiresAtMs ||
        !tokensEqual(token, options.bootstrapToken)
      ) {
        return undefined;
      }
      const capability = issue(controls, events, maxControlSessions, controlTtlMs);
      bootstrapConsumed = true;
      return capability;
    },

    issueEventCapability(controlToken) {
      const currentMs = readNow(now);
      purgeExpired(controls, currentMs);
      purgeExpired(events, currentMs);
      if (!authenticate(controls, controlToken, currentMs)) return undefined;
      return issue(events, controls, maxEventCapabilities, eventTtlMs);
    },

    authenticateControl(token) {
      const currentMs = readNow(now);
      purgeExpired(controls, currentMs);
      purgeExpired(events, currentMs);
      return authenticate(controls, token, currentMs);
    },

    authenticateEvents(token) {
      const currentMs = readNow(now);
      purgeExpired(controls, currentMs);
      purgeExpired(events, currentMs);
      return authenticate(events, token, currentMs);
    },
  };
}

function defaultCreateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function createAndValidateToken(createToken: () => string): string {
  const token = createToken();
  assertToken(token, "createToken result");
  return token;
}

function assertToken(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !isToken(value)) {
    throw new TypeError(`${name} must be a 32-byte base64url token`);
  }
}

function isToken(value: string): boolean {
  return value.length === TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

function tokensEqual(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !isToken(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "ascii"), Buffer.from(expected, "ascii"));
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

function authenticate(
  store: ReadonlyMap<string, StoredCapability>,
  token: unknown,
  nowMs: number,
): boolean {
  if (typeof token !== "string" || !isToken(token)) return false;
  const entry = store.get(digestToken(token));
  return entry !== undefined && entry.expiresAtMs > nowMs;
}

function purgeExpired(store: Map<string, StoredCapability>, nowMs: number): void {
  for (const [digest, entry] of store) {
    if (entry.expiresAtMs <= nowMs) store.delete(digest);
  }
}

function discardOldest(store: Map<string, StoredCapability>): void {
  let oldestDigest: string | undefined;
  let oldest: StoredCapability | undefined;
  for (const [digest, entry] of store) {
    if (
      !oldest ||
      entry.issuedAtMs < oldest.issuedAtMs ||
      (entry.issuedAtMs === oldest.issuedAtMs && digest < oldestDigest!)
    ) {
      oldestDigest = digest;
      oldest = entry;
    }
  }
  if (oldestDigest) store.delete(oldestDigest);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function addTtl(nowMs: number, ttlMs: number): number {
  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError("Capability expiry exceeds the supported timestamp range");
  }
  return expiresAtMs;
}

function readNow(now: () => number | Date): number {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError("now must return a valid millisecond timestamp");
  }
  return milliseconds;
}
