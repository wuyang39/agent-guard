import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import type { NativeGuardEvent } from "@agent-guard/contracts";
import { canonicalJson } from "@agent-guard/native-guard-protocol";

export const MAX_EVENT_SPOOL_EVENTS = 10_000;
export const MAX_EVENT_SPOOL_BYTES = 50 * 1024 * 1024;

const MAX_RESULT_PREVIEW_BYTES = 8 * 1024;
const MAX_RESULT_PROJECTION_BYTES = 256 * 1024;
const MAX_RESULT_DEPTH = 24;
const MAX_RESULT_ENTRIES = 4_096;
const MAX_RESULT_ARRAY_ENTRIES = 1_024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 900 * 1024;
const DATA_FILE_NAME = "events.jsonl";
const METADATA_FILE_NAME = "metadata.json";
const OWNER_FILE_NAME = "owner.lock";
const MAX_OWNER_BYTES = 1_024;
const SAFE_LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_EVENT_ID = /^[^\x00-\x1f\x7f]{1,256}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/i;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SENSITIVE_KEY = /(token|authorization|password|credential|cookie|secret)/i;
const EVENT_TYPES = new Set<NativeGuardEvent["type"]>([
  "lease_activated",
  "lease_renewed",
  "lease_recovery",
  "lease_revoked",
  "decision",
  "approval_requested",
  "approval_resolved",
  "tool_outcome",
  "sandbox_attested",
  "coverage_changed",
]);
const DETAIL_FIELDS: Record<NativeGuardEvent["type"], readonly string[]> = {
  decision: [
    "reasonCode",
    "message",
    "value",
    "requestId",
    "action",
    "policyId",
    "targetType",
    "toolName",
    "toolKind",
    "toolInputKind",
    "providerId",
    "riskTags",
    "paramsDigest",
    "rewrittenParamsDigest",
  ],
  lease_activated: [
    "reasonCode",
    "message",
    "value",
    "policyPackId",
    "policyPackDigest",
    "mode",
    "scope",
    "expiresAt",
    "status",
  ],
  lease_renewed: [
    "reasonCode",
    "message",
    "value",
    "policyPackId",
    "policyPackDigest",
    "expiresAt",
    "status",
  ],
  lease_recovery: [
    "reasonCode",
    "message",
    "value",
    "policyPackId",
    "policyPackDigest",
    "expiresAt",
    "status",
  ],
  lease_revoked: ["reasonCode", "message", "value", "status"],
  approval_requested: [
    "reasonCode",
    "message",
    "value",
    "requestId",
    "approvalId",
    "action",
    "status",
  ],
  approval_resolved: [
    "reasonCode",
    "message",
    "value",
    "requestId",
    "approvalId",
    "action",
    "status",
    "resolvedBy",
  ],
  tool_outcome: [
    "reasonCode",
    "message",
    "value",
    "requestId",
    "action",
    "status",
    "outcome",
    "success",
    "durationMs",
    "durationSource",
    "finalParamsDigest",
    "resultDigest",
    "resultPreview",
    "error",
    "errorCode",
    "riskTags",
  ],
  sandbox_attested: [
    "reasonCode",
    "message",
    "value",
    "status",
    "imageId",
    "containerId",
    "configDigest",
    "networkMode",
    "readOnlyRoot",
    "workspaceAccess",
  ],
  coverage_changed: [
    "reasonCode",
    "message",
    "value",
    "coverage",
    "previousCoverage",
    "finalizerAssurance",
    "conflictingPluginIds",
  ],
};

export type OutcomeEvidence = {
  resultPreview: string;
  resultDigest: string;
  projectionBytes: number;
};

export type EventUploadLease = {
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
};

type OwnerFileHandle = Awaited<ReturnType<typeof open>>;

export type EventSpoolOptions = {
  directory: string;
  upload: (
    lease: EventUploadLease,
    events: readonly NativeGuardEvent[],
    signal: AbortSignal,
  ) => Promise<void>;
  scheduleTimeout?: (callback: () => void, delayMs: number) => unknown;
  cancelTimeout?: (handle: unknown) => void;
  maxEvents?: number;
  maxBytes?: number;
  maxRecordBytes?: number;
  autoFlush?: boolean;
  writeOwnerFile?: (handle: OwnerFileHandle, contents: string) => Promise<void>;
  syncOwnerFile?: (handle: OwnerFileHandle) => Promise<void>;
  closeOwnerFile?: (handle: OwnerFileHandle) => Promise<void>;
  hardenOwnerFile?: (ownerPath: string) => Promise<void>;
  removeOwnerFile?: (ownerPath: string) => Promise<void>;
  renameOwnerFile?: (source: string, destination: string) => Promise<void>;
  onCorruptData?: (reason: "corrupt" | "oversized") => void | Promise<void>;
};

export interface EventSpool {
  acquire(): Promise<void>;
  enqueue(event: NativeGuardEvent): Promise<boolean>;
  flushNow(): Promise<void>;
  leaseRenewed(leaseId: string): void;
  cancelLease(leaseId: string, leaseEpoch?: number): void;
  stop(): Promise<void>;
}

type PendingEvent = {
  event: NativeGuardEvent;
  line: string;
  bytes: number;
  priority: number;
};

type SpoolMetadata = {
  schemaVersion: "native-event-spool-1";
  acknowledgedEventIds: string[];
};

type SpoolOwner = {
  schemaVersion: "native-event-spool-owner-1";
  pid: number;
  token: string;
};

export function sanitizeOutcomeResult(
  value: unknown,
  exactSecrets: readonly string[] = [],
): OutcomeEvidence {
  const state: ProjectionState = {
    ancestors: new Set<object>(),
    entries: 0,
    remainingBytes: MAX_RESULT_PROJECTION_BYTES,
    exactSecrets: exactSecrets.filter((entry) => entry.length > 0),
  };
  const projected = projectOutcomeValue(value, state, 0);
  const canonical = canonicalJson(projected);
  const projectionBytes = Buffer.byteLength(canonical, "utf8");
  if (projectionBytes > MAX_RESULT_PROJECTION_BYTES) {
    throw new Error("Native guard outcome projection exceeded its byte limit");
  }
  return {
    resultPreview: truncateUtf8(canonical, MAX_RESULT_PREVIEW_BYTES),
    resultDigest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    projectionBytes,
  };
}

