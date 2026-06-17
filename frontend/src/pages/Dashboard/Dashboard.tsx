import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, PlayCircle, ShieldAlert } from "lucide-react";
import { getBootstrap } from "../../lib/api/demoRuntime";
import { useStoredRuns } from "../../lib/hooks/useStoredRuns";
import { formatDate } from "../../lib/formatters/display";
import { summarizeRuns } from "../../lib/models/runStore";
import { RiskBadge } from "../../components/ui/RiskBadge";
import { StateBlock } from "../../components/ui/StateBlock";

export function Dashboard() {
  const runs = useStoredRuns();
  const stats = summarizeRuns(runs);
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: getBootstrap });

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Formal Console</p>
          <h1>Dashboard</h1>
        </div>
        <Link className="primary-action" to="/new-run">
          <PlayCircle size={18} />
          <span>开始检测</span>
        </Link>
      </header>

      {bootstrap.isError ? (
        <StateBlock
          kind="error"
          title="API runtime unavailable"
          detail="请先启动 npm run demo，再刷新正式前端。"
        />
      ) : null}

      <div className="metric-grid">
        <div className="metric-tile">
          <CheckCircle2 size={22} />
          <span>System</span>
          <strong>{bootstrap.isSuccess ? "Ready" : bootstrap.isLoading ? "Checking" : "Offline"}</strong>
        </div>
        <div className="metric-tile">
          <ShieldAlert size={22} />
          <span>Highest Risk</span>
          <strong>
            <RiskBadge level={stats.highestRisk} />
          </strong>
        </div>
        <div className="metric-tile">
          <AlertTriangle size={22} />
          <span>Findings</span>
          <strong>{stats.findingCount}</strong>
        </div>
        <div className="metric-tile">
          <FileText size={22} />
          <span>Runs</span>
          <strong>{stats.runCount}</strong>
        </div>
      </div>

      <div className="content-band">
        <div className="section-heading">
          <h2>Recent Runs</h2>
          <Link to="/runs">View all</Link>
        </div>
        {stats.summaries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run Group</th>
                  <th>Agent</th>
                  <th>Cases</th>
                  <th>Risk</th>
                  <th>Findings</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {stats.summaries.slice(0, 5).map((run) => (
                  <tr key={run.runGroupId}>
                    <td>
                      <Link to={`/runs/${run.runGroupId}`}>{run.runGroupId.slice(0, 22)}</Link>
                    </td>
                    <td>{run.agentName}</td>
                    <td>{run.caseCount}</td>
                    <td>
                      <RiskBadge level={run.highestRisk} />
                    </td>
                    <td>{run.findingCount}</td>
                    <td>{formatDate(run.finishedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <StateBlock title="暂无运行记录" detail="从 New Test Run 发起一次检测后，这里会显示本机运行历史。" />
        )}
      </div>
    </section>
  );
}
