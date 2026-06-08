import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import type { SupervisorActionCounts } from "../../types";
import { getSessionSummary } from "../../../storage/fileRunStore";

export async function supervisionRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/supervision/sessions/:runtimeSessionId
  app.get(
    "/api/v1/supervision/sessions/:runtimeSessionId",
    async (request, reply) => {
      const { runtimeSessionId } = request.params as {
        runtimeSessionId: string;
      };

      const summary = await getSessionSummary(runtimeSessionId);

      if (!summary) {
        reply.code(404);
        return failure(
          "NOT_FOUND",
          `Supervision session ${runtimeSessionId} not found`,
        );
      }

      const actionCounts: SupervisorActionCounts = {
        allow: summary.actionCounts["allow"] ?? 0,
        deny: summary.actionCounts["deny"] ?? 0,
        ask: summary.actionCounts["ask"] ?? 0,
        warn: summary.actionCounts["warn"] ?? 0,
        redact: summary.actionCounts["redact"] ?? 0,
        isolate: summary.actionCounts["isolate"] ?? 0,
      };

      return success({
        runtimeSessionId: summary.runtimeSessionId,
        agentId: summary.agentId,
        policyPackId: summary.policyPackId,
        records: [] as unknown[], // B-1: 完整记录查询留 B-4
        blockedActions: [] as unknown[],
        alerts: [] as unknown[],
        actionCounts,
        links: [
          {
            kind: "runtime_session" as const,
            id: summary.runtimeSessionId,
            label: `Runtime Session ${summary.runtimeSessionId}`,
          },
          {
            kind: "policy_pack" as const,
            id: summary.policyPackId,
            label: "Supervision Policy Pack",
          },
        ],
      });
    },
  );
}
