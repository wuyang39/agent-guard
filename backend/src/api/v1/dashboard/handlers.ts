import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import type { RiskCategory, RiskLevel } from "@agent-guard/contracts";
import { success } from "../../response";
import { listRunGroups, getSessionRecords } from "../../../storage/fileRunStore";
import { getReportEntry } from "../../../storage/fileReportStore";
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

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard/summary", async () => {
    const runs = await listRunGroups({ limit: 100 });
    const recentRunGroups = runs.slice(0, 5).map(toFrontendRunGroup);
    const countsByCategory = { ...emptyCounts };
    let highestRiskLevel: RiskLevel = "low";
    let findings = 0;
    let blockedActions = 0;
    let redactions = 0;
    let askDecisions = 0;
    let residualRisks = 0;

    for (const run of runs) {
      if (run.highestRiskLevel && riskRank[run.highestRiskLevel] > riskRank[highestRiskLevel]) {
        highestRiskLevel = run.highestRiskLevel;
      }

      const detection = run.detectionReportId
        ? await readDetectionReport(run.detectionReportId)
        : undefined;
      if (detection?.riskSummary) {
        findings += Number(detection.riskSummary.totalFindings ?? 0);
        const detectionRisk = detection.riskSummary.highestRiskLevel as RiskLevel | undefined;
        if (detectionRisk && riskRank[detectionRisk] > riskRank[highestRiskLevel]) {
          highestRiskLevel = detectionRisk;
        }
        for (const [category, count] of Object.entries(
          detection.riskSummary.countsByCategory ?? {},
        )) {
          if (category in countsByCategory) {
            countsByCategory[category as RiskCategory] += Number(count ?? 0);
          }
        }
      }

      for (const runtimeSessionId of run.runtimeSessionIds) {
        const session = await getSessionRecords(runtimeSessionId);
        if (!session) continue;
        blockedActions += session.blockedCount;
        redactions += session.redactedCount;
        askDecisions += session.askCount;
      }

      const defense = run.defenseReportId
        ? await readDefenseReport(run.defenseReportId)
        : undefined;
      residualRisks += Array.isArray(defense?.residualRisk)
        ? defense.residualRisk.length
        : 0;
    }

    return success({
      schemaVersion: "mvp-1",
      latestRunGroup: recentRunGroups[0],
      recentRunGroups,
      totals: {
        runGroups: runs.length,
        traces: runs.reduce((sum, run) => sum + run.traceIds.length, 0),
        riskReports: runs.reduce((sum, run) => sum + run.riskReportIds.length, 0),
        findings,
        blockedActions,
        redactions,
        askDecisions,
        residualRisks,
      },
      highestRiskLevel,
      countsByCategory,
    });
  });
}

function toFrontendRunGroup(run: P2RunGroup) {
  return {
    schemaVersion: "mvp-1" as const,
    runGroupId: run.runGroupId,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterKind: run.adapterKind,
    status: run.status,
    caseIds: run.caseIds ?? Array.from({ length: run.caseCount }, (_, index) => `case.${index + 1}`),
    caseCount: run.caseCount,
    detectionReportId: run.detectionReportId ?? "",
    riskProfileId: run.riskProfileId ?? "",
    policyPackId: run.policyPackId ?? "",
    defenseReportId: run.defenseReportId ?? "",
    traceIds: run.traceIds,
    riskReportIds: run.riskReportIds,
    runtimeSessionIds: run.runtimeSessionIds,
    artifactIds: run.artifactIds,
    createdAt: run.startedAt,
    updatedAt: run.endedAt ?? run.startedAt,
  };
}

async function readDetectionReport(reportId: string): Promise<Record<string, any> | undefined> {
  const entry = await getReportEntry(reportId);
  if (!entry) return undefined;
  return readJson(path.join(REPORTS_BASE, entry.runGroupId, "detection-report.json"));
}

async function readDefenseReport(reportId: string): Promise<Record<string, any> | undefined> {
  const entry = await getReportEntry(reportId);
  if (!entry) return undefined;
  return readJson(path.join(REPORTS_BASE, entry.runGroupId, "defense-report.json"));
}

async function readJson(filePath: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, any>;
  } catch {
    return undefined;
  }
}
