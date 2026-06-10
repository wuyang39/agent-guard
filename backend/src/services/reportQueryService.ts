import type { ReportArtifact } from "@agent-guard/contracts";
import type { FileReportStore } from "../storage/fileReportStore";
import type {
  CLineDashboardSummary,
  CLineRunBundle,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  TraceDetailView,
} from "./cLineRunTypes";

export type ReportQueryService = {
  dashboardSummary(): Promise<CLineDashboardSummary>;
  listRunGroups(): Promise<CLineRunGroup[]>;
  getRunGroup(runGroupId: string): Promise<CLineRunBundle | undefined>;
  latestRunBundle(): Promise<CLineRunBundle | undefined>;
  traceDetail(traceId: string): Promise<TraceDetailView | undefined>;
  detectionDetail(reportId: string): Promise<DetectionDetailView | undefined>;
  defenseDetail(reportId: string): Promise<DefenseDetailView | undefined>;
  riskReport(reportId: string): Promise<CLineRunBundle["riskReports"][number] | undefined>;
  policyPack(policyPackId: string): Promise<CLineRunBundle["policyPack"] | undefined>;
  supervisionSession(
    runtimeSessionId: string,
  ): Promise<{ runtimeSessionId: string; records: CLineRunBundle["supervisionRecords"] } | undefined>;
  artifact(artifactId: string): Promise<ReportArtifact | undefined>;
};

export function createReportQueryService(store: FileReportStore): ReportQueryService {
  return {
    dashboardSummary() {
      return store.buildDashboardSummary();
    },

    listRunGroups() {
      return store.listRunGroups();
    },

    getRunGroup(runGroupId) {
      return store.getBundle(runGroupId);
    },

    latestRunBundle() {
      return store.getLatestBundle();
    },

    async traceDetail(traceId) {
      const bundle = await store.findBundleByTraceId(traceId);
      const trace = bundle?.traces.find((candidate) => candidate.traceId === traceId);
      if (!bundle || !trace) {
        return undefined;
      }

      const relatedRiskReports = bundle.riskReports.filter(
        (report) => report.traceId === traceId || report.toolCallTrace.traceId === traceId,
      );
      const relatedEventIds = new Set(trace.events.map((event) => event.eventId));

      return {
        trace,
        relatedRiskReports,
        relatedFindings: relatedRiskReports.flatMap((report) =>
          report.findings.filter((finding) =>
            finding.evidenceEventIds.some((eventId) => relatedEventIds.has(eventId)),
          ),
        ),
        supervisionRecords: bundle.supervisionRecords.filter(
          (record) =>
            record.runtimeSessionId.includes(trace.caseId) ||
            (record.inputEventId && relatedEventIds.has(record.inputEventId)) ||
            (record.outputEventId && relatedEventIds.has(record.outputEventId)),
        ),
      };
    },

    async detectionDetail(reportId) {
      const bundle = await store.findBundleByDetectionReportId(reportId);
      if (!bundle) {
        return undefined;
      }

      return {
        detectionReport: bundle.detectionReport,
        riskProfile: bundle.riskProfile,
        policyPack: bundle.policyPack,
        sourceRiskReports: bundle.riskReports.filter((report) =>
          bundle.detectionReport.sourceRiskReportIds.includes(report.reportId),
        ),
      };
    },

    async defenseDetail(reportId) {
      const bundle = await store.findBundleByDefenseReportId(reportId);
      if (!bundle) {
        return undefined;
      }

      return {
        defenseReport: bundle.defenseReport,
        detectionReport: bundle.detectionReport,
        riskProfile: bundle.riskProfile,
        policyPack: bundle.policyPack,
        supervisionRecords: bundle.supervisionRecords,
        artifacts: bundle.artifacts.filter(
          (artifact) => artifact.reportId === bundle.defenseReport.defenseReportId,
        ),
      };
    },

    async riskReport(reportId) {
      const bundle = await store.findBundleByRiskReportId(reportId);
      return bundle?.riskReports.find((report) => report.reportId === reportId);
    },

    async policyPack(policyPackId) {
      const bundle = await store.findBundleByPolicyPackId(policyPackId);
      return bundle?.policyPack;
    },

    async supervisionSession(runtimeSessionId) {
      const bundle = await store.findBundleByRuntimeSessionId(runtimeSessionId);
      if (!bundle) {
        return undefined;
      }

      return {
        runtimeSessionId,
        records: bundle.supervisionRecords.filter(
          (record) => record.runtimeSessionId === runtimeSessionId,
        ),
      };
    },

    artifact(artifactId) {
      return store.findArtifact(artifactId);
    },
  };
}
