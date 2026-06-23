import { useEffect, useRef, useState } from "react";
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
  const targetPercent = clampPercent(
    progress?.percent ??
      (totalCases > 0
        ? Math.round(((completedCases + failedCases) / totalCases) * 100)
        : runGroup.status === "completed"
          ? 100
          : 0),
  );
  const percent = useSmoothPercent(targetPercent, runGroup.runGroupId);
  const runningCaseIds = progress?.runningCaseIds ?? [];
  const currentCases = runningCaseIds.slice(0, 2).join(", ");
  const hiddenCount = Math.max(0, runningCaseIds.length - 2);

  return (
    <div className={`run-progress${compact ? " compact" : ""}`}>
      <div className="run-progress-head">
        <span>
          {totalCases > 0 ? `${completedCases}/${totalCases}` : completedCases} 完成
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

function useSmoothPercent(targetPercent: number, runGroupId: string): number {
  const [displayPercent, setDisplayPercent] = useState(targetPercent);
  const previousRunGroupId = useRef(runGroupId);
  const displayRef = useRef(targetPercent);

  useEffect(() => {
    if (previousRunGroupId.current !== runGroupId) {
      previousRunGroupId.current = runGroupId;
      displayRef.current = targetPercent;
      setDisplayPercent(targetPercent);
      return;
    }

    const start = displayRef.current;
    const delta = targetPercent - start;
    if (delta === 0) return;

    if (delta < 0) {
      displayRef.current = targetPercent;
      setDisplayPercent(targetPercent);
      return;
    }

    const startedAt = performance.now();
    const durationMs = Math.max(700, Math.min(2200, delta * 90));
    let frameId = 0;

    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.min(targetPercent, Math.round(start + delta * eased));
      displayRef.current = next;
      setDisplayPercent(next);
      if (progress < 1) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [runGroupId, targetPercent]);

  return displayPercent;
}
