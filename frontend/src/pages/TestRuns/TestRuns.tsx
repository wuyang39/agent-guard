import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Trash2 } from "lucide-react";
import { useStoredRuns } from "../../lib/hooks/useStoredRuns";
import { clearRuns, summarizeRun } from "../../lib/models/runStore";
import { formatDate } from "../../lib/formatters/display";
import { RiskBadge } from "../../components/ui/RiskBadge";
import { StateBlock } from "../../components/ui/StateBlock";

export function TestRuns() {
  const runs = useStoredRuns();
  const [query, setQuery] = useState("");
  const filteredRuns = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return runs;
    return runs.filter((run) => {
      const summary = summarizeRun(run);
      return [summary.runGroupId, summary.agentName, summary.highestRisk, run.caseIds.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(value);
    });
  }, [query, runs]);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">History</p>
          <h1>Test Runs</h1>
        </div>
        <button className="ghost-action" type="button" onClick={clearRuns} disabled={!runs.length}>
          <Trash2 size={17} />
          <span>Clear</span>
        </button>
      </header>

      <div className="toolbar-row">
        <label className="search-box">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs" />
        </label>
      </div>

      {filteredRuns.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run Group</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Cases</th>
                <th>Risk</th>
                <th>Findings</th>
                <th>Blocked</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((run) => {
                const summary = summarizeRun(run);
                return (
                  <tr key={run.runGroupId}>
                    <td>
                      <Link to={`/runs/${run.runGroupId}`}>{summary.runGroupId.slice(0, 30)}</Link>
                    </td>
                    <td>{summary.agentName}</td>
                    <td>{summary.status}</td>
                    <td>{summary.caseCount}</td>
                    <td>
                      <RiskBadge level={summary.highestRisk} />
                    </td>
                    <td>{summary.findingCount}</td>
                    <td>{summary.blockedCount}</td>
                    <td>{formatDate(summary.finishedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <StateBlock title="暂无匹配运行" detail="发起检测后可在这里查看历史运行。" />
      )}
    </section>
  );
}
