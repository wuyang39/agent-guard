import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  NativeGuardEvent,
  RuntimeSupervisionRecord,
} from "@agent-guard/contracts";
import { digestJson } from "@agent-guard/native-guard-protocol";
import { Mutex } from "../shared/mutex";
import { resolveInsideDirectory } from "./pathSafety";

const DEFAULT_ROOT = path.resolve(
  process.cwd(),
  "outputs",
  "native-guard",
  "events",
);
const SAFE_LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(authorization|credential|privatekey|apikey|token|secret|password|cookie)/i;
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
const RECORD_ACTIONS = new Set<RuntimeSupervisionRecord["action"]>([
  "allow",
  "deny",
  "ask",
  "warn",
  "redact",
  "isolate",
]);
const RECORD_TARGETS = new Set<RuntimeSupervisionRecord["targetType"]>([
  "tool_call",
  "resource_access",
  "api_call",
  "file_write",
  "email_send",
  "code_execution",
  "agent_message",
]);
const NATIVE_ACTIONS = new Set(["allow", "warn", "deny", "ask", "redact"]);
const COVERAGE_VALUES = new Set([
  "off",
  "ready",
  "active",
  "recovery",
  "conditional",
  "unsupported",
  "misconfigured",
]);
const HEX_DIGEST = /^[a-f0-9]{64}$/i;
const MAX_RESULT_PREVIEW_BYTES = 8 * 1024;
const COMMON_DETAIL_FIELDS = ["reasonCode", "message", "value"] as const;
const DETAIL_FIELDS: Record<NativeGuardEvent["type"], readonly string[]> = {
  decision: [
    ...COMMON_DETAIL_FIELDS,
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
    ...COMMON_DETAIL_FIELDS,
    "leaseEpoch",
    "policyPackId",
    "policyPackDigest",
    "mode",
    "scope",
    "expiresAt",
    "status",
  ],
  lease_renewed: [
    ...COMMON_DETAIL_FIELDS,
    "leaseEpoch",
    "policyPackId",
    "policyPackDigest",
    "expiresAt",
    "status",
  ],
  lease_recovery: [
    ...COMMON_DETAIL_FIELDS,
    "leaseEpoch",
    "policyPackId",
    "policyPackDigest",
    "expiresAt",
    "status",
  ],
  lease_revoked: [...COMMON_DETAIL_FIELDS, "leaseEpoch", "status"],
  approval_requested: [
    ...COMMON_DETAIL_FIELDS,
    "requestId",
    "approvalId",
    "action",
    "status",
  ],
  approval_resolved: [
    ...COMMON_DETAIL_FIELDS,
    "requestId",
    "approvalId",
    "action",
    "status",
    "resolvedBy",
  ],
  tool_outcome: [
    ...COMMON_DETAIL_FIELDS,
    "requestId",
    "action",
    "status",
    "outcome",
    "success",
    "durationMs",
    "finalParamsDigest",
    "resultDigest",
    "resultPreview",
    "error",
    "errorCode",
    "riskTags",
  ],
  sandbox_attested: [
    ...COMMON_DETAIL_FIELDS,
    "status",
    "imageId",
    "containerId",
    "configDigest",
    "networkMode",
    "readOnlyRoot",
    "workspaceAccess",
  ],
  coverage_changed: [
    ...COMMON_DETAIL_FIELDS,
    "coverage",
    "previousCoverage",
    "finalizerAssurance",
    "conflictingPluginIds",
  ],
};

type StoredEnvelope = {
  sequence?: number;
  event: NativeGuardEvent;
  record?: RuntimeSupervisionRecord;
};

type RootCoordination = {
  mutex: Mutex;
  generation: number;
  listeners: Set<NativeGuardEventListener>;
};

const rootCoordinations = new Map<string, RootCoordination>();

export type NativeGuardEventListener = (
  event: NativeGuardEvent,
  record?: RuntimeSupervisionRecord,
) => void | Promise<void>;

export const NATIVE_GUARD_EVENT_STORE_PROCESS_MODEL = "single_process" as const;

export type NativeGuardEventStore = {
  append(
    event: NativeGuardEvent,
    record?: RuntimeSupervisionRecord,
  ): Promise<boolean>;
  listByRun(runId: string): Promise<NativeGuardEvent[]>;
  listRecordsByRun(runId: string): Promise<RuntimeSupervisionRecord[]>;
  listBySession(sessionKey: string): Promise<NativeGuardEvent[]>;
  subscribe(listener: NativeGuardEventListener): () => void;
};

