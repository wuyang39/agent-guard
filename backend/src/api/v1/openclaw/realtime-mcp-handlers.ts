import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JsonObject } from "@agent-guard/contracts";
import { success, failure } from "../../response";
import {
  getRealtimeActivePolicyState,
  getRealtimeMcpTools,
  finalizeRealtimeDefenseReport,
  handleRealtimeMcpJsonRpc,
  getRealtimeSupervisionBatch,
  listRealtimeSupervisionBatches,
  prepareRealtimeSession,
  refreshRealtimeMcpTools,
  resetRealtimeSessions,
  runRealtimeSupervisionBatch,
  setRealtimeActivePolicy,
  subscribeRealtimeEvents,
} from "../../../modules/openclaw/realtimeMcpServer";

type RealtimeMcpQuery = {
  sessionId?: string;
  policyPackId?: string;
};

const MCP_PATH = "/api/v1/openclaw/realtime/mcp";
const ACTIVE_POLICY_PATH = "/api/v1/openclaw/realtime/active-policy";
const SESSION_PREPARE_PATH = "/api/v1/openclaw/realtime/sessions";
const SESSION_RESET_PATH = "/api/v1/openclaw/realtime/sessions/reset";
const EVENTS_STREAM_PATH = "/api/v1/openclaw/realtime/events/stream";
const DEFENSE_REPORT_PATH = "/api/v1/openclaw/realtime/reports/defense";
const SUPERVISION_BATCHES_PATH = "/api/v1/openclaw/realtime/supervision-batches";

