import type { RiskCategory, RiskLevel, SupervisionAction } from "@agent-guard/contracts";

export function riskLabel(riskLevel: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    low: "低",
    medium: "中",
    high: "高",
    critical: "严重",
  };
  return labels[riskLevel];
}

export function riskTone(riskLevel: RiskLevel): string {
  const tones: Record<RiskLevel, string> = {
    low: "tone-low",
    medium: "tone-medium",
    high: "tone-high",
    critical: "tone-critical",
  };
  return tones[riskLevel];
}

export function categoryLabel(category: RiskCategory): string {
  const labels: Record<RiskCategory, string> = {
    tool_misuse: "工具误用",
    unauthorized_access: "未授权访问",
    data_leakage: "数据泄露",
    dangerous_action: "危险动作",
    instruction_injection_following: "指令注入跟随",
  };
  return labels[category];
}

export function actionLabel(action: SupervisionAction): string {
  const labels: Record<SupervisionAction, string> = {
    allow: "放行",
    deny: "阻断",
    ask: "确认",
    warn: "告警",
    redact: "脱敏",
    isolate: "隔离",
  };
  return labels[action];
}

export function actionTone(action: SupervisionAction): string {
  const tones: Record<SupervisionAction, string> = {
    allow: "tone-low",
    deny: "tone-critical",
    ask: "tone-high",
    warn: "tone-medium",
    redact: "tone-high",
    isolate: "tone-critical",
  };
  return tones[action];
}