export type NativeGuardEventStoreOptions = {
  rootDir?: string;
  fileHooks?: NativeGuardEventStoreFileHooks;
};

export type NativeGuardEventStoreFileHooks = {
  beforeAtomicRename?: (context: {
    kind: "active" | "quarantine";
    targetPath: string;
    tempPath: string;
  }) => void | Promise<void>;
  afterAppendSync?: (context: {
    targetPath: string;
  }) => void | Promise<void>;
};

export class NativeGuardEventConflictError extends Error {
  readonly code = "NATIVE_GUARD_EVENT_CONFLICT";

  constructor() {
    super("Native guard event id conflicts with different persisted content");
    this.name = "NativeGuardEventConflictError";
  }
}

export function createNativeGuardEventStore(
  options: NativeGuardEventStoreOptions = {},
): NativeGuardEventStore {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const coordination = coordinationFor(rootDir);
  const eventIds = new Set<string>();
  const envelopes: StoredEnvelope[] = [];
  let loading: Promise<void> | undefined;
  let loadedGeneration = -1;
  let nextSequence = 1;

  async function ensureLoaded(): Promise<void> {
    if (!loading || loadedGeneration !== coordination.generation) {
      eventIds.clear();
      envelopes.length = 0;
      nextSequence = 1;
      loading = loadExisting(rootDir, eventIds, envelopes, options.fileHooks)
        .then(() => {
          nextSequence =
            envelopes.reduce(
              (highest, envelope) =>
                Math.max(highest, envelope.sequence ?? 0),
              0,
            ) + 1;
          loadedGeneration = coordination.generation;
        })
        .catch((error) => {
          loading = undefined;
          loadedGeneration = -1;
          eventIds.clear();
          envelopes.length = 0;
          nextSequence = 1;
          throw error;
        });
    }
    await loading;
  }

  return {
    async append(
      event: NativeGuardEvent,
      record?: RuntimeSupervisionRecord,
    ): Promise<boolean> {
      let stored: StoredEnvelope | undefined;
      const appended = await coordination.mutex.run(async () => {
        await ensureLoaded();
        assertLeaseId(event.leaseId);
        assertNonEmptyId(event.eventId, "event id");
        stored = sanitizeEnvelope({
          sequence: nextSequence,
          event,
          ...(record ? { record } : {}),
        });
        assertValidStoredEnvelope(stored, event.leaseId);
        if (eventIds.has(stored.event.eventId)) {
          const existing = envelopes.find(
            ({ event: savedEvent }) =>
              savedEvent.eventId === stored!.event.eventId,
          );
          if (!existing || !sameLogicalEnvelope(existing, stored)) {
            throw new NativeGuardEventConflictError();
          }
          return false;
        }
        const filePath = eventFilePath(rootDir, stored.event.leaseId);
        await fs.mkdir(rootDir, { recursive: true });
        try {
          await appendDurably(
            filePath,
            `${JSON.stringify(stored)}\n`,
            options.fileHooks,
          );
        } catch (error) {
          coordination.generation += 1;
          loading = undefined;
          loadedGeneration = -1;
          eventIds.clear();
          envelopes.length = 0;
          nextSequence = 1;
          throw error;
        }
        eventIds.add(stored.event.eventId);
        envelopes.push(stored);
        nextSequence += 1;
        coordination.generation += 1;
        loadedGeneration = coordination.generation;
        return true;
      });

      if (appended && stored) {
        for (const listener of coordination.listeners) {
          try {
            void Promise.resolve(
              listener(
                clone(stored.event),
                stored.record ? clone(stored.record) : undefined,
              ),
            ).catch(() => undefined);
          } catch {
            // Listener failures must not change a decision that is already durable.
          }
        }
      }
      return appended;
    },

    async listByRun(runId: string): Promise<NativeGuardEvent[]> {
      return coordination.mutex.run(async () => {
        await ensureLoaded();
        return envelopes
          .filter(({ event }) => event.runId === runId)
          .map(({ event }) => clone(event));
      });
    },

    async listRecordsByRun(runId: string): Promise<RuntimeSupervisionRecord[]> {
      return coordination.mutex.run(async () => {
        await ensureLoaded();
        return envelopes
          .filter(({ event, record }) => event.runId === runId && record !== undefined)
          .map(({ record }) => clone(record!));
      });
    },

    async listBySession(sessionKey: string): Promise<NativeGuardEvent[]> {
      return coordination.mutex.run(async () => {
        await ensureLoaded();
        return envelopes
          .filter(({ event }) => event.sessionKey === sessionKey)
          .map(({ event }) => clone(event));
      });
    },

    subscribe(listener: NativeGuardEventListener): () => void {
      coordination.listeners.add(listener);
      return () => {
        coordination.listeners.delete(listener);
      };
    },
  };
}

