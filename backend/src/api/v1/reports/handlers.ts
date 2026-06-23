import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { success, failure } from "../../response";
import { getReportEntry, getArtifactEntry } from "../../../storage/fileReportStore";
import { getRunGroup, getSessionRecords } from "../../../storage/fileRunStore";
import { isPathInsideDirectory, resolveInsideDirectory } from "../../../storage/pathSafety";
import {
  composeReportBundleByBundleId,
  composeReportBundleForDefenseReport,
  composeReportBundleForRunGroup,
  exportReportBundle,
  getReportBundleExportJob,
  ReportBundleNotFoundError,
} from "../../../modules/report/reportBundleComposer";

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
      const runDir = resolveInsideDirectory(REPORTS_BASE, entry.runGroupId);
      const reportFile = path.join(runDir, "defense-report.json");
      const raw = await fs.readFile(reportFile, "utf-8");
      const defenseReport = JSON.parse(raw);
      const detectionReport = await readOptionalJson(path.join(runDir, "detection-report.json"));
      const riskProfile = await readOptionalJson(path.join(runDir, "agent-risk-profile.json"));
      const policyPack = await readOptionalJson(path.join(runDir, "supervision-policy-pack.json"));
      const runtimeSessions = await Promise.all(
        (defenseReport.runtimeSessionIds ?? []).map((runtimeSessionId: string) =>
          getSessionRecords(runtimeSessionId),
        ),
      );
      const loadedRuntimeSessions = runtimeSessions.filter(
        (session): session is NonNullable<typeof session> => Boolean(session),
      );
      const sessionRecords = loadedRuntimeSessions.flatMap((session) => session.records);
      const runGroup = await getRunGroup(entry.runGroupId);
      const policyContextSource = runGroup?.policyContextSource ?? runtimeSessions.find(
        (session) => session?.policyContextSource,
      )?.policyContextSource;
      const usesSyntheticFallback = policyContextSource === "synthetic_fallback";
      const evidenceSummary = {
        declaredRuntimeSessionCount: (defenseReport.runtimeSessionIds ?? []).length,
        runtimeSessionCount: loadedRuntimeSessions.length,
        supervisionRecordCount: sessionRecords.length,
        realSupervisionRecordCount: usesSyntheticFallback ? 0 : sessionRecords.length,
        policyContextSource,
        usesSyntheticFallback,
        canProveDefenseEffect: sessionRecords.length > 0 && !usesSyntheticFallback,
      };
      const reportBundle = await composeReportBundleForRunGroup(entry.runGroupId).catch(() => undefined);

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
        detectionReport,
        riskProfile,
        policyPack,
        policyContextSource,
        evidenceSummary,
        supervisionRecords: sessionRecords,
        reportBundle,
        evidenceBundle: reportBundle?.evidenceBundle,
        traceabilityGraph: reportBundle?.traceabilityGraph,
        quality: reportBundle?.quality,
        testContextViews: reportBundle?.testContextViews,
        runtimeSessionSummaries: loadedRuntimeSessions.map((session) => ({
          runtimeSessionId: session.runtimeSessionId,
          policyContextSource: session.policyContextSource,
          recordCount: session.recordCount,
          blockedCount: session.blockedCount,
          redactedCount: session.redactedCount,
          askCount: session.askCount,
        })),
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

  app.get("/api/v1/reports/bundles/:bundleId", async (request, reply) => {
    const { bundleId } = request.params as { bundleId: string };
    try {
      return success(await composeReportBundleByBundleId(bundleId));
    } catch (err) {
      if (err instanceof ReportBundleNotFoundError) {
        reply.code(404);
        return failure("NOT_FOUND", err.message);
      }
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/v1/test-runs/:runGroupId/report-bundle", async (request, reply) => {
    const { runGroupId } = request.params as { runGroupId: string };
    try {
      return success(await composeReportBundleForRunGroup(runGroupId));
    } catch (err) {
      if (err instanceof ReportBundleNotFoundError) {
        reply.code(404);
        return failure("NOT_FOUND", err.message);
      }
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/v1/reports/defense/:reportId/evidence", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    try {
      const bundle = await composeReportBundleForDefenseReport(reportId);
      return success({
        defenseReportId: reportId,
        bundleId: bundle.bundleId,
        evidenceBundle: bundle.evidenceBundle,
        claims: bundle.claims,
        traceabilityGraph: bundle.traceabilityGraph,
        testContextViews: bundle.testContextViews,
      });
    } catch (err) {
      if (err instanceof ReportBundleNotFoundError) {
        reply.code(404);
        return failure("NOT_FOUND", err.message);
      }
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/v1/reports/defense/:reportId/quality", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    try {
      const bundle = await composeReportBundleForDefenseReport(reportId);
      return success({
        defenseReportId: reportId,
        bundleId: bundle.bundleId,
        quality: bundle.quality,
      });
    } catch (err) {
      if (err instanceof ReportBundleNotFoundError) {
        reply.code(404);
        return failure("NOT_FOUND", err.message);
      }
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  app.post("/api/v1/reports/defense/:reportId/exports", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const body = isObject(request.body) ? request.body : {};
    const format =
      body.format === "html" || body.format === "pdf"
        ? body.format
        : "markdown";
    const language = body.language === "zh" ? "zh" : "en";
    const humanReview = parseHumanReview(body.humanReview);
    try {
      const bundle = await composeReportBundleForDefenseReport(reportId);
      return success(await exportReportBundle(bundle, format, humanReview, language));
    } catch (err) {
      if (err instanceof ReportBundleNotFoundError) {
        reply.code(404);
        return failure("NOT_FOUND", err.message);
      }
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });

  app.get("/api/v1/reports/exports/:exportJobId", async (request, reply) => {
    const { exportJobId } = request.params as { exportJobId: string };
    const job = getReportBundleExportJob(exportJobId);
    if (!job) {
      reply.code(404);
      return failure("NOT_FOUND", `Export job ${exportJobId} not found`);
    }
    return success(job);
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
      const runDir = resolveInsideDirectory(REPORTS_BASE, entry.runGroupId);
      const detectionReport = JSON.parse(
        await fs.readFile(path.join(runDir, "detection-report.json"), "utf-8"),
      );
      // 读取完整 RiskProfile + RiskReports
      let riskProfile = null;
      let sourceRiskReports: unknown[] = [];
      let policyPack = null;
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
      try {
        policyPack = JSON.parse(
          await fs.readFile(path.join(runDir, "supervision-policy-pack.json"), "utf-8"),
        );
      } catch { /* optional */ }

      return success({
        detectionReport,
        riskProfile,
        policyPack,
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

async function readOptionalJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHumanReview(value: unknown) {
  if (!isObject(value)) return undefined;
  const rawDecisions = isObject(value.claimDecisions) ? value.claimDecisions : {};
  const claimDecisions = Object.fromEntries(
    Object.entries(rawDecisions).filter(([, decision]) =>
      decision === "accepted" || decision === "needs_changes" || decision === "skipped",
    ),
  ) as Record<string, "accepted" | "needs_changes" | "skipped">;
  return {
    reviewerNote: typeof value.reviewerNote === "string" ? value.reviewerNote : undefined,
    reviewedClaimCount: typeof value.reviewedClaimCount === "number" ? value.reviewedClaimCount : Object.keys(claimDecisions).length,
    reviewedAt: typeof value.reviewedAt === "string" ? value.reviewedAt : undefined,
    claimDecisions,
  };
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
      const runDir = resolveInsideDirectory(REPORTS_BASE, entry.runGroupId);
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

      const artifactPath = path.resolve(entry.filePath);
      if (!isPathInsideDirectory(artifactPath, REPORTS_BASE)) {
        reply.code(403);
        return reply.type("application/json").send(
          JSON.stringify(failure("FORBIDDEN", "Artifact path is outside the reports store.")),
        );
      }

      if (entry.format === "pdf") {
        const buffer = await fs.readFile(artifactPath);
        return reply.type("application/pdf").send(buffer);
      }
      const raw = await fs.readFile(artifactPath, "utf-8");
      if (entry.format === "html") {
        return reply.type("text/html").send(raw);
      }
      if (entry.format === "markdown") {
        return reply.type("text/markdown; charset=utf-8").send(raw);
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
