import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
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
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type {
  NativeGuardEvidenceProof,
  NativeGuardLeaseActivation,
  NativeGuardLeaseScope,
  NativeGuardLeaseSummary,
  NativeGuardStatus,
} from "@agent-guard/contracts";
import {
  digestJson,
  nativeGuardScopesEqual,
  normalizeNativeGuardLeaseScope,
  parseCanonicalOpenClawSessionKey,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";

export type GuardedMarker = {
  leaseId: string;
  leaseEpoch?: number;
  rootSessionKey: string;
  childSessionKeys: string[];
  sessionBindings?: SessionBinding[];
  mode: "detection" | "supervision";
  scope: NativeGuardLeaseScope;
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
  lifecycleIntent?: LifecycleIntent;
  lifecycleQueue?: LifecycleIntent[];
  lifecycleOverflow?: true;
  rootTombstone?: {
    leaseEpoch: number;
    endedAt: string;
  };
};

export type SessionBinding = {
  childSessionKey: string;
  parentSessionKey: string;
};

export type LifecycleIntent =
  | {
      kind: "bind_child";
      parentSessionKey: string;
      childSessionKey: string;
      evidenceRequest?: NativeGuardEvidenceProof;
    }
  | {
      kind: "end_session";
      sessionKey: string;
      evidenceRequest?: NativeGuardEvidenceProof;
    };

export interface MarkerStore {
  load(): Promise<unknown[]>;
  write(marker: GuardedMarker): Promise<void>;
  remove(leaseId: string): Promise<void>;
}

export type FileMarkerStoreHooks = {
  createDirectory?: (directory: string) => Promise<void>;
  readMarker?: (path: string, size: number) => Promise<string>;
  rename?: (source: string, destination: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
  syncDirectory?: (directory: string) => Promise<void>;
};

export type OffLookup = { state: "off" };

export type IdentityMismatchLookup = { state: "identity_mismatch" };

export type RecoveryLookup = Omit<
  GuardedMarker,
  "childSessionKeys" | "lifecycleIntent" | "sessionBindings"
> & {
  state: "recovery";
};

export type LifecyclePendingLookup = Omit<
  GuardedMarker,
  "childSessionKeys" | "lifecycleIntent" | "sessionBindings"
> & {
  state: "lifecycle_pending";
};

export type RootEndedLookup = Omit<
  GuardedMarker,
  | "childSessionKeys"
  | "lifecycleIntent"
  | "lifecycleQueue"
  | "rootTombstone"
  | "sessionBindings"
> & {
  state: "root_ended";
};

export type ActiveLeaseLookup = Readonly<NativeGuardLeaseActivation & {
  state: "active";
  childSessionKeys: readonly string[];
}>;

export type RootEndedEvidenceLookup = Readonly<NativeGuardLeaseActivation & {
  state: "root_ended";
  childSessionKeys: readonly string[];
}>;

export type LeaseLookup =
  | OffLookup
  | IdentityMismatchLookup
  | RecoveryLookup
  | LifecyclePendingLookup
  | RootEndedLookup
  | ActiveLeaseLookup;

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
  lifecycleQueue: LifecycleIntent[];
  lifecycleOverflow: boolean;
};

type RootEndedRecord = {
  lease: RootEndedEvidenceLookup;
  sessionKeys: readonly string[];
  tombstone: NonNullable<GuardedMarker["rootTombstone"]>;
};

const MAX_LIFECYCLE_QUEUE_ITEMS = 128;
const MAX_SESSION_BINDINGS = 512;

class LifecycleMarkerCapacityError extends Error {
  constructor() {
    super("Native guard lifecycle queue exceeds its marker limit");
    this.name = "LifecycleMarkerCapacityError";
  }
}

export class FileMarkerStore implements MarkerStore {
  readonly #directory: string;
  readonly #createDirectory: NonNullable<FileMarkerStoreHooks["createDirectory"]>;
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
    assertWindowsUserRoot(this.#directory);
    this.#createDirectory = hooks.createDirectory ?? createMarkerDirectory;
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
    await ensureSecureDirectory(this.#directory, this.#createDirectory, this.#syncDirectory);
    const destination = join(this.#directory, markerFileName(parsedMarker.leaseId));
    await rejectSymlinkIfPresent(destination);
    const temporary = join(
      this.#directory,
      `.${parsedMarker.leaseId}.${process.pid}.${randomUUID()}.tmp`,
    );
    const contents = serializedMarkerContents(parsedMarker);
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
  readonly #recoveringByAgent = new Map<string, GuardedMarker>();
  readonly #recoveringByLease = new Map<string, GuardedMarker>();
  readonly #recoveryConflictByLease = new Map<string, ReadonlySet<string>>();
  readonly #activeByLease = new Map<string, ActiveRecord>();
  readonly #activeBySession = new Map<string, ActiveRecord>();
  readonly #activeByAgent = new Map<string, ActiveRecord>();
  readonly #rootEndedByLease = new Map<string, RootEndedRecord>();
  readonly #rootEndedBySession = new Map<string, RootEndedRecord>();
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
      if (active !== undefined) {
        return active.lifecycleQueue.length === 0 && !active.lifecycleOverflow
          ? active.lease
          : lifecyclePendingLookup(markerFromLease(
              active.lease,
              active.parentByChild,
              active.lifecycleQueue,
              active.lifecycleOverflow,
            ));
      }
      const rootEnded = this.#rootEndedBySession.get(sessionKey);
      if (rootEnded !== undefined) return rootEndedLookup(rootEnded.lease);
      const marker = this.#recoveringBySession.get(sessionKey);
      if (marker !== undefined) return markerLookup(marker);

      const parsedSession = parseCanonicalOpenClawSessionKey(sessionKey);
      if (parsedSession?.agentId === "main") {
        const agentActive = this.#activeByAgent.get("main");
        if (agentActive !== undefined) {
          return agentActive.lifecycleQueue.length === 0 && !agentActive.lifecycleOverflow
            ? agentActive.lease
            : lifecyclePendingLookup(markerFromLease(
                agentActive.lease,
                agentActive.parentByChild,
                agentActive.lifecycleQueue,
                agentActive.lifecycleOverflow,
              ));
        }
        const agentRecovery = this.#recoveringByAgent.get("main");
        if (agentRecovery !== undefined) return markerLookup(agentRecovery);
      }
      if (
        parsedSession === undefined &&
        (sessionKey === "agent:main" || sessionKey.startsWith("agent:main:")) &&
        (this.#activeByAgent.has("main") || this.#recoveringByAgent.has("main"))
      ) {
        return { state: "identity_mismatch" };
      }
      return { state: "off" };
    });
  }

  async lookupActiveLease(leaseId: string): Promise<ActiveLeaseLookup | undefined> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
      return this.#activeByLease.get(leaseId)?.lease;
    });
  }

  async hasSessionScopedCoverage(): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      return this.#activeBySession.size > 0 ||
        this.#recoveringBySession.size > 0 ||
        this.#rootEndedBySession.size > 0;
    });
  }

  async hasAgentScopedCoverage(agentId: "main"): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      return this.#activeByAgent.has(agentId) || this.#recoveringByAgent.has(agentId);
    });
  }

  async lookupEvidenceLease(
    leaseId: string,
  ): Promise<ActiveLeaseLookup | RootEndedEvidenceLookup | undefined> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
      return this.#activeByLease.get(leaseId)?.lease ?? this.#rootEndedByLease.get(leaseId)?.lease;
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
      if (this.#scopeHasActiveRecord(lease)) {
        throw new Error("Native guard session is already registered");
      }

      const recovering = this.#recoveringForScope(lease.scope, lease.rootSessionKey);
      if (recovering !== undefined) {
        if (this.#recoveryConflictByLease.has(recovering.leaseId)) {
          throw new Error("Native guard recovery markers conflict");
        }
        if (
          recovering.mode !== lease.mode ||
          recovering.policyPackId !== lease.policyPackId ||
          recovering.policyPackDigest !== lease.policyPackDigest ||
          !nativeGuardScopesEqual(recovering, lease) ||
          (recovering.leaseId !== lease.leaseId && this.#hasRecoveringLease(lease.leaseId))
        ) {
          throw new Error("Native guard recovery activation does not match the guarded marker");
        }
        if (recovering.rootTombstone !== undefined) {
          if (
            recovering.leaseId !== lease.leaseId ||
            lease.leaseEpoch < recovering.rootTombstone.leaseEpoch
          ) {
            throw new Error("Native guard root tombstone does not match the evidence lease");
          }
          const endedLease = rootEndedEvidenceLease(
            withChildSessionKeys(lease, recovering.childSessionKeys),
          );
          const recoveryParentByChild = markerParentByChild(recovering);
          await this.#markerStore.write(markerFromRootTombstone(
            endedLease,
            recovering.rootTombstone,
            recoveryParentByChild,
          ));
          this.#removeRecovering(recovering);
          this.#addRootEnded(endedLease, recovering.childSessionKeys, recovering.rootTombstone);
          return this.#statusWithoutExpiry();
        }
        const recoveredLease = withChildSessionKeys(lease, recovering.childSessionKeys);
        const recoveryQueue = markerLifecycleQueue(recovering);
        const recoveryParentByChild = markerParentByChild(recovering);
        await this.#markerStore.write(markerFromLease(
          recoveredLease,
          recoveryParentByChild,
          recoveryQueue,
          recovering.lifecycleOverflow === true,
        ));
        if (recovering.leaseId !== recoveredLease.leaseId) {
          try {
            await this.#markerStore.remove(recovering.leaseId);
          } catch (error) {
            await this.#markerStore.remove(recoveredLease.leaseId).catch(() => undefined);
            throw error;
          }
        }
        this.#removeRecovering(recovering);
        this.#addActive(
          recoveredLease,
          recovering.childSessionKeys,
          recovering.sessionBindings === undefined && recovering.childSessionKeys.length > 0,
          recoveryQueue,
          recovering.lifecycleOverflow === true,
          recoveryParentByChild,
        );
        return this.#statusWithoutExpiry();
      }

      const recoveringLeaseId = this.#recoveringByLease.get(lease.leaseId);
      if (
        recoveringLeaseId !== undefined &&
        !nativeGuardScopesEqual(recoveringLeaseId, lease)
      ) {
        throw new Error("Native guard recovery activation does not match the guarded marker");
      }
      if (this.#hasRecoveringLease(lease.leaseId)) {
        throw new Error("Native guard lease ID is already registered");
      }
      if (this.#scopeHasRecoveringRecord(lease)) {
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
      if (record.lifecycleQueue.length > 0 || record.lifecycleOverflow) {
        throw new Error("Native guard lease renewal is blocked by pending lifecycle work");
      }
      const current = record.lease;
      if (
        candidate.rootSessionKey !== current.rootSessionKey ||
        !nativeGuardScopesEqual(candidate, current) ||
        candidate.mode !== current.mode ||
        candidate.policyPackId !== current.policyPackId ||
        candidate.policyPackDigest !== current.policyPackDigest ||
        candidate.leaseEpoch <= current.leaseEpoch ||
        candidate.credential === current.credential ||
        candidate.evidenceCredential === current.evidenceCredential ||
        candidate.evidenceSigningKeyId === current.evidenceSigningKeyId ||
        candidate.evidenceSigningPrivateKey === current.evidenceSigningPrivateKey
      ) {
        throw new Error("Native guard lease renewal does not match the active lease");
      }
      const renewed = withChildSessionKeys(candidate, current.childSessionKeys);
      await this.#markerStore.write(markerFromLease(
        renewed,
        record.parentByChild,
        record.lifecycleQueue,
        record.lifecycleOverflow,
      ));
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
      if (record !== undefined && isAgentScope(record.lease.scope)) {
        if (
          record.lifecycleQueue.length > 0 ||
          record.lifecycleOverflow ||
          !sameMainAgentSessions(parentSessionKey, childSessionKey) ||
          childSessionKey === record.lease.rootSessionKey ||
          record.parentByChild.has(childSessionKey)
        ) return false;
        const lease = withChildSessionKeys(record.lease, [
          ...record.lease.childSessionKeys,
          childSessionKey,
        ]);
        const parentByChild = new Map(record.parentByChild);
        parentByChild.set(childSessionKey, parentSessionKey);
        await this.#markerStore.write(markerFromLease(lease, parentByChild));
        record.lease = lease;
        record.parentByChild = parentByChild;
        return true;
      }
      if (
        record === undefined ||
        record.lifecycleQueue.length > 0 ||
        record.lifecycleOverflow ||
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
      const parentByChild = new Map(record.parentByChild);
      parentByChild.set(childSessionKey, parentSessionKey);
      await this.#markerStore.write(markerFromLease(lease, parentByChild));
      record.lease = lease;
      record.parentByChild = parentByChild;
      this.#activeBySession.set(childSessionKey, record);
      return true;
    });
  }

  async prepareChildBinding(
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
      const expected: LifecycleIntent = { kind: "bind_child", parentSessionKey, childSessionKey };
      const exactIndex = record?.lifecycleQueue.findIndex((intent) =>
        sameLifecycleIntent(intent, expected)) ?? -1;
      if (record !== undefined && isAgentScope(record.lease.scope)) {
        if (!sameMainAgentSessions(parentSessionKey, childSessionKey)) return false;
        if (exactIndex >= 0) return true;
        if (
          childSessionKey === record.lease.rootSessionKey ||
          record.parentByChild.has(childSessionKey) ||
          record.lifecycleQueue.some((intent) =>
            intent.kind === "bind_child" && intent.childSessionKey === childSessionKey)
        ) return false;
        if (record.lifecycleOverflow || record.lifecycleQueue.length >= MAX_LIFECYCLE_QUEUE_ITEMS) {
          await this.#markLifecycleOverflow(record);
          return false;
        }
        const queue = [...record.lifecycleQueue, expected];
        let candidateMarker: GuardedMarker;
        try {
          candidateMarker = markerFromLease(record.lease, record.parentByChild, queue);
        } catch (error) {
          if (error instanceof LifecycleMarkerCapacityError) {
            await this.#markLifecycleOverflow(record);
            return false;
          }
          throw error;
        }
        await this.#markerStore.write(candidateMarker);
        record.lifecycleQueue = queue;
        return true;
      }
      if (record !== undefined && exactIndex >= 0) {
        const prefixTree = projectLifecycleTree(record, record.lifecycleQueue.slice(0, exactIndex));
        return prefixTree !== undefined &&
          prefixTree.sessionKeys.has(parentSessionKey) &&
          !prefixTree.sessionKeys.has(childSessionKey);
      }
      const projectedTree = record === undefined ? undefined : projectLifecycleTree(record);
      const activeChild = this.#activeBySession.get(childSessionKey);
      if (
        record === undefined ||
        projectedTree === undefined ||
        !projectedTree.sessionKeys.has(parentSessionKey) ||
        projectedTree.sessionKeys.has(childSessionKey) ||
        (activeChild !== undefined && activeChild !== record) ||
        this.#recoveringBySession.has(childSessionKey) ||
        childSessionKey === record.lease.rootSessionKey
      ) return false;
      if (record.lifecycleOverflow || record.lifecycleQueue.length >= MAX_LIFECYCLE_QUEUE_ITEMS) {
        await this.#markLifecycleOverflow(record);
        return false;
      }
      const queue = [...record.lifecycleQueue, expected];
      let candidateMarker: GuardedMarker;
      try {
        candidateMarker = markerFromLease(record.lease, record.parentByChild, queue);
      } catch (error) {
        if (error instanceof LifecycleMarkerCapacityError) {
          await this.#markLifecycleOverflow(record);
          return false;
        }
        throw error;
      }
      await this.#markerStore.write(candidateMarker);
      record.lifecycleQueue = queue;
      this.#activeBySession.set(childSessionKey, record);
      return true;
    });
  }

  async completeChildBinding(
    leaseId: string,
    parentSessionKey: string,
    childSessionKey: string,
  ): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const record = this.#activeByLease.get(leaseId);
      const expected: LifecycleIntent = { kind: "bind_child", parentSessionKey, childSessionKey };
      if (record === undefined || !sameLifecycleIntent(record.lifecycleQueue[0], expected)) return false;
      if (isAgentScope(record.lease.scope)) {
        const lease = withChildSessionKeys(record.lease, [
          ...record.lease.childSessionKeys,
          childSessionKey,
        ]);
        const queue = record.lifecycleQueue.slice(1);
        const parentByChild = new Map(record.parentByChild);
        parentByChild.set(childSessionKey, parentSessionKey);
        await this.#markerStore.write(markerFromLease(
          lease,
          parentByChild,
          queue,
          record.lifecycleOverflow,
        ));
        record.lease = lease;
        record.lifecycleQueue = queue;
        record.parentByChild = parentByChild;
        return true;
      }
      const lease = withChildSessionKeys(record.lease, [
        ...record.lease.childSessionKeys,
        childSessionKey,
      ]);
      const queue = record.lifecycleQueue.slice(1);
      const parentByChild = new Map(record.parentByChild);
      parentByChild.set(childSessionKey, parentSessionKey);
      await this.#markerStore.write(markerFromLease(
        lease,
        parentByChild,
        queue,
        record.lifecycleOverflow,
      ));
      record.lease = lease;
      record.lifecycleQueue = queue;
      record.parentByChild = parentByChild;
      this.#activeBySession.set(childSessionKey, record);
      return true;
    });
  }

  async pendingLifecycle(leaseId: string): Promise<LifecycleIntent | undefined> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeId(leaseId)) throw new TypeError("Native guard lease ID is invalid");
      const intent = this.#activeByLease.get(leaseId)?.lifecycleQueue[0] ??
        markerLifecycleQueue(this.#recoveringByLease.get(leaseId))[0];
      return intent === undefined ? undefined : structuredClone(intent);
    });
  }

  async attachLifecycleEvidenceRequest(
    leaseId: string,
    expected: LifecycleIntent,
    proof: NativeGuardEvidenceProof,
  ): Promise<LifecycleIntent> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const record = this.#activeByLease.get(leaseId);
      const head = record?.lifecycleQueue[0];
      if (record === undefined || head === undefined || !sameLifecycleIntent(head, expected)) {
        throw new Error("Native guard lifecycle queue head changed");
      }
      if (head.evidenceRequest !== undefined) {
        if (digestJson(head.evidenceRequest) !== digestJson(proof)) {
          throw new Error("Native guard lifecycle evidence request changed");
        }
        return structuredClone(head);
      }
      if (!validLifecycleEvidenceRequest(record.lease, head, proof)) {
        throw new Error("Native guard lifecycle evidence request is invalid");
      }
      const attached = { ...head, evidenceRequest: structuredClone(proof) } as LifecycleIntent;
      const queue = [attached, ...record.lifecycleQueue.slice(1)];
      await this.#markerStore.write(markerFromLease(
        record.lease,
        record.parentByChild,
        queue,
        record.lifecycleOverflow,
      ));
      record.lifecycleQueue = queue;
      return structuredClone(attached);
    });
  }

  async prepareSessionEnd(sessionKey: string): Promise<LifecycleIntent | undefined> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeSessionKey(sessionKey)) throw new TypeError("Native guard session key is invalid");
      const exactRecord = this.#activeBySession.get(sessionKey);
      const parsedSession = parseCanonicalOpenClawSessionKey(sessionKey);
      const record = exactRecord ?? (parsedSession?.agentId === "main"
        ? this.#activeByAgent.get("main")
        : undefined);
      if (record === undefined) return undefined;
      const expected: LifecycleIntent = { kind: "end_session", sessionKey };
      const exactIndex = record.lifecycleQueue.findIndex((intent) =>
        sameLifecycleIntent(intent, expected));
      if (isAgentScope(record.lease.scope)) {
        if (parsedSession?.agentId !== record.lease.scope.agentId) return undefined;
        if (exactIndex >= 0) return structuredClone(expected);
        if (record.lifecycleOverflow || record.lifecycleQueue.length >= MAX_LIFECYCLE_QUEUE_ITEMS) {
          await this.#markLifecycleOverflow(record);
          return undefined;
        }
        const queue = [...record.lifecycleQueue, expected];
        let candidateMarker: GuardedMarker;
        try {
          candidateMarker = markerFromLease(record.lease, record.parentByChild, queue);
        } catch (error) {
          if (error instanceof LifecycleMarkerCapacityError) {
            await this.#markLifecycleOverflow(record);
            return undefined;
          }
          throw error;
        }
        await this.#markerStore.write(candidateMarker);
        record.lifecycleQueue = queue;
        return structuredClone(expected);
      }
      if (exactIndex >= 0) {
        const prefixTree = projectLifecycleTree(record, record.lifecycleQueue.slice(0, exactIndex));
        return prefixTree?.sessionKeys.has(sessionKey) === true
          ? structuredClone(expected)
          : undefined;
      }
      const projectedTree = projectLifecycleTree(record);
      if (projectedTree === undefined || !projectedTree.sessionKeys.has(sessionKey)) {
        return undefined;
      }
      if (record.lifecycleOverflow || record.lifecycleQueue.length >= MAX_LIFECYCLE_QUEUE_ITEMS) {
        await this.#markLifecycleOverflow(record);
        return undefined;
      }
      const queue = [...record.lifecycleQueue, expected];
      let candidateMarker: GuardedMarker;
      try {
        candidateMarker = markerFromLease(record.lease, record.parentByChild, queue);
      } catch (error) {
        if (error instanceof LifecycleMarkerCapacityError) {
          await this.#markLifecycleOverflow(record);
          return undefined;
        }
        throw error;
      }
      await this.#markerStore.write(candidateMarker);
      record.lifecycleQueue = queue;
      return structuredClone(expected);
    });
  }

  async completeSessionEnd(leaseId: string, sessionKey: string): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      const record = this.#activeByLease.get(leaseId);
      const expected: LifecycleIntent = { kind: "end_session", sessionKey };
      if (record === undefined || !sameLifecycleIntent(record.lifecycleQueue[0], expected)) return false;
      if (isAgentScope(record.lease.scope)) {
        const subtree = collectSubtree(record.parentByChild, sessionKey);
        const lease = withChildSessionKeys(
          record.lease,
          record.lease.childSessionKeys.filter((key) => !subtree.has(key)),
        );
        const queue = record.lifecycleQueue.slice(1);
        const parentByChild = new Map(record.parentByChild);
        for (const key of subtree) parentByChild.delete(key);
        await this.#markerStore.write(markerFromLease(
          lease,
          parentByChild,
          queue,
          record.lifecycleOverflow,
        ));
        record.lease = lease;
        record.lifecycleQueue = queue;
        record.parentByChild = parentByChild;
        return true;
      }
      if (sessionKey === record.lease.rootSessionKey) {
        const tombstone = {
          leaseEpoch: record.lease.leaseEpoch,
          endedAt: this.#readNow().toISOString(),
        };
        const sessionKeys = [record.lease.rootSessionKey, ...record.lease.childSessionKeys];
        const endedLease = rootEndedEvidenceLease(record.lease);
        await this.#markerStore.write(markerFromRootTombstone(
          endedLease,
          tombstone,
          record.parentByChild,
        ));
        this.#removeActive(record);
        this.#addRootEnded(endedLease, sessionKeys.slice(1), tombstone);
        return true;
      }
      if (this.#activeBySession.get(sessionKey) !== record) return false;
      const projectedTree = sessionTreeFromRecord(record);
      const subtree = removeSessionSubtree(projectedTree, sessionKey);
      if (subtree === undefined) return false;
      const retainedChildren = record.lease.childSessionKeys.filter((key) => !subtree.has(key));
      const lease = withChildSessionKeys(record.lease, retainedChildren);
      const queue = pruneCoveredLifecycleTail(subtree, record.lifecycleQueue.slice(1));
      await this.#markerStore.write(markerFromLease(
        lease,
        record.parentByChild,
        queue,
        record.lifecycleOverflow,
      ));
      record.lease = lease;
      record.lifecycleQueue = queue;
      for (const key of subtree) {
        record.parentByChild.delete(key);
      }
      this.#rebuildActiveSessionIndexes(record);
      if (record.lease.childSessionKeys.length === 0) record.flatRecoveryBindings = false;
      return true;
    });
  }

  async endSession(sessionKey: string): Promise<boolean> {
    return this.#serialized(async () => {
      this.#assertStarted();
      await this.#purgeExpired();
      if (!safeSessionKey(sessionKey)) throw new TypeError("Native guard session key is invalid");
      const parsedSession = parseCanonicalOpenClawSessionKey(sessionKey);
      const hasExactInactive = this.#rootEndedBySession.has(sessionKey) ||
        this.#recoveringBySession.has(sessionKey);
      const active = this.#activeBySession.get(sessionKey) ??
        (!hasExactInactive && parsedSession?.agentId === "main"
          ? this.#activeByAgent.get("main")
          : undefined);
      if (active !== undefined) {
        if (active.lifecycleQueue.length > 0 || active.lifecycleOverflow) return false;
        if (isAgentScope(active.lease.scope)) {
          if (parsedSession?.agentId !== active.lease.scope.agentId) return false;
          const subtree = collectSubtree(active.parentByChild, sessionKey);
          const lease = withChildSessionKeys(
            active.lease,
            active.lease.childSessionKeys.filter((key) => !subtree.has(key)),
          );
          const parentByChild = new Map(active.parentByChild);
          for (const key of subtree) parentByChild.delete(key);
          await this.#markerStore.write(markerFromLease(lease, parentByChild));
          active.lease = lease;
          active.parentByChild = parentByChild;
          return true;
        }
        if (sessionKey === active.lease.rootSessionKey) {
          const tombstone = {
            leaseEpoch: active.lease.leaseEpoch,
            endedAt: this.#readNow().toISOString(),
          };
          const endedLease = rootEndedEvidenceLease(active.lease);
          await this.#markerStore.write(markerFromRootTombstone(
            endedLease,
            tombstone,
            active.parentByChild,
          ));
          this.#removeActive(active);
          this.#addRootEnded(
            endedLease,
            active.lease.childSessionKeys,
            tombstone,
          );
          return true;
        }

        const subtree = active.flatRecoveryBindings
          ? new Set([sessionKey])
          : collectSubtree(active.parentByChild, sessionKey);
        const retainedChildren = active.lease.childSessionKeys.filter((key) => !subtree.has(key));
        const lease = withChildSessionKeys(active.lease, retainedChildren);
        await this.#markerStore.write(markerFromLease(lease, active.parentByChild));
        active.lease = lease;
        for (const key of subtree) {
          active.parentByChild.delete(key);
          this.#activeBySession.delete(key);
        }
        if (active.lease.childSessionKeys.length === 0) active.flatRecoveryBindings = false;
        return true;
      }

      if (this.#rootEndedBySession.has(sessionKey)) return false;
      const recovering = this.#recoveringBySession.get(sessionKey) ??
        (parsedSession?.agentId === "main" ? this.#recoveringByAgent.get("main") : undefined);
      if (recovering === undefined) return false;
      if (isAgentScope(recovering.scope)) {
        return parsedSession?.agentId === recovering.scope.agentId;
      }
      if (sessionKey === recovering.rootSessionKey) {
        if (
          recovering.leaseEpoch === undefined ||
          markerLifecycleQueue(recovering).length > 0 ||
          recovering.lifecycleOverflow === true
        ) return false;
        const tombstone = {
          leaseEpoch: recovering.leaseEpoch,
          endedAt: this.#readNow().toISOString(),
        };
        const marker = markerFromRecoveryRootTombstone(recovering, tombstone);
        await this.#markerStore.write(marker);
        this.#recoveringByLease.set(marker.leaseId, marker);
        this.#rebuildRecoveryIndexes();
        return true;
      }
      if (this.#recoveryConflictByLease.has(recovering.leaseId)) return false;
      const parentByChild = markerParentByChild(recovering);
      const subtree = recovering.sessionBindings === undefined
        ? new Set([sessionKey])
        : collectSubtree(parentByChild, sessionKey);
      const childSessionKeys = recovering.childSessionKeys.filter((key) => !subtree.has(key));
      const { sessionBindings: _sessionBindings, ...markerWithoutBindings } = recovering;
      const sessionBindings = recovering.sessionBindings === undefined
        ? undefined
        : sessionBindingsFromParentMap(
            {
              rootSessionKey: recovering.rootSessionKey,
              childSessionKeys,
              scope: recovering.scope,
            },
            parentByChild,
          );
      const marker = {
        ...markerWithoutBindings,
        childSessionKeys,
        ...(sessionBindings === undefined ? {} : { sessionBindings }),
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
    const activeRecords = [...this.#activeByLease.values()].sort((left, right) =>
      compareLeaseSummaries(left.lease, right.lease));
    const hasRootEnded = this.#rootEndedByLease.size > 0 ||
      [...this.#recoveringByLease.values()].some((marker) => marker.rootTombstone !== undefined);
    const hasRecovery = this.#recoveringByLease.size > 0 || hasRootEnded;
    const hasLifecycleOverflow = activeRecords.some((record) => record.lifecycleOverflow) ||
      [...this.#recoveringByLease.values()].some((marker) => marker.lifecycleOverflow === true);
    const hasLifecyclePending = hasLifecycleOverflow ||
      activeRecords.some((record) => record.lifecycleQueue.length > 0) ||
      [...this.#recoveringByLease.values()].some((marker) => markerLifecycleQueue(marker).length > 0);
    if (activeRecords.length === 0) {
      return {
        coverage: hasRecovery ? "recovery" : "off",
        finalizerAssurance: "unverified",
        activeLeaseCount: 0,
        ...(hasRootEnded ? { reasonCode: "NATIVE_GUARD_ROOT_ENDED" } : {}),
      };
    }
    const status: NativeGuardStatus = {
      coverage: hasRecovery || hasLifecyclePending ? "recovery" : "active",
      finalizerAssurance: "unverified",
      activeLeaseCount: activeRecords.length,
      activeLeases: activeRecords.map(({ lease }) => leaseSummary(lease)),
      ...(hasLifecyclePending
        ? {
            reasonCode: hasLifecycleOverflow
              ? "NATIVE_GUARD_LIFECYCLE_OVERFLOW"
              : "NATIVE_GUARD_LIFECYCLE_PENDING",
          }
        : {}),
    };
    if (activeRecords.length === 1 && !hasRecovery) {
      const lease = activeRecords[0].lease;
      status.activeLease = leaseSummary(lease);
    }
    return status;
  }

  #scopeHasActiveRecord(
    lease: Pick<ActiveLeaseLookup, "rootSessionKey" | "scope">,
  ): boolean {
    return isAgentScope(lease.scope)
      ? this.#activeByAgent.has(lease.scope.agentId)
      : this.#activeBySession.has(lease.rootSessionKey);
  }

  #scopeHasRecoveringRecord(
    lease: Pick<ActiveLeaseLookup, "rootSessionKey" | "scope">,
  ): boolean {
    return this.#recoveringForScope(lease.scope, lease.rootSessionKey) !== undefined;
  }

  #recoveringForScope(
    scope: NativeGuardLeaseScope,
    rootSessionKey: string,
  ): GuardedMarker | undefined {
    return isAgentScope(scope)
      ? this.#recoveringByAgent.get(scope.agentId)
      : this.#recoveringBySession.get(rootSessionKey);
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
    for (const record of this.#rootEndedByLease.values()) {
      if (Date.parse(record.lease.expiresAt) <= nowMs) {
        this.#pendingDeletionLeaseIds.add(record.lease.leaseId);
        this.#removeRootEnded(record);
      }
    }
    await this.#retryPendingDeletions();
  }

  #removeActive(record: ActiveRecord): void {
    this.#activeByLease.delete(record.lease.leaseId);
    if (isAgentScope(record.lease.scope)) {
      if (this.#activeByAgent.get(record.lease.scope.agentId) === record) {
        this.#activeByAgent.delete(record.lease.scope.agentId);
      }
    }
    for (const [sessionKey, active] of this.#activeBySession) {
      if (active === record) this.#activeBySession.delete(sessionKey);
    }
  }

  #rebuildActiveSessionIndexes(record: ActiveRecord): void {
    for (const [sessionKey, active] of this.#activeBySession) {
      if (active === record) this.#activeBySession.delete(sessionKey);
    }
    if (isAgentScope(record.lease.scope)) return;
    this.#activeBySession.set(record.lease.rootSessionKey, record);
    for (const childSessionKey of record.lease.childSessionKeys) {
      this.#activeBySession.set(childSessionKey, record);
    }
    for (const intent of record.lifecycleQueue) {
      if (intent.kind === "bind_child") {
        this.#activeBySession.set(intent.childSessionKey, record);
      }
    }
  }

  #addRootEnded(
    lease: RootEndedEvidenceLookup,
    childSessionKeys: readonly string[],
    tombstone: NonNullable<GuardedMarker["rootTombstone"]>,
  ): void {
    const sessionKeys = Object.freeze([lease.rootSessionKey, ...childSessionKeys]);
    const record: RootEndedRecord = { lease, sessionKeys, tombstone };
    this.#rootEndedByLease.set(lease.leaseId, record);
    for (const sessionKey of sessionKeys) this.#rootEndedBySession.set(sessionKey, record);
  }

  #removeRootEnded(record: RootEndedRecord): void {
    this.#rootEndedByLease.delete(record.lease.leaseId);
    for (const sessionKey of record.sessionKeys) this.#rootEndedBySession.delete(sessionKey);
  }

  #addActive(
    lease: ActiveLeaseLookup,
    childSessionKeys: readonly string[] = [],
    flatRecoveryBindings = false,
    lifecycleQueue: readonly LifecycleIntent[] = [],
    lifecycleOverflow = false,
    recoveredParentByChild?: ReadonlyMap<string, string>,
  ): void {
    const parentByChild = new Map<string, string>();
    for (const childSessionKey of childSessionKeys) {
      parentByChild.set(
        childSessionKey,
        recoveredParentByChild?.get(childSessionKey) ?? lease.rootSessionKey,
      );
    }
    const record: ActiveRecord = {
      lease,
      parentByChild,
      flatRecoveryBindings,
      lifecycleQueue: lifecycleQueue.map((intent) => structuredClone(intent)),
      lifecycleOverflow,
    };
    this.#activeByLease.set(lease.leaseId, record);
    if (isAgentScope(lease.scope)) {
      this.#activeByAgent.set(lease.scope.agentId, record);
      return;
    }
    this.#activeBySession.set(lease.rootSessionKey, record);
    for (const childSessionKey of lease.childSessionKeys) {
      this.#activeBySession.set(childSessionKey, record);
    }
    for (const intent of record.lifecycleQueue) {
      if (intent.kind === "bind_child") {
        this.#activeBySession.set(intent.childSessionKey, record);
      }
    }
  }

  async #markLifecycleOverflow(record: ActiveRecord): Promise<void> {
    if (record.lifecycleOverflow) return;
    await this.#markerStore.write(markerFromLease(
      record.lease,
      record.parentByChild,
      record.lifecycleQueue,
      true,
    ));
    record.lifecycleOverflow = true;
  }

  #removeRecovering(marker: GuardedMarker): void {
    this.#recoveringByLease.delete(marker.leaseId);
    this.#rebuildRecoveryIndexes();
  }

  async #revokeWithoutPurge(leaseId: string): Promise<boolean> {
    const active = this.#activeByLease.get(leaseId);
    const rootEnded = this.#rootEndedByLease.get(leaseId);
    const conflict = this.#recoveryConflictByLease.get(leaseId);
    const recoveryLeaseIds = conflict === undefined
      ? (this.#recoveringByLease.has(leaseId) ? [leaseId] : [])
      : [...conflict].sort();
    if (active === undefined && rootEnded === undefined && recoveryLeaseIds.length === 0) {
      if (!this.#pendingDeletionLeaseIds.has(leaseId)) return false;
      await this.#markerStore.remove(leaseId);
      this.#pendingDeletionLeaseIds.delete(leaseId);
      return true;
    }
    const leaseIds = active === undefined && rootEnded === undefined ? recoveryLeaseIds : [leaseId];
    for (const markerLeaseId of leaseIds) {
      await this.#markerStore.remove(markerLeaseId);
    }
    if (active !== undefined) this.#removeActive(active);
    if (rootEnded !== undefined) this.#removeRootEnded(rootEnded);
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
    this.#recoveringByAgent.clear();
    this.#recoveryConflictByLease.clear();
    const markers = [...this.#recoveringByLease.values()].sort(compareMarkers);
    const parent = new Map(markers.map((marker) => [marker.leaseId, marker.leaseId]));
    const markersBySession = new Map<string, GuardedMarker[]>();
    const markersByAgent = new Map<string, GuardedMarker[]>();
    for (const marker of markers) {
      if (isAgentScope(marker.scope)) {
        const candidates = markersByAgent.get(marker.scope.agentId) ?? [];
        candidates.push(marker);
        markersByAgent.set(marker.scope.agentId, candidates);
        continue;
      }
      for (const sessionKey of markerSessionKeys(marker)) {
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
    for (const [agentId, candidates] of markersByAgent) {
      candidates.sort(compareMarkers);
      this.#recoveringByAgent.set(agentId, candidates[0]);
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
    scope: structuredClone(marker.scope),
    policyPackId: marker.policyPackId,
    policyPackDigest: marker.policyPackDigest,
    expiresAt: marker.expiresAt,
  };
}

function lifecyclePendingLookup(marker: GuardedMarker): LifecyclePendingLookup {
  return {
    state: "lifecycle_pending",
    leaseId: marker.leaseId,
    rootSessionKey: marker.rootSessionKey,
    mode: marker.mode,
    scope: structuredClone(marker.scope),
    policyPackId: marker.policyPackId,
    policyPackDigest: marker.policyPackDigest,
    expiresAt: marker.expiresAt,
  };
}

function rootEndedLookup(
  value: GuardedMarker | RootEndedEvidenceLookup,
): RootEndedLookup {
  return {
    state: "root_ended",
    leaseId: value.leaseId,
    rootSessionKey: value.rootSessionKey,
    mode: value.mode,
    scope: structuredClone(value.scope),
    policyPackId: value.policyPackId,
    policyPackDigest: value.policyPackDigest,
    expiresAt: value.expiresAt,
  };
}

function markerLookup(marker: GuardedMarker): RecoveryLookup | LifecyclePendingLookup | RootEndedLookup {
  if (marker.rootTombstone !== undefined) return rootEndedLookup(marker);
  return markerLifecycleQueue(marker).length === 0 && marker.lifecycleOverflow !== true
    ? recoveryLookup(marker)
    : lifecyclePendingLookup(marker);
}

function isAgentScope(
  scope: NativeGuardLeaseScope,
): scope is Extract<NativeGuardLeaseScope, { kind: "agent" }> {
  return typeof scope === "object" && scope.kind === "agent";
}

function normalizeLeaseScope(
  scope: NativeGuardLeaseScope | undefined,
  rootSessionKey: string,
): ReturnType<typeof normalizeNativeGuardLeaseScope> {
  if (typeof scope === "object" && scope !== null) {
    const expectedKeys = scope.kind === "session"
      ? "kind,sessionKey"
      : (scope.kind === "agent" ? "agentId,kind" : "");
    if (Object.keys(scope).sort().join(",") !== expectedKeys) {
      throw new TypeError("Native guard lease scope is invalid");
    }
  }
  return normalizeNativeGuardLeaseScope(scope, rootSessionKey);
}

function sameMainAgentSessions(parentSessionKey: string, childSessionKey: string): boolean {
  const parent = parseCanonicalOpenClawSessionKey(parentSessionKey);
  const child = parseCanonicalOpenClawSessionKey(childSessionKey);
  return parent?.agentId === "main" && child?.agentId === "main" &&
    parent.sessionKey !== child.sessionKey;
}

function leaseSummary(lease: ActiveLeaseLookup): NativeGuardLeaseSummary {
  return {
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    rootSessionKey: lease.rootSessionKey,
    scope: structuredClone(lease.scope),
    mode: lease.mode,
    policyPackId: lease.policyPackId,
    policyPackDigest: lease.policyPackDigest,
    expiresAt: lease.expiresAt,
  };
}

function compareLeaseSummaries(
  left: Pick<NativeGuardLeaseSummary, "leaseId" | "rootSessionKey">,
  right: Pick<NativeGuardLeaseSummary, "leaseId" | "rootSessionKey">,
): number {
  if (left.leaseId < right.leaseId) return -1;
  if (left.leaseId > right.leaseId) return 1;
  if (left.rootSessionKey < right.rootSessionKey) return -1;
  if (left.rootSessionKey > right.rootSessionKey) return 1;
  return 0;
}

function markerSessionKeys(marker: GuardedMarker): string[] {
  return [
    marker.rootSessionKey,
    ...marker.childSessionKeys,
    ...markerLifecycleQueue(marker)
      .filter((intent): intent is Extract<LifecycleIntent, { kind: "bind_child" }> =>
        intent.kind === "bind_child")
      .map(({ childSessionKey }) => childSessionKey),
  ];
}

function markerLifecycleQueue(marker: GuardedMarker | undefined): LifecycleIntent[] {
  if (marker === undefined) return [];
  if (marker.lifecycleQueue !== undefined) {
    return marker.lifecycleQueue.map((intent) => structuredClone(intent));
  }
  return marker.lifecycleIntent === undefined ? [] : [structuredClone(marker.lifecycleIntent)];
}

function markerParentByChild(marker: GuardedMarker): Map<string, string> {
  if (marker.sessionBindings === undefined) {
    return new Map(marker.childSessionKeys.map((childSessionKey) => [
      childSessionKey,
      marker.rootSessionKey,
    ]));
  }
  return new Map(marker.sessionBindings.map((binding) => [
    binding.childSessionKey,
    binding.parentSessionKey,
  ]));
}

type ProjectedSessionTree = {
  sessionKeys: Set<string>;
  parentByChild: Map<string, string>;
};

function sessionTreeFromRecord(record: ActiveRecord): ProjectedSessionTree {
  const sessionKeys = new Set([
    record.lease.rootSessionKey,
    ...record.lease.childSessionKeys,
  ]);
  const parentByChild = new Map<string, string>();
  for (const childSessionKey of record.lease.childSessionKeys) {
    const parentSessionKey = record.parentByChild.get(childSessionKey);
    parentByChild.set(
      childSessionKey,
      parentSessionKey !== undefined && sessionKeys.has(parentSessionKey)
        ? parentSessionKey
        : record.lease.rootSessionKey,
    );
  }
  return { sessionKeys, parentByChild };
}

function projectLifecycleTree(
  record: ActiveRecord,
  queue: readonly LifecycleIntent[] = record.lifecycleQueue,
): ProjectedSessionTree | undefined {
  const tree = sessionTreeFromRecord(record);
  for (const intent of queue) {
    if (!applyLifecycleIntent(tree, intent)) return undefined;
  }
  return tree;
}

function pruneCoveredLifecycleTail(
  removedSubtree: ReadonlySet<string>,
  queue: readonly LifecycleIntent[],
): LifecycleIntent[] {
  const covered = new Set(removedSubtree);
  const retained: LifecycleIntent[] = [];
  for (const intent of queue) {
    if (intent.kind === "bind_child") {
      if (covered.has(intent.parentSessionKey)) {
        covered.add(intent.childSessionKey);
        continue;
      }
      covered.delete(intent.childSessionKey);
      retained.push(intent);
      continue;
    }
    if (intent.kind === "end_session" && covered.has(intent.sessionKey)) continue;
    retained.push(intent);
  }
  return retained;
}

function applyLifecycleIntent(tree: ProjectedSessionTree, intent: LifecycleIntent): boolean {
  if (intent.kind === "bind_child") {
    if (
      !tree.sessionKeys.has(intent.parentSessionKey) ||
      tree.sessionKeys.has(intent.childSessionKey)
    ) return false;
    tree.sessionKeys.add(intent.childSessionKey);
    tree.parentByChild.set(intent.childSessionKey, intent.parentSessionKey);
    return true;
  }
  return removeSessionSubtree(tree, intent.sessionKey) !== undefined;
}

function removeSessionSubtree(
  tree: ProjectedSessionTree,
  sessionKey: string,
): Set<string> | undefined {
  if (!tree.sessionKeys.has(sessionKey)) return undefined;
  const subtree = collectSubtree(tree.parentByChild, sessionKey);
  for (const key of subtree) {
    tree.sessionKeys.delete(key);
    tree.parentByChild.delete(key);
  }
  return subtree;
}

function validLifecycleEvidenceRequest(
  lease: ActiveLeaseLookup,
  intent: LifecycleIntent,
  proof: NativeGuardEvidenceProof,
): boolean {
  if (
    !lifecycleProofMatchesIntent(lease.leaseId, intent, proof) ||
    proof.leaseEpoch !== lease.leaseEpoch ||
    proof.keyId !== lease.evidenceSigningKeyId
  ) return false;
  try {
    const { signature, ...unsigned } = proof;
    return verifyNativeGuardPayload(
      unsigned,
      signature,
      createPublicKey(createPrivateKey(lease.evidenceSigningPrivateKey)),
    );
  } catch {
    return false;
  }
}

function sameLifecycleIntent(
  left: LifecycleIntent | undefined,
  right: LifecycleIntent,
): boolean {
  if (left?.kind !== right.kind) return false;
  return left.kind === "bind_child" && right.kind === "bind_child"
    ? left.parentSessionKey === right.parentSessionKey &&
      left.childSessionKey === right.childSessionKey
    : left.kind === "end_session" && right.kind === "end_session" &&
      left.sessionKey === right.sessionKey;
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
    "evidenceCredential",
    "evidenceSigningKeyId",
    "evidenceSigningPrivateKey",
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
  let scope: ReturnType<typeof normalizeNativeGuardLeaseScope>;
  try {
    scope = normalizeLeaseScope(value.scope, value.rootSessionKey);
  } catch {
    throw invalidActivation();
  }
  if (!safeId(value.policyPackId) || !DIGEST.test(value.policyPackDigest)) throw invalidActivation();
  if (!validDecisionUrl(value.backendUrl)) throw invalidActivation();
  if (!validEd25519PublicKey(value.decisionPublicKey)) throw invalidActivation();
  if (!safeId(value.evidenceSigningKeyId)) throw invalidActivation();
  if (!validEd25519PrivateKey(value.evidenceSigningPrivateKey)) throw invalidActivation();
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
  if (
    typeof value.evidenceCredential !== "string" ||
    value.evidenceCredential.trim().length === 0 ||
    value.evidenceCredential.length > 4096 ||
    value.evidenceCredential === value.credential
  ) throw invalidActivation();

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
    scope: Object.freeze(scope),
    policyPackId: value.policyPackId,
    policyPackDigest: value.policyPackDigest,
    backendUrl: value.backendUrl,
    decisionPublicKey: value.decisionPublicKey,
    failurePolicy,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    credential: value.credential,
    evidenceCredential: value.evidenceCredential,
    evidenceSigningKeyId: value.evidenceSigningKeyId,
    evidenceSigningPrivateKey: value.evidenceSigningPrivateKey,
    childSessionKeys: Object.freeze([] as string[]),
  });
}

function markerFromLease(
  lease: ActiveLeaseLookup,
  parentByChild?: ReadonlyMap<string, string>,
  lifecycleQueue: readonly LifecycleIntent[] = [],
  lifecycleOverflow = false,
): GuardedMarker {
  const queue = lifecycleQueue.map((intent) => structuredClone(intent));
  const sessionBindings = sessionBindingsFromParentMap(lease, parentByChild);
  const marker: GuardedMarker = {
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    rootSessionKey: lease.rootSessionKey,
    childSessionKeys: [...lease.childSessionKeys].sort(),
    mode: lease.mode,
    scope: structuredClone(lease.scope),
    policyPackId: lease.policyPackId,
    policyPackDigest: lease.policyPackDigest,
    expiresAt: lease.expiresAt,
    ...(sessionBindings === undefined ? {} : { sessionBindings }),
    ...(queue.length === 0
      ? {}
      : {
          lifecycleIntent: structuredClone(queue[0]),
          lifecycleQueue: queue,
        }),
    ...(lifecycleOverflow ? { lifecycleOverflow: true as const } : {}),
  };
  const capacityMarker = lifecycleOverflow
    ? marker
    : { ...marker, lifecycleOverflow: true as const };
  if (serializedCanonicalMarkerBytes(capacityMarker) > MAX_MARKER_BYTES) {
    throw new LifecycleMarkerCapacityError();
  }
  return marker;
}

function serializedCanonicalMarkerBytes(marker: GuardedMarker): number {
  const parsedMarker = parseMarker(marker);
  if (parsedMarker === undefined) throw new TypeError("Native guard marker is invalid");
  return Buffer.byteLength(serializedMarkerContents(parsedMarker), "utf8");
}

function serializedMarkerContents(marker: GuardedMarker): string {
  return `${JSON.stringify(marker)}\n`;
}

function rootEndedEvidenceLease(lease: ActiveLeaseLookup): RootEndedEvidenceLookup {
  return Object.freeze({ ...lease, state: "root_ended" as const });
}

function markerFromRootTombstone(
  lease: RootEndedEvidenceLookup,
  tombstone: NonNullable<GuardedMarker["rootTombstone"]>,
  parentByChild?: ReadonlyMap<string, string>,
): GuardedMarker {
  const sessionBindings = sessionBindingsFromParentMap(lease, parentByChild);
  const marker: GuardedMarker = {
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    rootSessionKey: lease.rootSessionKey,
    childSessionKeys: [...lease.childSessionKeys].sort(),
    mode: lease.mode,
    scope: structuredClone(lease.scope),
    policyPackId: lease.policyPackId,
    policyPackDigest: lease.policyPackDigest,
    expiresAt: lease.expiresAt,
    ...(sessionBindings === undefined ? {} : { sessionBindings }),
    rootTombstone: structuredClone(tombstone),
  };
  if (Buffer.byteLength(JSON.stringify(marker), "utf8") > MAX_MARKER_BYTES) {
    throw new Error("Native guard root tombstone exceeds its marker limit");
  }
  return marker;
}

function markerFromRecoveryRootTombstone(
  marker: GuardedMarker,
  tombstone: NonNullable<GuardedMarker["rootTombstone"]>,
): GuardedMarker {
  const {
    lifecycleIntent: _lifecycleIntent,
    lifecycleQueue: _lifecycleQueue,
    lifecycleOverflow: _lifecycleOverflow,
    rootTombstone: _rootTombstone,
    ...base
  } = marker;
  const rootEnded = {
    ...base,
    rootTombstone: structuredClone(tombstone),
  };
  if (Buffer.byteLength(JSON.stringify(rootEnded), "utf8") > MAX_MARKER_BYTES) {
    throw new Error("Native guard root tombstone exceeds its marker limit");
  }
  return rootEnded;
}

function sessionBindingsFromParentMap(
  lease: Pick<ActiveLeaseLookup, "rootSessionKey" | "childSessionKeys" | "scope">,
  parentByChild: ReadonlyMap<string, string> | undefined,
): SessionBinding[] | undefined {
  if (lease.childSessionKeys.length === 0) return undefined;
  if (parentByChild === undefined) {
    throw new Error("Native guard committed session bindings are unavailable");
  }
  const bindings = lease.childSessionKeys.map((childSessionKey) => ({
    childSessionKey,
    parentSessionKey: parentByChild.get(childSessionKey) ?? "",
  }));
  const parsed = parseSessionBindings(
    bindings,
    lease.rootSessionKey,
    lease.childSessionKeys,
    lease.scope,
  );
  if (parsed === undefined) throw new Error("Native guard committed session bindings are invalid");
  return parsed;
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

function validEd25519PrivateKey(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\r?\n?$/.test(value)
  ) return false;
  try {
    const key = createPrivateKey(value);
    return key.type === "private" && key.asymmetricKeyType === "ed25519";
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

async function ensureSecureDirectory(
  directory: string,
  createDirectory: NonNullable<FileMarkerStoreHooks["createDirectory"]>,
  syncDirectory: NonNullable<FileMarkerStoreHooks["syncDirectory"]>,
): Promise<void> {
  const missingDirectories = await findMissingDirectories(directory);
  for (const missingDirectory of missingDirectories) {
    let created = true;
    try {
      await createDirectory(missingDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      created = false;
    }
    await assertSecureDirectory(missingDirectory);
    if (created) {
      await chmod(missingDirectory, 0o700);
      await assertSecureDirectory(missingDirectory);
    }
    await syncDirectory(dirname(missingDirectory));
  }
  await assertSecureDirectory(directory);
}

async function findMissingDirectories(directory: string): Promise<string[]> {
  const root = parse(directory).root;
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Native guard marker path root is unsafe");
  }
  assertTrustedPosixAncestor(rootMetadata);
  let current = root;
  let foundMissing = false;
  const missingDirectories: string[] = [];
  for (const segment of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (foundMissing) {
      missingDirectories.push(current);
      continue;
    }
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        foundMissing = true;
        missingDirectories.push(current);
        continue;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error("Native guard marker path contains a symbolic link");
    }
    if (!metadata.isDirectory()) {
      throw new Error("Native guard marker path contains a non-directory ancestor");
    }
    assertTrustedPosixAncestor(metadata);
  }
  return missingDirectories;
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
    if (!metadata.isDirectory()) {
      throw new Error("Native guard marker path contains a non-directory ancestor");
    }
    assertTrustedPosixAncestor(metadata);
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new Error("Native guard marker path is not a directory");
  assertSecurePosixMetadata(metadata, "marker directory");
}

function assertTrustedPosixAncestor(metadata: Stats): void {
  if (process.platform === "win32") return;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!isTrustedPosixAncestorMetadata(metadata.mode, metadata.uid, currentUid)) {
    throw new Error("Native guard marker ancestor permissions are invalid");
  }
}

export function isTrustedPosixAncestorMetadata(
  mode: number,
  ownerUid: number,
  currentUid: number,
): boolean {
  const writableByOthers = (mode & 0o022) !== 0;
  const hasStickyBit = (mode & 0o1000) !== 0;
  const hasTrustedOwner = ownerUid === currentUid || ownerUid === 0;
  return !writableByOthers || (hasStickyBit && hasTrustedOwner);
}

async function createMarkerDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
}

function assertWindowsUserRoot(directory: string): void {
  if (process.platform !== "win32") return;
  if (pathIsWithin(directory, homedir()) || pathIsWithin(directory, tmpdir())) return;
  throw new TypeError("Native guard marker directory must be within an OS-provided user root");
}

function pathIsWithin(candidate: string, anchor: string): boolean {
  const relation = relative(resolve(anchor), candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
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
  const requiredKeys = [
    "childSessionKeys",
    "expiresAt",
    "leaseId",
    "mode",
    "policyPackDigest",
    "policyPackId",
    "rootSessionKey",
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    "leaseEpoch",
    "lifecycleIntent",
    "lifecycleOverflow",
    "lifecycleQueue",
    "rootTombstone",
    "scope",
    "sessionBindings",
  ]);
  const keys = Object.keys(value);
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    keys.some((key) => !allowedKeys.has(key))
  ) return undefined;
  const lifecycleIntent = value.lifecycleIntent === undefined
    ? undefined
    : parseLifecycleIntent(value.lifecycleIntent);
  const lifecycleQueue = value.lifecycleQueue === undefined
    ? (lifecycleIntent === undefined ? [] : [lifecycleIntent])
    : parseLifecycleQueue(value.lifecycleQueue);
  const rootTombstone = value.rootTombstone === undefined
    ? undefined
    : parseRootTombstone(value.rootTombstone);
  let scope: ReturnType<typeof normalizeNativeGuardLeaseScope>;
  try {
    scope = normalizeLeaseScope(
      value.scope as NativeGuardLeaseScope | undefined,
      typeof value.rootSessionKey === "string" ? value.rootSessionKey : "",
    );
  } catch {
    return undefined;
  }
  if (
    !safeId(value.leaseId) ||
    (value.leaseEpoch !== undefined &&
      (!Number.isSafeInteger(value.leaseEpoch) || (value.leaseEpoch as number) <= 0)) ||
    !safeSessionKey(value.rootSessionKey) ||
    !Array.isArray(value.childSessionKeys) ||
    !value.childSessionKeys.every(safeSessionKey) ||
    (isAgentScope(scope) && !value.childSessionKeys.every((sessionKey) =>
      parseCanonicalOpenClawSessionKey(sessionKey)?.agentId === scope.agentId)) ||
    new Set(value.childSessionKeys).size !== value.childSessionKeys.length ||
    value.childSessionKeys.includes(value.rootSessionKey as string) ||
    (value.mode !== "detection" && value.mode !== "supervision") ||
    !safeId(value.policyPackId) ||
    typeof value.policyPackDigest !== "string" ||
    !DIGEST.test(value.policyPackDigest) ||
    !isCanonicalTimestamp(value.expiresAt) ||
    (value.lifecycleOverflow !== undefined && value.lifecycleOverflow !== true) ||
    (value.rootTombstone !== undefined && rootTombstone === undefined) ||
    (value.lifecycleIntent !== undefined && lifecycleIntent === undefined) ||
    lifecycleQueue === undefined ||
    (isAgentScope(scope) && rootTombstone !== undefined) ||
    (lifecycleIntent !== undefined && !sameLifecycleIntent(lifecycleQueue[0], lifecycleIntent))
  ) {
    return undefined;
  }
  if (
    rootTombstone !== undefined &&
    (lifecycleQueue.length > 0 || value.lifecycleOverflow === true)
  ) return undefined;
  if (
    rootTombstone !== undefined &&
    value.leaseEpoch !== undefined &&
    value.leaseEpoch !== rootTombstone.leaseEpoch
  ) return undefined;
  const childSessionKeys = [...value.childSessionKeys].sort();
  const sessionBindings = value.sessionBindings === undefined
    ? undefined
    : parseSessionBindings(value.sessionBindings, value.rootSessionKey, childSessionKeys, scope);
  if (value.sessionBindings !== undefined && sessionBindings === undefined) return undefined;
  if (!validLifecycleQueue(
    lifecycleQueue,
    value.leaseId,
    value.rootSessionKey,
    childSessionKeys,
    scope,
  )) return undefined;
  return {
    leaseId: value.leaseId,
    ...(value.leaseEpoch === undefined ? {} : { leaseEpoch: value.leaseEpoch as number }),
    rootSessionKey: value.rootSessionKey,
    childSessionKeys,
    mode: value.mode,
    scope,
    policyPackId: value.policyPackId,
    policyPackDigest: value.policyPackDigest,
    expiresAt: value.expiresAt,
    ...(sessionBindings === undefined ? {} : { sessionBindings }),
    ...(lifecycleQueue.length === 0
      ? {}
      : {
          lifecycleIntent: structuredClone(lifecycleQueue[0]),
          lifecycleQueue,
        }),
    ...(value.lifecycleOverflow === true ? { lifecycleOverflow: true as const } : {}),
    ...(rootTombstone === undefined ? {} : { rootTombstone }),
  };
}