async function appendDurably(
  filePath: string,
  content: string,
  fileHooks?: NativeGuardEventStoreFileHooks,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "a", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await fileHooks?.afterAppendSync?.({ targetPath: filePath });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function coordinationFor(rootDir: string): RootCoordination {
  const key = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  let coordination = rootCoordinations.get(key);
  if (!coordination) {
    coordination = { mutex: new Mutex(), generation: 0, listeners: new Set() };
    rootCoordinations.set(key, coordination);
  }
  return coordination;
}

async function loadExisting(
  rootDir: string,
  eventIds: Set<string>,
  envelopes: StoredEnvelope[],
  fileHooks?: NativeGuardEventStoreFileHooks,
): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const leaseId = entry.name.slice(0, -".jsonl".length);
    if (!SAFE_LEASE_ID.test(leaseId)) continue;
    const filePath = eventFilePath(rootDir, leaseId);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const validLines: string[] = [];
    let corruption: { line: number; reasonCode: string } | undefined;
    let needsRewrite = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        corruption = { line: index + 1, reasonCode: "empty_line" };
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruption = { line: index + 1, reasonCode: "invalid_json" };
        break;
      }
      try {
        assertValidStoredEnvelope(parsed, leaseId);
      } catch {
        corruption = { line: index + 1, reasonCode: "invalid_schema" };
        break;
      }
      const envelope = sanitizeEnvelope(parsed as StoredEnvelope);
      const safeLine = JSON.stringify(envelope);
      if (safeLine !== line) needsRewrite = true;
      assertNonEmptyId(envelope.event.eventId, "event id");
      if (eventIds.has(envelope.event.eventId)) {
        corruption = { line: index + 1, reasonCode: "duplicate_event_id" };
        break;
      }
      eventIds.add(envelope.event.eventId);
      envelopes.push(envelope);
      validLines.push(safeLine);
    }
    if (corruption) {
      await quarantineAndRepair(
        rootDir,
        filePath,
        validLines,
        corruption,
        fileHooks,
      );
    } else if (needsRewrite) {
      await rewriteJsonl(filePath, validLines, "active", fileHooks);
    }
  }
  envelopes.sort((left, right) => {
    if (left.sequence === undefined || right.sequence === undefined) return 0;
    return left.sequence - right.sequence;
  });
}

async function quarantineAndRepair(
  rootDir: string,
  filePath: string,
  validLines: string[],
  corruption: { line: number; reasonCode: string },
  fileHooks?: NativeGuardEventStoreFileHooks,
): Promise<void> {
  const quarantinePath = resolveInsideDirectory(
    rootDir,
    `${path.basename(filePath)}.corrupt-${randomUUID()}`,
  );
  const metadata = JSON.stringify({
    schemaVersion: "native-guard-quarantine-1",
    sourceFile: path.basename(filePath),
    validPrefixCount: validLines.length,
    corruption,
  });
  await atomicWriteFile(
    quarantinePath,
    `${validLines.join("\n")}${validLines.length > 0 ? "\n" : ""}${metadata}\n`,
    "quarantine",
    fileHooks,
  );
  await rewriteJsonl(filePath, validLines, "active", fileHooks);
}

async function rewriteJsonl(
  filePath: string,
  validLines: string[],
  kind: "active" | "quarantine",
  fileHooks?: NativeGuardEventStoreFileHooks,
): Promise<void> {
  const content = validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
  await atomicWriteFile(filePath, content, kind, fileHooks);
}

