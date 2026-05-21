import { createId } from "../../../shared/ids";
import { SCHEMA_VERSION } from "../../../shared/schemaVersion";
import { nowIso } from "../../../shared/time";
import type { ReportArtifact, RiskReport } from "../reportTypes";

export function exportJsonReport(
  report: RiskReport,
  path: string,
): ReportArtifact {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: createId("artifact"),
    reportId: report.reportId,
    format: "json",
    path,
    generatedAt: nowIso(),
  };
}
