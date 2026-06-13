import { Badge } from "../../components/ui/Badge";
import { EmptyBlock } from "../../components/ui/StateBlock";
import type { CLineDashboardSummary, DetectionDetailView, LoadState } from "../../lib/api/types";

type ProjectOverviewPageProps = {
  kind: "agent" | "cases" | "configs";
  summaryState: LoadState<CLineDashboardSummary>;
  detectionState: LoadState<DetectionDetailView>;
};

export function ProjectOverviewPage({
  kind,
  summaryState,
  detectionState,
}: ProjectOverviewPageProps) {
  if (summaryState.status !== "ready") {
    return (
      <EmptyBlock
        title={titleFor(kind)}
        message="当前没有可展示的项目运行数据。先运行一次 E2E 检测即可填充该视图。"
      />
    );
  }

  const latest = summaryState.data.latestRunGroup;
  const detection = detectionState.status === "ready" ? detectionState.data : undefined;

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Project Console</p>
            <h1>{titleFor(kind)}</h1>
          </div>
          <Badge>{latest?.status ?? "no run"}</Badge>
        </div>
        {kind === "agent" ? (
          <div className="id-grid">
            <div>
              <span>Agent</span>
              <code>{latest?.agentId ?? "-"}</code>
            </div>
            <div>
              <span>Detection report</span>
              <code>{latest?.detectionReportId ?? "-"}</code>
            </div>
            <div>
              <span>Policy pack</span>
              <code>{latest?.policyPackId ?? "-"}</code>
            </div>
            <div>
              <span>Defense report</span>
              <code>{latest?.defenseReportId ?? "-"}</code>
            </div>
          </div>
        ) : null}
        {kind === "cases" ? (
          <div className="report-list">
            {(latest?.caseIds ?? []).map((caseId) => (
              <div className="report-row" key={caseId}>
                <code>{caseId}</code>
                <span>included in latest run</span>
              </div>
            ))}
          </div>
        ) : null}
        {kind === "configs" ? (
          <div className="id-grid">
            <div>
              <span>Risk reports</span>
              <code>{latest?.riskReportIds.length ?? 0}</code>
            </div>
            <div>
              <span>Scenario summaries</span>
              <code>{detection?.detectionReport.scenarioSummary.length ?? 0}</code>
            </div>
            <div>
              <span>Policy templates used</span>
              <code>{detection?.detectionReport.recommendedPolicyTemplateIds.length ?? 0}</code>
            </div>
            <div>
              <span>Generated policies</span>
              <code>{detection?.policyPack.policies.length ?? 0}</code>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function titleFor(kind: ProjectOverviewPageProps["kind"]): string {
  if (kind === "agent") {
    return "Agent Connect";
  }
  if (kind === "cases") {
    return "Test Cases";
  }
  return "Configs";
}