export function sanitizeOutcomeDiagnostic(
  value: string,
  exactSecrets: readonly string[] = [],
): string {
  return scrubBoundedString(value, exactSecrets, 4 * 1024);
}

export function createEventSpool(options: EventSpoolOptions): EventSpool {
  return new AtomicEventSpool(options);
}

class AtomicEventSpool implements EventSpool {
  readonly #directory: string;
  readonly #dataPath: string;
  readonly #metadataPath: string;
  readonly #ownerPath: string;
  readonly #upload: EventSpoolOptions["upload"];
  readonly #scheduleTimeout: NonNullable<EventSpoolOptions["scheduleTimeout"]>;
  readonly #cancelTimeout: NonNullable<EventSpoolOptions["cancelTimeout"]>;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  readonly #maxRecordBytes: number;
  readonly #autoFlush: boolean;
  readonly #writeOwnerFile: NonNullable<EventSpoolOptions["writeOwnerFile"]>;
  readonly #syncOwnerFile: NonNullable<EventSpoolOptions["syncOwnerFile"]>;
  readonly #closeOwnerFile: NonNullable<EventSpoolOptions["closeOwnerFile"]>;
  readonly #hardenOwnerFile: NonNullable<EventSpoolOptions["hardenOwnerFile"]>;
  readonly #removeOwnerFile: NonNullable<EventSpoolOptions["removeOwnerFile"]>;
  readonly #renameOwnerFile: NonNullable<EventSpoolOptions["renameOwnerFile"]>;
  readonly #onCorruptData: EventSpoolOptions["onCorruptData"];
  readonly #pendingIds = new Set<string>();
  readonly #acknowledgedIds = new Set<string>();
  readonly #cancelledLeases = new Set<string>();
  readonly #cancelledLeaseEpochs = new Set<string>();
  #pending: PendingEvent[] = [];
  #pendingBytes = 0;
  #tail: Promise<void> = Promise.resolve();
  #loaded = false;
  #ownerToken: string | undefined;
  #ownerReleasePath: string | undefined;
  #ownerReleaseUnverified = false;
  #ownerClaimIncomplete = false;
  #ownershipReady = false;
  #stopped = false;
  #retryAttempt = 0;
  #retryTimer: unknown;
  #uploadController: AbortController | undefined;
  #uploadIdentity: EventUploadLease | undefined;

