import { buildServer } from "../backend/src/api/server";
import type {
  ApiResponse,
  CLineDashboardSummary,
  CLineRunBundle,
  DefenseDetailView,
  DetectionDetailView,
  TraceDetailView,
} from "../backend/src/services/cLineRunTypes";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const payload = (await response.json()) as ApiResponse<T>;
  assert(payload.ok, `API response ok for ${path}`);
  return payload.data;
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address !== null && typeof address !== "string", "server address has port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const bundle = await request<CLineRunBundle>(baseUrl, "/api/v1/test-runs/e2e", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert(bundle.runGroup.caseIds.length === 7, "run group covers seven enabled cases");
    assert(bundle.riskReports.length === 7, "seven risk reports returned");
    assert(bundle.traces.length === 14, "detection and supervised traces returned");
    assert(bundle.policyPack.policies.length > 0, "policy pack generated");
    assert(bundle.supervisionRecords.length > 0, "supervision records generated");
    assert(bundle.defenseReport.blockedActions.length > 0, "blocked actions generated");

    const summary = await request<CLineDashboardSummary>(baseUrl, "/api/v1/dashboard/summary");
    assert(summary.latestRunGroup?.runGroupId === bundle.runGroup.runGroupId, "latest run group indexed");
    assert(summary.totals.findings >= bundle.riskReports.length, "dashboard findings counted");

    const detection = await request<DetectionDetailView>(
      baseUrl,
      `/api/v1/reports/detection/${bundle.detectionReport.reportId}`,
    );
    assert(
      detection.riskProfile.sourceDetectionReportId === detection.detectionReport.reportId,
      "risk profile traces to detection report",
    );

    const defense = await request<DefenseDetailView>(
      baseUrl,
      `/api/v1/reports/defense/${bundle.defenseReport.defenseReportId}`,
    );
    assert(
      defense.defenseReport.policyPackId === defense.policyPack.policyPackId,
      "defense report traces to policy pack",
    );

    const trace = await request<TraceDetailView>(
      baseUrl,
      `/api/v1/traces/${bundle.traces[0].traceId}`,
    );
    assert(trace.trace.events.length > 0, "trace detail includes events");
    assert(trace.relatedFindings.length > 0, "trace detail includes related findings");

    console.log("PASS: C API e2e run + query verification");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
