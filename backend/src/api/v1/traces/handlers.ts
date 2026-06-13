import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import type { RiskReport, RuntimeSupervisionRecord } from "@agent-guard/contracts";
import { success, failure } from "../../response";
import { getSessionRecords, listRunGroups } from "../../../storage/fileRunStore";

const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");
const REPORTS_BASE = path.resolve(process.cwd(), "outputs", "reports");

export async function traceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/traces/:traceId", async (request, reply) => {
    const { traceId } = request.params as { traceId: string };

    try {
      const files = await fs.readdir(TRACES_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(TRACES_DIR, file), "utf-8");
        const trace = JSON.parse(raw);
        if (trace.traceId === traceId) {
          const runGroups = await listRunGroups();
          const relatedRunGroup = runGroups.find((runGroup) =>
            runGroup.traceIds.includes(traceId),
          );
          const relatedRiskReports = relatedRunGroup
            ? await readRiskReports(relatedRunGroup.runGroupId, traceId)
            : [];
          const relatedFindings = relatedRiskReports.flatMap((report) => report.findings);
          const eventToFindingIds = buildEventToFindingIds(relatedRiskReports);
          const supervisionRecords = relatedRunGroup
            ? await readSupervisionRecords(relatedRunGroup.runtimeSessionIds)
            : [];
          return success({
            trace,
            relatedRunGroupId: relatedRunGroup?.runGroupId ?? trace.runId ?? "",
            relatedRiskReportIds: relatedRiskReports.map((report) => report.reportId),
            relatedFindingIds: relatedFindings.map((finding) => finding.findingId),
            relatedRiskReports,
            relatedFindings,
            eventToFindingIds,
            supervisionRecords,
            links: [
              { kind: "trace" as const, id: trace.traceId, label: `Trace ${trace.traceId}` },
              ...(relatedRunGroup
                ? [{ kind: "test_run" as const, id: relatedRunGroup.runGroupId, label: `Run ${relatedRunGroup.runGroupId}` }]
                : []),
              ...relatedRiskReports.map((report) => ({
                kind: "risk_report" as const,
                id: report.reportId,
                label: `RiskReport ${report.reportId}`,
              })),
            ],
          });
        }
      }
      reply.code(404);
      return failure("NOT_FOUND", `Trace ${traceId} not found`);
    } catch (err) {
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });
}

async function readRiskReports(
  runGroupId: string,
  traceId: string,
): Promise<RiskReport[]> {
  try {
    const raw = await fs.readFile(
      path.join(REPORTS_BASE, runGroupId, "risk-reports.json"),
      "utf-8",
    );
    const reports = JSON.parse(raw) as RiskReport[];
    return reports.filter((report) => report.traceId === traceId);
  } catch {
    return [];
  }
}

async function readSupervisionRecords(
  runtimeSessionIds: string[],
): Promise<RuntimeSupervisionRecord[]> {
  const sessions = await Promise.all(
    runtimeSessionIds.map((runtimeSessionId) => getSessionRecords(runtimeSessionId)),
  );
  return sessions.flatMap((session) => session?.records ?? []);
}

function buildEventToFindingIds(
  riskReports: RiskReport[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const report of riskReports) {
    for (const finding of report.findings) {
      for (const eventId of finding.evidenceEventIds) {
        result[eventId] = [...(result[eventId] ?? []), finding.findingId];
      }
    }
  }
  return result;
}
