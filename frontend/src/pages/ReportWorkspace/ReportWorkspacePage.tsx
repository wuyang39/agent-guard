import { useState } from "react";
import type {
  DefenseClaim,
  EvidenceCoverageMatrix,
  EvidenceCoverageRow,
  EvidenceItem,
  ReportBundle,
  ReportQualitySummary,
  TestContextView,
  TestSelectionPlan,
} from "@agent-guard/contracts";
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
import { agentGuardApi } from "../../lib/api/client";
import type {
  LoadState,
  ReportBundleExportFormat,
  ReportBundleExportJob,
  ReportBundleExportLanguage,
  ReportBundleHumanReview,
} from "../../lib/api/types";
import { formatDateTime } from "../../lib/formatters/time";

type ReportWorkspacePageProps = {
  state: LoadState<ReportBundle>;
  selectionPlanState: LoadState<TestSelectionPlan>;
};

type CoverageRowView = EvidenceCoverageRow & {
  area: string;
};

type ClaimDecision = "accepted" | "needs_changes" | "skipped";

export function ReportWorkspacePage({
  state,
  selectionPlanState,
}: ReportWorkspacePageProps) {
  const [claimDecisions, setClaimDecisions] = useState<Record<string, ClaimDecision>>({});
  const [reviewerNote, setReviewerNote] = useState("");

  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载报告工作台..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有报告工作台数据" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="报告工作台加载失败" message={state.message} />;
  }

  const bundle = state.data;
  const coverageRows = coverageRowsFor(bundle.evidenceBundle.coverage);
  const review = buildHumanReview({
    claimDecisions,
    reviewerNote,
  });

  return (
    <div className="page-stack fill-page report-workspace-page">
      <section className="page-hero report-workspace-hero compact-report-hero">
        <div className="hero-copy">
          <h1>报告工作台</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={qualityTone(bundle.quality)}>{qualityLabel(bundle.quality)}</Badge>
          <Badge tone={review.reviewedClaimCount > 0 ? "tone-low" : "tone-high"}>
            复核 {review.reviewedClaimCount}/{bundle.claims.length}
          </Badge>
        </div>
        <div className="hero-metric">
          <span>质量分</span>
          <strong>{bundle.quality.score}</strong>
        </div>
      </section>

      <section className="workspace-grid report-workspace-grid compact-report-grid">
        <div className="workspace-main">
          <SummaryPanel
            bundle={bundle}
            selectionPlanState={selectionPlanState}
          />
          <HumanReviewPanel
            claimDecisions={claimDecisions}
            claims={bundle.claims}
            reviewerNote={reviewerNote}
            setClaimDecision={(claimId, decision) =>
              setClaimDecisions((current) => ({ ...current, [claimId]: decision }))
            }
            setReviewerNote={setReviewerNote}
          />
          <EvidenceMatrixPanel rows={coverageRows} />
          <ReportDeveloperDiagnostics
            bundle={bundle}
            selectionPlanState={selectionPlanState}
          />
        </div>

        <aside className="surface-rail report-workspace-rail">
          <QualityPanel quality={bundle.quality} />
          <EvidenceSnapshotPanel
            bundle={bundle}
            rows={coverageRows}
          />
          <ExportCenter
            bundle={bundle}
            humanReview={review}
          />
        </aside>
      </section>
    </div>
  );
}

function SummaryPanel({
  bundle,
  selectionPlanState,
}: {
  bundle: ReportBundle;
  selectionPlanState: LoadState<TestSelectionPlan>;
}) {
  const selectionPlan = selectionPlanState.status === "ready" ? selectionPlanState.data : undefined;
  return (
    <section className="panel report-summary-panel">
      <div className="section-header compact">
        <div>
          <h2>概览</h2>
        </div>
        <Badge tone={bundle.source.defenseReportId ? "tone-low" : "tone-high"}>
          {bundle.source.defenseReportId ? "防御报告" : "检测报告"}
        </Badge>
      </div>
      <div className="evidence-grid report-summary-grid compact-summary-grid">
        <div className="evidence-tile">
          <span>结论</span>
          <strong>{bundle.claims.length}</strong>
        </div>
        <div className="evidence-tile">
          <span>证据</span>
          <strong>{bundle.evidenceBundle.items.length}</strong>
        </div>
        <div className="evidence-tile">
          <span>缺口</span>
          <strong>{bundle.evidenceBundle.missingEvidence.length}</strong>
        </div>
        <div className="evidence-tile">
          <span>A/B 样本</span>
          <strong>{selectionPlan?.selectedCaseIds.length ?? bundle.testContextViews.length}</strong>
        </div>
      </div>
      <DeveloperDetails
        items={[
          { label: "Bundle", value: bundle.bundleId },
          { label: "Run group", value: bundle.runGroupId },
          { label: "Agent", value: bundle.agentId },
          { label: "Selection", value: selectionPlan?.selectionPlanId },
          { label: "Corpus", value: selectionPlan?.corpusManifestId },
          { label: "Detection", value: bundle.source.detectionReportId },
          { label: "Policy pack", value: bundle.source.policyPackId },
          { label: "Defense", value: bundle.source.defenseReportId },
          { label: "Generated", value: formatDateTime(bundle.generatedAt) },
        ]}
        title="技术信息"
      />
    </section>
  );
}

