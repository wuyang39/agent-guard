import { Badge } from "../../components/ui/Badge";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { RunProgress } from "../../components/ui/RunProgress";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { StatCard } from "../../components/ui/StatCard";
import { categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import {
  runPhaseDescription,
  runPhaseLabel,
  runPhaseTone,
} from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";
import { buildHistoricalDashboardCards, buildLatestRunCards } from "../../lib/models/dashboard";
import type { CLineDashboardSummary, CLineRunGroup, LoadState } from "../../lib/api/types";

type DashboardPageProps = {
  state: LoadState<CLineDashboardSummary>;
};

export function DashboardPage({
  state,
}: DashboardPageProps) {
  if (state.status === "loading" || state.status === "idle") {
    return <LoadingBlock message="正在加载总览数据..." />;
  }

  if (state.status === "empty") {
    return (
      <div className="page-stack fill-page dashboard-page">
        <section className="page-hero dashboard-hero">
          <div className="hero-copy">
            <p className="eyebrow">系统总览</p>
            <h1>总览</h1>
          </div>
        </section>
        <EmptyBlock title="还没有正式运行记录" message={state.message} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <ErrorBlock
        title="正式 API 暂不可用"
        message={state.message}
      />
    );
  }

  const summary = state.data;
  const latest = summary.latestRunGroup;
  const latestCards = buildLatestRunCards(summary);
  const historicalCards = buildHistoricalDashboardCards(summary);
  const latestRiskLevel = summary.latestRunMetrics?.highestRiskLevel ?? summary.highestRiskLevel;

  return (
    <div className="page-stack fill-page dashboard-page">
      <section className="page-hero dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">系统总览</p>
          <h1>总览</h1>
        </div>
      </section>

      <section className="workspace-grid dashboard-workspace">
        <div className="workspace-main">
          <div className="panel dashboard-stage-card">
            <div className="section-header compact">
              <div>
                <h2>当前进度</h2>
                <p className="muted">
                  {latest ? runPhaseDescription(latest.phase) : "还没有运行记录。"}
                </p>
              </div>
              <Badge tone={latest ? runPhaseTone(latest.phase) : "tone-neutral"}>
                {latest ? runPhaseLabel(latest.phase) : "等待运行"}
              </Badge>
            </div>
            {latest ? <RunStageRail runGroup={latest} /> : <EmptyStageRail />}
            {latest ? <RunProgress runGroup={latest} /> : null}
          </div>

          <div className="panel dashboard-latest-panel">
            <div className="section-header compact">
              <div>
                <h2>最新运行</h2>
              </div>
              {latest ? (
                <Badge tone={riskTone(latestRiskLevel)}>
                  {riskLabel(latestRiskLevel)}
                </Badge>
              ) : null}
            </div>
            <div className="metric-grid">
              {latestCards.map((card) => (
                <StatCard key={card.label} {...card} />
              ))}
            </div>
          </div>

        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <div className="section-header compact">
              <h2>历史累计</h2>
            </div>
            <MetricList cards={historicalCards} />
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>风险类别</h2>
            </div>
            <div className="category-list compact-list">
              {Object.entries(summary.countsByCategory).map(([category, count]) => (
                <div className="category-row" key={category}>
                  <span>{categoryLabel(category as keyof typeof summary.countsByCategory)}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </div>

          {latest ? (
            <DeveloperDetails
              items={[
                { label: "运行组", value: latest.runGroupId },
                { label: "智能体", value: latest.agentName ?? latest.agentId },
                { label: "适配器", value: latest.adapterKind },
                { label: "策略来源", value: latest.policyContextSource },
                { label: "选择计划", value: latest.selectionPlanId },
                { label: "检测报告", value: latest.detectionReportId },
                { label: "策略包", value: latest.policyPackId },
                { label: "防御报告", value: latest.defenseReportId },
                { label: "Trace 数", value: latest.traceIds.length },
                { label: "Runtime session 数", value: latest.runtimeSessionIds.length },
                { label: "Artifact 数", value: latest.artifactIds.length },
                { label: "更新时间", value: formatDateTime(latest.updatedAt) },
              ]}
              title="开发者上下文"
            />
          ) : null}
        </aside>
      </section>
    </div>
  );
}

function EmptyStageRail() {
  const stages = ["检测", "策略包", "实时监督", "防御报告"];
  return (
    <div className="run-stage-rail">
      {stages.map((stage) => (
        <div className="run-stage pending" key={stage}>
          <span />
          <strong>{stage}</strong>
        </div>
      ))}
    </div>
  );
}

function MetricList({ cards }: { cards: Array<{ label: string; value: string; hint: string }> }) {
  return (
    <div className="metric-list">
      {cards.map((card) => (
        <div className="metric-list-row" key={card.label}>
          <div>
            <strong>{card.label}</strong>
          </div>
          <code>{card.value}</code>
        </div>
      ))}
    </div>
  );
}

function RunStageRail({ runGroup }: { runGroup: CLineRunGroup }) {
  const stages: Array<{
    key: "detecting" | "policy_ready" | "supervision_completed" | "defense_report_ready";
    label: string;
  }> = [
    { key: "detecting", label: "检测" },
    { key: "policy_ready", label: "策略包" },
    { key: "supervision_completed", label: "实时监督" },
    { key: "defense_report_ready", label: "防御报告" },
  ];

  return (
    <div className="run-stage-rail">
      {stages.map((stage) => (
        <div className={`run-stage ${stageState(runGroup.phase, stage.key)}`} key={stage.key}>
          <span />
          <strong>{stage.label}</strong>
        </div>
      ))}
    </div>
  );
}

function stageState(
  phase: CLineRunGroup["phase"],
  stage: "detecting" | "policy_ready" | "supervision_completed" | "defense_report_ready",
): "done" | "active" | "pending" | "failed" {
  if (phase === "failed") return "failed";

  const order: Record<CLineRunGroup["phase"], number> = {
    queued: 0,
    detecting: 1,
    policy_ready: 2,
    supervising: 3,
    supervision_completed: 3,
    defense_report_ready: 4,
    failed: 0,
  };
  const stageOrder = {
    detecting: 1,
    policy_ready: 2,
    supervision_completed: 3,
    defense_report_ready: 4,
  }[stage];
  const phaseOrder = order[phase];

  if (phaseOrder > stageOrder) return "done";
  if (phaseOrder === stageOrder) return "active";
  return "pending";
}