function parseSessionBindings(
  value: unknown,
  rootSessionKey: unknown,
  childSessionKeys: readonly string[],
  scope: NativeGuardLeaseScope,
): SessionBinding[] | undefined {
  if (
    typeof rootSessionKey !== "string" ||
    !Array.isArray(value) ||
    value.length !== childSessionKeys.length ||
    value.length > MAX_SESSION_BINDINGS
  ) return undefined;
  const bindings: SessionBinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const binding = descriptor.value;
    if (
      !isRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "childSessionKey,parentSessionKey" ||
      !safeSessionKey(binding.childSessionKey) ||
      !safeSessionKey(binding.parentSessionKey)
    ) return undefined;
    bindings.push({
      childSessionKey: binding.childSessionKey,
      parentSessionKey: binding.parentSessionKey,
    });
  }

  const childSet = new Set(childSessionKeys);
  const agentScoped = isAgentScope(scope);
  const parentByChild = new Map<string, string>();
  for (const binding of bindings) {
    if (
      !childSet.has(binding.childSessionKey) ||
      binding.childSessionKey === binding.parentSessionKey ||
      (agentScoped
        ? !sameMainAgentSessions(binding.parentSessionKey, binding.childSessionKey)
        : (binding.parentSessionKey !== rootSessionKey && !childSet.has(binding.parentSessionKey))) ||
      parentByChild.has(binding.childSessionKey)
    ) return undefined;
    parentByChild.set(binding.childSessionKey, binding.parentSessionKey);
  }
  if (parentByChild.size !== childSet.size) return undefined;
  for (const childSessionKey of childSet) {
    const visited = new Set<string>();
    let current = childSessionKey;
    while (current !== rootSessionKey) {
      if (visited.has(current)) return undefined;
      visited.add(current);
      const parent = parentByChild.get(current);
      if (parent === undefined) {
        if (
          agentScoped &&
          parseCanonicalOpenClawSessionKey(current)?.agentId === scope.agentId
        ) break;
        return undefined;
      }
      current = parent;
    }
  }
  return bindings.sort((left, right) =>
    left.childSessionKey < right.childSessionKey
      ? -1
      : (left.childSessionKey > right.childSessionKey ? 1 : 0));
}

