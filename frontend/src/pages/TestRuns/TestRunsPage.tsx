import { Badge } from "../../components/ui/Badge";
import { RunProgress } from "../../components/ui/RunProgress";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { CLineRunGroup, LoadState } from "../../lib/api/types";
import {
  adapterKindLabel,
  policySourceLabel,
  runPhaseLabel,
  runPhaseTone,
} from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";

type TestRunsPageProps = {
  state: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>;
  onRun: () => void;
  onSelectRunGroup: (runGroup: CLineRunGroup) => void;
  selectedRunGroupId?: string;
  running: boolean;
};

export function TestRunsPage({
  state,
  onRun,
  onSelectRunGroup,
  selectedRunGroupId,
  running,
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
        message="生成监督策略包后，这里会显示运行组、报告和调用轨迹索引。"
        action={
          <button className="primary-button" disabled={running} onClick={onRun}>
            {running ? "正在运行检测..." : "运行检测生成策略包"}
          </button>
        }
      />
    );
  }

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">证据中心</p>
            <h1>测试运行</h1>
          </div>
          <div className="button-row">
            {selectedRunGroupId ? <Badge tone="tone-medium">当前 {selectedRunGroupId}</Badge> : null}
            <button className="primary-button" disabled={running} onClick={onRun}>
              {running ? "正在运行检测..." : "运行检测生成策略包"}
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>运行组</th>
                <th>选择计划</th>
                <th>智能体</th>
                <th>状态</th>
                <th>阶段</th>
                <th>策略来源</th>
                <th>检测进度</th>
                <th>用例</th>
                <th>风险报告</th>
                <th>调用轨迹</th>
                <th>更新</th>
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
                    <code>{runGroup.runGroupId}</code>
                    {selected ? <Badge tone="tone-low">已选择</Badge> : null}
                  </td>
                  <td>
                    <code>{runGroup.selectionPlanId ?? "未绑定"}</code>
                  </td>
                  <td>{runGroup.agentName ?? adapterKindLabel(runGroup.adapterKind)}</td>
                  <td>
                    <Badge tone={statusTone(runGroup.status)}>
                      {statusLabel(runGroup.status)}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={runPhaseTone(runGroup.phase)}>{runPhaseLabel(runGroup.phase)}</Badge>
                  </td>
                  <td>{policySourceLabel(runGroup.policyContextSource)}</td>
                  <td className="progress-cell">
                    <RunProgress runGroup={runGroup} compact />
                  </td>
                  <td>{runGroup.caseIds.length}</td>
                  <td>{runGroup.riskReportIds.length}</td>
                  <td>{runGroup.traceIds.length}</td>
                  <td>{formatDateTime(runGroup.updatedAt)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function statusLabel(status: CLineRunGroup["status"]): string {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  return "失败";
}

function statusTone(status: CLineRunGroup["status"]): string {
  if (status === "running") return "tone-medium";
  if (status === "completed") return "tone-low";
  return "tone-critical";
}
