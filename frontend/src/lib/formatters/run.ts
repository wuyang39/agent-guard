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
  queued: "排队中",
  detecting: "采集轨迹",
  policy_ready: "策略包就绪",
  supervising: "接收实时事件",
  supervision_completed: "监督完成",
  defense_report_ready: "防御报告就绪",
  failed: "运行失败",
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
  mock: "Mock",
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