function HumanReviewPanel({
  claims,
  claimDecisions,
  reviewerNote,
  setClaimDecision,
  setReviewerNote,
}: {
  claims: DefenseClaim[];
  claimDecisions: Record<string, ClaimDecision>;
  reviewerNote: string;
  setClaimDecision: (claimId: string, decision: ClaimDecision) => void;
  setReviewerNote: (note: string) => void;
}) {
  return (
    <section className="panel human-review-panel">
      <div className="section-header compact">
        <div>
          <h2>人工复核</h2>
        </div>
        <Badge>{reviewedCount(claimDecisions)} 已处理</Badge>
      </div>
      <div className="claim-decision-list">
        {claims.slice(0, 8).map((claim) => (
          <article className="claim-decision-row" key={claim.claimId}>
            <div>
              <strong>{claim.title}</strong>
              <span>{claim.claimType}</span>
            </div>
            <select
              aria-label={`${claim.title} 复核意见`}
              value={claimDecisions[claim.claimId] ?? ""}
              onChange={(event) =>
                setClaimDecision(claim.claimId, event.target.value as ClaimDecision)
              }
            >
              <option value="">待复核</option>
              <option value="accepted">通过</option>
              <option value="needs_changes">需修改</option>
              <option value="skipped">暂不纳入</option>
            </select>
          </article>
        ))}
      </div>
      <label className="field review-note-field">
        <span>复核备注</span>
        <textarea
          rows={4}
          value={reviewerNote}
          onChange={(event) => setReviewerNote(event.target.value)}
        />
      </label>
    </section>
  );
}

