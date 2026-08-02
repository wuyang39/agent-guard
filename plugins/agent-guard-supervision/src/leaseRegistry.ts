import { createPublicKey, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename as fsRename,
  unlink as fsUnlink,
} from "node:fs/promises";
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

export type FileMarkerStoreHooks = {
  readMarker?: (path: string, size: number) => Promise<string>;
  rename?: (source: string, destination: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
};

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
  flatRecoveryBindings: boolean;
};

export class FileMarkerStore implements MarkerStore {
  readonly #directory: string;
  readonly #readMarker: NonNullable<FileMarkerStoreHooks["readMarker"]>;
  readonly #rename: NonNullable<FileMarkerStoreHooks["rename"]>;
  readonly #unlink: NonNullable<FileMarkerStoreHooks["unlink"]>;
  readonly #syncDirectory: NonNullable<FileMarkerStoreHooks["syncDirectory"]>;

  constructor(directory: string, hooks: FileMarkerStoreHooks = {}) {
    if (
      typeof directory !== "string" ||
      directory.length === 0 ||
      directory.includes("\0") ||
      directory.split(/[\\/]+/).includes("..")
    ) {
      throw new TypeError("Native guard marker directory is invalid");
    }
    this.#directory = resolve(directory);
    this.#readMarker = hooks.readMarker ?? readMarkerFile;
    this.#rename = hooks.rename ?? fsRename;
    this.#unlink = hooks.unlink ?? fsUnlink;
    this.#syncDirectory = hooks.syncDirectory ?? syncDirectoryDurably;
  }

