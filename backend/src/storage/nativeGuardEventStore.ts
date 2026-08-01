import fs from "node:fs/promises";
import path from "node:path";
import type {
  NativeGuardEvent,
  RuntimeSupervisionRecord,
} from "@agent-guard/contracts";
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

type StoredEnvelope = {
  sequence?: number;
  event: NativeGuardEvent;
  record?: RuntimeSupervisionRecord;
};

type RootCoordination = {
  mutex: Mutex;
  generation: number;
};

const rootCoordinations = new Map<string, RootCoordination>();

export type NativeGuardEventListener = (
  event: NativeGuardEvent,
  record?: RuntimeSupervisionRecord,
) => void;

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

export function createNativeGuardEventStore(
  options: NativeGuardEventStoreOptions = {},
): NativeGuardEventStore {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_ROOT);
  const coordination = coordinationFor(rootDir);
  const eventIds = new Set<string>();
  const envelopes: StoredEnvelope[] = [];
  const listeners = new Set<NativeGuardEventListener>();
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
        if (eventIds.has(event.eventId)) return false;

        stored = sanitizeEnvelope({
          sequence: nextSequence,
          event,
          ...(record ? { record } : {}),
        });
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
        for (const listener of listeners) {
          try {
            listener(clone(stored.event), stored.record ? clone(stored.record) : undefined);
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
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function coordinationFor(rootDir: string): RootCoordination {
  const key = process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  let coordination = rootCoordinations.get(key);
  if (!coordination) {
    coordination = { mutex: new Mutex(), generation: 0 };
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

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) {
        throw corruptStore(entry.name, index + 1);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw corruptStore(entry.name, index + 1);
      }
      if (!isStoredEnvelope(parsed) || parsed.event.leaseId !== leaseId) {
        throw corruptStore(entry.name, index + 1);
      }
      assertNonEmptyId(parsed.event.eventId, "event id");
      if (eventIds.has(parsed.event.eventId)) {
        throw new Error("Native guard event store is corrupt: duplicate event id");
      }
      eventIds.add(parsed.event.eventId);
      envelopes.push(parsed);
    }
  }
  envelopes.sort((left, right) => {
    if (left.sequence === undefined || right.sequence === undefined) return 0;
    return left.sequence - right.sequence;
  });
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
  return sanitizeValue(envelope, new Set<object>()) as StoredEnvelope;
}

function sanitizeValue(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
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
      result[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitized;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/[-_\s]/g, ""));
}

function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  if (!isPlainObject(value) || !isPlainObject(value.event)) return false;
  const event = value.event;
  return (
    event.schemaVersion === "native-guard-1" &&
    typeof event.eventId === "string" &&
    typeof event.leaseId === "string" &&
    typeof event.sessionKey === "string" &&
    typeof event.timestamp === "string" &&
    isPlainObject(event.detail) &&
    (value.sequence === undefined ||
      (Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0)) &&
    (value.record === undefined || isPlainObject(value.record))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function corruptStore(fileName: string, line: number): Error {
  return new Error(`Native guard event store is corrupt at ${fileName}:${line}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
