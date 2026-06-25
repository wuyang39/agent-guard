/**
 * openclaw-agent-guard-plugin
 * 
 * OpenClaw 插件 — 拦截原生工具调用，走 Agent Guard 实时监督。
 *
 * 安装方式:
 *   openclaw plugins install E:\agent-guard\plugins\agent-guard-supervision
 *
 * 编译:
 *   cd E:\agent-guard\plugins\agent-guard-supervision
 *   npm install
 *   npm run build
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const AGENT_GUARD_URL = "http://127.0.0.1:3100";

/**
 * 高风险工具 — Agent Guard 不可达时 fail-close（直接阻断）
 */
const HIGH_RISK_TOOLS = new Set([
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
  "web_fetch",
  "browser",
  "cron",
]);

/**
 * 已知已由 Agent Guard MCP Gateway 监管的工具前缀 — 跳过插件拦截
 */
const ALREADY_SUPERVISED_PREFIXES = [
  "agent_guard__",
  "agent_guard_",
  "agw__sandbox_downstream__",
  "agw__",
];

export default definePluginEntry({
  id: "agent-guard-supervision",
  name: "Agent Guard Supervision",
  description:
    "Intercepts native OpenClaw tool calls and routes them through " +
    "Agent Guard realtime policy evaluation.",

  register(api) {
    // ====================================================================
    // 核心钩子: 拦截所有工具调用
    // ====================================================================
    api.registerHook("before_tool_call", async (event, _ctx) => {
      const toolName = event.toolName;

      // 跳过已由 Agent Guard MCP Gateway 监管的工具
      if (ALREADY_SUPERVISED_PREFIXES.some((p) => toolName.startsWith(p))) {
        return;
      }

      // 跳过非敏感工具（Session 操作、记忆操作等）
      const BYPASS_TOOLS = new Set([
        "session_status",
        "sessions_list",
        "sessions_history",
        "sessions_yield",
        "subagents",
        "memory_search",
        "memory_get",
        "image",
        "image_generate",
        "video_generate",
        "tts",
      ]);
      if (BYPASS_TOOLS.has(toolName)) {
        return;
      }

      // 构造 Agent Guard 评估请求
      const evalRequest = {
        toolName,
        parameters: event.params ?? {},
        sessionId: _ctx?.sessionKey ?? "default",
        agentId: _ctx?.agentId ?? "openclaw",
        runId: _ctx?.runId,
      };

      try {
        const decision = await evaluateWithAgentGuard(evalRequest);

        switch (decision.action) {
          case "allow":
            return; // 放行

          case "deny":
            return {
              block: true,
              blockReason: `[Agent Guard] ${decision.reason}`,
            };

          case "warn":
            console.warn(
              `[Agent Guard WARN] ${toolName}: ${decision.reason}`,
            );
            return; // 放行但已记录

          case "ask":
            // 主路径: 走 Agent Guard 的 ask 通道（前端弹窗）
            if (decision.askId) {
              // 返回 requireApproval 作为兜底
              return {
                requireApproval: {
                  title: `Agent Guard: 需要确认 - ${toolName}`,
                  description: decision.reason,
                  severity: "critical",
                  timeoutMs: 60_000,
                  timeoutBehavior: "deny",
                  pluginId: "agent-guard-supervision",
                },
              };
            }
            return {
              block: true,
              blockReason: `[Agent Guard] 待确认: ${decision.reason}`,
            };
        }
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        console.error(`[Agent Guard] 评估失败: ${errorMsg}`);

        // 分级 fail-close: 高风险工具阻断，低风险放行
        if (HIGH_RISK_TOOLS.has(toolName)) {
          return {
            block: true,
            blockReason: `[Agent Guard] 监督服务不可达，高风险工具已阻断 (${toolName})`,
          };
        }
        // 低风险工具: 记录警告后放行
        console.warn(
          `[Agent Guard] 监督不可达，低风险工具放行: ${toolName}`,
        );
        return;
      }
    });

    // ====================================================================
    // 可选: 监听工具执行结果，上报 Agent Guard 用于审计
    // ====================================================================
    api.registerHook("after_tool_call", async (event, _ctx) => {
      const toolName = event.toolName;

      // 跳过已监管的工具
      if (ALREADY_SUPERVISED_PREFIXES.some((p) => toolName.startsWith(p))) {
        return;
      }

      // Fire-and-forget 上报执行结果
      try {
        fetch(`${AGENT_GUARD_URL}/api/v1/openclaw/realtime/supervision/event`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "tool_call_result",
            toolName,
            parameters: event.params ?? {},
            result: event.result,
            error: event.error,
            durationMs: event.durationMs,
            sessionId: _ctx?.sessionKey ?? "default",
            agentId: _ctx?.agentId ?? "openclaw",
            source: "native_tool_hook",
            timestamp: new Date().toISOString(),
          }),
        }).catch(() => {
          /* 静默 */
        });
      } catch {
        /* 静默 */
      }
    });

    // ====================================================================
    // 启动时: 连接 Agent Guard 事件流，接收策略更新通知
    // ====================================================================
    connectEventStream();

    console.log("[Agent Guard] 监督插件已启动");
  },
});

// ====================================================================
// Agent Guard 远程评估
// ====================================================================
async function evaluateWithAgentGuard(request: {
  toolName: string;
  parameters: Record<string, unknown>;
  sessionId: string;
  agentId: string;
  runId?: string;
}): Promise<{
  action: "allow" | "deny" | "warn" | "ask";
  reason: string;
  askId?: string;
}> {
  const response = await fetch(
    `${AGENT_GUARD_URL}/api/v1/openclaw/realtime/supervision/eval`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtimeSessionId: request.sessionId,
        agentId: request.agentId,
        toolName: request.toolName,
        parameters: request.parameters,
        runId: request.runId,
        source: "native_tool_hook",
      }),
      signal: AbortSignal.timeout(3_000),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(
      `Agent Guard returned ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  const body = await response.json();
  if (!body.ok) {
    throw new Error(
      `Agent Guard eval failed: ${body.message ?? "unknown"}`,
    );
  }

  return {
    action: body.data.action ?? "allow",
    reason: body.data.reason ?? "No matching policy",
    askId: body.data.askId,
  };
}

// ====================================================================
// 事件流连接（接收策略更新通知）
// ====================================================================
function connectEventStream() {
  try {
    const es = new EventSource(
      `${AGENT_GUARD_URL}/api/v1/openclaw/realtime/events/stream?replay=1`,
    );

    es.addEventListener("active_policy_updated", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log(
          `[Agent Guard] 策略已更新: ${data.resolvedPolicyPackId}` +
            ` (${data.policyCount} 条规则)`,
        );
      } catch {
        /* 静默 */
      }
    });

    es.addEventListener("open", () => {
      console.log("[Agent Guard] 事件流已连接");
    });

    es.addEventListener("error", () => {
      console.warn("[Agent Guard] 事件流断开，将自动重连");
    });
  } catch (err) {
    console.error("[Agent Guard] 事件流初始化失败:", err);
  }
}
