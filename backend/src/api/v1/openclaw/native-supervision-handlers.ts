/**
 * Agent Guard 原生工具评估端点（简化版）
 *
 * 供 OpenClaw Plugin (before_tool_call hook) 调用的 REST API。
 * 使用已有的导出接口，不依赖 realtimeMcpServer 内部函数。
 */

import type { FastifyInstance } from "fastify";
import { createId, nowIso } from "../../../shared";
import { success, failure } from "../../response";
import { askChannel } from "../../../modules/supervisor/askChannel";
import { subscribeRealtimeEvents } from "../../../modules/openclaw/realtimeMcpServer";

// 工具风险分级
const RISK_LEVELS: Record<string, "critical" | "high" | "medium" | "low"> = {
  // 代码执行 — 最高风险
  exec: "critical",
  process: "critical",
  // 文件写入 — 高风险
  write: "high",
  edit: "high",
  apply_patch: "high",
  // 文件读取 — 中风险
  read: "medium",
  // 网络请求 — 中高风险
  web_fetch: "high",
  web_search: "medium",
  browser: "high",
  // 消息发送 — 中风险
  sessions_send: "medium",
  // 定时任务 — 高风险
  cron: "high",
};

// 实时事件订阅者（用于推送 native_tool_hook 事件）
const eventListeners: Array<(event: any) => void> = [];

// 订阅事件（与 realtimeMcpServer 的事件流共享）
subscribeRealtimeEvents((event) => {
  for (const listener of eventListeners) {
    listener(event);
  }
});

function pushEvent(event: any) {
  for (const listener of eventListeners) {
    listener(event);
  }
}

export async function nativeSupervisionRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ==================================================================
  // POST /api/v1/openclaw/realtime/supervision/eval
  // 供 OpenClaw Plugin 调用，评估原生工具调用
  // ==================================================================
  app.post(
    "/api/v1/openclaw/realtime/supervision/eval",
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;

      // ---- 参数校验 ----
      const toolName = typeof body.toolName === "string" ? body.toolName : "";
      if (!toolName) {
        reply.code(400);
        return failure("INVALID_TOOL_NAME", "toolName is required");
      }

      const parameters =
        typeof body.parameters === "object" && body.parameters !== null
          ? (body.parameters as Record<string, unknown>)
          : {};
      const runtimeSessionId =
        typeof body.runtimeSessionId === "string"
          ? body.runtimeSessionId
          : "default";
      const agentId =
        typeof body.agentId === "string" ? body.agentId : "openclaw";

      // ---- 获取当前活跃策略信息 ----
      // 注意: getRealtimeActivePolicyState 已从 realtimeMcpServer 导出
      const { getRealtimeActivePolicyState } = await import(
        "../../../modules/openclaw/realtimeMcpServer"
      );
      const policyState = await getRealtimeActivePolicyState();
      const hasActivePolicy =
        policyState && policyState.policyCount > 0;

      // ---- 风险等级判定 ----
      const riskLevel = RISK_LEVELS[toolName] ?? "medium";

      // ---- 策略决策 ----
      let action: "allow" | "deny" | "warn" | "ask" = "allow";
      let reason = "No matching policy, action allowed by default";

      if (!hasActivePolicy) {
        // 没有活跃策略包 → 高风险工具阻断，其余放行
        if (riskLevel === "critical") {
          action = "deny";
          reason =
            `[Agent Guard] 无活跃监督策略，高风险工具已阻断: ${toolName}`;
        } else if (riskLevel === "high") {
          action = "warn";
          reason =
            `[Agent Guard] 无活跃监督策略，高风险工具放行但已记录: ${toolName}`;
        } else {
          action = "allow";
          reason =
            `[Agent Guard] 无活跃监督策略，${riskLevel}风险工具已放行`;
        }
      } else {
        // 有策略包 — 按风险等级判定
        switch (riskLevel) {
          case "critical":
            action = "deny";
            reason =
              `策略包 ${policyState.resolvedPolicyPackId}: ` +
              `高风险工具 ${toolName} 已被阻断`;
            break;
          case "high":
            action = "ask";
            reason =
              `策略包 ${policyState.resolvedPolicyPackId}: ` +
              `高风险工具 ${toolName} 需要确认`;
            break;
          case "medium":
            action = "warn";
            reason =
              `策略包 ${policyState.resolvedPolicyPackId}: ` +
              `中风险工具 ${toolName} 已记录`;
            break;
          default:
            action = "allow";
            reason =
              `策略包 ${policyState.resolvedPolicyPackId}: ` +
              `低风险工具 ${toolName} 已放行`;
        }
      }

      // ---- 处理 ask 动作 — 通过 askChannel ----
      let askId: string | undefined;
      if (action === "ask") {
        const pendingAsk = askChannel.create({
          runtimeSessionId,
          agentId,
          policyId: "policy.native_tool.ask",
          policyPackId:
            policyState?.resolvedPolicyPackId ?? "none",
          targetType: "tool_call",
          targetId: toolName,
          payload: {
            toolName,
            parameters,
          } as Record<string, unknown>,
          reason,
          riskLevel: riskLevel === "critical" ? "critical" : "high",
        });
        askId = pendingAsk.askId;

        // 超时或人工审批后同步决策
        const finalDecision = await askChannel.wait(pendingAsk.askId);
        if (finalDecision === "rejected") {
          action = "deny";
          reason = `用户拒绝了 ${toolName} 的调用: ${reason}`;
        } else {
          action = "allow";
          reason = `用户批准了 ${toolName} 的调用`;
        }
      }

      // ---- 推送实时事件到 SSE ----
      pushEvent({
        eventId: createId("evt"),
        type: "supervision_decision",
        timestamp: nowIso(),
        runtimeSessionId,
        toolName,
        action,
        targetType: "tool_call",
        message: reason,
        detail: {
          source: "native_tool_hook",
          toolName,
          riskLevel,
          parameters,
          policyPackId: policyState?.resolvedPolicyPackId,
          askId,
        },
      });

      // ---- 返回决策 ----
      return success({
        action,
        reason,
        askId,
        policyPackId: policyState?.resolvedPolicyPackId,
        toolName,
      });
    },
  );

  // ==================================================================
  // POST /api/v1/openclaw/realtime/supervision/event
  // 供 OpenClaw Plugin (after_tool_call) 上报执行结果
  // ==================================================================
  app.post(
    "/api/v1/openclaw/realtime/supervision/event",
    async (request) => {
      const body = request.body as Record<string, unknown>;

      pushEvent({
        eventId: createId("evt"),
        type: "tool_call_result",
        timestamp: nowIso(),
        runtimeSessionId:
          typeof body.sessionId === "string" ? body.sessionId : "default",
        toolName:
          typeof body.toolName === "string" ? body.toolName : "",
        detail: {
          source: "native_tool_hook",
          result: body.result,
          error: body.error,
          durationMs: body.durationMs,
          ...(body as Record<string, unknown>),
        },
      });

      return success({ received: true });
    },
  );

  // ==================================================================
  // GET /api/v1/openclaw/realtime/supervision/status
  // 供插件查询当前监督状态
  // ==================================================================
  app.get(
    "/api/v1/openclaw/realtime/supervision/status",
    async () => {
      const { getRealtimeActivePolicyState } = await import(
        "../../../modules/openclaw/realtimeMcpServer"
      );
      const policyState = await getRealtimeActivePolicyState();

      return success({
        mode: "active",
        policy: policyState,
        supervisedNativeTools: Object.keys(RISK_LEVELS),
      });
    },
  );
}
