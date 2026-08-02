import { createPublicKey, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import type {
  NativeGuardLeaseActivation,
  NativeGuardStatus,
} from "@agent-guard/contracts";

export type GuardedMarker = {
  leaseId: string;
  rootSessionKey: string;
  childSessionKeys: string[];
  mode: "detection" | "supervision";
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
};

export interface MarkerStore {
  load(): Promise<unknown[]>;
  write(marker: GuardedMarker): Promise<void>;
  remove(leaseId: string): Promise<void>;
}

export type OffLookup = { state: "off" };

export type RecoveryLookup = Omit<GuardedMarker, "childSessionKeys"> & {
  state: "recovery";
};

export type ActiveLeaseLookup = Readonly<NativeGuardLeaseActivation & {
  state: "active";
  childSessionKeys: readonly string[];
}>;

export type LeaseLookup = OffLookup | RecoveryLookup | ActiveLeaseLookup;

export type LeaseRegistryOptions = {
  markerStore: MarkerStore;
  now?: () => Date;
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const DECISION_PATH = "/api/v1/openclaw/native-guard/decision";
const MARKER_SUFFIX = ".json";
const MAX_MARKER_BYTES = 64 * 1024;

type ActiveRecord = {
  lease: ActiveLeaseLookup;
  parentByChild: Map<string, string>;
};

export class FileMarkerStore implements MarkerStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (
      typeof directory !== "string" ||
      directory.length === 0 ||
      directory.includes("\0") ||
      directory.split(/[\\/]+/).includes("..")
    ) {
      throw new TypeError("Native guard marker directory is invalid");
    }
    this.#directory = resolve(directory);
  }

  async load(): Promise<unknown[]> {
    if (!(await pathExists(this.#directory))) return [];
    await assertSecureDirectory(this.#directory);
    const markers: GuardedMarker[] = [];
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(MARKER_SUFFIX)) continue;
      const leaseId = entry.name.slice(0, -MARKER_SUFFIX.length);
      if (!safeId(leaseId) || entry.name !== markerFileName(leaseId)) continue;
      const path = join(this.#directory, entry.name);
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MARKER_BYTES) continue;
        const handle = await open(path, "r");
        let text: string;
        try {
          const buffer = Buffer.alloc(metadata.size);
          const result = await handle.read(buffer, 0, metadata.size, 0);
          if (result.bytesRead !== metadata.size) continue;
          text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } finally {
          await handle.close();
        }
        const marker = parseMarker(JSON.parse(text) as unknown);
        if (marker !== undefined && marker.leaseId === leaseId) markers.push(marker);
      } catch {
        // A bad entry cannot suppress recovery from other valid marker files.
      }
    }
    return markers;
  }

  async write(marker: GuardedMarker): Promise<void> {
    const parsedMarker = parseMarker(marker);
    if (parsedMarker === undefined) throw new TypeError("Native guard marker is invalid");
    await ensureSecureDirectory(this.#directory);
    const destination = join(this.#directory, markerFileName(parsedMarker.leaseId));
    await rejectSymlinkIfPresent(destination);
    const temporary = join(
      this.#directory,
      `.${parsedMarker.leaseId}.${process.pid}.${randomUUID()}.tmp`,
    );
    const contents = `${JSON.stringify(parsedMarker)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_MARKER_BYTES) {
      throw new TypeError("Native guard marker is too large");
    }

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(leaseId: string): Promise<void> {
    if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
    if (!(await pathExists(this.#directory))) return;
    await assertSecureDirectory(this.#directory);
    const path = join(this.#directory, markerFileName(leaseId));
    await rejectSymlinkIfPresent(path);
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export class LeaseRegistry {
  readonly #markerStore: MarkerStore;
  readonly #now: () => Date;
  readonly #recoveringBySession = new Map<string, GuardedMarker>();
  readonly #recoveringByLease = new Map<string, GuardedMarker>();
  readonly #activeByLease = new Map<string, ActiveRecord>();
  readonly #activeBySession = new Map<string, ActiveRecord>();
  #tail: Promise<void> = Promise.resolve();
  #started = false;

  constructor(options: LeaseRegistryOptions) {
    this.#markerStore = options.markerStore;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.#serialized(async () => {
      if (this.#started) return;
      const nowMs = this.#now().getTime();
      for (const rawMarker of await this.#markerStore.load()) {
        const marker = parseMarker(rawMarker);
        if (marker === undefined) continue;
        if (Date.parse(marker.expiresAt) <= nowMs) {
          await this.#markerStore.remove(marker.leaseId).catch(() => undefined);
          continue;
        }
        if (this.#markerCollides(marker)) continue;
        this.#recoveringByLease.set(marker.leaseId, marker);
        this.#recoveringBySession.set(marker.rootSessionKey, marker);
        for (const childSessionKey of marker.childSessionKeys) {
          this.#recoveringBySession.set(childSessionKey, marker);
        }
      }
      this.#started = true;
    });
  }

  async lookup(sessionKey: string): Promise<LeaseLookup> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const active = this.#activeBySession.get(sessionKey);
      if (active !== undefined) return active.lease;
      const marker = this.#recoveringBySession.get(sessionKey);
      if (marker === undefined) return { state: "off" };
      return recoveryLookup(marker);
    });
  }

  async activate(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const lease = parseActivation(input, this.#now());
      if (this.#activeByLease.has(lease.leaseId) || this.#hasRecoveringLease(lease.leaseId)) {
        throw new Error("Native guard lease ID is already registered");
      }
      if (this.#activeBySession.has(lease.rootSessionKey) || this.#recoveringBySession.has(lease.rootSessionKey)) {
        throw new Error("Native guard session is already registered");
      }

      await this.#markerStore.write(markerFromLease(lease));
      const record = { lease, parentByChild: new Map<string, string>() };
      this.#activeByLease.set(lease.leaseId, record);
      this.#activeBySession.set(lease.rootSessionKey, record);
      return this.#statusWithoutExpiry();
    });
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const candidate = parseActivation(input, this.#now());
      const record = this.#activeByLease.get(candidate.leaseId);
      if (record === undefined) throw new Error("Native guard lease is not active");
      const current = record.lease;
      if (
        candidate.rootSessionKey !== current.rootSessionKey ||
        candidate.mode !== current.mode ||
        candidate.policyPackId !== current.policyPackId ||
        candidate.policyPackDigest !== current.policyPackDigest ||
        candidate.leaseEpoch <= current.leaseEpoch ||
        candidate.credential === current.credential
      ) {
        throw new Error("Native guard lease renewal does not match the active lease");
      }
      const renewed = withChildSessionKeys(candidate, current.childSessionKeys);
      await this.#markerStore.write(markerFromLease(renewed));
      record.lease = renewed;
      return this.#statusWithoutExpiry();
    });
  }

  async revoke(leaseId: string): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const active = this.#activeByLease.get(leaseId);
      const recovering = this.#recoveringByLease.get(leaseId);
      if (active === undefined && recovering === undefined) return false;
      if (active !== undefined) this.#removeActive(active);
      if (recovering !== undefined) this.#removeRecovering(recovering);
      await this.#markerStore.remove(leaseId);
      return true;
    });
  }

  async bindChild(
    leaseId: string,
    parentSessionKey: string,
    childSessionKey: string,
  ): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeId(leaseId) || !safeSessionKey(parentSessionKey) || !safeSessionKey(childSessionKey)) {
        throw new TypeError("Native guard child binding is invalid");
      }
      const record = this.#activeByLease.get(leaseId);
      if (
        record === undefined ||
        this.#activeBySession.get(parentSessionKey) !== record ||
        this.#activeBySession.has(childSessionKey) ||
        this.#recoveringBySession.has(childSessionKey) ||
        childSessionKey === record.lease.rootSessionKey
      ) {
        return false;
      }

      const lease = withChildSessionKeys(record.lease, [
        ...record.lease.childSessionKeys,
        childSessionKey,
      ]);
      await this.#markerStore.write(markerFromLease(lease));
      record.lease = lease;
      record.parentByChild.set(childSessionKey, parentSessionKey);
      this.#activeBySession.set(childSessionKey, record);
      return true;
    });
  }

  async endSession(sessionKey: string): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeSessionKey(sessionKey)) throw new TypeError("Native guard session key is invalid");
      const active = this.#activeBySession.get(sessionKey);
      if (active !== undefined) {
        if (sessionKey === active.lease.rootSessionKey) {
          this.#removeActive(active);
          await this.#markerStore.remove(active.lease.leaseId);
          return true;
        }

        const subtree = collectSubtree(active.parentByChild, sessionKey);
        const retainedChildren = active.lease.childSessionKeys.filter((key) => !subtree.has(key));
        const lease = withChildSessionKeys(active.lease, retainedChildren);
        await this.#markerStore.write(markerFromLease(lease));
        active.lease = lease;
        for (const key of subtree) {
          active.parentByChild.delete(key);
          this.#activeBySession.delete(key);
        }
        return true;
      }

      const recovering = this.#recoveringBySession.get(sessionKey);
      if (recovering === undefined) return false;
      if (sessionKey === recovering.rootSessionKey) {
        this.#removeRecovering(recovering);
        await this.#markerStore.remove(recovering.leaseId);
        return true;
      }
      const marker = {
        ...recovering,
        childSessionKeys: recovering.childSessionKeys.filter((key) => key !== sessionKey),
      };
      await this.#markerStore.write(marker);
      this.#removeRecovering(recovering);
      this.#recoveringByLease.set(marker.leaseId, marker);
      this.#recoveringBySession.set(marker.rootSessionKey, marker);
      for (const childSessionKey of marker.childSessionKeys) {
        this.#recoveringBySession.set(childSessionKey, marker);
      }
      return true;
    });
  }

  async status(): Promise<NativeGuardStatus> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      return this.#statusWithoutExpiry();
    });
  }

  #statusWithoutExpiry(): NativeGuardStatus {
    const activeRecords = [...this.#activeByLease.values()];
    if (activeRecords.length === 0) {
      return {
        coverage: this.#recoveringBySession.size > 0 ? "recovery" : "off",
        finalizerAssurance: "unverified",
        activeLeaseCount: 0,
      };
    }
    const status: NativeGuardStatus = {
      coverage: "active",
      finalizerAssurance: "unverified",
      activeLeaseCount: activeRecords.length,
    };
    if (activeRecords.length === 1) {
      const lease = activeRecords[0].lease;
      status.activeLease = {
        leaseId: lease.leaseId,
        leaseEpoch: lease.leaseEpoch,
        rootSessionKey: lease.rootSessionKey,
        mode: lease.mode,
        policyPackId: lease.policyPackId,
        policyPackDigest: lease.policyPackDigest,
        expiresAt: lease.expiresAt,
      };
    }
    return status;
  }

  #hasRecoveringLease(leaseId: string): boolean {
    return this.#recoveringByLease.has(leaseId);
  }

  #markerCollides(marker: GuardedMarker): boolean {
    if (this.#recoveringByLease.has(marker.leaseId)) return true;
    return [marker.rootSessionKey, ...marker.childSessionKeys]
      .some((sessionKey) => this.#recoveringBySession.has(sessionKey));
  }

  async #purgeExpired(): Promise<void> {
    const nowMs = this.#now().getTime();
    const expiredLeaseIds = new Set<string>();
    for (const record of this.#activeByLease.values()) {
      if (Date.parse(record.lease.expiresAt) <= nowMs) {
        expiredLeaseIds.add(record.lease.leaseId);
        this.#removeActive(record);
      }
    }
    for (const marker of this.#recoveringByLease.values()) {
      if (Date.parse(marker.expiresAt) <= nowMs) {
        expiredLeaseIds.add(marker.leaseId);
        this.#removeRecovering(marker);
      }
    }
    for (const leaseId of expiredLeaseIds) {
      await this.#markerStore.remove(leaseId).catch(() => undefined);
    }
  }

  #removeActive(record: ActiveRecord): void {
    this.#activeByLease.delete(record.lease.leaseId);
    this.#activeBySession.delete(record.lease.rootSessionKey);
    for (const childSessionKey of record.lease.childSessionKeys) {
      this.#activeBySession.delete(childSessionKey);
    }
  }

  #removeRecovering(marker: GuardedMarker): void {
    this.#recoveringByLease.delete(marker.leaseId);
    this.#recoveringBySession.delete(marker.rootSessionKey);
    for (const childSessionKey of marker.childSessionKeys) {
      this.#recoveringBySession.delete(childSessionKey);
    }
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error("Native guard lease registry has not started");
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function recoveryLookup(marker: GuardedMarker): RecoveryLookup {
  return {
    state: "recovery",
    leaseId: marker.leaseId,
    rootSessionKey: marker.rootSessionKey,
    mode: marker.mode,
    policyPackId: marker.policyPackId,
    policyPackDigest: marker.policyPackDigest,
    expiresAt: marker.expiresAt,
  };
}

function parseActivation(
  value: NativeGuardLeaseActivation,
  now: Date,
): ActiveLeaseLookup {
  if (!isRecord(value)) throw new TypeError("Native guard activation must be an object");
  if (Object.keys(value).sort().join(",") !== [
    "backendUrl",
    "credential",
    "decisionPublicKey",
    "expiresAt",
    "failurePolicy",
    "issuedAt",
    "leaseEpoch",
    "leaseId",
    "mode",
    "policyPackDigest",
    "policyPackId",
    "rootSessionKey",
    "schemaVersion",
    "scope",
  ].join(",")) {
    throw invalidActivation();
  }
  if (value.schemaVersion !== "native-guard-1") throw invalidActivation();
  if (!safeId(value.leaseId)) throw invalidActivation();
  if (!Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch <= 0) throw invalidActivation();
  if (!safeSessionKey(value.rootSessionKey)) throw invalidActivation();
  if (value.mode !== "detection" && value.mode !== "supervision") throw invalidActivation();
  if (value.scope !== "session_tree") throw invalidActivation();
  if (!safeId(value.policyPackId) || !DIGEST.test(value.policyPackDigest)) throw invalidActivation();
  if (!validDecisionUrl(value.backendUrl)) throw invalidActivation();
  if (!validEd25519PublicKey(value.decisionPublicKey)) throw invalidActivation();
  if (!validFailurePolicy(value.failurePolicy)) throw invalidActivation();
  if (!isCanonicalTimestamp(value.issuedAt) || !isCanonicalTimestamp(value.expiresAt)) throw invalidActivation();
  const issuedAtMs = Date.parse(value.issuedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  if (issuedAtMs > now.getTime() || expiresAtMs <= now.getTime() || expiresAtMs <= issuedAtMs) {
    throw invalidActivation();
  }
  if (typeof value.credential !== "string" || value.credential.trim().length === 0 || value.credential.length > 4096) {
    throw invalidActivation();
  }

  const failurePolicy = Object.freeze({
    lowRisk: value.failurePolicy.lowRisk,
    highRisk: value.failurePolicy.highRisk,
    unknownRisk: value.failurePolicy.unknownRisk,
  });
  return Object.freeze({
    state: "active" as const,
    schemaVersion: "native-guard-1" as const,
    leaseId: value.leaseId,
    leaseEpoch: value.leaseEpoch,
    rootSessionKey: value.rootSessionKey,
    mode: value.mode,
    scope: "session_tree" as const,
    policyPackId: value.policyPackId,
    policyPackDigest: value.policyPackDigest,
    backendUrl: value.backendUrl,
    decisionPublicKey: value.decisionPublicKey,
    failurePolicy,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    credential: value.credential,
    childSessionKeys: Object.freeze([] as string[]),
  });
}

function markerFromLease(lease: ActiveLeaseLookup): GuardedMarker {
  return {
    leaseId: lease.leaseId,
    rootSessionKey: lease.rootSessionKey,
    childSessionKeys: [...lease.childSessionKeys].sort(),
    mode: lease.mode,
    policyPackId: lease.policyPackId,
    policyPackDigest: lease.policyPackDigest,
    expiresAt: lease.expiresAt,
  };
}

function withChildSessionKeys(
  lease: ActiveLeaseLookup,
  childSessionKeys: readonly string[],
): ActiveLeaseLookup {
  return Object.freeze({
    ...lease,
    childSessionKeys: Object.freeze([...childSessionKeys].sort()),
  });
}

function collectSubtree(
  parentByChild: ReadonlyMap<string, string>,
  root: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const [child, parent] of parentByChild) {
    const children = childrenByParent.get(parent) ?? [];
    children.push(child);
    childrenByParent.set(parent, children);
  }
  const subtree = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || subtree.has(current)) continue;
    subtree.add(current);
    pending.push(...(childrenByParent.get(current) ?? []));
  }
  return subtree;
}

function validDecisionUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.pathname === DECISION_PATH &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function validEd25519PublicKey(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(value)
  ) {
    return false;
  }
  try {
    const key = createPublicKey(value);
    return key.type === "public" && key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function validFailurePolicy(value: unknown): value is NativeGuardLeaseActivation["failurePolicy"] {
  return isRecord(value) &&
    Object.keys(value).sort().join(",") === "highRisk,lowRisk,unknownRisk" &&
    (value.lowRisk === "allow" || value.lowRisk === "warn") &&
    value.highRisk === "deny" &&
    value.unknownRisk === "deny";
}

function invalidActivation(): TypeError {
  return new TypeError("Native guard lease activation is invalid");
}

function markerFileName(leaseId: string): string {
  if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
  return `${leaseId}${MARKER_SUFFIX}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await assertSecureExistingAncestors(directory);
  if (!(await pathExists(directory))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await assertSecureDirectory(directory);
}

async function assertSecureExistingAncestors(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const segment of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("Native guard marker path contains a symbolic link");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Native guard marker path contains a non-directory ancestor");
    }
  }
}

async function assertSecureDirectory(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const segment of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Native guard marker path contains a symbolic link");
    }
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new Error("Native guard marker path is not a directory");
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Native guard marker path contains a symbolic link");
    }
    if (!metadata.isFile()) throw new Error("Native guard marker path is not a file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function parseMarker(value: unknown): GuardedMarker | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).sort().join(",") !==
    "childSessionKeys,expiresAt,leaseId,mode,policyPackDigest,policyPackId,rootSessionKey") {
    return undefined;
  }
  if (
    !safeId(value.leaseId) ||
    !safeSessionKey(value.rootSessionKey) ||
    !Array.isArray(value.childSessionKeys) ||
    !value.childSessionKeys.every(safeSessionKey) ||
    new Set(value.childSessionKeys).size !== value.childSessionKeys.length ||
    value.childSessionKeys.includes(value.rootSessionKey as string) ||
    (value.mode !== "detection" && value.mode !== "supervision") ||
    !safeId(value.policyPackId) ||
    typeof value.policyPackDigest !== "string" ||
    !DIGEST.test(value.policyPackDigest) ||
    !isCanonicalTimestamp(value.expiresAt)
  ) {
    return undefined;
  }
  return {
    leaseId: value.leaseId,
    rootSessionKey: value.rootSessionKey,
    childSessionKeys: [...value.childSessionKeys].sort(),
    mode: value.mode,
    policyPackId: value.policyPackId,
    policyPackDigest: value.policyPackDigest,
    expiresAt: value.expiresAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value) ||
    value.includes("..") ||
    value.endsWith(".")
  ) {
    return false;
  }
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value);
}

function safeSessionKey(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\/\x00-\x1f\x7f]/.test(value) &&
    !value.includes("..");
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