  constructor(options: EventSpoolOptions) {
    this.#directory = parseSpoolDirectory(options.directory);
    this.#dataPath = `${this.#directory}${sep}${DATA_FILE_NAME}`;
    this.#metadataPath = `${this.#directory}${sep}${METADATA_FILE_NAME}`;
    this.#ownerPath = `${this.#directory}${sep}${OWNER_FILE_NAME}`;
    if (typeof options.upload !== "function") throw new TypeError("Event spool uploader is invalid");
    this.#upload = options.upload;
    this.#scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    });
    this.#cancelTimeout = options.cancelTimeout ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#maxEvents = positiveInteger(
      options.maxEvents ?? MAX_EVENT_SPOOL_EVENTS,
      MAX_EVENT_SPOOL_EVENTS,
      "event limit",
    );
    this.#maxBytes = positiveInteger(
      options.maxBytes ?? MAX_EVENT_SPOOL_BYTES,
      MAX_EVENT_SPOOL_BYTES,
      "byte limit",
    );
    this.#maxRecordBytes = positiveInteger(
      options.maxRecordBytes ?? Math.min(DEFAULT_MAX_RECORD_BYTES, this.#maxBytes),
      Math.min(this.#maxBytes, 1024 * 1024),
      "record limit",
    );
    this.#autoFlush = options.autoFlush !== false;
    this.#writeOwnerFile = options.writeOwnerFile ?? (async (handle, contents) => {
      await handle.writeFile(contents, { encoding: "utf8" });
    });
    this.#syncOwnerFile = options.syncOwnerFile ?? ((handle) => handle.sync());
    this.#closeOwnerFile = options.closeOwnerFile ?? ((handle) => handle.close());
    this.#hardenOwnerFile = options.hardenOwnerFile ?? (async (ownerPath) => {
      if (process.platform !== "win32") await chmod(ownerPath, 0o600);
    });
    this.#removeOwnerFile = options.removeOwnerFile ?? (async (ownerPath) => {
      await unlink(ownerPath);
    });
    this.#renameOwnerFile = options.renameOwnerFile ?? ((source, destination) => rename(source, destination));
    this.#onCorruptData = options.onCorruptData;
  }

  acquire(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("Native guard event spool is stopped"));
    return this.#serialized(async () => {
      this.#assertRunning();
      await this.#ensureOwnership();
    });
  }

  async enqueue(rawEvent: NativeGuardEvent): Promise<boolean> {
    if (this.#stopped) throw new Error("Native guard event spool is stopped");
    const accepted = await this.#serialized(async () => {
      this.#assertRunning();
      await this.#ensureLoaded();
      const event = sanitizeEvent(rawEvent, false);
      if (this.#pendingIds.has(event.eventId) || this.#acknowledgedIds.has(event.eventId)) {
        return false;
      }
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > this.#maxRecordBytes || bytes > this.#maxBytes) {
        throw new TypeError("Native guard event spool record is oversized");
      }
      const entry = { event, line, bytes, priority: eventPriority(event) };
      this.#pending.push(entry);
      this.#pendingIds.add(event.eventId);
      this.#pendingBytes += bytes;
      this.#evictToLimits();
      await this.#writeData();
      await this.#writeMetadata();
      return true;
    });
    if (accepted && this.#autoFlush && !this.#stopped) void this.flushNow();
    return accepted;
  }

  flushNow(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#serialized(async () => {
      if (this.#stopped) return;
      await this.#ensureLoaded();
      await this.#flushPending();
    });
  }

  cancelLease(leaseId: string, leaseEpoch?: number): void {
    if (!SAFE_LEASE_ID.test(leaseId)) return;
    if (leaseEpoch === undefined) {
      this.#cancelledLeases.add(leaseId);
    } else if (Number.isSafeInteger(leaseEpoch) && leaseEpoch > 0) {
      this.#cancelledLeaseEpochs.add(leaseEpochKey(leaseId, leaseEpoch));
    }
    const active = this.#uploadIdentity;
    if (
      active?.leaseId === leaseId &&
      (leaseEpoch === undefined || active.leaseEpoch === leaseEpoch)
    ) {
      this.#uploadController?.abort();
    }
    if (!this.#hasUploadablePending()) this.#clearRetry();
  }

  leaseRenewed(leaseId: string): void {
    if (!SAFE_LEASE_ID.test(leaseId) || this.#stopped) return;
    if (this.#uploadIdentity?.leaseId === leaseId) this.#uploadController?.abort();
    this.#clearRetry();
    if (this.#autoFlush && this.#hasUploadablePending()) void this.flushNow();
  }

  async stop(): Promise<void> {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#clearRetry();
      this.#uploadController?.abort();
    }
    await this.#tail;
    await this.#releaseOwnership();
  }

  async #flushPending(): Promise<void> {
    while (!this.#stopped) {
      const batch = this.#nextBatch();
      if (batch.length === 0) return;
      const first = batch[0];
      const identity = eventIdentity(first.event);
      const controller = new AbortController();
      this.#uploadController = controller;
      this.#uploadIdentity = identity;
      try {
        await this.#upload(identity, batch.map(({ event }) => event), controller.signal);
        if (controller.signal.aborted || this.#stopped || this.#isCancelled(identity)) return;
        this.#retryAttempt = 0;
        for (const entry of batch) this.#rememberAcknowledged(entry.event.eventId);
        await this.#writeMetadata();
        const acknowledged = new Set(batch.map(({ event }) => event.eventId));
        this.#pending = this.#pending.filter(({ event }) => !acknowledged.has(event.eventId));
        for (const eventId of acknowledged) this.#pendingIds.delete(eventId);
        this.#pendingBytes = this.#pending.reduce((total, entry) => total + entry.bytes, 0);
        await this.#writeData();
        await this.#writeMetadata();
      } catch {
        if (!this.#stopped && !this.#isCancelled(identity)) this.#scheduleRetry();
        return;
      } finally {
        if (this.#uploadController === controller) {
          this.#uploadController = undefined;
          this.#uploadIdentity = undefined;
        }
      }
    }
  }

  #nextBatch(): PendingEvent[] {
    const first = this.#pending.find((entry) => !this.#isCancelled(eventIdentity(entry.event)));
    if (first === undefined) return [];
    const identity = eventIdentity(first.event);
    const batch: PendingEvent[] = [];
    let bodyBytes = Buffer.byteLength('{"events":[]}', "utf8");
    for (const entry of this.#pending) {
      if (!sameIdentity(eventIdentity(entry.event), identity)) continue;
      const separatorBytes = batch.length === 0 ? 0 : 1;
      if (
        batch.length >= 100 ||
        bodyBytes + entry.bytes - 1 + separatorBytes > MAX_UPLOAD_BATCH_BYTES
      ) break;
      batch.push(entry);
      bodyBytes += entry.bytes - 1 + separatorBytes;
    }
    return batch;
  }

  #scheduleRetry(): void {
    if (this.#stopped || this.#retryTimer !== undefined || !this.#hasUploadablePending()) return;
    const delayMs = Math.min(30_000, 250 * (2 ** Math.min(this.#retryAttempt, 7)));
    this.#retryAttempt += 1;
    this.#retryTimer = this.#scheduleTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#stopped) void this.flushNow();
    }, delayMs);
    const timer = this.#retryTimer as { unref?: () => void } | undefined;
    timer?.unref?.();
  }

  #clearRetry(): void {
    if (this.#retryTimer === undefined) return;
    try {
      this.#cancelTimeout(this.#retryTimer);
    } catch {
      // A host timer implementation cannot be allowed to break cancellation.
    }
    this.#retryTimer = undefined;
  }

  #hasUploadablePending(): boolean {
    return this.#pending.some((entry) => !this.#isCancelled(eventIdentity(entry.event)));
  }

  #isCancelled(identity: EventUploadLease): boolean {
    return this.#cancelledLeases.has(identity.leaseId) ||
      this.#cancelledLeaseEpochs.has(leaseEpochKey(identity.leaseId, identity.leaseEpoch));
  }

  #rememberAcknowledged(eventId: string): void {
    this.#acknowledgedIds.delete(eventId);
    this.#acknowledgedIds.add(eventId);
    while (this.#acknowledgedIds.size > this.#maxEvents) {
      const oldest = this.#acknowledgedIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#acknowledgedIds.delete(oldest);
    }
  }

  #evictToLimits(): void {
    while (
      this.#pending.length > this.#maxEvents ||
      this.#pendingBytes > this.#maxBytes
    ) {
      let victimIndex = 0;
      for (let index = 1; index < this.#pending.length; index += 1) {
        if (this.#pending[index].priority < this.#pending[victimIndex].priority) {
          victimIndex = index;
        }
      }
      const [victim] = this.#pending.splice(victimIndex, 1);
      this.#pendingIds.delete(victim.event.eventId);
      this.#pendingBytes -= victim.bytes;
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    await this.#ensureOwnership();
    await removeStaleTemporaryFiles(this.#directory);
    await this.#loadMetadata();
    let data: string | undefined;
    try {
      data = await readBoundedFile(
        this.#dataPath,
        this.#maxBytes + this.#maxRecordBytes,
        "event spool data",
      );
    } catch (error) {
      if (error instanceof Error && /corrupt|oversized/i.test(error.message)) {
        await this.#quarantineCorruptData("oversized");
        return;
      }
      throw error;
    }
    let partial = false;
    let needsRewrite = false;
    if (data !== undefined) {
      const completeText = data.endsWith("\n") ? data : data.slice(0, data.lastIndexOf("\n") + 1);
      partial = completeText.length !== data.length;
      try {
        for (const line of completeText.split("\n")) {
          if (line.length === 0) continue;
          if (Buffer.byteLength(line, "utf8") + 1 > this.#maxRecordBytes) {
            throw new Error("Native guard event spool is corrupt or oversized");
          }
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            throw new Error("Native guard event spool is corrupt");
          }
          const event = sanitizeEvent(raw, true);
          if (this.#acknowledgedIds.has(event.eventId) || this.#pendingIds.has(event.eventId)) continue;
          const normalizedLine = `${JSON.stringify(event)}\n`;
          if (normalizedLine !== `${line}\n`) needsRewrite = true;
          const entry = {
            event,
            line: normalizedLine,
            bytes: Buffer.byteLength(normalizedLine, "utf8"),
            priority: eventPriority(event),
          };
          if (entry.bytes > this.#maxRecordBytes) {
            throw new Error("Native guard event spool record is oversized");
          }
          this.#pending.push(entry);
          this.#pendingIds.add(event.eventId);
          this.#pendingBytes += entry.bytes;
        }
      } catch {
        await this.#quarantineCorruptData("corrupt");
        return;
      }
    }
    this.#evictToLimits();
    this.#loaded = true;
    if (
      data === undefined ||
      partial ||
      needsRewrite ||
      this.#pendingBytes !== Buffer.byteLength(data ?? "", "utf8")
    ) {
      await this.#writeData();
    }
    if (!(await pathExists(this.#metadataPath))) await this.#writeMetadata();
  }

  async #quarantineCorruptData(reason: "corrupt" | "oversized"): Promise<void> {
    await quarantineFile(this.#dataPath);
    this.#pending = [];
    this.#pendingIds.clear();
    this.#pendingBytes = 0;
    this.#loaded = true;
    await this.#writeData();
    if (!(await pathExists(this.#metadataPath))) await this.#writeMetadata();
    try {
      await this.#onCorruptData?.(reason);
    } catch {
      // A diagnostic sink cannot prevent the spool from recovering safely.
    }
  }

  async #ensureOwnership(): Promise<void> {
    if (this.#ownershipReady) return;
    if (this.#ownerToken !== undefined) {
      throw new Error("Native guard event spool ownership acquisition is incomplete");
    }
    await ensureSecureDirectory(this.#directory);
    const token = randomUUID();
    const owner: SpoolOwner = {
      schemaVersion: "native-event-spool-owner-1",
      pid: process.pid,
      token,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.#ownerPath, "wx", 0o600);
        // Record the token as soon as wx succeeds. A partial write is still
        // our claim and must be cleaned up through the same atomic release
        // path, never by deleting the canonical path blindly.
        this.#ownerToken = token;
        this.#ownerClaimIncomplete = true;
        try {
          await this.#writeOwnerFile(handle, `${JSON.stringify(owner)}\n`);
          await this.#syncOwnerFile(handle);
          this.#ownerClaimIncomplete = false;
          await handle.close();
          await this.#hardenOwnerFile(this.#ownerPath);
          this.#ownershipReady = true;
          return;
        } catch (error) {
          await handle.close().catch(() => undefined);
          await this.#releaseOwnership().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt > 0 || !(await recoverDeadOwner(this.#ownerPath))) {
          throw new Error("Native guard event spool ownership is unavailable");
        }
      }
    }
    throw new Error("Native guard event spool ownership is unavailable");
  }

  async #releaseOwnership(): Promise<void> {
    const token = this.#ownerToken;
    if (token === undefined) return;

    // Once the canonical path has been moved, all retries target the private
    // inode. This keeps a replacement owner at owner.lock out of the retry
    // path and gives release exactly-one semantics across processes.
    if (this.#ownerReleasePath === undefined) {
      const releasePath = `${this.#ownerPath}.release-${token}-${randomUUID()}`;
      try {
        await this.#renameOwnerFile(this.#ownerPath, releasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.#clearOwnership(token);
          return;
        }
        throw error;
      }
      this.#ownerReleasePath = releasePath;
      this.#ownerReleaseUnverified = this.#ownerClaimIncomplete;
    }

    const releasePath = this.#ownerReleasePath;
    if (releasePath === undefined) return;
    if (!this.#ownerReleaseUnverified) {
      let owner: SpoolOwner;
      try {
        owner = await readSpoolOwner(releasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.#clearOwnership(token);
          return;
        }
        // Preserve and retry only the private inode whose ownership could
        // not be proved. A replacement at the canonical path belongs to a
        // different claimant and must never be moved by this spool.
        throw error;
      }
      if (owner.pid !== process.pid || owner.token !== token) {
        // A different owner was captured by the atomic move. Try to restore
        // it only with exclusive-create semantics; never overwrite a racing
        // claimant. Either way, fail closed and forget our ownership token.
        await restoreOwnerIfAbsent(releasePath, this.#ownerPath).catch(() => undefined);
        this.#ownerReleasePath = undefined;
        this.#ownerReleaseUnverified = false;
        this.#clearOwnership(token);
        throw new Error("Native guard event spool ownership changed during release");
      }
    }
    try {
      await this.#removeOwnerFile(releasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#clearOwnership(token);
        return;
      }
      // The spool is already stopped, so ownership may be handed off while
      // cleanup retries only this private inode. Recreating owner.lock here
      // would introduce duplicate owner state if private removal then failed.
      throw error;
    }
    this.#clearOwnership(token);
  }

  #clearOwnership(token: string): void {
    if (this.#ownerToken !== token) return;
    this.#ownerToken = undefined;
    this.#ownerReleasePath = undefined;
    this.#ownerReleaseUnverified = false;
    this.#ownerClaimIncomplete = false;
    this.#ownershipReady = false;
  }

  async #loadMetadata(): Promise<void> {
    const text = await readBoundedFile(this.#metadataPath, MAX_METADATA_BYTES, "event spool metadata");
    if (text === undefined) return;
    try {
      const raw = JSON.parse(text) as unknown;
      if (!isPlainRecord(raw) || dataProperty(raw, "schemaVersion") !== "native-event-spool-1") {
        throw new Error("invalid metadata");
      }
      const acknowledged = dataProperty(raw, "acknowledgedEventIds");
      if (!Array.isArray(acknowledged) || acknowledged.length > this.#maxEvents) {
        throw new Error("invalid metadata");
      }
      for (let index = 0; index < acknowledged.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(acknowledged, index);
        if (descriptor === undefined || !("value" in descriptor) || !SAFE_EVENT_ID.test(String(descriptor.value))) {
          throw new Error("invalid metadata");
        }
        this.#acknowledgedIds.add(String(descriptor.value));
      }
    } catch {
      await quarantineFile(this.#metadataPath);
      this.#acknowledgedIds.clear();
      await this.#writeMetadata();
    }
  }

  async #writeData(): Promise<void> {
    const contents = this.#pending.map(({ line }) => line).join("");
    if (Buffer.byteLength(contents, "utf8") > this.#maxBytes) {
      throw new Error("Native guard event spool exceeds its byte limit");
    }
    await atomicWrite(this.#directory, this.#dataPath, contents);
  }

  async #writeMetadata(): Promise<void> {
    const metadata: SpoolMetadata = {
      schemaVersion: "native-event-spool-1",
      acknowledgedEventIds: [...this.#acknowledgedIds],
    };
    const contents = `${JSON.stringify(metadata)}\n`;
    if (Buffer.byteLength(contents, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("Native guard event spool metadata is oversized");
    }
    await atomicWrite(this.#directory, this.#metadataPath, contents);
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#tail.then(operation, operation);
    this.#tail = current.then(() => undefined, () => undefined);
    return current;
  }

  #assertRunning(): void {
    if (this.#stopped) throw new Error("Native guard event spool is stopped");
  }
}

type ProjectionState = {
  ancestors: Set<object>;
  entries: number;
  remainingBytes: number;
  exactSecrets: readonly string[];
};

const OMIT_PROJECTION = Symbol("omit-outcome-projection");
const MAX_OUTCOME_STRING_BYTES = 32 * 1024;
const MAX_EXACT_SECRET_OVERLAP = 4 * 1024;

function projectOutcomeValue(
  value: unknown,
  state: ProjectionState,
  depth: number,
): unknown | typeof OMIT_PROJECTION {
  if (depth > MAX_RESULT_DEPTH || state.entries >= MAX_RESULT_ENTRIES || state.remainingBytes <= 0) {
    return projectFixedString("[TRUNCATED]", state);
  }
  state.entries += 1;
  if (value === null) return reserveProjection(state, 4) ? null : OMIT_PROJECTION;
  if (typeof value === "boolean") {
    return reserveProjection(state, value ? 4 : 5) ? value : OMIT_PROJECTION;
  }
  if (typeof value === "string") return boundedOutcomeString(value, state);
  if (typeof value === "number" && Number.isFinite(value)) {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    return reserveProjection(state, bytes) ? value : OMIT_PROJECTION;
  }
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) {
    return projectFixedString("[UNAVAILABLE]", state);
  }
  if (state.ancestors.has(value)) return projectFixedString("[CIRCULAR]", state);

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return projectFixedString("[UNAVAILABLE]", state);
      }
      if (!reserveProjection(state, 2)) return OMIT_PROJECTION;
      const output: unknown[] = [];
      const length = Math.min(value.length, MAX_RESULT_ARRAY_ENTRIES);
      for (let index = 0; index < length; index += 1) {
        const separatorBytes = output.length === 0 ? 0 : 1;
        if (!reserveProjection(state, separatorBytes)) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        const projected = descriptor !== undefined && "value" in descriptor
          ? projectOutcomeValue(descriptor.value, state, depth + 1)
          : projectFixedString("[UNAVAILABLE]", state);
        if (projected === OMIT_PROJECTION) {
          state.remainingBytes += separatorBytes;
          break;
        }
        output.push(projected);
        if (state.entries >= MAX_RESULT_ENTRIES || state.remainingBytes <= 0) break;
      }
      if (value.length > output.length) addArrayTruncation(output, state);
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return projectFixedString("[UNAVAILABLE]", state);
    }
    if (!reserveProjection(state, 2)) return OMIT_PROJECTION;
    const output: Record<string, unknown> = {};
    let keys = 0;
    let truncated = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (keys >= MAX_RESULT_ENTRIES || state.entries >= MAX_RESULT_ENTRIES) {
        truncated = true;
        break;
      }
      const safeKey = scrubBoundedString(
        key,
        state.exactSecrets,
        MAX_OUTCOME_STRING_BYTES,
      );
      if (Object.hasOwn(output, safeKey)) {
        truncated = true;
        break;
      }
      const keyBytes = Buffer.byteLength(JSON.stringify(safeKey), "utf8") + 1 +
        (keys === 0 ? 0 : 1);
      if (!reserveProjection(state, keyBytes)) {
        truncated = true;
        break;
      }
      keys += 1;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const projected = SENSITIVE_KEY.test(key)
        ? projectFixedString("[REDACTED]", state)
        : descriptor !== undefined && "value" in descriptor
          ? projectOutcomeValue(descriptor.value, state, depth + 1)
          : projectFixedString("[UNAVAILABLE]", state);
      if (projected === OMIT_PROJECTION) {
        state.remainingBytes += keyBytes;
        truncated = true;
        break;
      }
      Object.defineProperty(output, safeKey, {
        value: projected,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (state.remainingBytes <= 0) break;
    }
    if (truncated) addObjectTruncation(output, state);
    return output;
  } finally {
    state.ancestors.delete(value);
  }
}

function boundedOutcomeString(
  value: string,
  state: ProjectionState,
): string | typeof OMIT_PROJECTION {
  const scrubbed = scrubBoundedString(value, state.exactSecrets, MAX_OUTCOME_STRING_BYTES);
  const fitted = fitCanonicalString(scrubbed, state.remainingBytes);
  if (fitted === undefined) return OMIT_PROJECTION;
  state.remainingBytes -= Buffer.byteLength(JSON.stringify(fitted), "utf8");
  return fitted;
}

function reserveProjection(state: ProjectionState, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > state.remainingBytes) return false;
  state.remainingBytes -= bytes;
  return true;
}

function projectFixedString(
  value: string,
  state: ProjectionState,
): string | typeof OMIT_PROJECTION {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return reserveProjection(state, bytes) ? value : OMIT_PROJECTION;
}

function addArrayTruncation(output: unknown[], state: ProjectionState): void {
  const separatorBytes = output.length === 0 ? 0 : 1;
  const markerBytes = Buffer.byteLength(JSON.stringify("[TRUNCATED]"), "utf8");
  if (reserveProjection(state, separatorBytes + markerBytes)) output.push("[TRUNCATED]");
}

function addObjectTruncation(output: Record<string, unknown>, state: ProjectionState): void {
  const key = "[TRUNCATED]";
  if (Object.hasOwn(output, key)) return;
  const bytes = Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + 4 +
    (Object.keys(output).length === 0 ? 0 : 1);
  if (!reserveProjection(state, bytes)) return;
  Object.defineProperty(output, key, {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function sanitizeEvent(value: unknown, allowLegacyEpoch: boolean): NativeGuardEvent {
  if (!isPlainRecord(value)) throw new TypeError("Native guard event schema is invalid");
  const schemaVersion = dataProperty(value, "schemaVersion");
  const eventId = dataProperty(value, "eventId");
  const type = dataProperty(value, "type");
  const leaseId = dataProperty(value, "leaseId");
  const explicitLeaseEpoch = dataProperty(value, "leaseEpoch");
  const sessionKey = dataProperty(value, "sessionKey");
  const timestamp = dataProperty(value, "timestamp");
  const rawDetail = dataProperty(value, "detail");
  const legacyLeaseEpoch = allowLegacyEpoch && isPlainRecord(rawDetail)
    ? dataProperty(rawDetail, "leaseEpoch")
    : undefined;
  const leaseEpoch = explicitLeaseEpoch ?? legacyLeaseEpoch;
  if (
    schemaVersion !== "native-guard-1" ||
    typeof eventId !== "string" || !SAFE_EVENT_ID.test(eventId) ||
    typeof type !== "string" || !EVENT_TYPES.has(type as NativeGuardEvent["type"]) ||
    typeof leaseId !== "string" || !SAFE_LEASE_ID.test(leaseId) ||
    !Number.isSafeInteger(leaseEpoch) || (leaseEpoch as number) <= 0 ||
    !safeString(sessionKey, 512) ||
    typeof timestamp !== "string" || !CANONICAL_TIMESTAMP.test(timestamp) ||
    new Date(timestamp).toISOString() !== timestamp
  ) {
    throw new TypeError("Native guard event schema is invalid");
  }
  const detail = projectDetail(type as NativeGuardEvent["type"], rawDetail);
  if (
    allowLegacyEpoch &&
    type === "tool_outcome" &&
    detail.durationSource === undefined
  ) detail.durationSource = "legacy_unspecified";
  validateTypedDetail(type as NativeGuardEvent["type"], value, detail);
  const runId = optionalString(value, "runId", 256);
  const toolCallId = optionalString(value, "toolCallId", 256);
  const decisionId = optionalString(value, "decisionId", 256);
  return {
    schemaVersion,
    eventId,
    type: type as NativeGuardEvent["type"],
    leaseId,
    leaseEpoch: leaseEpoch as number,
    sessionKey,
    ...(runId === undefined ? {} : { runId }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(decisionId === undefined ? {} : { decisionId }),
    timestamp,
    detail,
  };
}

function projectDetail(
  type: NativeGuardEvent["type"],
  rawDetail: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(rawDetail)) throw new TypeError("Native guard event detail is invalid");
  const detail: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS[type]) {
    const descriptor = Object.getOwnPropertyDescriptor(rawDetail, field);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) throw new TypeError("Native guard event detail is invalid");
    Object.defineProperty(detail, field, {
      value: sanitizeDetailValue(descriptor.value, 0, { entries: 0 }),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (typeof detail.resultPreview === "string") {
    detail.resultPreview = truncateUtf8(scrubGenericSecrets(detail.resultPreview), MAX_RESULT_PREVIEW_BYTES);
  }
  if (typeof detail.error === "string") {
    detail.error = truncateUtf8(scrubGenericSecrets(detail.error), 4 * 1024);
  }
  return detail;
}

function sanitizeDetailValue(
  value: unknown,
  depth: number,
  budget: { entries: number },
): unknown {
  if (depth > 8 || budget.entries >= 2_048) return "[TRUNCATED]";
  budget.entries += 1;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateUtf8(scrubGenericSecrets(normalizeUnicode(value)), 32 * 1024);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Native guard event detail is invalid");
    return value;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new TypeError("Native guard event detail is invalid");
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1_000) {
      throw new TypeError("Native guard event detail is invalid");
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("Native guard event detail is invalid");
      }
      result.push(sanitizeDetailValue(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  if (!isPlainRecord(value)) throw new TypeError("Native guard event detail is invalid");
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key) || count >= 1_000) {
      throw new TypeError("Native guard event detail is invalid");
    }
    count += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Native guard event detail is invalid");
    }
    Object.defineProperty(result, key, {
      value: SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : sanitizeDetailValue(descriptor.value, depth + 1, budget),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateTypedDetail(
  type: NativeGuardEvent["type"],
  event: Record<string, unknown>,
  detail: Record<string, unknown>,
): void {
  if (type === "tool_outcome") {
    if (!safeString(dataProperty(event, "toolCallId"), 256)) throw invalidTypedEvent();
    if (!HEX_DIGEST.test(String(detail.finalParamsDigest))) throw invalidTypedEvent();
    if (!HEX_DIGEST.test(String(detail.resultDigest))) throw invalidTypedEvent();
    const durationSource = String(detail.durationSource);
    if (!new Set(["host", "guard_elapsed", "legacy_unspecified", "unavailable"]).has(durationSource)) {
      throw invalidTypedEvent();
    }
    if (durationSource === "unavailable") {
      if (detail.durationMs !== undefined) throw invalidTypedEvent();
    } else if (typeof detail.durationMs !== "number" || detail.durationMs < 0) {
      throw invalidTypedEvent();
    }
    if (detail.resultPreview !== undefined && typeof detail.resultPreview !== "string") throw invalidTypedEvent();
    if (detail.error !== undefined && typeof detail.error !== "string") throw invalidTypedEvent();
  } else if (type === "decision") {
    if (!safeString(dataProperty(event, "toolCallId"), 256) ||
      !safeString(dataProperty(event, "decisionId"), 256) ||
      !safeString(detail.requestId, 256) ||
      !safeString(detail.reasonCode, 128) ||
      !safeString(detail.toolName, 256) ||
      !HEX_DIGEST.test(String(detail.paramsDigest)) ||
      !new Set(["allow", "warn", "deny", "ask", "redact"]).has(String(detail.action))) {
      throw invalidTypedEvent();
    }
  } else if (type === "approval_requested" || type === "approval_resolved") {
    if (!safeString(dataProperty(event, "toolCallId"), 256) || !safeString(detail.approvalId, 256)) {
      throw invalidTypedEvent();
    }
    if (type === "approval_resolved" && !safeString(detail.status, 128)) throw invalidTypedEvent();
  } else if (type === "coverage_changed" && !safeString(detail.coverage, 64)) {
    throw invalidTypedEvent();
  }
}

function invalidTypedEvent(): TypeError {
  return new TypeError("Native guard typed event is invalid");
}

function eventIdentity(event: NativeGuardEvent): EventUploadLease {
  return {
    leaseId: event.leaseId,
    leaseEpoch: event.leaseEpoch,
    sessionKey: event.sessionKey,
  };
}

function sameIdentity(left: EventUploadLease, right: EventUploadLease): boolean {
  return left.leaseId === right.leaseId &&
    left.leaseEpoch === right.leaseEpoch &&
    left.sessionKey === right.sessionKey;
}

function eventPriority(event: NativeGuardEvent): number {
  if (event.type === "approval_requested" || event.type === "approval_resolved") return 4;
  if (event.type === "coverage_changed" || event.type.startsWith("lease_")) return 4;
  if (event.type === "sandbox_attested") return 3;
  if (event.type === "decision") {
    return event.detail.action === "deny" || event.detail.action === "ask" ? 4 : 2;
  }
  if (event.type === "tool_outcome") {
    return event.detail.error !== undefined || event.detail.success === false ? 3 : 0;
  }
  return 1;
}

function leaseEpochKey(leaseId: string, leaseEpoch: number): string {
  return `${leaseId}\0${String(leaseEpoch)}`;
}

function parseSpoolDirectory(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 4_096 ||
    value.includes("\0") ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw new TypeError("Native guard event spool directory is invalid");
  }
  return resolve(value);
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`Native guard event spool ${label} is invalid`);
  }
  return value;
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await verifySecureAncestors(directory);
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Native guard event spool directory is a symlink or is invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await verifySecureAncestors(directory);
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Native guard event spool directory is a symlink or is invalid");
    }
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function verifySecureAncestors(directory: string): Promise<void> {
  let current = directory;
  while (true) {
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Native guard event spool directory is a symlink or is invalid");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function recoverDeadOwner(ownerPath: string): Promise<boolean> {
  const gate = await acquireOwnerRecoveryGate(ownerPath);
  if (gate === undefined) return false;
  try {
    let owner: SpoolOwner;
    try {
      owner = await readSpoolOwner(ownerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (ownerProcessMayExist(owner.pid)) return false;
    const quarantinedPath = `${ownerPath}.stale-${randomUUID()}`;
    try {
      await rename(ownerPath, quarantinedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const quarantined = await readSpoolOwner(quarantinedPath);
      if (quarantined.pid !== owner.pid || quarantined.token !== owner.token) {
        await restoreOwnerIfAbsent(quarantinedPath, ownerPath).catch(() => undefined);
        return false;
      }
      await unlink(quarantinedPath);
      return true;
    } catch {
      await restoreOwnerIfAbsent(quarantinedPath, ownerPath).catch(() => undefined);
      return false;
    }
  } finally {
    await releaseOwnerRecoveryGate(gate);
  }
}

type OwnerRecoveryGate = {
  path: string;
  token: string;
};

async function acquireOwnerRecoveryGate(ownerPath: string): Promise<OwnerRecoveryGate | undefined> {
  const gatePath = `${ownerPath}.recovery`;
  const token = randomUUID();
  const gate = {
    schemaVersion: "native-event-spool-recovery-1",
    pid: process.pid,
    token,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(gatePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(gate)}\n`, { encoding: "utf8" });
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(gatePath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      return { path: gatePath, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: { pid: number; token: string };
    try {
      existing = await readOwnerRecoveryGate(gatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (ownerProcessMayExist(existing.pid)) return undefined;

    const quarantinedPath = `${gatePath}.stale-${randomUUID()}`;
    try {
      await rename(gatePath, quarantinedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const quarantined = await readOwnerRecoveryGate(quarantinedPath);
      if (quarantined.pid !== existing.pid || quarantined.token !== existing.token) {
        await restoreOwnerIfAbsent(quarantinedPath, gatePath).catch(() => undefined);
        return undefined;
      }
      await unlink(quarantinedPath);
    } catch {
      await restoreOwnerIfAbsent(quarantinedPath, gatePath).catch(() => undefined);
      return undefined;
    }
  }
  return undefined;
}

async function releaseOwnerRecoveryGate(gate: OwnerRecoveryGate): Promise<void> {
  const privatePath = `${gate.path}.release-${gate.token}-${randomUUID()}`;
  try {
    await rename(gate.path, privatePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const current = await readOwnerRecoveryGate(privatePath);
    if (current.pid !== process.pid || current.token !== gate.token) {
      await restoreOwnerIfAbsent(privatePath, gate.path).catch(() => undefined);
      throw new Error("Native guard event spool recovery gate changed during release");
    }
    await unlink(privatePath);
  } catch (error) {
    await restoreOwnerIfAbsent(privatePath, gate.path).catch(() => undefined);
    throw error;
  }
}

async function readOwnerRecoveryGate(gatePath: string): Promise<{ pid: number; token: string }> {
  const metadata = await lstat(gatePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  const bytes = await readFile(gatePath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "pid,schemaVersion,token" ||
    value.schemaVersion !== "native-event-spool-recovery-1" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.token)
  ) throw new Error("Native guard event spool ownership is unsafe");
  return { pid: value.pid as number, token: value.token };
}

async function restoreOwnerIfAbsent(sourcePath: string, destinationPath: string): Promise<boolean> {
  const metadata = await lstat(sourcePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  const contents = await readFile(sourcePath);
  if (contents.byteLength === 0 || contents.byteLength > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  let handle: OwnerFileHandle | undefined;
  try {
    handle = await open(destinationPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(destinationPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
  try {
    await unlink(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return true;
}

async function readSpoolOwner(ownerPath: string): Promise<SpoolOwner> {
  const metadata = await lstat(ownerPath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  const bytes = await readFile(ownerPath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_OWNER_BYTES) {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Native guard event spool ownership is unsafe");
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "pid,schemaVersion,token" ||
    value.schemaVersion !== "native-event-spool-owner-1" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(value.token)
  ) throw new Error("Native guard event spool ownership is unsafe");
  return value as SpoolOwner;
}

function ownerProcessMayExist(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleTemporaryFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^\.(events\.jsonl|metadata\.json)\.tmp-[0-9a-f-]{36}$/.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Native guard event spool temporary file is unsafe");
    }
    await unlink(`${directory}${sep}${entry.name}`);
  }
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Native guard ${label} is a symlink or is invalid`);
  }
  if (metadata.size > maxBytes) throw new Error(`Native guard ${label} is corrupt or oversized`);
  const contents = await readFile(path);
  if (contents.byteLength > maxBytes) throw new Error(`Native guard ${label} is corrupt or oversized`);
  return contents.toString("utf8");
}

async function atomicWrite(directory: string, destination: string, contents: string): Promise<void> {
  await rejectSymlink(destination);
  const base = destination.slice(destination.lastIndexOf(sep) + 1);
  const temporary = `${directory}${sep}.${base}.tmp-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    if (process.platform !== "win32") await chmod(destination, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Native guard event spool file is a symlink or is invalid");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function quarantineFile(path: string): Promise<void> {
  await rejectSymlink(path);
  await rename(path, `${path}.corrupt-${randomUUID()}`);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !new Set(["EACCES", "EBADF", "EINVAL", "EPERM"]).has(code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new TypeError("Native guard event contains an accessor");
  return descriptor.value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const candidate = dataProperty(value, key);
  if (candidate === undefined) return undefined;
  if (!safeString(candidate, maxLength)) throw new TypeError("Native guard event identity is invalid");
  return candidate;
}

function safeString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\x00-\x1f\x7f]/.test(value);
}

function scrubGenericSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]{0,64}PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]{0,64}PRIVATE KEY-----|$)/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(authorization|cookie)\b\s*[:=]\s*[^\r\n,]+/gi, "$1=[REDACTED]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|credential)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1=[REDACTED]",
    );
}

function scrubBoundedString(
  value: string,
  exactSecrets: readonly string[],
  maxOutputBytes: number,
): string {
  const secrets = exactSecrets
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => entry.slice(0, MAX_EXACT_SECRET_OVERLAP));
  const overlap = Math.min(
    MAX_EXACT_SECRET_OVERLAP,
    Math.max(128, ...secrets.map(({ length }) => length)),
  );
  const rawLimit = maxOutputBytes + overlap;
  const raw = value.length > rawLimit ? value.slice(0, rawLimit) : value;
  let scrubbed = scrubGenericSecrets(normalizeUnicode(raw));
  for (const secret of secrets) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  const truncated = value.length > raw.length;
  const suffix = truncated ? "[TRUNCATED]" : "";
  const prefixBudget = Math.max(0, maxOutputBytes - Buffer.byteLength(suffix, "utf8"));
  return `${truncateUtf8(scrubbed, prefixBudget)}${suffix}`;
}

function fitCanonicalString(value: string, maxBytes: number): string | undefined {
  if (maxBytes < 2) return undefined;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = safeCodeUnitPrefix(value, middle);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return safeCodeUnitPrefix(value, low);
}

function safeCodeUnitPrefix(value: string, length: number): string {
  let end = Math.min(value.length, Math.max(0, length));
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff
  ) end -= 1;
  return value.slice(0, end);
}

function normalizeUnicode(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
    } else {
      output += value[index];
    }
  }
  return output;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
