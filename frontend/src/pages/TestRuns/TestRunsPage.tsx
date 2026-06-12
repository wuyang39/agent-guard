import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { CLineRunGroup, LoadState } from "../../lib/api/types";
import { formatDateTime } from "../../lib/formatters/time";

type TestRunsPageProps = {
  state: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>;
  onRun: () => void;
  running: boolean;
};

export function TestRunsPage({ state, onRun, running }: TestRunsPageProps) {
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
        message="运行一次 E2E 检测后，这里会显示 runGroup、报告和 trace 索引。"
        action={
          <button className="primary-button" disabled={running} onClick={onRun}>
            {running ? "运行中..." : "运行一次 E2E 检测"}
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
            <p className="eyebrow">Project Console</p>
            <h1>Test Runs</h1>
          </div>
          <button className="primary-button" disabled={running} onClick={onRun}>
            {running ? "运行中..." : "运行一次 E2E 检测"}
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run Group</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Cases</th>
                <th>Risk Reports</th>
                <th>Traces</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {state.data.runGroups.map((runGroup) => (
                <tr key={runGroup.runGroupId}>
                  <td>
                    <code>{runGroup.runGroupId}</code>
                  </td>
                  <td>{runGroup.agentId}</td>
                  <td>
                    <Badge tone={runGroup.status === "completed" ? "tone-low" : "tone-critical"}>
                      {runGroup.status}
                    </Badge>
                  </td>
                  <td>{runGroup.caseIds.length}</td>
                  <td>{runGroup.riskReportIds.length}</td>
                  <td>{runGroup.traceIds.length}</td>
                  <td>{formatDateTime(runGroup.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