async function atomicWriteFile(
  targetPath: string,
  content: string,
  kind: "active" | "quarantine",
  fileHooks?: NativeGuardEventStoreFileHooks,
): Promise<void> {
  const directory = path.dirname(targetPath);
  const tempPath = resolveInsideDirectory(
    directory,
    `.${path.basename(targetPath)}.tmp-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fileHooks?.beforeAtomicRename?.({ kind, targetPath, tempPath });
    await fs.rename(tempPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function eventFilePath(rootDir: string, leaseId: string): string {
  assertLeaseId(leaseId);
  return resolveInsideDirectory(rootDir, `${leaseId}.jsonl`);
}

function assertLeaseId(leaseId: string): void {
  if (!SAFE_LEASE_ID.test(leaseId)) {
    throw new Error("Native guard lease id is not path safe");
  }
}

function assertNonEmptyId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Native guard ${label} must be non-empty`);
  }
}

function sanitizeEnvelope(envelope: StoredEnvelope): StoredEnvelope {
  const sanitized = sanitizeValue(envelope, new Set<object>()) as StoredEnvelope;
  assertValidStoredEnvelope(sanitized, sanitized.event.leaseId);
  return projectEnvelope(sanitized);
}

function projectEnvelope(envelope: StoredEnvelope): StoredEnvelope {
  return {
    ...(envelope.sequence === undefined ? {} : { sequence: envelope.sequence }),
    event: projectEvent(envelope.event),
    ...(envelope.record ? { record: projectRecord(envelope.record) } : {}),
  };
}

function projectEvent(event: NativeGuardEvent): NativeGuardEvent {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    type: event.type,
    leaseId: event.leaseId,
    sessionKey: event.sessionKey,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(event.decisionId === undefined ? {} : { decisionId: event.decisionId }),
    timestamp: event.timestamp,
    detail: projectEventDetail(event.type, event.detail),
  };
}

function projectEventDetail(
  type: NativeGuardEvent["type"],
  detail: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "decision":
    case "lease_activated":
    case "lease_renewed":
    case "lease_recovery":
    case "lease_revoked":
    case "approval_requested":
    case "approval_resolved":
    case "sandbox_attested":
    case "coverage_changed":
      return pickFields(detail, DETAIL_FIELDS[type]);
    case "tool_outcome": {
      const projected = pickFields(detail, DETAIL_FIELDS[type]);
      if (typeof projected.resultPreview === "string") {
        projected.resultPreview = truncateUtf8(
          projected.resultPreview,
          MAX_RESULT_PREVIEW_BYTES,
        );
      }
      return projected;
    }
  }
}

function projectRecord(
  record: RuntimeSupervisionRecord,
): RuntimeSupervisionRecord {
  return {
    schemaVersion: record.schemaVersion,
    recordId: record.recordId,
    runtimeSessionId: record.runtimeSessionId,
    agentId: record.agentId,
    policyPackId: record.policyPackId,
    policyId: record.policyId,
    action: record.action,
    decisionReason: record.decisionReason,
    targetType: record.targetType,
    ...(record.targetId === undefined ? {} : { targetId: record.targetId }),
    ...(record.inputEventId === undefined
      ? {}
      : { inputEventId: record.inputEventId }),
    ...(record.outputEventId === undefined
      ? {}
      : { outputEventId: record.outputEventId }),
    ...(record.gateway === undefined
      ? {}
      : { gateway: projectGateway(record.gateway) as RuntimeSupervisionRecord["gateway"] }),
    createdAt: record.createdAt,
  };
}

function projectGateway(gateway: Record<string, unknown>): Record<string, unknown> {
  const projected = pickFields(gateway, [
    "providerId",
    "providerName",
    "providerType",
    "originalToolName",
    "exposedToolName",
    "canonicalToolId",
    "decisionSource",
  ]);
  if (isPlainObject(gateway.capabilityProfileSnapshot)) {
    projected.capabilityProfileSnapshot = pickFields(
      gateway.capabilityProfileSnapshot,
      [
        "schemaVersion",
        "originalToolName",
        "canonicalToolId",
        "providerType",
        "surfaces",
        "operations",
        "capabilityTags",
        "riskTags",
        "sideEffect",
        "dataClasses",
        "authScopes",
        "networkReachability",
        "sensitiveFields",
        "confidence",
        "profileSource",
        "llmAssisted",
      ],
    );
  }
  if (isPlainObject(gateway.batch)) {
    projected.batch = pickFields(gateway.batch, [
      "batchId",
      "externalCaseId",
      "source",
    ]);
  }
  return projected;
}

function pickFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) projected[field] = source[field];
  }
  return projected;
}

function sameLogicalEnvelope(
  left: StoredEnvelope,
  right: StoredEnvelope,
): boolean {
  return digestJson({ event: left.event, record: left.record ?? null }) ===
    digestJson({ event: right.event, record: right.record ?? null });
}

function sanitizeValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Native guard events support finite JSON numbers only");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Native guard events support JSON values only");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Native guard events do not support circular values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Native guard events support plain JSON objects only");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Native guard events do not support sparse arrays");
        }
        return sanitizeValue(entry, ancestors);
      });
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = sanitizeValue(entry, ancestors);
      Object.defineProperty(result, key, {
        value: isSensitiveKey(key) ? "[REDACTED]" : sanitized,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/[-_\s]/g, ""));
}

function scrubString(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(authorization|cookie)\b\s*[:=]\s*[^\r\n,]+/gi, "$1=[REDACTED]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|secret|password|credential)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
      "$1=[REDACTED]",
    );
}

function assertValidStoredEnvelope(
  value: unknown,
  expectedLeaseId: string,
): asserts value is StoredEnvelope {
  if (!isPlainObject(value) || !isPlainObject(value.event)) {
    throw new Error("Native guard event envelope schema is invalid");
  }
  if (
    value.sequence !== undefined &&
    (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0)
  ) {
    throw new Error("Native guard event sequence is invalid");
  }
  assertValidEvent(value.event, expectedLeaseId);
  if (value.record !== undefined) assertValidRecord(value.record);
}

function assertValidEvent(
  event: Record<string, unknown>,
  expectedLeaseId: string,
): void {
  if (event.schemaVersion !== "native-guard-1") {
    throw new Error("Native guard event schema is invalid");
  }
  for (const field of ["eventId", "leaseId", "sessionKey"] as const) {
    if (!isNonEmptyString(event[field])) {
      throw new Error(`Native guard event ${field} is invalid`);
    }
  }
  if (event.leaseId !== expectedLeaseId) {
    throw new Error("Native guard event lease id does not match its file");
  }
  if (!EVENT_TYPES.has(event.type as NativeGuardEvent["type"])) {
    throw new Error("Native guard event type is invalid");
  }
  assertCanonicalTimestamp(event.timestamp, "event timestamp");
  for (const field of ["runId", "toolCallId", "decisionId"] as const) {
    if (event[field] !== undefined && !isNonEmptyString(event[field])) {
      throw new Error(`Native guard event ${field} is invalid`);
    }
  }
  if (!isPlainObject(event.detail) || !isJsonTree(event.detail)) {
    throw new Error("Native guard event detail is invalid JSON");
  }
  assertTypedEvent(event.type as NativeGuardEvent["type"], event);
}

