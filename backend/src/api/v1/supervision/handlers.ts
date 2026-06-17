import type { FastifyInstance } from "fastify";
import type {
  RuntimeSupervisionRecord,
  BlockedAction,
  RuntimeAlert,
} from "@agent-guard/contracts";
import { createId, nowIso } from "../../../shared";
import { success, failure } from "../../response";
import type { SupervisorActionCounts } from "../../types";
import { getSessionRecords } from "../../../storage/fileRunStore";

export async function supervisionRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/supervision/sessions/:runtimeSessionId
  app.get(
    "/api/v1/supervision/sessions/:runtimeSessionId",
    async (request, reply) => {
      const { runtimeSessionId } = request.params as {
        runtimeSessionId: string;
      };

      const session = await getSessionRecords(runtimeSessionId);

      if (!session) {
        reply.code(404);
        return failure(
          "NOT_FOUND",
          `Supervision session ${runtimeSessionId} not found`,
        );
      }

      const records: RuntimeSupervisionRecord[] = session.records ?? [];
      const blockedActions = buildBlockedActions(records);
      const alerts = buildAlerts(records);

      const actionCounts: SupervisorActionCounts = {
        allow: session.actionCounts["allow"] ?? 0,
        deny: session.actionCounts["deny"] ?? 0,
        ask: session.actionCounts["ask"] ?? 0,
        warn: session.actionCounts["warn"] ?? 0,
        redact: session.actionCounts["redact"] ?? 0,
        isolate: session.actionCounts["isolate"] ?? 0,
      };

      return success({
        runtimeSessionId: session.runtimeSessionId,
        agentId: session.agentId,
        policyPackId: session.policyPackId,
        policyContextSource: session.policyContextSource,
        records,
        blockedActions,
        alerts,
        actionCounts,
        links: [
          {
            kind: "runtime_session" as const,
            id: session.runtimeSessionId,
            label: `Runtime Session ${session.runtimeSessionId}`,
          },
          {
            kind: "policy_pack" as const,
            id: session.policyPackId,
            label: "Supervision Policy Pack",
          },
        ],
      });
    },
  );
}

function buildBlockedActions(records: RuntimeSupervisionRecord[]): BlockedAction[] {
  return records
    .filter((r) => r.action === "deny")
    .map((r) => ({
      blockedActionId: createId("blocked_action"),
      recordId: r.recordId,
      policyId: r.policyId,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.decisionReason,
      createdAt: nowIso(),
    }));
}

function buildAlerts(records: RuntimeSupervisionRecord[]): RuntimeAlert[] {
  return records
    .filter((r) => r.action === "warn")
    .map((r) => ({
      alertId: createId("runtime_alert"),
      recordId: r.recordId,
      riskLevel: "medium" as const,
      title: "Runtime supervision warning",
      message: r.decisionReason,
      createdAt: nowIso(),
    }));
}
