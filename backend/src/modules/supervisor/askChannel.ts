/**
 * askChannel — 半真实 HITL ask 通道
 *
 * 状态机: pending → approved | rejected | timeout
 * - SSE 推送给前端
 * - POST /respond 收回 Approve/Reject
 * - 超时后走默认策略 (AGENT_GUARD_ASK_TIMEOUT=demo_approve 兜底)
 */

import { EventEmitter } from "node:events";
import { createId, nowIso } from "../../shared";
import type { RiskLevel } from "@agent-guard/contracts";

function getAskTimeoutMs(): number {
  return Number(process.env.AGENT_GUARD_ASK_TIMEOUT_MS ?? 60_000);
}
function getTimeoutAction(): "reject" | "demo_approve" {
  return process.env.AGENT_GUARD_ASK_TIMEOUT === "demo_approve"
    ? "demo_approve"
    : "reject";
}

export type AskDecision = "approved" | "rejected" | "timeout";

export type PendingAsk = {
  askId: string;
  runtimeSessionId: string;
  agentId: string;
  policyId: string;
  policyPackId: string;
  targetType: string;
  targetId?: string;
  payload: Record<string, unknown>;
  reason: string;
  riskLevel: RiskLevel;
  /** 实际状态: 是如何结束的 */
  status: "pending" | "approved" | "rejected" | "timeout";
  /** 最终决策: approve 放行 / reject 阻断。timeout + demo_approve → approved */
  finalDecision?: "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

/** 全局 ask 事件总线 — SSE handler 订阅，SupervisionBridge 发布 */
class AskChannel extends EventEmitter {
  private pending = new Map<string, PendingAsk>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  /** 创建一个 pending ask，启动超时计时器 */
  create(partial: Omit<PendingAsk, "askId" | "status" | "createdAt">): PendingAsk {
    const ask: PendingAsk = {
      ...partial,
      askId: createId("ask"),
      status: "pending",
      createdAt: nowIso(),
    };
    this.pending.set(ask.askId, ask);

    // 超时计时器
    const timer = setTimeout(() => {
      this.resolve(
        ask.askId,
        getTimeoutAction() === "demo_approve" ? "approved" : "rejected",
        "timeout",
        "timeout",
      );
    }, getAskTimeoutMs());
    this.timeouts.set(ask.askId, timer);

    // 通知 SSE 订阅者
    this.emit("ask:new", ask);
    return ask;
  }

  /** 等待 ask 被解决，返回最终决策（approved → 放行, rejected/timeout → 阻断） */
  async wait(askId: string): Promise<AskDecision> {
    const ask = this.pending.get(askId);
    if (!ask) return "rejected";
    // 已解决：返回 finalDecision（非 pending 时 finalDecision 一定已设置）
    if (ask.status !== "pending") return ask.finalDecision ?? "rejected";

    return new Promise((resolve) => {
      const onResolve = (resolved: PendingAsk) => {
        if (resolved.askId === askId) {
          this.off("ask:resolved", onResolve);
          resolve(resolved.finalDecision ?? "rejected");
        }
      };
      this.on("ask:resolved", onResolve);
    });
  }

  /** Approve / Reject / Timeout */
  resolve(
    askId: string,
    decision: AskDecision,
    resolvedBy: string = "api",
    /** 真实状态覆写——超时时传 "timeout" 落地 */
    overrideStatus?: "timeout",
  ): PendingAsk | undefined {
    const ask = this.pending.get(askId);
    if (!ask || ask.status !== "pending") return undefined;

    // 清除超时
    const timer = this.timeouts.get(askId);
    if (timer) { clearTimeout(timer); this.timeouts.delete(askId); }

    // status = 如何结束的; finalDecision = 是否放行
    ask.status = overrideStatus ?? (decision === "approved" ? "approved" : "rejected");
    ask.finalDecision = decision === "approved" ? "approved" : "rejected";
    ask.resolvedAt = nowIso();
    ask.resolvedBy = resolvedBy;

    this.emit("ask:resolved", ask);
    return ask;
  }

  /** 查询单个 ask 状态 */
  get(askId: string): PendingAsk | undefined {
    return this.pending.get(askId);
  }

  /** 查询某 session 的所有 ask */
  listBySession(runtimeSessionId: string): PendingAsk[] {
    return [...this.pending.values()].filter(
      (a) => a.runtimeSessionId === runtimeSessionId,
    );
  }

  /** 列出 pending 状态的 ask */
  listPending(): PendingAsk[] {
    return [...this.pending.values()].filter((a) => a.status === "pending");
  }
}

/** 全局单例 */
export const askChannel = new AskChannel();

/** 默认超时策略（供外部查询） */
export function getAskTimeoutConfig() {
  return {
    timeoutMs: getAskTimeoutMs(),
    defaultAction: getTimeoutAction(),
  };
}
