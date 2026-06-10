import type { RiskCategory, RiskLevel, SupervisionAction } from "@agent-guard/contracts";

export function riskLabel(riskLevel: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    critical: "Critical",
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
    tool_misuse: "Tool misuse",
    unauthorized_access: "Unauthorized access",
    data_leakage: "Data leakage",
    dangerous_action: "Dangerous action",
    instruction_injection_following: "Instruction injection",
  };
  return labels[category];
}

export function actionLabel(action: SupervisionAction): string {
  const labels: Record<SupervisionAction, string> = {
    allow: "Allow",
    deny: "Deny",
    ask: "Ask",
    warn: "Warn",
    redact: "Redact",
    isolate: "Isolate",
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
