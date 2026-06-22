/**
 * fileRunStore — 文件级 RunGroup + Supervision Session 索引
 *
 * 存储位置: outputs/run-index/
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createId, Mutex, nowIso } from "../shared";
import type { RunE2ERequest, P2RunGroup, P2AdapterKind } from "../api/types";
import type { RunStatus, RuntimeSupervisionRecord } from "@agent-guard/contracts";
import { resolveInsideDirectory } from "./pathSafety";

const ROOT = path.resolve(process.cwd(), "outputs", "run-index");
const RUN_GROUPS_FILE = path.join(ROOT, "run-groups.json");
const SESSIONS_DIR = path.join(ROOT, "sessions");

/** 保护 run-groups.json 的并发 read-modify-write */
const runGroupsMutex = new Mutex();

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function createRunGroupId(): string {
  return createId("run_group");
}

export function buildInitialRunGroup(
  request: RunE2ERequest,
  agentId: string,
): P2RunGroup {
  return {
    runGroupId: createRunGroupId(),
    agentId,
    agentName: request.agent.name,
    adapterKind: request.adapterKind,
    selectionPlanId: request.selectionPlanId,
    status: "running",
    phase: "queued",
    startedAt: nowIso(),
    caseIds: request.caseIds ?? [],
    caseCount: request.caseIds?.length ?? 0,
    testRunIds: [],
    traceIds: [],
    riskReportIds: [],
    runtimeSessionIds: [],
    artifactIds: [],
  };
}

// ---- RunGroup CRUD ----

export async function saveRunGroup(runGroup: P2RunGroup): Promise<void> {
  await runGroupsMutex.run(async () => {
    await ensureDir(ROOT);
    const all = await readJson<P2RunGroup[]>(RUN_GROUPS_FILE, []);
    const idx = all.findIndex((r) => r.runGroupId === runGroup.runGroupId);
    if (idx >= 0) {
      all[idx] = runGroup;
    } else {
      all.push(runGroup);
    }
    await writeJson(RUN_GROUPS_FILE, all);
  });
}

export async function getRunGroup(
  runGroupId: string,
): Promise<P2RunGroup | undefined> {
  const all = await readJson<P2RunGroup[]>(RUN_GROUPS_FILE, []);
  return all.find((r) => r.runGroupId === runGroupId);
}

export async function listRunGroups(opts?: {
  limit?: number;
  status?: RunStatus;
  adapterKind?: P2AdapterKind;
}): Promise<P2RunGroup[]> {
  let all = await readJson<P2RunGroup[]>(RUN_GROUPS_FILE, []);

  if (opts?.status) {
    all = all.filter((r) => r.status === opts.status);
  }
  if (opts?.adapterKind) {
    all = all.filter((r) => r.adapterKind === opts.adapterKind);
  }

  // 按 startedAt 倒序
  all.sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  if (opts?.limit && opts.limit > 0) {
    all = all.slice(0, opts.limit);
  }

  return all;
}

// ---- Supervision Session ----

export type SupervisionSessionSummary = {
  runtimeSessionId: string;
  runGroupId: string;
  sourceRunGroupId?: string;
  agentId: string;
  policyPackId: string;
  policyContextSource?: "stored_detection" | "synthetic_fallback";
  traceId?: string;
  startedAt?: string;
  recordCount: number;
  blockedCount: number;
  redactedCount: number;
  askCount: number;
  actionCounts: Record<string, number>;
};

export type SupervisionSessionFull = SupervisionSessionSummary & {
  records: RuntimeSupervisionRecord[];
};

export async function saveSessionRecords(
  summary: SupervisionSessionSummary,
  records: RuntimeSupervisionRecord[],
): Promise<void> {
  await ensureDir(SESSIONS_DIR);
  await writeJson(
    sessionFilePath(summary.runtimeSessionId),
    { ...summary, records } satisfies SupervisionSessionFull,
  );
}

export async function getSessionRecords(
  runtimeSessionId: string,
): Promise<SupervisionSessionFull | undefined> {
  try {
    const raw = await fs.readFile(sessionFilePath(runtimeSessionId), "utf-8");
    const parsed = JSON.parse(raw);
    // 兼容旧格式（无 records 字段）
    if (!Array.isArray(parsed.records)) {
      return undefined;
    }
    return parsed as SupervisionSessionFull;
  } catch {
    return undefined;
  }
}

// 保留兼容别名
export const saveSessionSummary = saveSessionRecords;
export const getSessionSummary = getSessionRecords;

function sessionFilePath(runtimeSessionId: string): string {
  return resolveInsideDirectory(SESSIONS_DIR, `${runtimeSessionId}.json`);
}