  async load(): Promise<unknown[]> {
    if (!(await pathExists(this.#directory))) return [];
    await assertSecureDirectory(this.#directory);
    const markers: GuardedMarker[] = [];
    for (const entry of await readdir(this.#directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(MARKER_SUFFIX)) continue;
      const leaseId = entry.name.slice(0, -MARKER_SUFFIX.length);
      if (!safeId(leaseId) || entry.name !== markerFileName(leaseId)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw markerCandidateError(entry.name);
      }
      const path = join(this.#directory, entry.name);
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw markerCandidateError(entry.name);
        assertSecurePosixMetadata(metadata, "marker");
        if (metadata.size > MAX_MARKER_BYTES) throw markerCandidateError(entry.name);
        const text = await this.#readMarker(path, metadata.size);
        const marker = parseMarker(JSON.parse(text) as unknown);
        if (marker === undefined || marker.leaseId !== leaseId) throw markerCandidateError(entry.name);
        markers.push(marker);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Native guard marker")) throw error;
        throw markerCandidateError(entry.name);
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
      await this.#rename(temporary, destination);
      await chmod(destination, 0o600);
      await this.#syncDirectory(this.#directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.#unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(leaseId: string): Promise<void> {
    if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
    if (!(await pathExists(this.#directory))) return;
    await assertSecureDirectory(this.#directory);
    const path = join(this.#directory, markerFileName(leaseId));
    await rejectSymlinkIfPresent(path);
    await this.#unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await this.#syncDirectory(this.#directory);
  }
}

export class LeaseRegistry {
  readonly #markerStore: MarkerStore;
  readonly #now: () => Date;
  readonly #recoveringBySession = new Map<string, GuardedMarker>();
  readonly #recoveringByLease = new Map<string, GuardedMarker>();
  readonly #recoveryConflictByLease = new Map<string, ReadonlySet<string>>();
  readonly #activeByLease = new Map<string, ActiveRecord>();
  readonly #activeBySession = new Map<string, ActiveRecord>();
  readonly #pendingDeletionLeaseIds = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  #started = false;

  constructor(options: LeaseRegistryOptions) {
    this.#markerStore = options.markerStore;
    this.#now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.#serialized(async () => {
      if (this.#started) return;
      const now = this.#readNow();
      const nowMs = now.getTime();
      const loadedMarkers: GuardedMarker[] = [];
      for (const rawMarker of await this.#markerStore.load()) {
        const marker = parseMarker(rawMarker);
        if (marker === undefined) {
          throw new Error("Native guard marker store returned an invalid marker");
        }
        loadedMarkers.push(marker);
      }
      loadedMarkers.sort(compareMarkers);
      for (let index = 1; index < loadedMarkers.length; index += 1) {
        if (loadedMarkers[index - 1].leaseId === loadedMarkers[index].leaseId) {
          throw new Error("Native guard marker set contains a duplicate lease ID");
        }
      }
      for (const marker of loadedMarkers) {
        if (Date.parse(marker.expiresAt) <= nowMs) {
          this.#pendingDeletionLeaseIds.add(marker.leaseId);
          continue;
        }
        this.#recoveringByLease.set(marker.leaseId, marker);
      }
      this.#rebuildRecoveryIndexes();
      await this.#retryPendingDeletions();
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
      const lease = parseActivation(input, this.#readNow());
      if (this.#pendingDeletionLeaseIds.has(lease.leaseId)) {
        throw new Error("Native guard lease marker deletion is pending");
      }
      if (this.#activeByLease.has(lease.leaseId)) {
        throw new Error("Native guard lease ID is already registered");
      }
      if (this.#activeBySession.has(lease.rootSessionKey)) {
        throw new Error("Native guard session is already registered");
      }

      const recovering = this.#recoveringBySession.get(lease.rootSessionKey);
      if (recovering !== undefined && recovering.rootSessionKey === lease.rootSessionKey) {
        if (this.#recoveryConflictByLease.has(recovering.leaseId)) {
          throw new Error("Native guard recovery markers conflict");
        }
        if (
          recovering.mode !== lease.mode ||
          recovering.policyPackId !== lease.policyPackId ||
          recovering.policyPackDigest !== lease.policyPackDigest ||
          (recovering.leaseId !== lease.leaseId && this.#hasRecoveringLease(lease.leaseId))
        ) {
          throw new Error("Native guard recovery activation does not match the guarded marker");
        }
        const recoveredLease = withChildSessionKeys(lease, recovering.childSessionKeys);
        await this.#markerStore.write(markerFromLease(recoveredLease));
        if (recovering.leaseId !== recoveredLease.leaseId) {
          try {
            await this.#markerStore.remove(recovering.leaseId);
          } catch (error) {
            await this.#markerStore.remove(recoveredLease.leaseId).catch(() => undefined);
            throw error;
          }
        }
        this.#removeRecovering(recovering);
        this.#addActive(recoveredLease, recovering.childSessionKeys, recovering.childSessionKeys.length > 0);
        return this.#statusWithoutExpiry();
      }

      if (this.#hasRecoveringLease(lease.leaseId)) {
        throw new Error("Native guard lease ID is already registered");
      }
      if (recovering !== undefined || this.#recoveringBySession.has(lease.rootSessionKey)) {
        throw new Error("Native guard session is already registered");
      }

      await this.#markerStore.write(markerFromLease(lease));
      this.#addActive(lease);
      return this.#statusWithoutExpiry();
    });
  }

  async renew(input: NativeGuardLeaseActivation): Promise<NativeGuardStatus> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const candidate = parseActivation(input, this.#readNow());
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
      return this.#revokeWithoutPurge(leaseId);
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
          await this.#markerStore.remove(active.lease.leaseId);
          this.#removeActive(active);
          return true;
        }

        const subtree = active.flatRecoveryBindings
          ? new Set([sessionKey])
          : collectSubtree(active.parentByChild, sessionKey);
        const retainedChildren = active.lease.childSessionKeys.filter((key) => !subtree.has(key));
        const lease = withChildSessionKeys(active.lease, retainedChildren);
        await this.#markerStore.write(markerFromLease(lease));
        active.lease = lease;
        for (const key of subtree) {
          active.parentByChild.delete(key);
          this.#activeBySession.delete(key);
        }
        if (active.lease.childSessionKeys.length === 0) active.flatRecoveryBindings = false;
        return true;
      }

      const recovering = this.#recoveringBySession.get(sessionKey);
      if (recovering === undefined) return false;
      if (sessionKey === recovering.rootSessionKey) {
        return this.#revokeWithoutPurge(recovering.leaseId);
      }
      if (this.#recoveryConflictByLease.has(recovering.leaseId)) return false;
      const marker = {
        ...recovering,
        childSessionKeys: recovering.childSessionKeys.filter((key) => key !== sessionKey),
      };
      await this.#markerStore.write(marker);
      this.#recoveringByLease.set(marker.leaseId, marker);
      this.#rebuildRecoveryIndexes();
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
    const hasRecovery = this.#recoveringByLease.size > 0;
    if (activeRecords.length === 0) {
      return {
        coverage: hasRecovery ? "recovery" : "off",
        finalizerAssurance: "unverified",
        activeLeaseCount: 0,
      };
    }
    const status: NativeGuardStatus = {
      coverage: hasRecovery ? "recovery" : "active",
      finalizerAssurance: "unverified",
      activeLeaseCount: activeRecords.length,
    };
    if (activeRecords.length === 1 && !hasRecovery) {
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

  async #purgeExpired(): Promise<void> {
    const nowMs = this.#readNow().getTime();
    await this.#retryPendingDeletions();
    for (const record of this.#activeByLease.values()) {
      if (Date.parse(record.lease.expiresAt) <= nowMs) {
        this.#pendingDeletionLeaseIds.add(record.lease.leaseId);
        this.#removeActive(record);
      }
    }
    for (const marker of this.#recoveringByLease.values()) {
      if (Date.parse(marker.expiresAt) <= nowMs) {
        this.#pendingDeletionLeaseIds.add(marker.leaseId);
        this.#removeRecovering(marker);
      }
    }
    await this.#retryPendingDeletions();
  }

  #removeActive(record: ActiveRecord): void {
    this.#activeByLease.delete(record.lease.leaseId);
    this.#activeBySession.delete(record.lease.rootSessionKey);
    for (const childSessionKey of record.lease.childSessionKeys) {
      this.#activeBySession.delete(childSessionKey);
    }
  }

  #addActive(
    lease: ActiveLeaseLookup,
    childSessionKeys: readonly string[] = [],
    flatRecoveryBindings = false,
  ): void {
    const parentByChild = new Map<string, string>();
    for (const childSessionKey of childSessionKeys) {
      parentByChild.set(childSessionKey, lease.rootSessionKey);
    }
    const record = { lease, parentByChild, flatRecoveryBindings };
    this.#activeByLease.set(lease.leaseId, record);
    this.#activeBySession.set(lease.rootSessionKey, record);
    for (const childSessionKey of lease.childSessionKeys) {
      this.#activeBySession.set(childSessionKey, record);
    }
  }

  #removeRecovering(marker: GuardedMarker): void {
    this.#recoveringByLease.delete(marker.leaseId);
    this.#rebuildRecoveryIndexes();
  }

  async #revokeWithoutPurge(leaseId: string): Promise<boolean> {
    const active = this.#activeByLease.get(leaseId);
    const conflict = this.#recoveryConflictByLease.get(leaseId);
    const recoveryLeaseIds = conflict === undefined
      ? (this.#recoveringByLease.has(leaseId) ? [leaseId] : [])
      : [...conflict].sort();
    if (active === undefined && recoveryLeaseIds.length === 0) {
      if (!this.#pendingDeletionLeaseIds.has(leaseId)) return false;
      await this.#markerStore.remove(leaseId);
      this.#pendingDeletionLeaseIds.delete(leaseId);
      return true;
    }
    const leaseIds = active === undefined ? recoveryLeaseIds : [leaseId];
    for (const markerLeaseId of leaseIds) {
      await this.#markerStore.remove(markerLeaseId);
    }
    if (active !== undefined) this.#removeActive(active);
    for (const markerLeaseId of recoveryLeaseIds) {
      this.#recoveringByLease.delete(markerLeaseId);
    }
    if (recoveryLeaseIds.length > 0) this.#rebuildRecoveryIndexes();
    return true;
  }

  async #retryPendingDeletions(): Promise<void> {
    for (const leaseId of [...this.#pendingDeletionLeaseIds].sort()) {
      try {
        await this.#markerStore.remove(leaseId);
        this.#pendingDeletionLeaseIds.delete(leaseId);
      } catch {
        // The lease remains unavailable; a later serialized boundary retries cleanup.
      }
    }
  }

  #rebuildRecoveryIndexes(): void {
    this.#recoveringBySession.clear();
    this.#recoveryConflictByLease.clear();
    const markers = [...this.#recoveringByLease.values()].sort(compareMarkers);
    const parent = new Map(markers.map((marker) => [marker.leaseId, marker.leaseId]));
    const markersBySession = new Map<string, GuardedMarker[]>();
    for (const marker of markers) {
      for (const sessionKey of [marker.rootSessionKey, ...marker.childSessionKeys]) {
        const candidates = markersBySession.get(sessionKey) ?? [];
        candidates.push(marker);
        markersBySession.set(sessionKey, candidates);
      }
    }
    const find = (leaseId: string): string => {
      let root = leaseId;
      while (parent.get(root) !== root) root = parent.get(root) ?? root;
      let current = leaseId;
      while (current !== root) {
        const next = parent.get(current) ?? root;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (left: string, right: string): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      const [first, second] = [leftRoot, rightRoot].sort();
      parent.set(second, first);
    };
    for (const [sessionKey, candidates] of markersBySession) {
      candidates.sort(compareMarkers);
      this.#recoveringBySession.set(sessionKey, candidates[0]);
      for (let index = 1; index < candidates.length; index += 1) {
        union(candidates[0].leaseId, candidates[index].leaseId);
      }
    }
    const groups = new Map<string, string[]>();
    for (const marker of markers) {
      const root = find(marker.leaseId);
      const group = groups.get(root) ?? [];
      group.push(marker.leaseId);
      groups.set(root, group);
    }
    for (const leaseIds of groups.values()) {
      if (leaseIds.length < 2) continue;
      const conflict = new Set(leaseIds.sort());
      for (const leaseId of conflict) this.#recoveryConflictByLease.set(leaseId, conflict);
    }
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error("Native guard lease registry has not started");
  }

  #readNow(): Date {
    const now = this.#now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Native guard lease registry clock is invalid");
    }
    return new Date(now.getTime());
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

function compareMarkers(left: GuardedMarker, right: GuardedMarker): number {
  if (left.leaseId < right.leaseId) return -1;
  if (left.leaseId > right.leaseId) return 1;
  if (left.rootSessionKey < right.rootSessionKey) return -1;
  if (left.rootSessionKey > right.rootSessionKey) return 1;
  return 0;
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
    const hostname = url.hostname.toLowerCase();
    const port = url.port === "" ? 80 : Number(url.port);
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(hostname) &&
      url.pathname === DECISION_PATH &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535;
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
  let created = false;
  if (!(await pathExists(directory))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    created = true;
  }
  await assertSecureDirectory(directory);
  if (created) {
    await chmod(directory, 0o700);
    await assertSecureDirectory(directory);
  }
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
  assertSecurePosixMetadata(metadata, "marker directory");
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Native guard marker path contains a symbolic link");
    }
    if (!metadata.isFile()) throw new Error("Native guard marker path is not a file");
    assertSecurePosixMetadata(metadata, "marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertSecurePosixMetadata(metadata: Stats, kind: string): void {
  // Node mode/uid fields do not represent Windows ACL ownership semantics.
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (metadata.uid !== process.getuid()) {
    throw new Error(`Native guard ${kind} owner is invalid`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`Native guard ${kind} permissions are invalid`);
  }
}

async function readMarkerFile(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, 0);
    if (result.bytesRead !== size) throw new Error("Native guard marker read was truncated");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    await handle.close();
  }
}

async function syncDirectoryDurably(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EINVAL" || code === "ENOTSUP" || code === "EBADF")
      ) {
        // Windows Node cannot fsync directory handles; file fsync still precedes rename.
        return;
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function markerCandidateError(fileName: string): Error {
  return new Error(`Native guard marker candidate is unsafe: ${fileName}`);
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
