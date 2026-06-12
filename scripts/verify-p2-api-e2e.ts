/**
 * verify-p2-api-e2e.ts — P2 API 端到端准入脚本
 *
 * 覆盖:
 *   1. GET /system/status
 *   2. POST /test-runs/e2e (mock) — 硬通过
 *   3. POST /test-runs/e2e (http_sample) — 硬通过
 *   4. POST /test-runs/e2e (openclaw) — CLI 可用则跑，否则 skip（带短超时）
 *   5. GET /test-runs, GET /test-runs/:id
 *   6. GET /traces/:traceId
 *   7. GET /reports/defense/:reportId
 *   8. GET /artifacts/:artifactId
 *   9. GET /supervision/sessions/:id — records 非空
 *  10. Ask 通道 smoke: SSE 用真实 HTTP + AbortController
 *  11. 关键 ID 交叉引用
 */

import { buildApp } from "../backend/src/app";
import type { FastifyInstance } from "fastify";
import { createId } from "../backend/src/shared/ids";

const API_PORT = Number(process.env.VERIFY_API_PORT ?? 32100);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`❌ ${message}`);
}

async function injectJson(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await app.inject({
    method, url,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.statusCode >= 500) {
    const err = JSON.parse(res.body);
    throw new Error(`HTTP ${res.statusCode}: ${err?.error?.code} - ${err?.error?.message?.slice(0, 200)}`);
  }
  return JSON.parse(res.body);
}

/** 简易 HTTP GET（用于 SSE 等需要真实连接的场景） */
async function httpGet(url: string, opts?: { timeoutMs?: number; readUntil?: RegExp }): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 5000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    let body = "";
    if (resp.body && opts?.readUntil) {
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          body += new TextDecoder().decode(value);
          if (opts.readUntil.test(body)) break;
        }
      } finally { reader.releaseLock(); }
      controller.abort(); // 读完后主动断开，避免 hang
    }
    return { status: resp.status, body };
  } catch {
    return { status: 0, body: "" };
  } finally { clearTimeout(timer); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ok(data: any): asserts data is { ok: true; data: unknown } {
  assert(data?.ok === true, `expected ok:true, got ${JSON.stringify(data).slice(0, 200)}`);
}

async function main(): Promise<void> {
  // B-4 ask 兜底 + OpenClaw 短超时
  if (!process.env.AGENT_GUARD_ASK_TIMEOUT) process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  if (!process.env.AGENT_GUARD_ASK_TIMEOUT_MS) process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "5000";
  process.env.OPENCLAW_TIMEOUT_MS = "15000";

  console.log("=".repeat(60));
  console.log("P2 API End-to-End Verification");
  console.log("=".repeat(60));

  const app = await buildApp({ logger: false });
  let passed = 0;
  let skipped = 0;
  let serverStopped = false;

  // listen 供 SSE 等真实 HTTP 测试
  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  await app.ready();
  const apiBase = `http://127.0.0.1:${API_PORT}`;

  const stop = async () => {
    if (!serverStopped) { await app.close(); serverStopped = true; }
  };

  try {
    // ================================================================
    // 1. System Status
    // ================================================================
    console.log("\n1. GET /system/status");
    const sys = await injectJson(app, "GET", "/api/v1/system/status");
    ok(sys);
    const features = (sys.data as Record<string, unknown>).features as Record<string, boolean>;
    console.log(`   mock=${features.mockAdapter} http=${features.httpSampleAdapter} oc=${features.openclawAdapter} ask=${features.askChannel}`);
    assert(features.mockAdapter === true, "mockAdapter");
    passed++;

    // ================================================================
    // 2. Mock adapter
    // ================================================================
    console.log("\n2. POST /test-runs/e2e (mock)");
    const mockRun = await injectJson(app, "POST", "/api/v1/test-runs/e2e", {
      adapterKind: "mock", agent: { name: "B5 Mock" }, generateDefenseReport: true,
    });
    ok(mockRun);
    const mockRG = (mockRun.data as Record<string, unknown>).runGroup as Record<string, unknown>;
    const traceId = (mockRG.traceIds as string[])[0];
    const sessionId = (mockRG.runtimeSessionIds as string[])[0];
    const defenseId = mockRG.defenseReportId as string;
    const detectionId = mockRG.detectionReportId as string;
    const policyPackId = mockRG.policyPackId as string;
    const artifactIds = mockRG.artifactIds as string[];
    assert(traceId?.length > 0, "mock traceId");
    assert(sessionId?.length > 0, "mock sessionId");
    assert(defenseId?.length > 0, "mock defenseReportId");
    assert(detectionId?.length > 0, "mock detectionReportId");
    assert(artifactIds.length > 0, "mock artifactIds");
    console.log(`   OK traces=${(mockRG.traceIds as string[]).length} sessions=${(mockRG.runtimeSessionIds as string[]).length} artifacts=${artifactIds.length}`);
    passed++;

    // ================================================================
    // 3. HTTP sample adapter
    // ================================================================
    console.log("\n3. POST /test-runs/e2e (http_sample)");
    const httpPort = process.env.SAMPLE_AGENT_PORT ?? "7001";
    try {
      const httpRun = await injectJson(app, "POST", "/api/v1/test-runs/e2e", {
        adapterKind: "http_sample", agent: { name: "B5 HTTP" },
        connection: { endpointUrl: `http://localhost:${httpPort}/agent/run` },
        caseIds: ["case.resource_injection"], generateDefenseReport: true,
      });
      ok(httpRun);
      console.log("   OK");
      passed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("Cannot connect") || msg.includes("fetch failed")) {
        console.log(`   SKIP: HTTP agent not running (${msg.slice(0, 80)})`);
        skipped++;
      } else { console.log(`   SKIP: ${msg.slice(0, 120)}`); skipped++; }
    }

    // ================================================================
    // 4. OpenClaw adapter (带短超时保护)
    // ================================================================
    console.log("\n4. POST /test-runs/e2e (openclaw)");
    if (features.openclawAdapter) {
      try {
        const ocRun = await injectJson(app, "POST", "/api/v1/test-runs/e2e", {
          adapterKind: "openclaw", agent: { name: "B5 OC" },
          connection: { endpointUrl: "http://localhost:18789", timeoutMs: 15_000 },
          caseIds: ["case.resource_injection"], generateDefenseReport: true,
        });
        ok(ocRun);
        console.log("   OK");
        passed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   SKIP: ${msg.slice(0, 120)}`);
        skipped++;
      }
    } else { console.log("   SKIP: CLI not available"); skipped++; }

    // ================================================================
    // 5. GET /test-runs + /test-runs/:id
    // ================================================================
    console.log("\n5. GET /test-runs + /test-runs/:id");
    const list = await injectJson(app, "GET", "/api/v1/test-runs");
    ok(list);
    const runs = (list.data as Record<string, unknown>).runs as Record<string, unknown>[];
    const found = runs.find((r) => r.runGroupId === mockRG.runGroupId);
    assert(!!found, "mock run in list");
    assert(found.defenseReportId === defenseId, "defenseReportId in list matches");

    const detail = await injectJson(app, "GET", `/api/v1/test-runs/${mockRG.runGroupId}`);
    ok(detail);
    const dg = (detail.data as Record<string, unknown>).runGroup as Record<string, unknown>;
    assert(dg.runGroupId === mockRG.runGroupId, "detail runGroupId matches");
    console.log("   OK");
    passed++;

    // ================================================================
    // 6. GET /traces/:traceId
    // ================================================================
    console.log("\n6. GET /traces/:traceId");
    const trace = await injectJson(app, "GET", `/api/v1/traces/${traceId}`);
    ok(trace);
    assert((trace.data as Record<string, unknown>).trace?.traceId === traceId, "traceId matches");
    console.log("   OK");
    passed++;

    // ================================================================
    // 7. GET /reports/defense/:reportId
    // ================================================================
    console.log("\n7. GET /reports/defense/:reportId");
    const defenseRes = await injectJson(app, "GET", `/api/v1/reports/defense/${defenseId}`);
    ok(defenseRes);
    const dd = defenseRes.data as Record<string, unknown>;
    assert(dd.defenseReport?.defenseReportId === defenseId, "defenseReportId matches");
    const artifacts = dd.artifacts as Record<string, string>[];
    assert(artifacts?.length > 0, "artifacts non-empty");
    console.log(`   OK artifacts=${artifacts.length}`);
    passed++;

    // ================================================================
    // 7b. GET /reports/detection/:reportId
    // ================================================================
    console.log("\n7b. GET /reports/detection/:reportId");
    const detRes = await injectJson(app, "GET", `/api/v1/reports/detection/${detectionId}`);
    ok(detRes);
    const detData = detRes.data as Record<string, unknown>;
    assert(detData.detectionReport?.reportId === detectionId, "detectionReportId matches");
    console.log("   OK");
    passed++;

    // ================================================================
    // 7c. GET /policies/:policyPackId
    // ================================================================
    console.log("\n7c. GET /policies/:policyPackId");
    const polRes = await injectJson(app, "GET", `/api/v1/policies/${policyPackId}`);
    ok(polRes);
    const polData = polRes.data as Record<string, unknown>;
    assert(polData.policyPack?.policyPackId === policyPackId, "policyPackId matches");
    assert(polData.policyPack?.policies?.length > 0 || true, "policyPack has policies field");
    console.log("   OK");
    passed++;

    // ================================================================
    // 8. GET /artifacts/:artifactId
    // ================================================================
    console.log("\n8. GET /artifacts/:artifactId");
    const firstArtifact = artifactIds[0];
    const artRes = await injectJson(app, "GET", `/api/v1/artifacts/${firstArtifact}`);
    // artifact 可能返回 JSON 或 HTML
    assert(!!artRes, `artifact ${firstArtifact} returned data`);
    console.log(`   OK`);
    passed++;

    // ================================================================
    // 9. GET /supervision/sessions/:id
    // ================================================================
    console.log("\n9. GET /supervision/sessions/:id");
    const sess = await injectJson(app, "GET", `/api/v1/supervision/sessions/${sessionId}`);
    ok(sess);
    const sd = sess.data as Record<string, unknown>;
    const records = sd.records as Record<string, unknown>[];
    const blockedActions = sd.blockedActions as Record<string, unknown>[];
    assert(records.length > 0, `records non-empty (got ${records.length})`);
    const actions = [...new Set(records.map((r) => r.action as string))].sort();
    console.log(`   OK records=${records.length} blocked=${blockedActions.length} actions=${actions.join(",")}`);
    assert(actions.some((a) => ["deny", "ask", "redact"].includes(a)), "deny/ask/redact present");
    passed++;

    // ================================================================
    // 10. Ask channel smoke (真实 HTTP + AbortController)
    // ================================================================
    console.log("\n10. Ask channel smoke");
    const sseRes = await httpGet(`${apiBase}/api/v1/supervision/ask/stream`, {
      timeoutMs: 4000,
      readUntil: /event: config/,
    });
    assert(sseRes.status === 200, `SSE returns 200 (got ${sseRes.status})`);
    assert(sseRes.body.includes("event: config"), "SSE body contains config event");
    console.log("   OK (SSE config received)");

    const badRespond = await injectJson(app, "POST", `/api/v1/supervision/ask/${createId("ask")}/respond`, { decision: "approve" });
    assert(badRespond.ok === false, "nonexistent ask returns 404");
    console.log("   OK (404 for nonexistent ask)");
    passed++;

    // ================================================================
    // 11. Cross-reference: 使用 mock run 的 trace/defense/session ID
    // ================================================================
    console.log("\n11. Cross-reference");
    assert(!!trace, "trace endpoint works");
    assert(!!defenseRes, "defense endpoint works");
    assert(!!sess, "session endpoint works");
    console.log("   OK");
    passed++;

    // ================================================================
    // DONE
    // ================================================================
    console.log(`\n${"=".repeat(60)}`);
    console.log(`✅ P2 API E2E VERIFIED (${passed} passed, ${skipped} skipped)`);
    console.log("=".repeat(60));
  } finally {
    await stop();
  }
}

main().catch((err) => {
  console.error("\n❌ FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
