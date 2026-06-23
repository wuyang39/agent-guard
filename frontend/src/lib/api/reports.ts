import { apiBaseUrl, request } from "./core";
import type { ReportBundle } from "@agent-guard/contracts";
import type {
  DefenseDetailView,
  DetectionDetailView,
  ReportBundleEvidenceView,
  ReportBundleExportFormat,
  ReportBundleExportJob,
  ReportBundleExportLanguage,
  ReportBundleHumanReview,
  ReportBundleQualityView,
  TraceDetailView,
} from "./types";

export const reportsApi = {
  detectionDetail(reportId: string) {
    return request<DetectionDetailView>(
      `/api/v1/reports/detection/${encodeURIComponent(reportId)}`,
    );
  },

  defenseDetail(reportId: string) {
    return request<DefenseDetailView>(
      `/api/v1/reports/defense/${encodeURIComponent(reportId)}`,
    );
  },

  reportBundle(bundleId: string) {
    return request<ReportBundle>(
      `/api/v1/reports/bundles/${encodeURIComponent(bundleId)}`,
    );
  },

  reportBundleForRunGroup(runGroupId: string) {
    return request<ReportBundle>(
      `/api/v1/test-runs/${encodeURIComponent(runGroupId)}/report-bundle`,
    );
  },

  defenseReportEvidence(reportId: string) {
    return request<ReportBundleEvidenceView>(
      `/api/v1/reports/defense/${encodeURIComponent(reportId)}/evidence`,
    );
  },

  defenseReportQuality(reportId: string) {
    return request<ReportBundleQualityView>(
      `/api/v1/reports/defense/${encodeURIComponent(reportId)}/quality`,
    );
  },

  exportDefenseReportBundle(
    reportId: string,
    format: ReportBundleExportFormat,
    humanReview?: ReportBundleHumanReview,
    language: ReportBundleExportLanguage = "en",
  ) {
    return request<ReportBundleExportJob>(
      `/api/v1/reports/defense/${encodeURIComponent(reportId)}/exports`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format, humanReview, language }),
      },
    );
  },

  reportExportJob(exportJobId: string) {
    return request<ReportBundleExportJob>(
      `/api/v1/reports/exports/${encodeURIComponent(exportJobId)}`,
    );
  },

  async traceDetail(traceId: string) {
    const result = await request<P2TraceDetailWire>(
      `/api/v1/traces/${encodeURIComponent(traceId)}`,
    );
    return {
      trace: result.trace,
      relatedRiskReports: result.relatedRiskReports ?? [],
      relatedFindings: result.relatedFindings ?? [],
      supervisionRecords: result.supervisionRecords ?? [],
    } satisfies TraceDetailView;
  },

  artifactUrl(artifactId: string) {
    return `${apiBaseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
  },
};

type P2TraceDetailWire = {
  trace: TraceDetailView["trace"];
  relatedRiskReports?: TraceDetailView["relatedRiskReports"];
  relatedFindings?: TraceDetailView["relatedFindings"];
  supervisionRecords?: TraceDetailView["supervisionRecords"];
};
