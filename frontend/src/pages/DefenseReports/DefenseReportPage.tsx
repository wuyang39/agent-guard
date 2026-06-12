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

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Defense Report</p>
            <h1>防御证明</h1>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={onGoDetection}>
              Detection
            </button>
            <button className="secondary-button" onClick={onGoTrace}>
              Trace
            </button>
          </div>
        </div>
        <div className="id-grid">
          <div>
            <span>DefenseReport</span>
            <code>{defenseReport.defenseReportId}</code>
          </div>
          <div>
            <span>PolicyPack</span>
            <code>{defenseReport.policyPackId}</code>
          </div>
          <div>
            <span>Runtime sessions</span>
            <code>{defenseReport.runtimeSessionIds.length}</code>
          </div>
          <div>
            <span>Generated</span>
            <code>{formatDateTime(defenseReport.generatedAt)}</code>
          </div>
        </div>
      </section>

      <section className="stat-grid">
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

      <section className="split-grid">
        <div className="panel">
          <h2>阻断动作</h2>
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

        <div className="panel">
          <h2>监督记录</h2>
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
      </section>

      <section className="panel">
        <div className="section-header compact">
          <h2>残余风险与导出</h2>
          <div className="button-row">
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
        {defenseReport.residualRisk.length ? (
          <div className="report-list">
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
      </section>
    </div>
  );
}
