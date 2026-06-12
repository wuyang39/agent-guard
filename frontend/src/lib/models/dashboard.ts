import type { CLineDashboardSummary } from "../api/types";

export type SummaryCard = {
  label: string;
  value: string;
  hint: string;
};

export function buildDashboardCards(summary: CLineDashboardSummary): SummaryCard[] {
  return [
    {
      label: "运行组",
      value: String(summary.totals.runGroups),
      hint: "由正式 API 索引返回",
    },
    {
      label: "Trace",
      value: String(summary.totals.traces),
      hint: "检测 + 监督重跑轨迹",
    },
    {
      label: "Findings",
      value: String(summary.totals.findings),
      hint: "来自 RiskReport",
    },
    {
      label: "Blocked",
      value: String(summary.totals.blockedActions),
      hint: "来自 DefenseReport",
    },
    {
      label: "Redacted",
      value: String(summary.totals.redactions),
      hint: "运行时监督脱敏",
    },
    {
      label: "Ask",
      value: String(summary.totals.askDecisions),
      hint: "需要确认的动作",
    },
  ];
}
