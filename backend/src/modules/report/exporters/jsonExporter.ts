import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../../shared/ids";
import { SCHEMA_VERSION } from "../../../shared/schemaVersion";
import { nowIso } from "../../../shared/time";
import type { ReportArtifact, RiskReport } from "../reportTypes";

export async function exportJsonReport(
  report: RiskReport,
  outputPath: string,
): Promise<ReportArtifact> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: createId("artifact"),
    reportId: report.reportId,
    format: "json",
    path: outputPath,
    generatedAt: nowIso(),
  };
}
