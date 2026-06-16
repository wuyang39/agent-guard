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
        message="当前没有可展示的运行数据。先生成监督策略包即可填充该视图。"
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
            <p className="eyebrow">证据中心</p>
            <h1>{titleFor(kind)}</h1>
          </div>
          <Badge>{latest?.status ?? "暂无运行"}</Badge>
        </div>
        {kind === "agent" ? (
          <div className="id-grid">
            <div>
              <span>智能体</span>
              <code>{latest?.agentId ?? "-"}</code>
            </div>
            <div>
              <span>检测报告</span>
              <code>{latest?.detectionReportId ?? "-"}</code>
            </div>
            <div>
              <span>策略包</span>
              <code>{latest?.policyPackId ?? "-"}</code>
            </div>
            <div>
              <span>防御报告</span>
              <code>{latest?.defenseReportId ?? "-"}</code>
            </div>
          </div>
        ) : null}
        {kind === "cases" ? (
          <div className="report-list">
            {(latest?.caseIds ?? []).map((caseId) => (
              <div className="report-row" key={caseId}>
                <code>{caseId}</code>
                <span>包含在最新运行中</span>
              </div>
            ))}
          </div>
        ) : null}
        {kind === "configs" ? (
          <div className="id-grid">
            <div>
              <span>风险报告</span>
              <code>{latest?.riskReportIds.length ?? 0}</code>
            </div>
            <div>
              <span>场景摘要</span>
              <code>{detection?.detectionReport.scenarioSummary.length ?? 0}</code>
            </div>
            <div>
              <span>策略模板</span>
              <code>{detection?.detectionReport.recommendedPolicyTemplateIds.length ?? 0}</code>
            </div>
            <div>
              <span>生成策略</span>
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
    return "智能体接入";
  }
  if (kind === "cases") {
    return "测试用例";
  }
  return "配置摘要";
}