function parseRootTombstone(
  value: unknown,
): NonNullable<GuardedMarker["rootTombstone"]> | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "endedAt,leaseEpoch" ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) <= 0 ||
    typeof value.endedAt !== "string" ||
    !isCanonicalTimestamp(value.endedAt)
  ) return undefined;
  return { leaseEpoch: value.leaseEpoch as number, endedAt: value.endedAt };
}

function parseLifecycleQueue(value: unknown): LifecycleIntent[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIFECYCLE_QUEUE_ITEMS) {
    return undefined;
  }
  const queue: LifecycleIntent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const intent = parseLifecycleIntent(descriptor.value);
    if (intent === undefined) return undefined;
    queue.push(intent);
  }
  return queue;
}

function validLifecycleQueue(
  queue: readonly LifecycleIntent[],
  leaseId: unknown,
  rootSessionKey: unknown,
  childSessionKeys: readonly string[],
  scope: NativeGuardLeaseScope,
): boolean {
  if (typeof leaseId !== "string" || typeof rootSessionKey !== "string") return false;
  const known = new Set([rootSessionKey, ...childSessionKeys]);
  for (let index = 0; index < queue.length; index += 1) {
    const intent = queue[index];
    if (
      intent.evidenceRequest !== undefined &&
      !lifecycleProofMatchesIntent(leaseId, intent, intent.evidenceRequest)
    ) return false;
    if (intent.kind === "bind_child") {
      if (isAgentScope(scope)) {
        if (
          !sameMainAgentSessions(intent.parentSessionKey, intent.childSessionKey) ||
          known.has(intent.childSessionKey)
        ) return false;
        known.add(intent.childSessionKey);
        continue;
      }
      if (!known.has(intent.parentSessionKey) || known.has(intent.childSessionKey)) return false;
      known.add(intent.childSessionKey);
      continue;
    }
    if (isAgentScope(scope)) {
      if (parseCanonicalOpenClawSessionKey(intent.sessionKey)?.agentId !== scope.agentId) return false;
      known.delete(intent.sessionKey);
      continue;
    }
    if (!known.has(intent.sessionKey)) return false;
    if (intent.sessionKey === rootSessionKey && index !== queue.length - 1) return false;
    known.delete(intent.sessionKey);
  }
  return true;
}

