import { agentGuardApi } from "../../lib/api/client";
import type { DefenseDetailView, LoadState } from "../../lib/api/types";
import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { actionTone, categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import { policySourceLabel } from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";
import { deriveDefenseEvidenceSummary } from "../../lib/models/defense";

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
    return <LoadingBlock message="正在加载防御报告和运行时监督记录..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有防御报告" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="防御报告加载失败" message={state.message} />;
  }

  const { defenseReport, supervisionRecords, artifacts } = state.data;
  const evidenceSummary = deriveDefenseEvidenceSummary(state.data);
  const policyContextSource = evidenceSummary.policyContextSource;
  const effectiveness = defenseReport.defenseEffectiveness;
  const hasResidualRisk = defenseReport.residualRisk.length > 0;

  return (
    <div className="page-stack fill-page defense-page">
      <section className="page-hero defense-hero">
        <div className="hero-copy">
          <p className="eyebrow">防御报告</p>
          <h1>防御报告</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={hasResidualRisk ? "tone-high" : "tone-low"}>
            {hasResidualRisk ? "存在残余风险" : "无残余风险"}
          </Badge>
          {policyContextSource ? (
            <Badge tone={policyContextSource === "synthetic_fallback" ? "tone-high" : "tone-low"}>
              {policySourceLabel(policyContextSource)}
            </Badge>
          ) : null}
          <button className="secondary-button" onClick={onGoDetection}>
            检测与策略
          </button>
          <button className="secondary-button" onClick={onGoTrace}>
            调用轨迹
          </button>
        </div>
        <div className="hero-metric">
          <span>阻断高风险</span>
          <strong>{effectiveness.blockedHighRiskActionCount}</strong>
          <span>runtime sessions: {evidenceSummary.runtimeSessionCount}</span>
        </div>
      </section>

      <section className={`panel evidence-panel${evidenceSummary.canProveDefenseEffect ? "" : " evidence-panel-warning"}`}>
        <div className="section-header compact">
          <div>
            <p className="eyebrow">证据强度</p>
            <h2>监督记录证明力</h2>
          </div>
          <Badge tone={evidenceSummary.canProveDefenseEffect ? "tone-low" : "tone-critical"}>
            {evidenceSummary.canProveDefenseEffect ? "可证明真实防御效果" : "证据不足"}
          </Badge>
        </div>
        {!evidenceSummary.canProveDefenseEffect ? (
          <p className="evidence-warning-text">
            当前报告没有可用于证明真实防御效果的 runtime records；如果策略来源为合成兜底，也不能作为真实 OpenClaw 防御效果证据。
          </p>
        ) : null}
        <div className="evidence-grid">
          <div className="evidence-tile">
            <span>真实监督记录</span>
            <strong>{evidenceSummary.realSupervisionRecordCount}</strong>
          </div>
          <div className="evidence-tile">
            <span>策略来源</span>
            <strong>{policySourceLabel(policyContextSource)}</strong>
          </div>
          <div className="evidence-tile">
            <span>Runtime Session</span>
            <strong>{evidenceSummary.runtimeSessionCount}</strong>
            {evidenceSummary.declaredRuntimeSessionCount !== evidenceSummary.runtimeSessionCount ? (
              <small>报告声明 {evidenceSummary.declaredRuntimeSessionCount} 个</small>
            ) : null}
          </div>
          <div className="evidence-tile">
            <span>Synthetic Fallback</span>
            <strong>{evidenceSummary.usesSyntheticFallback ? "是" : "否"}</strong>
          </div>
        </div>
      </section>

      <section className="report-kpi-grid">
        <div className="stat-card">
          <div className="stat-label">高风险阻断</div>
          <strong>{effectiveness.blockedHighRiskActionCount}</strong>
          <span>防御报告记录的高风险阻断</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">脱敏</div>
          <strong>{effectiveness.redactedActionCount}</strong>
          <span>运行时脱敏动作</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">确认</div>
          <strong>{effectiveness.askDecisionCount}</strong>
          <span>需要确认的动作</span>
        </div>
        <div className="stat-card">
          <div className="stat-label">残余风险</div>
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
                    <Badge tone="tone-critical">阻断</Badge>
                  </article>
                ))
              ) : (
                <p className="muted">没有阻断类型的动作。</p>
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
                <span>防御报告</span>
                <code>{defenseReport.defenseReportId}</code>
              </div>
              <div>
                <span>策略包</span>
                <code>{defenseReport.policyPackId}</code>
              </div>
              <div>
                <span>生成时间</span>
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