function assertTypedEvent(
  type: NativeGuardEvent["type"],
  event: Record<string, unknown>,
): void {
  const detail = event.detail as Record<string, unknown>;
  switch (type) {
    case "decision":
      requireEventId(event.toolCallId, "decision toolCallId");
      requireEventId(event.decisionId, "decision decisionId");
      for (const field of [
        "requestId",
        "reasonCode",
        "targetType",
        "toolName",
      ] as const) {
        requireDetailString(detail, field, "decision");
      }
      if (!NATIVE_ACTIONS.has(detail.action as string)) {
        throw new Error("Native guard decision action is invalid");
      }
      if (!RECORD_TARGETS.has(detail.targetType as RuntimeSupervisionRecord["targetType"])) {
        throw new Error("Native guard decision targetType is invalid");
      }
      requireDigest(detail.paramsDigest, "decision paramsDigest");
      if (detail.action === "redact") {
        requireDigest(
          detail.rewrittenParamsDigest,
          "decision rewritten params digest",
        );
      } else if (detail.rewrittenParamsDigest !== undefined) {
        requireDigest(
          detail.rewrittenParamsDigest,
          "decision rewritten params digest",
        );
      }
      return;
    case "tool_outcome":
      requireEventId(event.toolCallId, "tool outcome toolCallId");
      requireDigest(detail.finalParamsDigest, "tool outcome finalParamsDigest");
      requireDigest(detail.resultDigest, "tool outcome resultDigest");
      if (
        typeof detail.durationMs !== "number" ||
        !Number.isFinite(detail.durationMs) ||
        detail.durationMs < 0
      ) {
        throw new Error("Native guard tool outcome durationMs is invalid");
      }
      assertOptionalDetailString(detail, "error", "tool outcome");
      assertOptionalDetailString(detail, "resultPreview", "tool outcome");
      return;
    case "lease_activated":
    case "lease_renewed":
    case "lease_recovery":
    case "lease_revoked":
      if (!Number.isSafeInteger(detail.leaseEpoch) || (detail.leaseEpoch as number) <= 0) {
        throw new Error(`Native guard ${type} leaseEpoch is invalid`);
      }
      return;
    case "approval_requested":
      requireEventId(event.toolCallId, "approval requested toolCallId");
      requireDetailString(detail, "approvalId", "approval requested");
      return;
    case "approval_resolved":
      requireEventId(event.toolCallId, "approval resolved toolCallId");
      requireDetailString(detail, "approvalId", "approval resolved");
      requireDetailString(detail, "status", "approval resolved");
      return;
    case "sandbox_attested":
      requireDetailString(detail, "status", "sandbox attestation");
      requireDetailString(detail, "configDigest", "sandbox attestation");
      return;
    case "coverage_changed":
      if (!COVERAGE_VALUES.has(detail.coverage as string)) {
        throw new Error("Native guard coverage change coverage is invalid");
      }
      return;
  }
}

function requireEventId(value: unknown, label: string): void {
  if (!isNonEmptyString(value)) throw new Error(`Native guard ${label} is required`);
}

function requireDetailString(
  detail: Record<string, unknown>,
  field: string,
  context: string,
): void {
  if (!isNonEmptyString(detail[field])) {
    throw new Error(`Native guard ${context} detail ${field} is required`);
  }
}

function assertOptionalDetailString(
  detail: Record<string, unknown>,
  field: string,
  context: string,
): void {
  if (detail[field] !== undefined && typeof detail[field] !== "string") {
    throw new Error(`Native guard ${context} detail ${field} is invalid`);
  }
}

function requireDigest(value: unknown, label: string): void {
  if (typeof value !== "string" || !HEX_DIGEST.test(value)) {
    throw new Error(`Native guard ${label} must be a 64 character hex digest`);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertValidRecord(value: unknown): void {
  if (!isPlainObject(value)) {
    throw new Error("Native guard supervision record schema is invalid");
  }
  if (value.schemaVersion !== "mvp-1" && value.schemaVersion !== "p3-a-1") {
    throw new Error("Native guard supervision record schema is invalid");
  }
  for (const field of [
    "recordId",
    "runtimeSessionId",
    "agentId",
    "policyPackId",
    "policyId",
    "decisionReason",
  ] as const) {
    if (!isNonEmptyString(value[field])) {
      throw new Error(`Native guard supervision record ${field} is invalid`);
    }
  }
  if (!RECORD_ACTIONS.has(value.action as RuntimeSupervisionRecord["action"])) {
    throw new Error("Native guard supervision record action is invalid");
  }
  if (!RECORD_TARGETS.has(value.targetType as RuntimeSupervisionRecord["targetType"])) {
    throw new Error("Native guard supervision record target is invalid");
  }
  for (const field of ["targetId", "inputEventId", "outputEventId"] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) {
      throw new Error(`Native guard supervision record ${field} is invalid`);
    }
  }
  assertCanonicalTimestamp(value.createdAt, "supervision record timestamp");
  if (
    value.gateway !== undefined &&
    (!isPlainObject(value.gateway) || !isJsonTree(value.gateway))
  ) {
    throw new Error("Native guard supervision record gateway is invalid JSON");
  }
}

function assertCanonicalTimestamp(value: unknown, label: string): void {
  if (!isNonEmptyString(value)) throw new Error(`Native guard ${label} is invalid`);
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs) || new Date(timeMs).toISOString() !== value) {
    throw new Error(`Native guard ${label} must be canonical`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonTree(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonTree);
  return isPlainObject(value) && Object.values(value).every(isJsonTree);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