function parseLifecycleIntent(value: unknown): LifecycleIntent | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  const evidenceRequest = value.evidenceRequest === undefined
    ? undefined
    : parseEvidenceProof(value.evidenceRequest);
  if (value.evidenceRequest !== undefined && evidenceRequest === undefined) return undefined;
  if (
    value.kind === "bind_child" &&
    (Object.keys(value).sort().join(",") === "childSessionKey,kind,parentSessionKey" ||
      Object.keys(value).sort().join(",") === "childSessionKey,evidenceRequest,kind,parentSessionKey") &&
    safeSessionKey(value.parentSessionKey) &&
    safeSessionKey(value.childSessionKey)
  ) {
    return {
      kind: "bind_child",
      parentSessionKey: value.parentSessionKey,
      childSessionKey: value.childSessionKey,
      ...(evidenceRequest === undefined ? {} : { evidenceRequest }),
    };
  }
  if (
    value.kind === "end_session" &&
    (Object.keys(value).sort().join(",") === "kind,sessionKey" ||
      Object.keys(value).sort().join(",") === "evidenceRequest,kind,sessionKey") &&
    safeSessionKey(value.sessionKey)
  ) {
    return {
      kind: "end_session",
      sessionKey: value.sessionKey,
      ...(evidenceRequest === undefined ? {} : { evidenceRequest }),
    };
  }
  return undefined;
}

