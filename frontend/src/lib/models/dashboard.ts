import type { CLineDashboardSummary } from "../api/types";

export type SummaryCard = {
  label: string;
  value: string;
  hint: string;
};

export function buildLatestRunCards(summary: CLineDashboardSummary): SummaryCard[] {
  const metrics = summary.latestRunMetrics;
  if (!metrics) {
    return [
      {
        label: "轨迹",
        value: "0",
        hint: "最新运行尚未产生轨迹",
      },
      {
        label: "风险发现",
        value: "0",
        hint: "最新运行尚未生成检测报告",
      },
      {
        label: "阻断",
        value: "0",
        hint: "等待实时监督记录",
      },
      {
        label: "脱敏",
        value: "0",
        hint: "等待实时监督记录",
      },
      {
        label: "确认",
        value: "0",
        hint: "等待实时监督记录",
      },
      {
        label: "残余风险",
        value: "0",
        hint: "等待防御报告",
      },
    ];
  }

  return [
    {
      label: "轨迹",
      value: String(metrics.traces),
      hint: "最新运行产生的调用轨迹",
    },
    {
      label: "风险发现",
      value: String(metrics.findings),
      hint: "最新检测报告",
    },
    {
      label: "阻断",
      value: String(metrics.blockedActions),
      hint: "最新运行的监督记录",
    },
    {
      label: "脱敏",
      value: String(metrics.redactions),
      hint: "最新运行的监督记录",
    },
    {
      label: "确认",
      value: String(metrics.askDecisions),
      hint: "最新运行的确认动作",
    },
    {
      label: "残余风险",
      value: String(metrics.residualRisks),
      hint: "最新防御报告",
    },
  ];
}

export function buildHistoricalDashboardCards(summary: CLineDashboardSummary): SummaryCard[] {
  return [
    {
      label: "历史运行组",
      value: String(summary.totals.runGroups),
      hint: `最近 ${summary.historicalWindow?.runLimit ?? 100} 条索引累计`,
    },
    {
      label: "历史轨迹",
      value: String(summary.totals.traces),
      hint: "检测与监督轨迹累计",
    },
    {
      label: "历史风险发现",
      value: String(summary.totals.findings),
      hint: "检测报告累计",
    },
    {
      label: "历史阻断",
      value: String(summary.totals.blockedActions),
      hint: "监督记录累计",
    },
    {
      label: "历史脱敏",
      value: String(summary.totals.redactions),
      hint: "监督记录累计",
    },
    {
      label: "历史确认",
      value: String(summary.totals.askDecisions),
      hint: "监督记录累计",
    },
  ];
}
