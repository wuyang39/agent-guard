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
            {running ? "运行中..." : "生成检测策略包"}
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
  const cards = buildDashboardCards(summary);

  return (
    <div className="page-stack fill-page dashboard-page">
      <section className="page-hero dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">Project Console</p>
          <h1>总览</h1>
          <p className="hero-lead">
            按 OpenClaw 主路线推进：内置场景检测、生成策略包、进入实时监督，再沉淀防御报告。
          </p>
        </div>
        <div className="hero-actions">
          <Badge tone={state.source === "api" ? "tone-low" : "tone-medium"}>
            {state.source === "api" ? "Live API" : "Typed mock"}
          </Badge>
          <button className="primary-button hero-button" disabled={running} onClick={onRun}>
            {running ? "运行中..." : "生成检测策略包"}
          </button>
        </div>
        <div className="hero-metric">
          <span>最高风险</span>
          <strong>{riskLabel(summary.highestRiskLevel)}</strong>
          <Badge tone={riskTone(summary.highestRiskLevel)}>
            {latest?.phase ?? latest?.status ?? "no run"}
          </Badge>
        </div>
      </section>

      <section className="workspace-grid dashboard-workspace">
        <div className="workspace-main">
          <div className="metric-grid">
            {cards.map((card) => (
              <StatCard key={card.label} {...card} />
            ))}
          </div>

          <div className="panel grow-panel">
            <div className="section-header compact">
              <h2>最近运行组</h2>
              {latest ? (
                <Badge tone={riskTone(summary.highestRiskLevel)}>
                  {riskLabel(summary.highestRiskLevel)}
                </Badge>
              ) : null}
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
                    <dd>{latest.agentName ?? latest.agentId}</dd>
                  </div>
                  <div>
                    <dt>Phase</dt>
                    <dd>{latest.phase}</dd>
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
              <p className="muted">
                暂无运行组。点击运行按钮后，这里会显示 API 索引返回的最新 runGroup。
              </p>
            )}
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <p className="eyebrow">Demo Flow</p>
            <h2>演示流程</h2>
            <div className="workflow-list">
              <div className="workflow-step is-done">
                <span>1</span>
                <div>
                  <strong>智能体接入</strong>
                  <p>{latest?.agentName ?? latest?.agentId ?? "等待配置检测对象"}</p>
                </div>
              </div>
              <div className={`workflow-step ${latest ? "is-done" : ""}`}>
                <span>2</span>
                <div>
                  <strong>E2E 检测</strong>
                  <p>{latest ? `${latest.caseIds.length} 个用例已进入检测` : "等待首次运行"}</p>
                </div>
              </div>
              <div className={`workflow-step ${latest?.policyPackId ? "is-done" : ""}`}>
                <span>3</span>
                <div>
                  <strong>生成监督策略</strong>
                  <p>{latest?.policyPackId || "检测完成后生成策略包"}</p>
                </div>
              </div>
              <div className={`workflow-step ${latest?.runtimeSessionIds.length ? "is-done" : ""}`}>
                <span>4</span>
                <div>
                  <strong>实时监督</strong>
                  <p>{latest?.runtimeSessionIds.length ? `${latest.runtimeSessionIds.length} 个监督会话` : "使用策略包监督 OpenClaw 工具调用"}</p>
                </div>
              </div>
              <div className={`workflow-step ${latest?.defenseReportId ? "is-done" : ""}`}>
                <span>5</span>
                <div>
                  <strong>防御报告</strong>
                  <p>{latest?.defenseReportId || "监督记录沉淀后生成报告"}</p>
                </div>
              </div>
            </div>
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
        </aside>
      </section>
    </div>
  );
}