function parseEvidenceProof(value: unknown): NativeGuardEvidenceProof | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [
    "bodyDigest",
    "issuedAt",
    "keyId",
    "leaseEpoch",
    "leaseId",
    "method",
    "path",
    "proofId",
    "schemaVersion",
    "signature",
    "signatureContext",
  ].join(",")) return undefined;
  if (
    value.schemaVersion !== "native-guard-1" ||
    value.signatureContext !== "native_guard.evidence_request.v1" ||
    !safeId(value.proofId) ||
    !safeId(value.leaseId) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) <= 0 ||
    value.method !== "POST" ||
    typeof value.path !== "string" ||
    typeof value.bodyDigest !== "string" ||
    !DIGEST.test(value.bodyDigest) ||
    typeof value.issuedAt !== "string" ||
    !isCanonicalTimestamp(value.issuedAt) ||
    !safeId(value.keyId) ||
    typeof value.signature !== "string" ||
    value.signature.length === 0 ||
    value.signature.length > 128
  ) return undefined;
  return value as NativeGuardEvidenceProof;
}

function lifecycleProofMatchesIntent(
  leaseId: string,
  intent: LifecycleIntent,
  proof: NativeGuardEvidenceProof,
): boolean {
  const path = intent.kind === "bind_child"
    ? "/api/v1/openclaw/native-guard/lifecycle/bind-child"
    : "/api/v1/openclaw/native-guard/lifecycle/end-session";
  const body = intent.kind === "bind_child"
    ? {
        leaseId,
        leaseEpoch: proof.leaseEpoch,
        parentSessionKey: intent.parentSessionKey,
        childSessionKey: intent.childSessionKey,
      }
    : {
        leaseId,
        leaseEpoch: proof.leaseEpoch,
        sessionKey: intent.sessionKey,
      };
  return proof.leaseId === leaseId && proof.path === path && proof.bodyDigest === digestJson(body);
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
