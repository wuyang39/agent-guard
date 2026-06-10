import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { StatCard } from "../../components/ui/StatCard";
import { categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { buildDashboardCards } from "../../lib/models/dashboard";
import type { CLineDashboardSummary, LoadState } from "../../lib/api/types";

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
    return <LoadingBlock message="正在从 C 线正式 API 加载 Dashboard 数据..." />;
  }

  if (state.status === "empty") {
    return (
      <EmptyBlock
        title="还没有正式运行记录"
        message={state.message}
        action={
          <button className="primary-button" disabled={running} onClick={onRun}>
            {running ? "运行中..." : "运行一次 E2E 检测"}
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
              重试运行
            </button>
            <button className="secondary-button" onClick={onUseMock}>
              使用 typed mock
            </button>
          </div>
        }
      />
    );
  }

  const summary = state.data;
  const latest = summary.latestRunGroup;

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Project Console</p>
            <h1>Dashboard</h1>
          </div>
          <div className="button-row">
            <Badge tone={state.source === "api" ? "tone-low" : "tone-medium"}>
              {state.source === "api" ? "Live API" : "Typed mock"}
            </Badge>
            <button className="primary-button" disabled={running} onClick={onRun}>
              {running ? "运行中..." : "运行一次 E2E 检测"}
            </button>
          </div>
        </div>

        <div className="stat-grid">
          {buildDashboardCards(summary).map((card) => (
            <StatCard key={card.label} {...card} />
          ))}
        </div>
      </section>

      <section className="split-grid">
        <div className="panel">
          <div className="section-header compact">
            <h2>最近运行组</h2>
            {latest ? <Badge tone={riskTone(summary.highestRiskLevel)}>{riskLabel(summary.highestRiskLevel)}</Badge> : null}
          </div>
          {latest ? (
            <div className="run-summary">
              <dl>
                <div>
                  <dt>Run Group</dt>
                  <dd>{latest.runGroupId}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{latest.agentId}</dd>
                </div>
                <div>
                  <dt>Cases</dt>
                  <dd>{latest.caseIds.length}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatDateTime(latest.updatedAt)}</dd>
                </div>
              </dl>
              <div className="button-row">
                <button className="secondary-button" onClick={() => onSelectView("detection")}>
                  Detection
                </button>
                <button className="secondary-button" onClick={() => onSelectView("defense")}>
                  Defense
                </button>
                <button className="secondary-button" onClick={() => onSelectView("trace")}>
                  Trace
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">暂无运行组。点击运行按钮后，这里会显示 API 索引返回的最新 runGroup。</p>
          )}
        </div>

        <div className="panel">
          <h2>风险类别分布</h2>
          <div className="category-list">
            {Object.entries(summary.countsByCategory).map(([category, count]) => (
              <div className="category-row" key={category}>
                <span>{categoryLabel(category as keyof typeof summary.countsByCategory)}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
