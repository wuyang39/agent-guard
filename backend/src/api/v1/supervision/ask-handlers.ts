import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import { askChannel, getAskTimeoutConfig } from "../../../modules/supervisor/askChannel";

export async function askRoutes(app: FastifyInstance): Promise<void> {
  // SSE stream — 推送 pending ask
  app.get("/api/v1/supervision/ask/stream", async (request, reply) => {
    const query = request.query as { sessionId?: string };
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // 推送已有 pending asks
    const existing = query.sessionId
      ? askChannel.listBySession(query.sessionId).filter((a) => a.status === "pending")
      : askChannel.listPending();
    for (const ask of existing) {
      send("ask_decision", ask);
    }

    // 订阅新 ask
    const onNew = (ask: { runtimeSessionId: string; status: string }) => {
      if (!query.sessionId || ask.runtimeSessionId === query.sessionId) {
        send("ask_decision", ask);
      }
    };
    const onResolved = (ask: { runtimeSessionId: string }) => {
      if (!query.sessionId || ask.runtimeSessionId === query.sessionId) {
        send("ask_resolved", ask);
      }
    };

    askChannel.on("ask:new", onNew);
    askChannel.on("ask:resolved", onResolved);

    // 超时配置
    send("config", getAskTimeoutConfig());

    // 心跳
    const heartbeat = setInterval(() => {
      try { reply.raw.write(": heartbeat\n\n"); } catch { /* closed */ }
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      askChannel.off("ask:new", onNew);
      askChannel.off("ask:resolved", onResolved);
    });
  });

  // Approve / Reject
  app.post(
    "/api/v1/supervision/ask/:askId/respond",
    async (request, reply) => {
      const { askId } = request.params as { askId: string };
      const body = request.body as {
        decision: "approve" | "reject";
        reason?: string;
      };

      if (!body.decision || !["approve", "reject"].includes(body.decision)) {
        reply.code(400);
        return failure("BAD_REQUEST", "decision must be 'approve' or 'reject'");
      }

      const resolved = askChannel.resolve(
        askId,
        body.decision === "approve" ? "approved" : "rejected",
        body.reason ?? "api",
      );

      if (!resolved) {
        reply.code(404);
        return failure(
          "NOT_FOUND",
          `Ask ${askId} not found or already resolved`,
        );
      }

      return success(resolved);
    },
  );
}
