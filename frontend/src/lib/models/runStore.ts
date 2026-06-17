import type { AgentConfig, DemoRunResult, RiskLevel } from "../api/demoRuntime";

export type StoredRun = {
  runGroupId: string;
  createdAt: string;
  finishedAt?: string;
  status: "completed" | "failed";
  agent: AgentConfig;
  mode: "vulnerable" | "guarded";
  caseIds: string[];
  results: DemoRunResult[];
};

export type RunSummary = {
  runGroupId: string;
  createdAt: string;
  finishedAt?: string;
  status: StoredRun["status"];
  agentName: string;
  caseCount: number;
  highestRisk: RiskLevel;
  findingCount: number;
  blockedCount: number;
};

const STORAGE_KEY = "agent_guard_formal_frontend_runs_v1";
const riskRank: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function createRunGroupId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `run_group.${crypto.randomUUID()}`;
  return `run_group.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}`;
}

export function loadRuns(): StoredRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRun(run: StoredRun) {
  const next = [run, ...loadRuns().filter((item) => item.runGroupId !== run.runGroupId)].slice(0, 20);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event("agent-guard-runs-updated"));
}

export function getRun(runGroupId: string) {
  return loadRuns().find((run) => run.runGroupId === runGroupId);
}

export function clearRuns() {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event("agent-guard-runs-updated"));
}

export function summarizeRun(run: StoredRun): RunSummary {
  const highestRisk = run.results.reduce<RiskLevel>((highest, result) => {
    const level = result.risk?.riskLevel || "none";
    return riskRank[level] > riskRank[highest] ? level : highest;
  }, "none");

  return {
    runGroupId: run.runGroupId,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    status: run.status,
    agentName: run.agent.name,
    caseCount: run.caseIds.length,
    highestRisk,
    findingCount: run.results.reduce((count, result) => count + (result.risk?.findingCount || 0), 0),
    blockedCount: run.results.reduce(
      (count, result) =>
        count + result.supervisionRecords.filter((record) => record.decision?.action === "block" || record.decision?.action === "deny").length,
      0,
    ),
  };
}

export function summarizeRuns(runs: StoredRun[]) {
  const summaries = runs.map(summarizeRun);
  const highestRisk = summaries.reduce<RiskLevel>(
    (highest, summary) => (riskRank[summary.highestRisk] > riskRank[highest] ? summary.highestRisk : highest),
    "none",
  );
  return {
    runCount: summaries.length,
    findingCount: summaries.reduce((count, item) => count + item.findingCount, 0),
    blockedCount: summaries.reduce((count, item) => count + item.blockedCount, 0),
    highestRisk,
    summaries,
  };
}
