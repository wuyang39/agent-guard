import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { StatCard } from "../../components/ui/StatCard";
import { categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import {
  adapterKindLabel,
  policySourceLabel,
  runPhaseDescription,
  runPhaseLabel,
  runPhaseTone,
} from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";
import { buildHistoricalDashboardCards, buildLatestRunCards } from "../../lib/models/dashboard";
import type { CLineDashboardSummary, CLineRunGroup, LoadState } from "../../lib/api/types";

type DashboardPageProps = {
  state: LoadState<CLineDashboardSummary>;
  running: boolean;
  onRun: () => void;
  onUseMock: () => void;
  onSelectView: (view: "detection" | "defense" | "trace") => void;
};

export function DashboardPage({
  state,
  running,
  onRun,
  onUseMock,
  onSelectView,
}: DashboardPageProps) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <LoadingBlock
        message={running ? "正在执行检测并生成监督策略包..." : "正在加载总览数据..."}
      />
    );
  }

  if (state.status === "empty") {
    return (
      <EmptyBlock
        title="还没有正式运行记录"
          message={state.message}
          action={
            <button className="primary-button" disabled={running} onClick={onRun}>
              {running ? "正在生成策略包..." : "生成监督策略包"}
            </button>
          }
        />
    );
  }

  if (state.status === "error") {
    return (
      <ErrorBlock
        title="正式 API 暂不可用"
        message={state.message}
        action={
          <div className="button-row">
            <button className="primary-button" disabled={running} onClick={onRun}>
              {running ? "正在生成策略包..." : "重新生成策略包"}
            </button>
            <button className="secondary-button" onClick={onUseMock}>
              使用示例数据
            </button>
          </div>
        }
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
        <div className="hero-actions">
          <Badge tone={state.source === "api" ? "tone-low" : "tone-medium"}>
            {state.source === "api" ? "服务已连接" : "示例数据"}
          </Badge>
          {latest ? (
            <Badge tone={runPhaseTone(latest.phase)}>{runPhaseLabel(latest.phase)}</Badge>
          ) : null}
          <button className="primary-button hero-button" disabled={running} onClick={onRun}>
            {running ? "正在生成策略包..." : "生成监督策略包"}
          </button>
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
          </div>

          <div className="panel dashboard-latest-panel">
            <div className="section-header compact">
              <div>
                <h2>最新运行</h2>
                <p className="muted">主视区只保留最新一次运行的关键结果。</p>
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

          <div className="panel dashboard-action-panel">
            <div className="section-header compact">
              <h2>下一步</h2>
            </div>
            {latest ? (
              <div className="dashboard-action-row">
                <button className="secondary-button" onClick={() => onSelectView("detection")}>
                  检测与策略
                </button>
                <button className="secondary-button" onClick={() => onSelectView("defense")}>
                  防御报告
                </button>
                <button className="secondary-button" onClick={() => onSelectView("trace")}>
                  调用轨迹
                </button>
              </div>
            ) : (
              <p className="muted">
                暂无运行组。点击运行按钮后，这里会显示服务返回的最新运行记录。
              </p>
            )}
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section current-run-card">
            <div className="section-header compact">
              <h2>当前运行</h2>
              <Badge tone={latest ? runPhaseTone(latest.phase) : "tone-neutral"}>
                {latest ? adapterKindLabel(latest.adapterKind) : "无记录"}
              </Badge>
            </div>
            {latest ? (
              <div className="rail-list">
                <div>
                  <span>运行组</span>
                  <code>{latest.runGroupId}</code>
                </div>
                <div>
                  <span>智能体</span>
                  <code>{latest.agentName ?? latest.agentId}</code>
                </div>
                <div>
                  <span>策略来源</span>
                  <code>{policySourceLabel(latest.policyContextSource)}</code>
                </div>
                <div>
                  <span>更新时间</span>
                  <code>{formatDateTime(latest.updatedAt)}</code>
                </div>
              </div>
            ) : (
              <p className="muted">生成监督策略包后，这里会显示最新运行上下文。</p>
            )}
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>历史累计</h2>
              <Badge>{summary.historicalWindow?.runCount ?? summary.totals.runGroups} 条</Badge>
            </div>
            <MetricList cards={historicalCards} />
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>风险类别</h2>
              <Badge>历史累计</Badge>
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
            <span>{card.hint}</span>
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