export async function openClawRealtimeMcpRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(MCP_PATH, async (_request, _reply) => {
    await refreshRealtimeMcpTools();
    const activePolicy = await getRealtimeActivePolicyState();
    return success({
      endpoint: MCP_PATH,
      transport: "streamable-http",
      mode: "realtime_mcp_supervision",
      activePolicy,
      tools: getRealtimeMcpTools(),
      openclawConfigExample: {
        mcp: {
          servers: {
            agent_guard: {
              transport: "streamable-http",
              url: "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp",
              timeout: 20,
              connectTimeout: 5,
            },
          },
        },
      },
    });
  });

  app.post(MCP_PATH, async (request, reply) =>
    handleMcpRequest(request, reply),
  );

  // Convenience alias for clients that expect a root-level MCP endpoint.
  app.post("/mcp/openclaw/realtime", async (request, reply) =>
    handleMcpRequest(request, reply),
  );

  app.get(ACTIVE_POLICY_PATH, async (_request, _reply) =>
    success(await getRealtimeActivePolicyState()),
  );

  app.post(ACTIVE_POLICY_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const policyPackId = body.policyPackId;
    if (typeof policyPackId !== "string" || policyPackId.length === 0) {
      reply.code(400);
      return failure("INVALID_POLICY_PACK_ID", "policyPackId is required");
    }

    const resetSessions =
      typeof body.resetSessions === "boolean"
        ? body.resetSessions
        : typeof body.resetSession === "boolean"
          ? body.resetSession
          : true;
    const runtimeSessionId =
      typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : undefined;

    try {
      return success(
        await setRealtimeActivePolicy(policyPackId, {
          resetSessions,
          runtimeSessionId,
        }),
      );
    } catch (error) {
      reply.code(404);
      return failure(
        "POLICY_PACK_NOT_FOUND",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.post(SESSION_RESET_PATH, async (request) => {
    const body = isObject(request.body) ? request.body : {};
    const runtimeSessionId =
      typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : undefined;
    const resetCount = resetRealtimeSessions(runtimeSessionId);
    return success({ resetCount, runtimeSessionId });
  });

  app.post(SESSION_PREPARE_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const runtimeSessionId =
      typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : undefined;
    const policyPackId =
      typeof body.policyPackId === "string" ? body.policyPackId : undefined;

    try {
      return success(await prepareRealtimeSession({ runtimeSessionId, policyPackId }));
    } catch (error) {
      reply.code(404);
      return failure(
        "REALTIME_SESSION_PREPARE_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.post(DEFENSE_REPORT_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const runtimeSessionId =
      typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : undefined;

    try {
      return success(await finalizeRealtimeDefenseReport(runtimeSessionId));
    } catch (error) {
      reply.code(400);
      return failure(
        "REALTIME_DEFENSE_REPORT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.get(SUPERVISION_BATCHES_PATH, async (request) => {
    const query = request.query as { runtimeSessionId?: string; limit?: string };
    const limit = Number.parseInt(query.limit ?? "", 10);
    return success(
      await listRealtimeSupervisionBatches({
        runtimeSessionId:
          typeof query.runtimeSessionId === "string"
            ? query.runtimeSessionId
            : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  });

  app.get(`${SUPERVISION_BATCHES_PATH}/:batchId`, async (request, reply) => {
    const params = request.params as { batchId?: string };
    if (!params.batchId) {
      reply.code(400);
      return failure("INVALID_BATCH_ID", "batchId is required");
    }
    const batch = await getRealtimeSupervisionBatch(params.batchId);
    if (!batch) {
      reply.code(404);
      return failure("BATCH_NOT_FOUND", `Batch ${params.batchId} not found`);
    }
    return success(batch);
  });

  app.post(SUPERVISION_BATCHES_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const cases = Array.isArray(body.cases) ? body.cases : [];
    if (cases.length === 0) {
      reply.code(400);
      return failure("INVALID_BATCH_CASES", "cases must be a non-empty array");
    }

    try {
      return success(
        await runRealtimeSupervisionBatch({
          runtimeSessionId:
            typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : undefined,
          policyPackId:
            typeof body.policyPackId === "string" ? body.policyPackId : undefined,
          source: isBatchSource(body.source) ? body.source : "external_unknown_test_pack",
          stopOnError: body.stopOnError === true,
          cases: cases.map((item, index) => normalizeBatchCase(item, index)),
        }),
      );
    } catch (error) {
      reply.code(400);
      return failure(
        "SUPERVISION_BATCH_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.get(EVENTS_STREAM_PATH, async (request, reply) => {
    const query = request.query as { replay?: string };
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    const send = (eventName: string, data: unknown) => {
      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send("config", {
      endpoint: EVENTS_STREAM_PATH,
      replay: query.replay !== "0",
    });

    const unsubscribe = subscribeRealtimeEvents(
      (event) => send(event.type, event),
      { replay: query.replay !== "0" },
    );

    request.raw.on("close", () => {
      unsubscribe();
    });
  });
}

async function handleMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const query = request.query as RealtimeMcpQuery;

  try {
    if (
      !request.body ||
      (typeof request.body !== "object" && !Array.isArray(request.body))
    ) {
      reply.code(400);
      return failure("INVALID_JSON_RPC", "Request body must be a JSON-RPC object or batch");
    }

    const response = await handleRealtimeMcpJsonRpc(
      request.body as Parameters<typeof handleRealtimeMcpJsonRpc>[0],
      {
        sessionId: query.sessionId,
        policyPackId: query.policyPackId,
      },
    );

    if (!response) {
      return reply.code(202).send("");
    }

    return reply.type("application/json").send(response);
  } catch (error) {
    reply.code(500);
    return failure(
      "OPENCLAW_REALTIME_MCP_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBatchCase(value: unknown, index: number) {
  const item = isObject(value) ? value : {};
  const toolName = typeof item.toolName === "string" ? item.toolName : "";
  if (!toolName) {
    throw new Error(`cases[${index}].toolName is required`);
  }
  return {
    externalCaseId:
      typeof item.externalCaseId === "string" && item.externalCaseId
        ? item.externalCaseId
        : `external_case.${index + 1}`,
    toolName,
    arguments: isJsonObject(item.arguments) ? item.arguments : {},
    notes: typeof item.notes === "string" ? item.notes : undefined,
  };
}

function isBatchSource(
  value: unknown,
): value is "external_unknown_test_pack" | "manual" | "script" | "unknown" {
  return (
    value === "external_unknown_test_pack" ||
    value === "manual" ||
    value === "script" ||
    value === "unknown"
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
