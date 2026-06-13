import type { FastifyInstance } from "fastify";
import { buildApp } from "../backend/src/app";
import type { P2RunGroup } from "../backend/src/api/types";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function request<T>(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = JSON.parse(response.body) as ApiResponse<T>;
  assert(payload.ok, `${method} ${url} returned ok:true`);
  return payload.data;
}

async function main(): Promise<void> {
  process.env.AGENT_GUARD_ASK_TIMEOUT = process.env.AGENT_GUARD_ASK_TIMEOUT ?? "demo_approve";
  process.env.AGENT_GUARD_ASK_TIMEOUT_MS = process.env.AGENT_GUARD_ASK_TIMEOUT_MS ?? "100";

  const app = await buildApp({ logger: false });
  try {
    const status = await request<{
      apiVersion: string;
      features: Record<string, boolean>;
    }>(app, "GET", "/api/v1/system/status");
    assert(status.apiVersion === "p2-api-freeze-2", "formal API version is exposed");
    assert(status.features.e2eRun === true, "formal E2E feature is enabled");

    const run = await request<{ runGroup: P2RunGroup; links: unknown[] }>(
      app,
      "POST",
      "/api/v1/test-runs/e2e",
      {
        adapterKind: "mock",
        agent: { name: "Formal API Verify Agent" },
        caseIds: ["case.resource_injection"],
        generateDefenseReport: true,
      },
    );
    const runGroup = run.runGroup;
    assert(runGroup.status === "completed", "run group completed");
    assert(runGroup.detectionReportId?.length > 0, "detection report generated");
    assert(runGroup.riskProfileId?.length > 0, "risk profile generated");
    assert(runGroup.policyPackId?.length > 0, "policy pack generated");
    assert(runGroup.runtimeSessionIds.length > 0, "supervision sessions generated");
    assert(runGroup.defenseReportId?.length > 0, "defense report generated");
    assert(runGroup.artifactIds.length > 0, "defense artifacts generated");

    const detail = await request<{ runGroup: P2RunGroup }>(
      app,
      "GET",
      `/api/v1/test-runs/${runGroup.runGroupId}`,
    );
    assert(detail.runGroup.runGroupId === runGroup.runGroupId, "run detail is queryable");

    const detection = await request<{
      detectionReport: { reportId: string };
      riskProfile: { sourceDetectionReportId: string };
      policyPack: { policyPackId: string; policies: unknown[] };
      sourceRiskReports: unknown[];
    }>(app, "GET", `/api/v1/reports/detection/${runGroup.detectionReportId}`);
    assert(detection.detectionReport.reportId === runGroup.detectionReportId, "detection detail matches");
    assert(
      detection.riskProfile.sourceDetectionReportId === runGroup.detectionReportId,
      "risk profile traces to detection report",
    );
    assert(detection.policyPack.policyPackId === runGroup.policyPackId, "policy pack is linked");
    assert(detection.sourceRiskReports.length > 0, "source risk reports are exposed");

    const policy = await request<{ policyPack: { policyPackId: string; policies: unknown[] } }>(
      app,
      "GET",
      `/api/v1/policies/${runGroup.policyPackId}`,
    );
    assert(policy.policyPack.policyPackId === runGroup.policyPackId, "policy endpoint matches");
    assert(policy.policyPack.policies.length > 0, "policy endpoint has policies");

    const trace = await request<{
      trace: { traceId: string; events: unknown[] };
      relatedRiskReports: unknown[];
      relatedFindings: unknown[];
    }>(app, "GET", `/api/v1/traces/${runGroup.traceIds[0]}`);
    assert(trace.trace.traceId === runGroup.traceIds[0], "trace detail matches");
    assert(trace.trace.events.length > 0, "trace events exist");
    assert(trace.relatedRiskReports.length > 0, "trace has related risk reports");
    assert(trace.relatedFindings.length > 0, "trace has related findings");

    const defense = await request<{
      defenseReport: { defenseReportId: string; policyPackId: string };
      supervisionRecords: unknown[];
      artifacts: unknown[];
    }>(app, "GET", `/api/v1/reports/defense/${runGroup.defenseReportId}`);
    assert(defense.defenseReport.defenseReportId === runGroup.defenseReportId, "defense detail matches");
    assert(defense.defenseReport.policyPackId === runGroup.policyPackId, "defense traces to policy pack");
    assert(defense.supervisionRecords.length > 0, "defense includes supervision records");
    assert(defense.artifacts.length > 0, "defense includes artifacts");

    console.log("PASS: formal API e2e run + query verification");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
