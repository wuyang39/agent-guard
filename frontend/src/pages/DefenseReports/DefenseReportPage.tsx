import { agentGuardApi } from "../../lib/api/client";
import type { DefenseDetailView, LoadState } from "../../lib/api/types";
import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { actionTone, categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";

type DefenseReportPageProps = {
  state: LoadState<DefenseDetailView>;
  onGoDetection: () => void;
  onGoTrace: () => void;
};

export function DefenseReportPage({
  state,
  onGoDetection,
  onGoTrace,
}: DefenseReportPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载 DefenseReport 和运行时监督记录..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有防御报告" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="防御报告加载失败" message={state.message} />;
  }

  const { defenseReport, supervisionRecords, artifacts } = state.data;
  const effectiveness = defenseReport.defenseEffectiveness;
  const hasResidualRisk = defenseReport.residualRisk.length > 0;

  return (
    <div className="page-stack fill-page defense-page">
      <section className="page-hero defense-hero">
        <div className="hero-copy">
          <p className="eyebrow">Defense Report</p>
          <h1>防御报告</h1>
          <p className="hero-lead">
            汇总监督策略的执行效果，给答辩或复盘提供可以追溯的防御证据。
          </p>
        </div>
        <div className="hero-actions">
          <Badge tone={hasResidualRisk ? "tone-high" : "tone-low"}>
            {hasResidualRisk ? "Residual risk" : "No residual risk"}
          </Badge>
          <button className="secondary-button" onClick={onGoDetection}>
            Detection
          </button>
          <button className="secondary-button" onClick={onGoTrace}>
            Trace
          </button>
        </div>
        <div className="hero-metric">
          <span>阻断高风险</span>
          <strong>{effectiveness.blockedHighRiskActionCount}</strong>
          <span>runtime sessions: {defenseReport.runtimeSessionIds.length}</span>
        </div>
      </section>

      <section className="report-kpi-grid">
        <div className="stat-card">
          <div className="stat-label">Blocked high risk</div>
          <strong>{effectiveness.blockedHighRiskActionCount}</strong>
          <span>来自 DefenseReport.defenseEffectiveness</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">Redacted</div>
          <strong>{effectiveness.redactedActionCount}</strong>
          <span>运行时脱敏动作</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">Ask</div>
          <strong>{effectiveness.askDecisionCount}</strong>
          <span>需要确认的动作</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">Residual risks</div>
          <strong>{defenseReport.residualRisk.length}</strong>
          <span>尚未被运行时记录覆盖</span>
        </div>
      </section>

      <section className="workspace-grid defense-workspace">
        <div className="workspace-main">
          <div className="panel grow-panel">
            <div className="section-header compact">
              <h2>阻断动作</h2>
              <Badge>{defenseReport.blockedActions.length} actions</Badge>
            </div>
            <div className="timeline-list">
              {defenseReport.blockedActions.length ? (
                defenseReport.blockedActions.map((action) => (
                  <article className="list-item" key={action.blockedActionId}>
                    <div>
                      <strong>{action.targetType}</strong>
                      <p>{action.reason}</p>
                      <code>{action.targetId ?? action.policyId}</code>
                    </div>
                    <Badge tone="tone-critical">deny</Badge>
                  </article>
                ))
              ) : (
                <p className="muted">没有 deny 类型的阻断动作。</p>
              )}
            </div>
          </div>

          <div className="panel grow-panel">
            <div className="section-header compact">
              <h2>监督记录</h2>
              <Badge>{supervisionRecords.length} records</Badge>
            </div>
            <div className="timeline-list">
              {supervisionRecords.map((record) => (
                <article className="list-item" key={record.recordId}>
                  <div>
                    <strong>{record.targetType}</strong>
                    <p>{record.decisionReason}</p>
                    <code>{record.runtimeSessionId}</code>
                  </div>
                  <Badge tone={actionTone(record.action)}>{record.action}</Badge>
                </article>
              ))}
            </div>
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <p className="eyebrow">Report IDs</p>
            <h2>报告索引</h2>
            <div className="rail-list">
              <div>
                <span>DefenseReport</span>
                <code>{defenseReport.defenseReportId}</code>
              </div>
              <div>
                <span>PolicyPack</span>
                <code>{defenseReport.policyPackId}</code>
              </div>
              <div>
                <span>Generated</span>
                <code>{formatDateTime(defenseReport.generatedAt)}</code>
              </div>
            </div>
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>残余风险</h2>
              <Badge tone={hasResidualRisk ? "tone-high" : "tone-low"}>
                {defenseReport.residualRisk.length}
              </Badge>
            </div>
            {hasResidualRisk ? (
              <div className="report-list compact-list">
                {defenseReport.residualRisk.map((risk) => (
                  <div className="report-row" key={risk.residualRiskId}>
                    <Badge tone={riskTone(risk.riskLevel)}>{riskLabel(risk.riskLevel)}</Badge>
                    <span>{categoryLabel(risk.category)}</span>
                    <code>{risk.relatedWeaknessIds.join(", ")}</code>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">当前 DefenseReport 中没有残余风险。</p>
            )}
          </div>

          <div className="rail-section">
            <h2>导出</h2>
            <div className="button-row rail-actions">
              {artifacts.map((artifact) => (
                <a
                  className="secondary-link"
                  href={artifact.url ?? agentGuardApi.artifactUrl(artifact.artifactId)}
                  key={artifact.artifactId}
                  rel="noreferrer"
                  target="_blank"
                >
                  打开 {artifact.format}
                </a>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}