function EvidenceMatrixPanel({ rows }: { rows: CoverageRowView[] }) {
  const visibleRows = rows.slice(0, 10);
  return (
    <section className="panel compact-evidence-matrix">
      <div className="section-header compact">
        <div>
          <h2>证据矩阵</h2>
        </div>
        <Badge>{rows.length} 行</Badge>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>区域</th>
              <th>结论</th>
              <th>状态</th>
              <th>缺口</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.area}.${row.claimId}`}>
                <td>{areaLabel(row.area)}</td>
                <td><code>{row.claimId}</code></td>
                <td>
                  <Badge tone={coverageTone(row.coverageStatus)}>{coverageLabel(row.coverageStatus)}</Badge>
                </td>
                <td>{row.missingEvidenceKinds.join(", ") || "无"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > visibleRows.length ? (
        <DeveloperDetails
          items={rows.slice(visibleRows.length).map((row) => ({
            label: areaLabel(row.area),
            value: `${row.claimId} / ${coverageLabel(row.coverageStatus)}`,
          }))}
          title="更多矩阵行"
        />
      ) : null}
    </section>
  );
}

function QualityPanel({ quality }: { quality: ReportQualitySummary }) {
  return (
    <section className="rail-section compact-quality-panel">
      <div className="section-header compact">
        <div>
          <h2>质量</h2>
        </div>
        <Badge tone={qualityTone(quality)}>{qualityLabel(quality)}</Badge>
      </div>
      <div className="metric-list">
        {quality.checks.slice(0, 5).map((check) => (
          <div className="metric-list-row" key={check.checkId}>
            <div>
              <strong>{check.title}</strong>
              <span>{check.detail}</span>
            </div>
            <Badge tone={qualityCheckTone(check.status)}>{qualityCheckLabel(check.status)}</Badge>
          </div>
        ))}
      </div>
      {quality.blockingIssues.length ? (
        <div className="missing-evidence-list">
          {quality.blockingIssues.map((issue) => (
            <p className="evidence-warning-text" key={issue}>{issue}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function EvidenceSnapshotPanel({
  bundle,
  rows,
}: {
  bundle: ReportBundle;
  rows: CoverageRowView[];
}) {
  const runtimeRecords = bundle.evidenceBundle.items.filter((item) => item.kind === "runtime_record");
  const incompleteRows = rows.filter((row) => row.coverageStatus !== "complete");
  return (
    <section className="rail-section evidence-snapshot-panel">
      <div className="section-header compact">
        <div>
          <h2>证据</h2>
        </div>
        <Badge>{bundle.evidenceBundle.items.length}</Badge>
      </div>
      <div className="id-grid compact-proof-grid">
        <div>
          <span>运行时记录</span>
          <code>{runtimeRecords.length}</code>
        </div>
        <div>
          <span>图谱节点</span>
          <code>{bundle.traceabilityGraph.nodes.length}</code>
        </div>
        <div>
          <span>未完整覆盖</span>
          <code>{incompleteRows.length}</code>
        </div>
      </div>
      <DeveloperDetails
        items={bundle.evidenceBundle.missingEvidence.map((item) => ({
          label: item.severity,
          value: `${item.requiredKind}: ${item.reason}`,
        }))}
        title="缺失证据"
      />
    </section>
  );
}

function ExportCenter({
  bundle,
  humanReview,
}: {
  bundle: ReportBundle;
  humanReview: ReportBundleHumanReview;
}) {
  const [exportingFormat, setExportingFormat] = useState<ReportBundleExportFormat | undefined>();
  const [language, setLanguage] = useState<ReportBundleExportLanguage>("zh");
  const [job, setJob] = useState<ReportBundleExportJob | undefined>();
  const [error, setError] = useState<string | undefined>();
  const defenseReportId = bundle.source.defenseReportId;
  const formats: ReportBundleExportFormat[] = ["markdown", "html", "pdf"];
  const languages: ReportBundleExportLanguage[] = ["zh", "en"];
  const canExport = Boolean(defenseReportId) && humanReview.reviewedClaimCount > 0 && Boolean(humanReview.reviewerNote?.trim());

  async function exportBundle(format: ReportBundleExportFormat) {
    if (!defenseReportId || !canExport) return;
    setExportingFormat(format);
    setError(undefined);
    try {
      const nextJob = await agentGuardApi.exportDefenseReportBundle(
        defenseReportId,
        format,
        humanReview,
        language,
      );
      setJob(nextJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingFormat(undefined);
    }
  }

  return (
    <section className="rail-section">
      <div className="section-header compact">
        <div>
          <h2>导出</h2>
        </div>
        <Badge tone={canExport ? "tone-low" : "tone-high"}>
          {canExport ? "可导出" : "待复核"}
        </Badge>
      </div>
      <div className="report-export-options">
        <span>语言</span>
        <div className="segmented-control report-language-control" role="group" aria-label="报告语言">
          {languages.map((option) => (
            <button
              className={language === option ? "active" : ""}
              key={option}
              onClick={() => {
                setLanguage(option);
                setJob(undefined);
              }}
              type="button"
            >
              {reportLanguageLabel(option)}
            </button>
          ))}
        </div>
      </div>
      <div className="button-row rail-actions">
        {formats.map((format) => (
          <button
            className="secondary-button"
            disabled={!canExport || Boolean(exportingFormat)}
            key={format}
            onClick={() => void exportBundle(format)}
          >
            {exportingFormat === format ? "导出中..." : exportFormatLabel(format)}
          </button>
        ))}
      </div>
      <DeveloperDetails
        items={[
          { label: "Bundle", value: bundle.bundleId },
          { label: "Defense", value: defenseReportId },
          { label: "Language", value: reportLanguageLabel(language) },
          { label: "Human reviewed", value: humanReview.reviewedClaimCount },
          { label: "Export job", value: job?.exportJobId },
          { label: "Artifact", value: job?.artifact.artifactId },
          { label: "Artifact URL", value: job?.artifact.url },
          { label: "Exported at", value: job ? formatDateTime(job.generatedAt) : undefined },
          { label: "Generated", value: formatDateTime(bundle.generatedAt) },
        ]}
        title="导出信息"
      />
      {job ? (
        <a
          className="secondary-link export-download-link"
          href={agentGuardApi.artifactUrl(job.artifact.artifactId)}
          rel="noreferrer"
          target="_blank"
        >
          打开 {reportLanguageLabel(job.language)} {job.artifact.format}
        </a>
      ) : null}
      {error ? <p className="evidence-warning-text">{error}</p> : null}
    </section>
  );
}

function ReportDeveloperDiagnostics({
  bundle,
  selectionPlanState,
}: {
  bundle: ReportBundle;
  selectionPlanState: LoadState<TestSelectionPlan>;
}) {
  const selectionPlan = selectionPlanState.status === "ready" ? selectionPlanState.data : undefined;
  const coverageRows = coverageRowsFor(bundle.evidenceBundle.coverage);
  const graph = bundle.traceabilityGraph;
  const selectedCases = selectionPlan?.selectedCasesSummary ?? [];
  const selectionIssues = selectionPlan
    ? [
        ...selectionPlan.coverageSnapshot.blockingIssues,
        ...selectionPlan.coverageSnapshot.warnings,
        ...selectionPlan.evalStyleResult.failedChecks,
        ...selectionPlan.evalStyleResult.warnings,
        ...selectionPlan.fallbackReasons,
      ]
    : [];

  return (
    <DeveloperDiagnostics
      count={
        bundle.claims.length +
        bundle.evidenceBundle.items.length +
        graph.nodes.length +
        graph.edges.length
      }
      title="开发者诊断：A/B/C 证据链"
    >
      <DiagnosticSection title="A 线选样与覆盖" count={selectedCases.length}>
        <DiagnosticKeyValueGrid
          items={[
            { label: "Selection plan", value: selectionPlan?.selectionPlanId },
            { label: "Corpus", value: selectionPlan?.corpusManifestId },
            { label: "Profile", value: selectionPlan?.targetProfile },
            { label: "Mode", value: selectionPlan?.mode },
            { label: "Ready", value: selectionPlan?.coverageSnapshot.ready },
            { label: "Requested cases", value: selectionPlan?.requestedCaseCount },
            { label: "Selected cases", value: selectionPlan?.selectedCaseIds.length },
            { label: "Attack families", value: selectionPlan?.coverageSnapshot.coveredAttackFamilies.join(", ") },
            { label: "Target surfaces", value: selectionPlan?.coverageSnapshot.coveredTargetSurfaces.join(", ") },
            { label: "LLM provider", value: selectionPlan?.llmAudit?.provider },
            { label: "LLM model", value: selectionPlan?.llmAudit?.model },
            { label: "LLM fallback", value: selectionPlan?.llmAudit?.fallbackUsed },
          ]}
        />
        <DiagnosticTable
          columns={[
            { header: "Case", render: (row) => <code>{row.caseId}</code> },
            { header: "Name", render: (row) => row.caseName },
            { header: "Families", render: (row) => row.attackFamilies.join(", ") || "-" },
            { header: "Surfaces", render: (row) => row.targetSurfaces.join(", ") || "-" },
            { header: "Quality", render: (row) => row.qualityScore },
            { header: "Reason", render: (row) => row.reason },
          ]}
          emptyLabel="暂无选样明细"
          rowKey={(row) => row.caseId}
          rows={selectedCases}
        />
        <DiagnosticTable
          columns={[
            { header: "Case", render: (row) => <code>{row.caseId}</code> },
            { header: "Source", render: (row) => row.source },
            { header: "Reason", render: (row) => row.reason },
          ]}
          emptyLabel="暂无选样原因"
          maxRows={16}
          rowKey={(row, index) => `${row.caseId}.${row.source}.${index}`}
          rows={selectionPlan?.selectionReasons ?? []}
        />
        <DiagnosticJson value={selectionIssues.length ? selectionIssues : selectionPlan?.llmAudit} />
      </DiagnosticSection>

      <DiagnosticSection title="报告结论与来源" count={bundle.claims.length}>
        <DiagnosticTable
          columns={[
            { header: "Claim", render: (claim) => <code>{claim.claimId}</code> },
            { header: "Type", render: (claim) => claim.claimType },
            { header: "Review", render: (claim) => claim.reviewStatus },
            { header: "Confidence", render: (claim) => claim.confidence },
            { header: "Statement", render: (claim) => claim.statement },
            { header: "Source IDs", render: (claim) => <CodeList values={claimSourceIds(claim)} /> },
          ]}
          rowKey={(claim) => claim.claimId}
          rows={bundle.claims}
        />
      </DiagnosticSection>

      <DiagnosticSection title="TestContextView" count={bundle.testContextViews.length}>
        <DiagnosticTable
          columns={[
            { header: "Case", render: (view) => <code>{view.caseId}</code> },
            { header: "Name", render: (view) => view.caseName },
            { header: "Source", render: (view) => view.source },
            { header: "Tools", render: (view) => <CodeList values={view.tools.map((tool) => tool.toolId)} /> },
            { header: "Resources", render: (view) => <CodeList values={view.resources.map((resource) => resource.resourceId)} /> },
            { header: "Prompts", render: (view) => <CodeList values={view.prompts.map((prompt) => prompt.promptId)} /> },
            { header: "Risk rules", render: (view) => <CodeList values={view.riskRuleIds} /> },
            { header: "Warnings", render: (view) => view.warnings.join("; ") || "-" },
          ]}
          rowKey={(view) => view.contextViewId}
          rows={bundle.testContextViews}
        />
        <DiagnosticJson value={bundle.testContextViews.map(contextDiagnosticView)} />
      </DiagnosticSection>

      <DiagnosticSection title="EvidenceBundle" count={bundle.evidenceBundle.items.length}>
        <DiagnosticKeyValueGrid
          items={[
            { label: "Evidence bundle", value: bundle.evidenceBundle.evidenceBundleId },
            { label: "Report", value: bundle.evidenceBundle.reportId },
            { label: "Coverage rows", value: coverageRows.length },
            { label: "Missing evidence", value: bundle.evidenceBundle.missingEvidence.length },
          ]}
        />
        <DiagnosticTable
          columns={[
            { header: "Kind", render: (item) => item.kind },
            { header: "Object", render: (item) => <code>{item.objectId}</code> },
            { header: "Title", render: (item) => item.title },
            { header: "Claims", render: (item) => <CodeList values={item.relatedClaimIds} /> },
            { header: "Summary", render: (item) => item.summary },
          ]}
          maxRows={18}
          rowKey={(item) => item.evidenceId}
          rows={bundle.evidenceBundle.items}
        />
        <DiagnosticTable
          columns={[
            { header: "Severity", render: (item) => item.severity },
            { header: "Required", render: (item) => item.requiredKind },
            { header: "Claim", render: (item) => item.relatedClaimId ? <code>{item.relatedClaimId}</code> : "-" },
            { header: "Source", render: (item) => item.sourceId ? <code>{item.sourceId}</code> : "-" },
            { header: "Reason", render: (item) => item.reason },
          ]}
          emptyLabel="没有缺失证据"
          rowKey={(item) => item.missingEvidenceId}
          rows={bundle.evidenceBundle.missingEvidence}
        />
      </DiagnosticSection>

      <DiagnosticSection title="TraceabilityGraph" count={graph.nodes.length + graph.edges.length}>
        <DiagnosticKeyValueGrid
          items={[
            { label: "Graph", value: graph.graphId },
            { label: "Nodes", value: graph.nodes.length },
            { label: "Edges", value: graph.edges.length },
          ]}
        />
        <DiagnosticTable
          columns={[
            { header: "Node", render: (node) => <code>{node.nodeId}</code> },
            { header: "Kind", render: (node) => node.kind },
            { header: "Label", render: (node) => node.label },
            { header: "Data", render: (node) => node.data ? <code>{JSON.stringify(node.data)}</code> : "-" },
          ]}
          maxRows={28}
          rowKey={(node) => node.nodeId}
          rows={graph.nodes}
        />
        <DiagnosticTable
          columns={[
            { header: "From", render: (edge) => <code>{edge.from}</code> },
            { header: "Relation", render: (edge) => edge.relation },
            { header: "To", render: (edge) => <code>{edge.to}</code> },
          ]}
          maxRows={28}
          rowKey={(edge) => edge.edgeId}
          rows={graph.edges}
        />
      </DiagnosticSection>

      <DiagnosticSection title="导出 Artifact" count={bundle.exports.length}>
        <DiagnosticTable
          columns={[
            { header: "Artifact", render: (artifact) => <code>{artifact.artifactId}</code> },
            { header: "Report", render: (artifact) => <code>{artifact.reportId}</code> },
            { header: "Format", render: (artifact) => artifact.format },
            { header: "Generated", render: (artifact) => formatDateTime(artifact.generatedAt) },
          ]}
          emptyLabel="当前 bundle 尚无导出 artifact"
          rowKey={(artifact) => artifact.artifactId}
          rows={bundle.exports}
        />
      </DiagnosticSection>
    </DeveloperDiagnostics>
  );
}

function buildHumanReview(input: {
  claimDecisions: Record<string, ClaimDecision>;
  reviewerNote: string;
}): ReportBundleHumanReview {
  return {
    reviewerNote: input.reviewerNote,
    claimDecisions: input.claimDecisions,
    reviewedClaimCount: reviewedCount(input.claimDecisions),
    reviewedAt: new Date().toISOString(),
  };
}

function reviewedCount(claimDecisions: Record<string, ClaimDecision>): number {
  return Object.values(claimDecisions).filter(Boolean).length;
}

function coverageRowsFor(coverage: EvidenceCoverageMatrix): CoverageRowView[] {
  return [
    ...coverage.riskClaims.map((row) => ({ ...row, area: "risk" })),
    ...coverage.detectionClaims.map((row) => ({ ...row, area: "detection" })),
    ...coverage.policyClaims.map((row) => ({ ...row, area: "policy" })),
    ...coverage.runtimeEffectClaims.map((row) => ({ ...row, area: "runtime_effect" })),
    ...coverage.residualRiskClaims.map((row) => ({ ...row, area: "residual_risk" })),
  ];
}

function qualityTone(quality: ReportQualitySummary): string {
  if (quality.level === "submission_ready") return "tone-low";
  if (quality.level === "reviewable") return "tone-medium";
  return "tone-high";
}

function qualityLabel(quality: ReportQualitySummary): string {
  if (quality.level === "submission_ready") return "提交级";
  if (quality.level === "reviewable") return "可复核";
  return "草稿";
}

function qualityCheckTone(status: ReportQualitySummary["checks"][number]["status"]): string {
  if (status === "pass") return "tone-low";
  if (status === "warn") return "tone-high";
  return "tone-critical";
}

function qualityCheckLabel(status: ReportQualitySummary["checks"][number]["status"]): string {
  if (status === "pass") return "通过";
  if (status === "warn") return "警告";
  return "失败";
}

function coverageTone(status: EvidenceCoverageRow["coverageStatus"]): string {
  if (status === "complete") return "tone-low";
  if (status === "partial") return "tone-high";
  return "tone-critical";
}

function coverageLabel(status: EvidenceCoverageRow["coverageStatus"]): string {
  if (status === "complete") return "完整";
  if (status === "partial") return "部分";
  return "缺失";
}

function areaLabel(area: string): string {
  const labels: Record<string, string> = {
    risk: "风险",
    detection: "检测",
    policy: "策略",
    runtime_effect: "运行时",
    residual_risk: "残余风险",
  };
  return labels[area] ?? area;
}

function exportFormatLabel(format: ReportBundleExportFormat): string {
  const labels: Record<ReportBundleExportFormat, string> = {
    markdown: "Markdown",
    html: "HTML",
    pdf: "PDF",
  };
  return labels[format];
}

function reportLanguageLabel(language: ReportBundleExportLanguage): string {
  return language === "zh" ? "中文" : "English";
}

function claimSourceIds(claim: DefenseClaim): string[] {
  return Object.values(claim.sourceIds).flatMap((value) => value ?? []);
}

function contextDiagnosticView(view: TestContextView) {
  return {
    contextViewId: view.contextViewId,
    contextId: view.contextId,
    caseId: view.caseId,
    source: view.source,
    task: view.task,
    tools: view.tools,
    resources: view.resources,
    prompts: view.prompts,
    riskRuleIds: view.riskRuleIds,
    warnings: view.warnings,
  };
}

function CodeList({ values }: { values: string[] }) {
  if (!values.length) return <span>-</span>;
  return (
    <span className="diagnostic-id-list">
      {values.map((value, index) => (
        <code key={`${value}.${index}`}>{value}</code>
      ))}
    </span>
  );
}
