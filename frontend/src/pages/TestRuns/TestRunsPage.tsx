import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { RunProgress } from "../../components/ui/RunProgress";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { CLineRunGroup, LoadState } from "../../lib/api/types";
import { runPhaseLabel, runPhaseTone } from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";

type TestRunsPageProps = {
  state: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>;
  onSelectRunGroup: (runGroup: CLineRunGroup) => void;
  selectedRunGroupId?: string;
};

export function TestRunsPage({
  state,
  onSelectRunGroup,
  selectedRunGroupId,
}: TestRunsPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载测试运行索引..." />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="测试运行加载失败" message={state.message} />;
  }

  if (state.status === "empty" || state.data.runGroups.length === 0) {
    return (
      <EmptyBlock
        title="没有测试运行"
        message="生成监督策略包后，这里会显示运行索引。"
      />
    );
  }

  const selectedRunGroup =
    state.data.runGroups.find((runGroup) => runGroup.runGroupId === selectedRunGroupId) ??
    state.data.runGroups[0];

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">证据中心</p>
            <h1>测试运行</h1>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>运行时间</th>
                <th>阶段</th>
                <th>检测进度</th>
                <th>用例</th>
                <th>风险报告</th>
              </tr>
            </thead>
            <tbody>
              {state.data.runGroups.map((runGroup) => {
                const selected = selectedRunGroupId === runGroup.runGroupId;
                return (
                <tr
                  className={`selectable-row${selected ? " selected-row" : ""}`}
                  key={runGroup.runGroupId}
                  onClick={() => onSelectRunGroup(runGroup)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectRunGroup(runGroup);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <td>
                    {formatDateTime(runGroup.updatedAt)}
                  </td>
                  <td>
                    <Badge tone={runPhaseTone(runGroup.phase)}>{runPhaseLabel(runGroup.phase)}</Badge>
                  </td>
                  <td className="progress-cell">
                    <RunProgress runGroup={runGroup} compact />
                  </td>
                  <td>{runGroup.caseIds.length}</td>
                  <td>{runGroup.riskReportIds.length}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {selectedRunGroup ? (
          <DeveloperDetails
            items={[
              { label: "运行组", value: selectedRunGroup.runGroupId },
              { label: "智能体", value: selectedRunGroup.agentName ?? selectedRunGroup.agentId },
              { label: "适配器", value: selectedRunGroup.adapterKind },
              { label: "策略来源", value: selectedRunGroup.policyContextSource },
              { label: "选择计划", value: selectedRunGroup.selectionPlanId },
              { label: "检测报告", value: selectedRunGroup.detectionReportId },
              { label: "风险画像", value: selectedRunGroup.riskProfileId },
              { label: "策略包", value: selectedRunGroup.policyPackId },
              { label: "防御报告", value: selectedRunGroup.defenseReportId },
              { label: "Trace 数", value: selectedRunGroup.traceIds.length },
              { label: "Runtime session 数", value: selectedRunGroup.runtimeSessionIds.length },
              { label: "Artifact 数", value: selectedRunGroup.artifactIds.length },
            ]}
            title="选中运行详情"
          />
        ) : null}
        {selectedRunGroup ? <RunGroupDiagnostics runGroup={selectedRunGroup} /> : null}
      </section>
    </div>
  );
}

function RunGroupDiagnostics({ runGroup }: { runGroup: CLineRunGroup }) {
  return (
    <DeveloperDiagnostics
      count={
        runGroup.caseIds.length +
        runGroup.traceIds.length +
        runGroup.riskReportIds.length +
        runGroup.runtimeSessionIds.length +
        runGroup.artifactIds.length
      }
      title="选中运行开发者诊断"
    >
      <DiagnosticSection title="状态与进度">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Run group", value: runGroup.runGroupId },
            { label: "Status", value: runGroup.status },
            { label: "Phase", value: runGroup.phase },
            { label: "Policy context", value: runGroup.policyContextSource },
            { label: "Adapter", value: runGroup.adapterKind },
            { label: "Case count", value: runGroup.caseCount ?? runGroup.caseIds.length },
            { label: "Created", value: formatDateTime(runGroup.createdAt) },
            { label: "Updated", value: formatDateTime(runGroup.updatedAt) },
          ]}
        />
        <DiagnosticJson value={runGroup.progress} emptyLabel="暂无 progress payload" />
      </DiagnosticSection>

      <DiagnosticSection title="证据对象">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Selection plan", value: runGroup.selectionPlanId },
            { label: "Detection report", value: runGroup.detectionReportId },
            { label: "Risk profile", value: runGroup.riskProfileId },
            { label: "Policy pack", value: runGroup.policyPackId },
            { label: "Defense report", value: runGroup.defenseReportId },
          ]}
        />
        <div className="diagnostic-run-id-groups">
          <DiagnosticIdGroup label="Cases" values={runGroup.caseIds} />
          <DiagnosticIdGroup label="Traces" values={runGroup.traceIds} />
          <DiagnosticIdGroup label="Risk reports" values={runGroup.riskReportIds} />
          <DiagnosticIdGroup label="Runtime sessions" values={runGroup.runtimeSessionIds} />
          <DiagnosticIdGroup label="Artifacts" values={runGroup.artifactIds} />
        </div>
      </DiagnosticSection>
    </DeveloperDiagnostics>
  );
}

function DiagnosticIdGroup({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="diagnostic-id-group">
      <strong>{label}</strong>
      <CodeList values={values} />
    </div>
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
