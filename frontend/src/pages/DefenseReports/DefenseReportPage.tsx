import { agentGuardApi } from "../../lib/api/client";
import type { DefenseDetailView, LoadState } from "../../lib/api/types";
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
import { actionTone, categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { deriveDefenseEvidenceSummary } from "../../lib/models/defense";

type DefenseReportPageProps = {
  state: LoadState<DefenseDetailView>;
};

export function DefenseReportPage({
  state,
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
        </div>
        <div className="hero-metric">
          <span>阻断高风险</span>
          <strong>{effectiveness.blockedHighRiskActionCount}</strong>
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
            当前报告缺少实时监督记录，不能证明真实防御效果。
          </p>
        ) : null}
        <div className="evidence-grid compact-evidence-grid">
          <div className="evidence-tile">
            <span>监督记录</span>
            <strong>{evidenceSummary.realSupervisionRecordCount}</strong>
          </div>
          <div className="evidence-tile">
            <span>会话</span>
            <strong>{evidenceSummary.runtimeSessionCount}</strong>
          </div>
        </div>
      </section>

      <DeveloperDetails
        items={[
          { label: "防御报告", value: defenseReport.defenseReportId },
          { label: "智能体", value: defenseReport.agentId },
          { label: "检测报告", value: defenseReport.detectionReportId },
          { label: "风险画像", value: defenseReport.riskProfileId },
          { label: "策略包", value: defenseReport.policyPackId },
          { label: "策略来源", value: state.data.policyContextSource },
          { label: "会话数", value: defenseReport.runtimeSessionIds.length },
          { label: "监督记录", value: supervisionRecords.length },
          { label: "质量等级", value: state.data.quality?.level },
          { label: "质量分", value: state.data.quality?.score },
          { label: "生成时间", value: formatDateTime(defenseReport.generatedAt) },
        ]}
        title="报告索引"
      />
      <DefenseDeveloperDiagnostics detail={state.data} />

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
              <Badge>{defenseReport.blockedActions.length} 条</Badge>
            </div>
            <div className="timeline-list">
              {defenseReport.blockedActions.length ? (
                defenseReport.blockedActions.map((action) => (
                  <article className="list-item" key={action.blockedActionId}>
                    <div>
                      <strong>{action.targetType}</strong>
                      <p>{action.reason}</p>
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
              <Badge>{supervisionRecords.length} 条</Badge>
            </div>
            <div className="timeline-list">
              {supervisionRecords.map((record) => (
                <article className="list-item" key={record.recordId}>
                  <div>
                    <strong>{record.targetType}</strong>
                    <p>{record.decisionReason}</p>
                  </div>
                  <Badge tone={actionTone(record.action)}>{record.action}</Badge>
                </article>
              ))}
            </div>
          </div>
        </div>

        <aside className="surface-rail">
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
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">当前报告没有残余风险。</p>
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

function DefenseDeveloperDiagnostics({ detail }: { detail: DefenseDetailView }) {
  const {
    defenseReport,
    detectionReport,
    riskProfile,
    policyPack,
    policyContextSource,
    evidenceSummary,
    runtimeSessionSummaries,
    supervisionRecords,
    artifacts,
    reportBundle,
    evidenceBundle,
    traceabilityGraph,
    quality,
    testContextViews,
  } = detail;

  return (
    <DeveloperDiagnostics
      count={
        supervisionRecords.length +
        artifacts.length +
        (traceabilityGraph?.nodes.length ?? 0) +
        (traceabilityGraph?.edges.length ?? 0)
      }
      title="防御报告开发者诊断"
    >
      <DiagnosticSection title="报告上下文">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Defense report", value: defenseReport.defenseReportId },
            { label: "Detection report", value: detectionReport.reportId },
            { label: "Risk profile", value: riskProfile.profileId },
            { label: "Policy pack", value: policyPack.policyPackId },
            { label: "Policy context", value: policyContextSource },
            { label: "Report bundle", value: reportBundle?.bundleId },
            { label: "Evidence bundle", value: evidenceBundle?.evidenceBundleId },
            { label: "Traceability graph", value: traceabilityGraph?.graphId },
            { label: "Quality level", value: quality?.level },
            { label: "Quality score", value: quality?.score },
            { label: "Can prove defense", value: evidenceSummary?.canProveDefenseEffect },
            { label: "Synthetic fallback", value: evidenceSummary?.usesSyntheticFallback },
          ]}
        />
        <DiagnosticJson value={evidenceSummary} emptyLabel="暂无证据强度摘要" />
      </DiagnosticSection>

      <DiagnosticSection title="运行时会话" count={runtimeSessionSummaries?.length ?? 0}>
        <DiagnosticTable
          columns={[
            { header: "Runtime session", render: (session) => <code>{session.runtimeSessionId}</code> },
            { header: "Policy context", render: (session) => session.policyContextSource ?? "-" },
            { header: "Records", render: (session) => session.recordCount },
            { header: "Blocked", render: (session) => session.blockedCount },
            { header: "Redacted", render: (session) => session.redactedCount },
            { header: "Ask", render: (session) => session.askCount },
          ]}
          emptyLabel="暂无运行时会话汇总"
          rowKey={(session) => session.runtimeSessionId}
          rows={runtimeSessionSummaries ?? []}
        />
      </DiagnosticSection>

      <DiagnosticSection title="RuntimeSupervisionRecord" count={supervisionRecords.length}>
        <DiagnosticTable
          columns={[
            { header: "Record", render: (record) => <code>{record.recordId}</code> },
            { header: "Session", render: (record) => <code>{record.runtimeSessionId}</code> },
            { header: "Policy", render: (record) => <code>{record.policyId}</code> },
            { header: "Action", render: (record) => record.action },
            { header: "Target", render: (record) => `${record.targetType}${record.targetId ? ` / ${record.targetId}` : ""}` },
            { header: "Input", render: (record) => record.inputEventId ? <code>{record.inputEventId}</code> : "-" },
            { header: "Output", render: (record) => record.outputEventId ? <code>{record.outputEventId}</code> : "-" },
            { header: "Reason", render: (record) => record.decisionReason },
          ]}
          rowKey={(record) => record.recordId}
          rows={supervisionRecords}
        />
        <DiagnosticJson value={supervisionRecords.map((record) => ({
          recordId: record.recordId,
          gateway: record.gateway,
        }))} />
      </DiagnosticSection>

      <DiagnosticSection title="质量与缺口" count={quality?.checks.length ?? 0}>
        <DiagnosticTable
          columns={[
            { header: "Check", render: (check) => <code>{check.checkId}</code> },
            { header: "Title", render: (check) => check.title },
            { header: "Status", render: (check) => check.status },
            { header: "Detail", render: (check) => check.detail },
          ]}
          emptyLabel="暂无质量检查"
          rowKey={(check) => check.checkId}
          rows={quality?.checks ?? []}
        />
        <DiagnosticJson value={quality?.blockingIssues} emptyLabel="暂无 blocking issue" />
      </DiagnosticSection>

      <DiagnosticSection title="TraceabilityGraph" count={(traceabilityGraph?.nodes.length ?? 0) + (traceabilityGraph?.edges.length ?? 0)}>
        <DiagnosticTable
          columns={[
            { header: "Node", render: (node) => <code>{node.nodeId}</code> },
            { header: "Kind", render: (node) => node.kind },
            { header: "Label", render: (node) => node.label },
          ]}
          emptyLabel="暂无图谱节点"
          maxRows={28}
          rowKey={(node) => node.nodeId}
          rows={traceabilityGraph?.nodes ?? []}
        />
        <DiagnosticTable
          columns={[
            { header: "From", render: (edge) => <code>{edge.from}</code> },
            { header: "Relation", render: (edge) => edge.relation },
            { header: "To", render: (edge) => <code>{edge.to}</code> },
          ]}
          emptyLabel="暂无图谱边"
          maxRows={28}
          rowKey={(edge) => edge.edgeId}
          rows={traceabilityGraph?.edges ?? []}
        />
      </DiagnosticSection>

      <DiagnosticSection title="TestContextView" count={testContextViews?.length ?? 0}>
        <DiagnosticTable
          columns={[
            { header: "Case", render: (view) => <code>{view.caseId}</code> },
            { header: "Name", render: (view) => view.caseName },
            { header: "Source", render: (view) => view.source },
            { header: "Tools", render: (view) => <CodeList values={view.tools.map((tool) => tool.toolId)} /> },
            { header: "Resources", render: (view) => <CodeList values={view.resources.map((resource) => resource.resourceId)} /> },
            { header: "Warnings", render: (view) => view.warnings.join("; ") || "-" },
          ]}
          emptyLabel="暂无 TestContextView"
          rowKey={(view) => view.contextViewId}
          rows={testContextViews ?? []}
        />
      </DiagnosticSection>

      <DiagnosticSection title="导出 Artifact" count={artifacts.length}>
        <DiagnosticTable
          columns={[
            { header: "Artifact", render: (artifact) => <code>{artifact.artifactId}</code> },
            { header: "Report", render: (artifact) => <code>{artifact.reportId}</code> },
            { header: "Format", render: (artifact) => artifact.format },
            { header: "Label", render: (artifact) => artifact.label },
            { header: "Generated", render: (artifact) => formatDateTime(artifact.generatedAt) },
            { header: "URL", render: (artifact) => <code>{artifact.url}</code> },
          ]}
          emptyLabel="暂无导出 artifact"
          rowKey={(artifact) => artifact.artifactId}
          rows={artifacts}
        />
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
