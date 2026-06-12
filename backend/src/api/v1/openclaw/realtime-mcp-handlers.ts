import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { success, failure } from "../../response";
import {
  getRealtimeMcpTools,
  handleRealtimeMcpJsonRpc,
} from "../../../modules/openclaw/realtimeMcpServer";

type RealtimeMcpQuery = {
  sessionId?: string;
  policyPackId?: string;
};

const MCP_PATH = "/api/v1/openclaw/realtime/mcp";

export async function openClawRealtimeMcpRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(MCP_PATH, async (_request, _reply) =>
    success({
      endpoint: MCP_PATH,
      transport: "streamable-http",
      mode: "realtime_mcp_supervision",
      tools: getRealtimeMcpTools(),
      openclawConfigExample: {
        mcp: {
          servers: {
            agent_guard: {
              transport: "streamable-http",
              url: "http://127.0.0.1:3000/api/v1/openclaw/realtime/mcp",
              timeout: 20,
              connectTimeout: 5,
            },
          },
        },
      },
    }),
  );

  app.post(MCP_PATH, async (request, reply) =>
    handleMcpRequest(request, reply),
  );

  // Convenience alias for clients that expect a root-level MCP endpoint.
  app.post("/mcp/openclaw/realtime", async (request, reply) =>
    handleMcpRequest(request, reply),
  );
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
