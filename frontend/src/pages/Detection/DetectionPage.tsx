import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
  DiagnosticTable,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { categoryLabel, riskLabel, riskTone, actionLabel, actionTone } from "../../lib/formatters/risk";
import type { DetectionDetailView, LoadState } from "../../lib/api/types";
import { formatDateTime } from "../../lib/formatters/time";

type DetectionPageProps = {
  state: LoadState<DetectionDetailView>;
  onActivateRealtime: () => void;
};

export function DetectionPage({
  state,
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
            <button className="primary-button" onClick={onActivateRealtime}>
              启用实时监督
            </button>
          </div>
        </div>
      </section>

      <DeveloperDetails
        items={[
          { label: "检测报告", value: detectionReport.reportId },
          { label: "风险画像", value: riskProfile.profileId },
          { label: "策略包", value: policyPack.policyPackId },
          { label: "源风险报告", value: sourceRiskReports.length },
          { label: "策略模板", value: detectionReport.recommendedPolicyTemplateIds.length },
          { label: "生成时间", value: formatDateTime(detectionReport.generatedAt) },
        ]}
        title="报告索引"
      />
      <DetectionDeveloperDiagnostics detail={state.data} />

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
                        {scenario.status === "passed" ? "通过" : "失败"}
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
          <Badge>{policyPack.policies.length} 条</Badge>
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
                  <dt>目标</dt>
                  <dd>{policy.targetType}</dd>
                </div>
                <div>
                  <dt>风险</dt>
                  <dd>{riskLabel(policy.riskLevel)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function DetectionDeveloperDiagnostics({ detail }: { detail: DetectionDetailView }) {
  const { detectionReport, riskProfile, policyPack, sourceRiskReports } = detail;
  return (
    <DeveloperDiagnostics
      count={sourceRiskReports.length + riskProfile.weaknesses.length + policyPack.policies.length}
      title="检测策略开发者诊断"
    >
      <DiagnosticSection title="检测报告索引">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Detection report", value: detectionReport.reportId },
            { label: "Agent", value: detectionReport.agentId },
            { label: "Risk profile", value: riskProfile.profileId },
            { label: "Policy pack", value: policyPack.policyPackId },
            { label: "Source risk reports", value: sourceRiskReports.length },
            { label: "Recommended templates", value: detectionReport.recommendedPolicyTemplateIds.length },
            { label: "Evidence chains", value: detectionReport.evidenceChainIds.length },
            { label: "Findings", value: detectionReport.findingIds.length },
            { label: "Generated", value: formatDateTime(detectionReport.generatedAt) },
          ]}
        />
        <DiagnosticTable
          columns={[
            { header: "Scenario", render: (scenario) => <code>{scenario.scenarioId}</code> },
            { header: "Status", render: (scenario) => scenario.status },
            { header: "Cases", render: (scenario) => <CodeList values={scenario.caseIds} /> },
            { header: "Findings", render: (scenario) => <CodeList values={scenario.triggeredFindingIds} /> },
          ]}
          rowKey={(scenario) => scenario.scenarioId}
          rows={detectionReport.scenarioSummary}
        />
      </DiagnosticSection>

      <DiagnosticSection title="源风险报告" count={sourceRiskReports.length}>
        <DiagnosticTable
          columns={[
            { header: "Risk report", render: (report) => <code>{report.reportId}</code> },
            { header: "Case", render: (report) => report.caseReport.caseName },
            { header: "Trace", render: (report) => <code>{report.traceId}</code> },
            { header: "Level", render: (report) => report.riskLevel },
            { header: "Findings", render: (report) => <CodeList values={report.findings.map((finding) => finding.findingId)} /> },
            { header: "Evidence chains", render: (report) => <CodeList values={report.evidenceChains.map((chain) => chain.chainId)} /> },
          ]}
          emptyLabel="暂无源风险报告"
          rowKey={(report) => report.reportId}
          rows={sourceRiskReports}
        />
      </DiagnosticSection>

      <DiagnosticSection title="风险画像弱点" count={riskProfile.weaknesses.length}>
        <DiagnosticTable
          columns={[
            { header: "Weakness", render: (weakness) => <code>{weakness.weaknessId}</code> },
            { header: "Title", render: (weakness) => weakness.title },
            { header: "Category", render: (weakness) => weakness.category },
            { header: "Findings", render: (weakness) => <CodeList values={weakness.sourceFindingIds} /> },
            { header: "Templates", render: (weakness) => <CodeList values={weakness.recommendedPolicyTemplateIds} /> },
          ]}
          rowKey={(weakness) => weakness.weaknessId}
          rows={riskProfile.weaknesses}
        />
      </DiagnosticSection>

      <DiagnosticSection title="SupervisionPolicyPack" count={policyPack.policies.length}>
        <DiagnosticKeyValueGrid
          items={[
            { label: "Policy pack", value: policyPack.policyPackId },
            { label: "Source detection", value: policyPack.sourceDetectionReportId },
            { label: "Source risk profile", value: policyPack.sourceRiskProfileId },
            { label: "Default action", value: policyPack.defaultAction },
            { label: "Created", value: formatDateTime(policyPack.createdAt) },
            { label: "Expires", value: policyPack.expiresAt ? formatDateTime(policyPack.expiresAt) : undefined },
          ]}
        />
        <DiagnosticTable
          columns={[
            { header: "Policy", render: (policy) => <code>{policy.policyId}</code> },
            { header: "Template", render: (policy) => policy.sourcePolicyTemplateId ? <code>{policy.sourcePolicyTemplateId}</code> : "-" },
            { header: "Weaknesses", render: (policy) => <CodeList values={policy.sourceWeaknessIds} /> },
            { header: "Target", render: (policy) => policy.targetType },
            { header: "Action", render: (policy) => policy.action },
            { header: "Risk", render: (policy) => policy.riskLevel },
            { header: "Reason", render: (policy) => policy.reason },
          ]}
          rowKey={(policy) => policy.policyId}
          rows={policyPack.policies}
        />
        <DiagnosticJson value={policyPack.policies.map((policy) => ({
          policyId: policy.policyId,
          match: policy.match,
        }))} />
      </DiagnosticSection>
    </DeveloperDiagnostics>
  );
}

function CodeList({ values }: { values: string[] }) {
  if (!values.length) return <span className="muted">-</span>;
  return (
    <span className="diagnostic-id-list">
      {values.map((value, index) => (
        <code key={`${value}.${index}`}>{value}</code>
      ))}
    </span>
  );
}
