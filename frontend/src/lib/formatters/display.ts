import type { RiskLevel } from "../api/demoRuntime";

export const riskLabel: Record<RiskLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const eventTypeLabel: Record<string, string> = {
  test_started: "Test Started",
  task_sent: "Task Sent",
  prompt_load: "Prompt Load",
  resource_access: "Resource Access",
  tool_call: "Tool Call",
  tool_result: "Tool Result",
  agent_message: "Agent Message",
  system_error: "System Error",
};

export function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(start?: string, end?: string) {
  if (!start || !end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function toTitleCase(value?: string) {
  if (!value) return "-";
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
