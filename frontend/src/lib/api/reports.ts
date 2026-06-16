import { apiBaseUrl, request } from "./core";
import type { DefenseDetailView, DetectionDetailView, TraceDetailView } from "./types";

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
