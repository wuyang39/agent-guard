import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFileReportStore } from "../storage/fileReportStore";
import { createE2ERunService, type RunCLineE2EInput } from "../services/e2eRunService";
import { createReportQueryService } from "../services/reportQueryService";
import type { ApiResponse } from "../services/cLineRunTypes";

const rootDir = path.resolve(process.cwd());
const configDir = path.join(rootDir, "configs");
const outputDir = path.join(rootDir, "outputs", "p2");
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? "127.0.0.1";
const sampleAgentPort = Number(process.env.SAMPLE_AGENT_PORT ?? 7001);
const sampleAgentEndpoint = `http://127.0.0.1:${sampleAgentPort}/agent/run?mode=vulnerable`;
const sampleAgentHealthEndpoint = `http://127.0.0.1:${sampleAgentPort}/health`;
const sampleAgentScript = path.join(rootDir, "scripts", "sample-agent-server.mjs");
let sampleAgentProcess: ChildProcess | undefined;

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  await app.register(cors, {
    origin: true,
  });

  const store = createFileReportStore(outputDir);
  const runService = createE2ERunService({
    rootDir,
    configDir,
    store,
  });
  const queryService = createReportQueryService(store);

  app.get("/api/v1/system/status", async () =>
    ok({
      schemaVersion: "mvp-1" as const,
      service: "agent-guard-api",
      status: "ok",
      outputDir,
      generatedAt: new Date().toISOString(),
    }),
  );

  app.get("/api/v1/dashboard/summary", async () =>
    ok(await queryService.dashboardSummary()),
  );

  app.post("/api/v1/test-runs/e2e", async (request) => {
    const input = isObject(request.body) ? (request.body as RunCLineE2EInput) : {};
    return ok(await runService.run(input));
  });

  app.get("/api/v1/agents/sample/status", async () =>
    ok(await getSampleAgentStatus()),
  );

  app.post("/api/v1/agents/sample/start", async () =>
    ok(await startSampleAgent()),
  );

  app.get("/api/v1/supervision/live/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });

    const emit = (event: Record<string, unknown>) => {
      if (!closed) {
        reply.raw.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n\n`);
      }
    };

    try {
      emit({
        type: "live_started",
        message: "Starting sample agent connection and supervised run.",
      });
      const status = await startSampleAgent();
      emit({ type: "agent_status", status });

      const query = request.query as { caseIds?: string };
      const caseIds = query.caseIds
        ?.split(",")
        .map((caseId) => caseId.trim())
        .filter(Boolean);
      const bundle = await runService.run({
        agent: {
          agentId: "agent.sample_http",
          name: "Local HTTP Sample Agent",
          description: "Local sample agent connected through the formal API adapter.",
          adapterType: "api",
        },
        adapter: {
          adapterType: "api",
          endpoint: sampleAgentEndpoint,
          timeoutMs: 8000,
        },
        caseIds: caseIds?.length ? caseIds : undefined,
      });

      emit({
        type: "run_group",
        runGroup: bundle.runGroup,
        riskReportCount: bundle.riskReports.length,
        traceCount: bundle.traces.length,
      });

      for (const trace of bundle.traces.slice(0, 8)) {
        emit({
          type: "trace_summary",
          traceId: trace.traceId,
          caseId: trace.caseId,
          eventCount: trace.events.length,
          status: trace.status,
        });
      }

      for (const record of bundle.supervisionRecords) {
        emit({
          type: "supervision_record",
          record,
        });
      }

      emit({
        type: "defense_report",
        defenseReportId: bundle.defenseReport.defenseReportId,
        blockedActions: bundle.defenseReport.blockedActions.length,
        redactions: bundle.defenseReport.defenseEffectiveness.redactedActionCount,
        askDecisions: bundle.defenseReport.defenseEffectiveness.askDecisionCount,
      });
      emit({
        type: "live_complete",
        message: "Live supervision stream completed.",
      });
    } catch (streamError) {
      emit({
        type: "live_error",
        message: streamError instanceof Error ? streamError.message : String(streamError),
      });
    } finally {
      reply.raw.end();
    }
  });

  app.get("/api/v1/test-runs", async () =>
    ok({
      schemaVersion: "mvp-1" as const,
      runGroups: await queryService.listRunGroups(),
    }),
  );

  app.get("/api/v1/test-runs/:runGroupId", async (request, reply) => {
    const { runGroupId } = request.params as { runGroupId: string };
    const bundle = await queryService.getRunGroup(runGroupId);
    return bundle ? ok(bundle) : notFound(reply, "run_group_not_found", runGroupId);
  });

  app.get("/api/v1/traces/:traceId", async (request, reply) => {
    const { traceId } = request.params as { traceId: string };
    const detail = await queryService.traceDetail(traceId);
    return detail ? ok(detail) : notFound(reply, "trace_not_found", traceId);
  });

  app.get("/api/v1/reports/risk/:reportId", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const report = await queryService.riskReport(reportId);
    return report ? ok({ riskReport: report }) : notFound(reply, "risk_report_not_found", reportId);
  });

  app.get("/api/v1/reports/detection/:reportId", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const detail = await queryService.detectionDetail(reportId);
    return detail ? ok(detail) : notFound(reply, "detection_report_not_found", reportId);
  });

  app.get("/api/v1/policies/:policyPackId", async (request, reply) => {
    const { policyPackId } = request.params as { policyPackId: string };
    const policyPack = await queryService.policyPack(policyPackId);
    return policyPack ? ok({ policyPack }) : notFound(reply, "policy_pack_not_found", policyPackId);
  });

  app.get("/api/v1/supervision/sessions/:runtimeSessionId", async (request, reply) => {
    const { runtimeSessionId } = request.params as { runtimeSessionId: string };
    const session = await queryService.supervisionSession(runtimeSessionId);
    return session ? ok(session) : notFound(reply, "runtime_session_not_found", runtimeSessionId);
  });

  app.get("/api/v1/reports/defense/:reportId", async (request, reply) => {
    const { reportId } = request.params as { reportId: string };
    const detail = await queryService.defenseDetail(reportId);
    return detail ? ok(detail) : notFound(reply, "defense_report_not_found", reportId);
  });

  app.get("/api/v1/artifacts/:artifactId", async (request, reply) => {
    const { artifactId } = request.params as { artifactId: string };
    const artifact = await queryService.artifact(artifactId);
    if (!artifact) {
      return notFound(reply, "artifact_not_found", artifactId);
    }

    const artifactPath = path.resolve(artifact.path);
    if (!artifactPath.startsWith(outputDir)) {
      reply.code(403);
      return error("artifact_outside_store", "Artifact path is outside the configured store.");
    }

    if ((request.query as { raw?: string }).raw === "1") {
      const contentType =
        artifact.format === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8";
      reply.type(contentType);
      return readFile(artifactPath);
    }

    return ok({ artifact });
  });

  app.setErrorHandler((err: unknown, _request, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    reply.code(500).send(error("internal_error", message));
  });

  return app;
}

function ok<T>(data: T): ApiResponse<T> {
  return {
    ok: true,
    data,
  };
}

function error(code: string, message: string): ApiResponse<never> {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function notFound(reply: FastifyReply, code: string, id: string): ApiResponse<never> {
  reply.code(404);
  return error(code, `No object found for id "${id}".`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getSampleAgentStatus(): Promise<{
  running: boolean;
  endpoint: string;
  healthEndpoint: string;
  pid?: number;
}> {
  try {
    const response = await fetch(sampleAgentHealthEndpoint, {
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) {
      return {
        running: false,
        endpoint: sampleAgentEndpoint,
        healthEndpoint: sampleAgentHealthEndpoint,
      };
    }
    const health = (await response.json()) as { ok?: boolean };
    return {
      running: Boolean(health.ok),
      endpoint: sampleAgentEndpoint,
      healthEndpoint: sampleAgentHealthEndpoint,
      pid: sampleAgentProcess?.pid,
    };
  } catch {
    return {
      running: false,
      endpoint: sampleAgentEndpoint,
      healthEndpoint: sampleAgentHealthEndpoint,
      pid: sampleAgentProcess?.pid,
    };
  }
}

async function startSampleAgent(): Promise<{
  running: boolean;
  endpoint: string;
  healthEndpoint: string;
  pid?: number;
  startedByApi: boolean;
  message: string;
}> {
  const current = await getSampleAgentStatus();
  if (current.running) {
    return {
      ...current,
      startedByApi: false,
      message: "Sample agent is already running.",
    };
  }

  sampleAgentProcess = spawn(process.execPath, [sampleAgentScript], {
    cwd: rootDir,
    env: { ...process.env, SAMPLE_AGENT_PORT: String(sampleAgentPort) },
    stdio: "ignore",
    windowsHide: true,
  });
  sampleAgentProcess.unref();
  sampleAgentProcess.on("exit", () => {
    sampleAgentProcess = undefined;
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const next = await getSampleAgentStatus();
    if (next.running) {
      return {
        ...next,
        startedByApi: true,
        message: "Sample agent started.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    ...(await getSampleAgentStatus()),
    startedByApi: true,
    message: "Sample agent did not become ready in time.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildServer();
  await app.listen({ port, host });
  console.log(`Agent Guard C-line API is running at http://${host}:${port}`);
}
