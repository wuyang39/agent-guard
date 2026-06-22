import fs from "node:fs/promises";
import path from "node:path";
import type {
  TestSelectionPlan,
  TestSelectionStatus,
} from "@agent-guard/contracts";
import { resolveInsideDirectory } from "../../storage/pathSafety";

const ROOT = path.resolve(process.cwd(), "outputs", "test-selection", "plans");

export async function saveSelectionPlan(plan: TestSelectionPlan): Promise<void> {
  await ensureDir(ROOT);
  await fs.writeFile(planFilePath(plan.selectionPlanId), JSON.stringify(plan, null, 2), "utf-8");
}

export async function getSelectionPlan(
  selectionPlanId: string,
): Promise<TestSelectionPlan | undefined> {
  try {
    const raw = await fs.readFile(planFilePath(selectionPlanId), "utf-8");
    return JSON.parse(raw) as TestSelectionPlan;
  } catch {
    return undefined;
  }
}

export async function listSelectionPlans(): Promise<TestSelectionPlan[]> {
  try {
    await ensureDir(ROOT);
    const entries = await fs.readdir(ROOT, { withFileTypes: true });
    const plans = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const raw = await fs.readFile(resolveInsideDirectory(ROOT, entry.name), "utf-8");
          return JSON.parse(raw) as TestSelectionPlan;
        }),
    );
    return plans.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } catch {
    return [];
  }
}

export async function updateSelectionPlanStatus(
  selectionPlanId: string,
  status: TestSelectionStatus,
  opts?: { runGroupId?: string; error?: string; agentId?: string },
): Promise<TestSelectionPlan | undefined> {
  const plan = await getSelectionPlan(selectionPlanId);
  if (!plan) return undefined;
  const runGroupIds = opts?.runGroupId
    ? [...new Set([...(plan.runGroupIds ?? []), opts.runGroupId])]
    : plan.runGroupIds;
  const updated: TestSelectionPlan = {
    ...plan,
    agentId: opts?.agentId ?? plan.agentId,
    status,
    runGroupIds,
    fallbackReasons: opts?.error
      ? [...plan.fallbackReasons, opts.error]
      : plan.fallbackReasons,
    updatedAt: new Date().toISOString(),
  };
  await saveSelectionPlan(updated);
  return updated;
}

function planFilePath(selectionPlanId: string): string {
  return resolveInsideDirectory(ROOT, `${selectionPlanId}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
