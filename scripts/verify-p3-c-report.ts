/**
 * P3 C-line report bundle verification.
 *
 * This proves the C-line report APIs consume B-line persisted runtime evidence:
 * Realtime MCP tools/call -> RuntimeSupervisionRecord[] -> DefenseReport
 * -> ReportBundle -> EvidenceBundle / Quality / Markdown export.
 */

import { buildApp } from "../backend/src/app";

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: { code: number; message: string };
};

type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function injectJson<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
): Promise<ApiResponse<T>> {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: payload ? { "content-type": "application/json" } : undefined,
  });
  const parsed = JSON.parse(response.body) as ApiResponse<T>;
  assert(response.statusCode < 400, `${method} ${url} returned ${response.statusCode}: ${response.body}`);
  assert(parsed.ok === true, `${method} ${url} returned API error: ${parsed.error?.message}`);
  return parsed;
}

async function rpc<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/realtime/mcp",
    payload: { jsonrpc: "2.0", id, method, params },
  });
  assert(response.statusCode < 400, `${method} RPC returned ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body) as JsonRpcResponse<T>;
}

async function main(): Promise<void> {
  process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "50";

  const app = await buildApp({ logger: false });
  try {
    const active = await injectJson<{ resolvedPolicyPackId: string }>(
      app,
      "POST",
      "/api/v1/openclaw/realtime/active-policy",
      { policyPackId: "fallback", resetSessions: true },
    );
    assert(
      active.data?.resolvedPolicyPackId === "policy_pack.openclaw.realtime.fallback",
      "fallback realtime policy is active",
    );

    const session = await injectJson<{
      runtimeSessionId: string;
      policyPackId: string;
      traceId: string;
    }>(app, "POST", "/api/v1/openclaw/realtime/sessions", {
      policyPackId: active.data.resolvedPolicyPackId,
    });
    const runtimeSessionId = session.data?.runtimeSessionId;
    assert(Boolean(runtimeSessionId), "prepared realtime session id");

    const denied = await rpc<McpCallResult>(app, 1, "tools/call", {
      name: "agent_guard_read_file",
      arguments: {
        _agentGuardSessionId: runtimeSessionId,
        path: "/secret/.env",
      },
    });
    assert(denied.result?.isError === true, "deny call was blocked");

    const redacted = await rpc<McpCallResult>(app, 2, "tools/call", {
      name: "agent_guard_call_api",
      arguments: {
        _agentGuardSessionId: runtimeSessionId,
        method: "POST",
        url: "https://safe.example.test/upload",
        body: "token=demo-secret-token",
      },
    });
    assert(!redacted.error, "redact call completed");

    const finalized = await injectJson<{
      runGroup: {
        runGroupId: string;
        defenseReportId: string;
        runtimeSessionId: string;
      };
      supervisionRecords: { recordId: string; action: string }[];
    }>(app, "POST", "/api/v1/openclaw/realtime/reports/defense", {
      runtimeSessionId,
    });
    const runGroupId = finalized.data?.runGroup.runGroupId;
    const defenseReportId = finalized.data?.runGroup.defenseReportId;
    assert(Boolean(runGroupId), "finalized run group id");
    assert(Boolean(defenseReportId), "finalized defense report id");
    assert((finalized.data?.supervisionRecords.length ?? 0) >= 2, "finalized has runtime records");

    const bundle = await injectJson<{
      bundleId: string;
      source: { defenseReportId?: string; runtimeSessionIds: string[] };
      claims: { claimType: string; sourceIds: { runtimeRecordIds?: string[] } }[];
      evidenceBundle: {
        items: { kind: string }[];
        missingEvidence: { severity: string; reason: string }[];
        coverage: { runtimeEffectClaims: { coverageStatus: string }[] };
      };
      quality: { level: string; score: number; blockingIssues: string[] };
    }>(app, "GET", `/api/v1/test-runs/${runGroupId}/report-bundle`);
    assert(bundle.data?.source.defenseReportId === defenseReportId, "bundle links defense report");
    assert(bundle.data.source.runtimeSessionIds.includes(runtimeSessionId!), "bundle links runtime session");
    assert(
      bundle.data.claims.some((claim) => claim.claimType === "runtime_effect" && claim.sourceIds.runtimeRecordIds?.length),
      "runtime effect claims link runtime records",
    );
    assert(
      bundle.data.evidenceBundle.items.some((item) => item.kind === "runtime_record"),
      "evidence bundle includes runtime records",
    );
    assert(
      bundle.data.evidenceBundle.coverage.runtimeEffectClaims.some((row) => row.coverageStatus === "complete"),
      "runtime effect coverage is complete for at least one claim",
    );
    assert(bundle.data.quality.level === "reviewable", "fallback report quality is reviewable, not submission_ready");

    const evidence = await injectJson<{
      bundleId: string;
      evidenceBundle: { items: unknown[] };
      testContextViews: { source: string }[];
    }>(app, "GET", `/api/v1/reports/defense/${defenseReportId}/evidence`);
    assert(evidence.data?.bundleId === bundle.data.bundleId, "evidence endpoint returns same bundle");
    assert((evidence.data?.evidenceBundle.items.length ?? 0) > 0, "evidence endpoint has items");

    const quality = await injectJson<{ quality: { level: string; blockingIssues: string[] } }>(
      app,
      "GET",
      `/api/v1/reports/defense/${defenseReportId}/quality`,
    );
    assert(quality.data?.quality.level === bundle.data.quality.level, "quality endpoint matches bundle");

    const exported = await injectJson<{
      exportJobId: string;
      artifact: { artifactId: string; format: string; url: string };
      status: string;
    }>(app, "POST", `/api/v1/reports/defense/${defenseReportId}/exports`, {
      format: "markdown",
      humanReview: {
        reviewerNote: "Reviewer accepted runtime-backed claims for verification.",
        reviewedClaimCount: 1,
        reviewedAt: new Date().toISOString(),
        claimDecisions: {
          "claim.runtime.sample": "accepted",
        },
      },
    });
    assert(exported.data?.status === "completed", "markdown export completed");
    assert(exported.data.artifact.format === "markdown", "markdown artifact format");
    const exportJob = await injectJson<{ exportJobId: string; status: string }>(
      app,
      "GET",
      `/api/v1/reports/exports/${exported.data.exportJobId}`,
    );
    assert(exportJob.data?.status === "completed", "export job is queryable");
    const artifactResponse = await app.inject({
      method: "GET",
      url: exported.data.artifact.url,
    });
    assert(artifactResponse.statusCode === 200, "markdown artifact is downloadable");
    assert(artifactResponse.body.includes("Agent Guard Report Bundle"), "markdown artifact content");
    assert(artifactResponse.body.includes("Human Review"), "markdown artifact includes human review");

    const exportedZh = await injectJson<{
      exportJobId: string;
      language: string;
      artifact: { artifactId: string; format: string; language: string; url: string };
      status: string;
    }>(app, "POST", `/api/v1/reports/defense/${defenseReportId}/exports`, {
      format: "markdown",
      language: "zh",
      humanReview: {
        reviewerNote: "复核人已确认运行时证据链完整。",
        reviewedClaimCount: 1,
        reviewedAt: new Date().toISOString(),
        claimDecisions: {
          "claim.runtime.sample": "accepted",
        },
      },
    });
    assert(exportedZh.data?.status === "completed", "zh markdown export completed");
    assert(exportedZh.data.language === "zh", "zh markdown export language");
    assert(exportedZh.data.artifact.language === "zh", "zh markdown artifact language");
    const zhArtifactResponse = await app.inject({
      method: "GET",
      url: exportedZh.data.artifact.url,
    });
    assert(zhArtifactResponse.statusCode === 200, "zh markdown artifact is downloadable");
    assert(zhArtifactResponse.body.includes("Agent Guard 报告包"), "zh markdown artifact content");
    assert(zhArtifactResponse.body.includes("人工复核"), "zh markdown artifact includes human review");

    const exportedPdf = await injectJson<{
      exportJobId: string;
      artifact: { artifactId: string; format: string; url: string };
      status: string;
    }>(app, "POST", `/api/v1/reports/defense/${defenseReportId}/exports`, {
      format: "pdf",
      humanReview: {
        reviewerNote: "Reviewer accepted runtime-backed claims for verification.",
        reviewedClaimCount: 1,
        reviewedAt: new Date().toISOString(),
        claimDecisions: {
          "claim.runtime.sample": "accepted",
        },
      },
    });
    assert(exportedPdf.data?.status === "completed", "pdf export completed");
    assert(exportedPdf.data.artifact.format === "pdf", "pdf artifact format");
    const pdfArtifactResponse = await app.inject({
      method: "GET",
      url: exportedPdf.data.artifact.url,
    });
    assert(pdfArtifactResponse.statusCode === 200, "pdf artifact is downloadable");
    assert(pdfArtifactResponse.body.startsWith("%PDF-"), "pdf artifact content");

    console.log("PASS: P3 C report bundle consumes B-line runtime evidence");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
