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
    "resultDigest",
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
      loading = loadExisting(rootDir, eventIds, envelopes)
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
        await fs.appendFile(filePath, `${JSON.stringify(stored)}\n`, "utf8");
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
): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const leaseId = entry.name.slice(0, -".jsonl".length);
    assertLeaseId(leaseId);
    const filePath = eventFilePath(rootDir, leaseId);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const validLines: string[] = [];
    let corrupt = false;
    let needsRewrite = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        corrupt = true;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
        assertValidStoredEnvelope(parsed, leaseId);
      } catch {
        corrupt = true;
        break;
      }
      const envelope = sanitizeEnvelope(parsed as StoredEnvelope);
      const safeLine = JSON.stringify(envelope);
      if (safeLine !== line) needsRewrite = true;
      assertNonEmptyId(envelope.event.eventId, "event id");
      if (eventIds.has(envelope.event.eventId)) {
        corrupt = true;
        break;
      }
      eventIds.add(envelope.event.eventId);
      envelopes.push(envelope);
      validLines.push(safeLine);
    }
    if (corrupt) {
      await quarantineAndRepair(rootDir, filePath, validLines);
    } else if (needsRewrite) {
      await rewriteJsonl(filePath, validLines);
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
): Promise<void> {
  const quarantinePath = resolveInsideDirectory(
    rootDir,
    `${path.basename(filePath)}.corrupt-${randomUUID()}`,
  );
  await fs.rename(filePath, quarantinePath);
  await rewriteJsonl(filePath, validLines);
}

async function rewriteJsonl(
  filePath: string,
  validLines: string[],
): Promise<void> {
  const content = validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
  await fs.writeFile(filePath, content, "utf8");
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
    detail: pickFields(event.detail, DETAIL_FIELDS[event.type]),
  };
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
