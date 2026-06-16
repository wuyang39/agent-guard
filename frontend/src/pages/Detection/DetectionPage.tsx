import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { categoryLabel, riskLabel, riskTone, actionLabel, actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import type { DetectionDetailView, LoadState } from "../../lib/api/types";

type DetectionPageProps = {
  state: LoadState<DetectionDetailView>;
  onGoTrace: () => void;
  onGoDefense: () => void;
  onActivateRealtime: () => void;
};

export function DetectionPage({
  state,
  onGoTrace,
  onGoDefense,
  onActivateRealtime,
}: DetectionPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载检测报告、风险画像和策略包..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有检测报告" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="检测报告加载失败" message={state.message} />;
  }

  const { detectionReport, riskProfile, policyPack, sourceRiskReports } = state.data;

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">检测策略</p>
            <h1>检测画像与策略包</h1>
          </div>
          <div className="button-row">
            <Badge tone={riskTone(detectionReport.riskSummary.highestRiskLevel)}>
              {riskLabel(detectionReport.riskSummary.highestRiskLevel)}
            </Badge>
            <button className="secondary-button" onClick={onGoTrace}>
              调用轨迹
            </button>
            <button className="secondary-button" onClick={onGoDefense}>
              防御报告
            </button>
            <button className="primary-button" onClick={onActivateRealtime}>
              启用实时监督
            </button>
          </div>
        </div>

        <div className="id-grid">
          <div>
            <span>检测报告</span>
            <code>{detectionReport.reportId}</code>
          </div>
          <div>
            <span>风险画像</span>
            <code>{riskProfile.profileId}</code>
          </div>
          <div>
            <span>策略包</span>
            <code>{policyPack.policyPackId}</code>
          </div>
          <div>
            <span>生成时间</span>
            <code>{formatDateTime(detectionReport.generatedAt)}</code>
          </div>
        </div>
      </section>

      <section className="split-grid">
        <div className="panel">
          <h2>场景失守摘要</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>场景</th>
                  <th>状态</th>
                  <th>用例</th>
                  <th>风险发现</th>
                </tr>
              </thead>
              <tbody>
                {detectionReport.scenarioSummary.map((scenario) => (
                  <tr key={scenario.scenarioId}>
                    <td>{scenario.scenarioId}</td>
                    <td>
                      <Badge tone={scenario.status === "passed" ? "tone-low" : "tone-high"}>
                        {scenario.status}
                      </Badge>
                    </td>
                    <td>{scenario.caseIds.length}</td>
                    <td>{scenario.triggeredFindingIds.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h2>风险画像</h2>
          <div className="weakness-list">
            {riskProfile.weaknesses.map((weakness) => (
              <article className="list-item" key={weakness.weaknessId}>
                <div>
                  <strong>{weakness.title}</strong>
                  <p>{weakness.description}</p>
                </div>
                <Badge tone="tone-high">{categoryLabel(weakness.category)}</Badge>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-header compact">
          <h2>生成的监督策略</h2>
          <Badge>{policyPack.policies.length} policies</Badge>
        </div>
        <div className="policy-grid">
          {policyPack.policies.map((policy) => (
            <article className="policy-card" key={policy.policyId}>
              <div className="policy-title-row">
                <strong>{policy.name}</strong>
                <Badge tone={actionTone(policy.action)}>{actionLabel(policy.action)}</Badge>
              </div>
              <p>{policy.reason}</p>
              <dl>
                <div>
                  <dt>Target</dt>
                  <dd>{policy.targetType}</dd>
                </div>
                <div>
                  <dt>Risk</dt>
                  <dd>{riskLabel(policy.riskLevel)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>源风险报告</h2>
        <div className="report-list">
          {sourceRiskReports.map((report) => (
            <div className="report-row" key={report.reportId}>
              <code>{report.reportId}</code>
              <span>{report.caseReport.caseName}</span>
              <Badge tone={riskTone(report.riskLevel)}>{riskLabel(report.riskLevel)}</Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
