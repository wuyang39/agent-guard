import type { AgentAdapterKind, CLineRunGroup } from "../api/types";

const phaseLabels: Record<CLineRunGroup["phase"], string> = {
  queued: "等待执行",
  detecting: "检测中",
  policy_ready: "策略包已生成",
  supervising: "实时监督中",
  supervision_completed: "监督已完成",
  defense_report_ready: "防御报告已生成",
  failed: "运行失败",
};

const phaseDescriptions: Record<CLineRunGroup["phase"], string> = {
  queued: "任务已创建，等待后端开始检测。",
  detecting: "正在采集调用轨迹并生成检测报告。",
  policy_ready: "检测完成，监督策略包已生成，等待进入实时监督。",
  supervising: "实时监督会话正在接收工具调用事件。",
  supervision_completed: "监督记录已生成，可以生成防御报告。",
  defense_report_ready: "监督记录已沉淀为防御报告。",
  failed: "运行失败，请查看运行记录和服务状态。",
};

const phaseTones: Record<CLineRunGroup["phase"], string> = {
  queued: "tone-neutral",
  detecting: "tone-medium",
  policy_ready: "tone-medium",
  supervising: "tone-high",
  supervision_completed: "tone-low",
  defense_report_ready: "tone-low",
  failed: "tone-critical",
};

const adapterLabels: Record<AgentAdapterKind, string> = {
  openclaw: "OpenClaw",
  http_sample: "HTTP Sample",
  mock: "示例适配器",
};

const policySourceLabels: Record<NonNullable<CLineRunGroup["policyContextSource"]>, string> = {
  stored_detection: "真实检测策略",
  synthetic_fallback: "合成兜底策略",
};

export function runPhaseLabel(phase: CLineRunGroup["phase"]): string {
  return phaseLabels[phase];
}

export function runPhaseDescription(phase: CLineRunGroup["phase"]): string {
  return phaseDescriptions[phase];
}

export function runPhaseTone(phase: CLineRunGroup["phase"]): string {
  return phaseTones[phase];
}

export function adapterKindLabel(adapterKind: AgentAdapterKind | undefined): string {
  return adapterKind ? adapterLabels[adapterKind] : "-";
}

export function policySourceLabel(
  source: CLineRunGroup["policyContextSource"] | undefined,
): string {
  return source ? policySourceLabels[source] : "-";
}
