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

  // GET /api/v1/reports/detection/:reportId
  app.get("/api/v1/reports/detection/:reportId", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    try {
      const entry = await getReportEntry(reportId);
      if (!entry || entry.reportType !== "detection_report") {
        reply.code(404);
        return failure("NOT_FOUND", `Detection report ${reportId} not found`);
      }
      const runDir = path.join(REPORTS_BASE, entry.runGroupId);
      const detectionReport = JSON.parse(
        await fs.readFile(path.join(runDir, "detection-report.json"), "utf-8"),
      );
      // 读取完整 RiskProfile + RiskReports
      let riskProfile = null;
      let sourceRiskReports: unknown[] = [];
      try {
        riskProfile = JSON.parse(
          await fs.readFile(path.join(runDir, "agent-risk-profile.json"), "utf-8"),
        );
      } catch { /* optional */ }
      try {
        sourceRiskReports = JSON.parse(
          await fs.readFile(path.join(runDir, "risk-reports.json"), "utf-8"),
        );
      } catch { /* optional */ }

      return success({
        detectionReport,
        riskProfile,
        sourceRiskReports,
        links: [
          { kind: "detection_report" as const, id: reportId, label: `Detection Report ${reportId}` },
          { kind: "risk_profile" as const, id: riskProfile?.profileId ?? "", label: "Risk Profile" },
          { kind: "test_run" as const, id: entry.runGroupId, label: `Run ${entry.runGroupId}` },
        ],
      });
    } catch (err) {
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });
}

/** 策略查询 + artifact 访问 */
export async function policyRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/policies/:policyPackId
  app.get("/api/v1/policies/:policyPackId", async (request, reply) => {
    const { policyPackId } = request.params as { policyPackId: string };
    try {
      const entry = await getReportEntry(policyPackId);
      if (!entry || entry.reportType !== "policy_pack") {
        reply.code(404);
        return failure("NOT_FOUND", `Policy pack ${policyPackId} not found`);
      }
      const runDir = path.join(REPORTS_BASE, entry.runGroupId);
      const raw = await fs.readFile(path.join(runDir, "supervision-policy-pack.json"), "utf-8");
      const policyPack = JSON.parse(raw);
      return success({
        policyPack,
        sourceDetectionReportId: policyPack.sourceDetectionReportId,
        sourceRiskProfileId: policyPack.sourceRiskProfileId,
        sourceWeaknessTitles: {} as Record<string, string>,
        links: [
          { kind: "policy_pack" as const, id: policyPackId, label: `Policy Pack ${policyPackId}` },
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
