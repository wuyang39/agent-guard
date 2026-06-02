import path from "node:path";
import type { ReportArtifact, RiskReport } from "../reportTypes";
import { exportHtmlReport } from "./htmlExporter";
import { exportJsonReport } from "./jsonExporter";

export * from "./htmlExporter";
export * from "./jsonExporter";

export type ExportReportFormat = "json" | "html";

export type ExportReportOptions = {
  outputDir: string;
  fileBaseName?: string;
  formats?: ExportReportFormat[];
};

export async function exportReport(
  report: RiskReport,
  options: ExportReportOptions,
): Promise<ReportArtifact[]> {
  const fileBaseName = options.fileBaseName ?? `${report.caseId}-${report.reportId}`;
  const formats = options.formats ?? ["json", "html"];
  const artifacts: ReportArtifact[] = [];

  if (formats.includes("json")) {
    artifacts.push(await exportJsonReport(report, path.join(options.outputDir, `${fileBaseName}.json`)));
  }

  if (formats.includes("html")) {
    artifacts.push(await exportHtmlReport(report, path.join(options.outputDir, `${fileBaseName}.html`)));
  }

  return artifacts;
}
