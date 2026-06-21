import fs from "node:fs/promises";
import path from "node:path";
import type { SupervisionBatchResult } from "@agent-guard/contracts";
import { resolveInsideDirectory } from "./pathSafety";

const ROOT = path.resolve(process.cwd(), "outputs", "run-index", "batches");

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function saveSupervisionBatch(
  batch: SupervisionBatchResult,
): Promise<void> {
  await writeJson(batchFilePath(batch.batchId), batch);
}

export async function getSupervisionBatch(
  batchId: string,
): Promise<SupervisionBatchResult | undefined> {
  return readJson<SupervisionBatchResult>(batchFilePath(batchId));
}

export async function listSupervisionBatches(opts: {
  runtimeSessionId?: string;
  limit?: number;
} = {}): Promise<SupervisionBatchResult[]> {
  await ensureDir(ROOT);
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const batches: SupervisionBatchResult[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const batch = await readJson<SupervisionBatchResult>(path.join(ROOT, entry.name));
    if (!batch) continue;
    if (opts.runtimeSessionId && batch.runtimeSessionId !== opts.runtimeSessionId) {
      continue;
    }
    batches.push(batch);
  }

  batches.sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  return opts.limit && opts.limit > 0 ? batches.slice(0, opts.limit) : batches;
}

function batchFilePath(batchId: string): string {
  return resolveInsideDirectory(ROOT, `${batchId}.json`);
}
