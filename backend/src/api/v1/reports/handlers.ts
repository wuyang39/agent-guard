import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { success, failure } from "../../response";
import { getReportEntry, getArtifactEntry } from "../../../storage/fileReportStore";

const REPORTS_BASE = path.resolve(process.cwd(), "outputs", "reports");

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/reports/defense/:reportId
  app.get("/api/v1/reports/defense/:reportId", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };

    try {
      const entry = await getReportEntry(reportId);
      if (!entry || entry.reportType !== "defense_report") {
        reply.code(404);
        return failure("NOT_FOUND", `Defense report ${reportId} not found`);
      }

      // 从文件系统读 defense report
      const runDir = path.join(REPORTS_BASE, entry.runGroupId);
      const reportFile = path.join(runDir, "defense-report.json");
      const raw = await fs.readFile(reportFile, "utf-8");
      const defenseReport = JSON.parse(raw);

      const artifacts = await Promise.all(
        entry.artifactIds.map(async (artifactId: string) => {
          const artifactEntry = await getArtifactEntry(artifactId);
          return artifactEntry
            ? {
                artifactId: artifactEntry.artifactId,
                reportId: artifactEntry.reportId,
                format: artifactEntry.format,
                label: artifactEntry.label,
                url: `/api/v1/artifacts/${artifactEntry.artifactId}`,
                generatedAt: artifactEntry.generatedAt,
              }
            : null;
        }),
      );

      return success({
        defenseReport,
        artifacts: artifacts.filter(Boolean),
        links: [
          { kind: "defense_report" as const, id: reportId, label: `Defense Report ${reportId}` },
          { kind: "test_run" as const, id: entry.runGroupId, label: `Run ${entry.runGroupId}` },
        ],
      });
    } catch (err) {
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });
}

/** Artifact 访问（独立于 defense report） */
export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };

    try {
      const entry = await getArtifactEntry(artifactId);
      if (!entry) {
        reply.code(404);
        return reply.type("application/json").send(
          JSON.stringify(failure("NOT_FOUND", `Artifact ${artifactId} not found`)),
        );
      }

      const raw = await fs.readFile(entry.filePath, "utf-8");
      if (entry.format === "html") {
        return reply.type("text/html").send(raw);
      }
      // JSON → 直接返回对象
      return JSON.parse(raw);
    } catch (err) {
      reply.code(500);
      return reply.type("application/json").send(
        JSON.stringify(failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err))),
      );
    }
  });
}
