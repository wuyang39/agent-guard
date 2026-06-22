import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import type { RiskCategory, RiskLevel } from "@agent-guard/contracts";
import { success } from "../../response";
import { listRunGroups, getSessionRecords } from "../../../storage/fileRunStore";
import { getReportEntry } from "../../../storage/fileReportStore";
import { resolveInsideDirectory } from "../../../storage/pathSafety";
import type { P2RunGroup } from "../../types";

const REPORTS_BASE = path.resolve(process.cwd(), "outputs", "reports");

const emptyCounts: Record<RiskCategory, number> = {
  tool_misuse: 0,
  unauthorized_access: 0,
  data_leakage: 0,
  dangerous_action: 0,
  instruction_injection_following: 0,
};

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

type DashboardRunMetrics = {
  traces: number;
  riskReports: number;
  findings: number;
  blockedActions: number;
  redactions: number;
  askDecisions: number;
  residualRisks: number;
  highestRiskLevel: RiskLevel;
  countsByCategory: Record<RiskCategory, number>;
};

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard/summary", async () => {
    const runs = await listRunGroups({ limit: 100 });
    const recentRunGroups = runs.slice(0, 5).map(toFrontendRunGroup);
    const historicalMetrics = createEmptyRunMetrics();
    const metricsByRunGroup = new Map<string, DashboardRunMetrics>();

    for (const run of runs) {
      const metrics = await collectRunMetrics(run);
      metricsByRunGroup.set(run.runGroupId, metrics);
      addRunMetrics(historicalMetrics, metrics);
    }

    const latestRun = runs[0];
    const latestRunMetrics = latestRun
      ? {
          runGroupId: latestRun.runGroupId,
          ...(metricsByRunGroup.get(latestRun.runGroupId) ?? createEmptyRunMetrics()),
        }
      : undefined;

    return success({
      schemaVersion: "mvp-1",
      latestRunGroup: recentRunGroups[0],
      recentRunGroups,
      historicalWindow: {
        runLimit: 100,
        runCount: runs.length,
      },
      latestRunMetrics,
      totals: {
        runGroups: runs.length,
        traces: historicalMetrics.traces,
        riskReports: historicalMetrics.riskReports,
        findings: historicalMetrics.findings,
        blockedActions: historicalMetrics.blockedActions,
        redactions: historicalMetrics.redactions,
        askDecisions: historicalMetrics.askDecisions,
        residualRisks: historicalMetrics.residualRisks,
      },
      highestRiskLevel: historicalMetrics.highestRiskLevel,
      countsByCategory: historicalMetrics.countsByCategory,
    });
  });
}

function createEmptyRunMetrics(): DashboardRunMetrics {
  return {
    traces: 0,
    riskReports: 0,
    findings: 0,
    blockedActions: 0,
    redactions: 0,
    askDecisions: 0,
    residualRisks: 0,
    highestRiskLevel: "low",
    countsByCategory: { ...emptyCounts },
  };
}

function addRunMetrics(target: DashboardRunMetrics, source: DashboardRunMetrics): void {
  target.traces += source.traces;
  target.riskReports += source.riskReports;
  target.findings += source.findings;
  target.blockedActions += source.blockedActions;
  target.redactions += source.redactions;
  target.askDecisions += source.askDecisions;
  target.residualRisks += source.residualRisks;

  if (riskRank[source.highestRiskLevel] > riskRank[target.highestRiskLevel]) {
    target.highestRiskLevel = source.highestRiskLevel;
  }

  for (const [category, count] of Object.entries(source.countsByCategory)) {
    target.countsByCategory[category as RiskCategory] += Number(count ?? 0);
  }
}

async function collectRunMetrics(run: P2RunGroup): Promise<DashboardRunMetrics> {
  const metrics = createEmptyRunMetrics();
  metrics.traces = run.traceIds.length;
  metrics.riskReports = run.riskReportIds.length;

  if (run.highestRiskLevel && riskRank[run.highestRiskLevel] > riskRank[metrics.highestRiskLevel]) {
    metrics.highestRiskLevel = run.highestRiskLevel;
  }

  const detection = run.detectionReportId
    ? await readDetectionReport(run.detectionReportId)
    : undefined;
  if (detection?.riskSummary) {
    metrics.findings += Number(detection.riskSummary.totalFindings ?? 0);
    const detectionRisk = detection.riskSummary.highestRiskLevel as RiskLevel | undefined;
    if (detectionRisk && riskRank[detectionRisk] > riskRank[metrics.highestRiskLevel]) {
      metrics.highestRiskLevel = detectionRisk;
    }
    for (const [category, count] of Object.entries(
      detection.riskSummary.countsByCategory ?? {},
    )) {
      if (category in metrics.countsByCategory) {
        metrics.countsByCategory[category as RiskCategory] += Number(count ?? 0);
      }
    }
  }

  for (const runtimeSessionId of run.runtimeSessionIds) {
    const session = await getSessionRecords(runtimeSessionId);
    if (!session) continue;
    metrics.blockedActions += session.blockedCount;
    metrics.redactions += session.redactedCount;
    metrics.askDecisions += session.askCount;
  }

  const defense = run.defenseReportId
    ? await readDefenseReport(run.defenseReportId)
    : undefined;
  metrics.residualRisks += Array.isArray(defense?.residualRisk)
    ? defense.residualRisk.length
    : 0;

  return metrics;
}

function toFrontendRunGroup(run: P2RunGroup) {
  return {
    schemaVersion: "mvp-1" as const,
    runGroupId: run.runGroupId,
    selectionPlanId: run.selectionPlanId,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterKind: run.adapterKind,
    status: run.status,
    phase: run.phase ?? inferRunPhase(run),
    policyContextSource: run.policyContextSource,
    caseIds: run.caseIds ?? Array.from({ length: run.caseCount }, (_, index) => `case.${index + 1}`),
    caseCount: run.caseCount,
    progress: run.progress,
    detectionReportId: run.detectionReportId ?? "",
    riskProfileId: run.riskProfileId ?? "",
    policyPackId: run.policyPackId ?? "",
    defenseReportId: run.defenseReportId ?? "",
    traceIds: run.traceIds,
    riskReportIds: run.riskReportIds,
    runtimeSessionIds: run.runtimeSessionIds,
    artifactIds: run.artifactIds,
    createdAt: run.startedAt,
    updatedAt: run.updatedAt ?? run.endedAt ?? run.startedAt,
  };
}

function inferRunPhase(run: P2RunGroup) {
  if (run.status === "failed") return "failed";
  if (run.defenseReportId) return "defense_report_ready";
  if (run.runtimeSessionIds.length > 0) return "supervision_completed";
  if (run.policyPackId) return "policy_ready";
  if (run.status === "running") return "detecting";
  return "queued";
}

async function readDetectionReport(reportId: string): Promise<Record<string, any> | undefined> {
  const entry = await getReportEntry(reportId);
  if (!entry) return undefined;
  return readJson(path.join(resolveInsideDirectory(REPORTS_BASE, entry.runGroupId), "detection-report.json"));
}

async function readDefenseReport(reportId: string): Promise<Record<string, any> | undefined> {
  const entry = await getReportEntry(reportId);
  if (!entry) return undefined;
  return readJson(path.join(resolveInsideDirectory(REPORTS_BASE, entry.runGroupId), "defense-report.json"));
}

async function readJson(filePath: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}
