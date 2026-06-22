import type { CLineRunGroup } from "../../lib/api/types";

type RunProgressProps = {
  runGroup: CLineRunGroup;
  compact?: boolean;
};

export function RunProgress({ runGroup, compact = false }: RunProgressProps) {
  const progress = runGroup.progress;
  const totalCases = progress?.totalCases ?? runGroup.caseCount ?? runGroup.caseIds.length;
  const completedCases = progress?.completedCases ?? runGroup.riskReportIds.length;
  const failedCases = progress?.failedCases ?? (runGroup.status === "failed" ? 1 : 0);
  const percent = clampPercent(
    progress?.percent ??
      (totalCases > 0
        ? Math.round(((completedCases + failedCases) / totalCases) * 100)
        : runGroup.status === "completed"
          ? 100
          : 0),
  );
  const runningCaseIds = progress?.runningCaseIds ?? [];
  const currentCases = runningCaseIds.slice(0, 2).join(", ");
  const hiddenCount = Math.max(0, runningCaseIds.length - 2);

  return (
    <div className={`run-progress${compact ? " compact" : ""}`}>
      <div className="run-progress-head">
        <span>
          {completedCases}/{totalCases || "-"} 完成
          {failedCases ? `，${failedCases} 失败` : ""}
        </span>
        <code>{percent}%</code>
      </div>
      <div className="progress-track" aria-label={`检测进度 ${percent}%`}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {!compact && runningCaseIds.length ? (
        <p className="field-note">
          当前: {currentCases}
          {hiddenCount ? ` 等 ${hiddenCount + 2} 个用例` : ""}
        </p>
      ) : null}
      {!compact && progress?.concurrency ? (
        <p className="field-note">并发: {progress.concurrency}</p>
      ) : null}
    </div>
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
