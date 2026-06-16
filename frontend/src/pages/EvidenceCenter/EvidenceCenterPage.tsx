import type {
  CLineDashboardSummary,
  CLineRunGroup,
  DetectionDetailView,
  LoadState,
  SystemStatus,
  TraceDetailView,
} from "../../lib/api/types";
import { DetectionPage } from "../Detection/DetectionPage";
import { ProjectOverviewPage } from "../ProjectOverview/ProjectOverviewPage";
import { SystemPage } from "../System/SystemPage";
import { TestRunsPage } from "../TestRuns/TestRunsPage";
import { TraceDetailPage } from "../TraceDetail/TraceDetailPage";

export type EvidenceTabKey =
  | "runs"
  | "cases"
  | "detection"
  | "trace"
  | "system"
  | "configs";

type EvidenceCenterPageProps = {
  activeTab: EvidenceTabKey;
  onTabChange: (tab: EvidenceTabKey) => void;
  summaryState: LoadState<CLineDashboardSummary>;
  detectionState: LoadState<DetectionDetailView>;
  traceState: LoadState<TraceDetailView>;
  runGroupsState: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>;
  systemState: LoadState<SystemStatus>;
  selectedRunGroupId?: string;
  running: boolean;
  onRun: () => void;
  onGoDefense: () => void;
  onActivateRealtime: () => void;
  onSelectRunGroup: (runGroup: CLineRunGroup) => void;
};

const TABS: Array<{ key: EvidenceTabKey; label: string; summary: string }> = [
  { key: "runs", label: "测试运行", summary: "每次检测任务的运行索引" },
  { key: "cases", label: "测试用例", summary: "本轮检测覆盖的风险场景" },
  { key: "detection", label: "检测与策略", summary: "风险画像和策略包" },
  { key: "trace", label: "调用轨迹", summary: "工具调用和证据链" },
  { key: "system", label: "系统状态", summary: "API 与适配器可用性" },
  { key: "configs", label: "配置摘要", summary: "报告、策略和配置统计" },
];

export function EvidenceCenterPage({
  activeTab,
  onTabChange,
  summaryState,
  detectionState,
  traceState,
  runGroupsState,
  systemState,
  selectedRunGroupId,
  running,
  onRun,
  onGoDefense,
  onActivateRealtime,
  onSelectRunGroup,
}: EvidenceCenterPageProps) {
  const currentTab = TABS.find((tab) => tab.key === activeTab) ?? TABS[0];

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">证据中心</p>
            <h1>证据中心</h1>
          </div>
        </div>
        <div className="tab-row">
          {TABS.map((tab) => (
            <button
              className={`tab-button${activeTab === tab.key ? " active" : ""}`}
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
            >
              <strong>{tab.label}</strong>
              <span>{tab.summary}</span>
            </button>
          ))}
        </div>
      </section>

      {currentTab.key === "runs" ? (
        <TestRunsPage
          onRun={onRun}
          onSelectRunGroup={onSelectRunGroup}
          running={running}
          selectedRunGroupId={selectedRunGroupId}
          state={runGroupsState}
        />
      ) : null}

      {currentTab.key === "cases" ? (
        <ProjectOverviewPage
          detectionState={detectionState}
          kind="cases"
          summaryState={summaryState}
        />
      ) : null}

      {currentTab.key === "detection" ? (
        <DetectionPage
          onActivateRealtime={onActivateRealtime}
          onGoDefense={onGoDefense}
          onGoTrace={() => onTabChange("trace")}
          state={detectionState}
        />
      ) : null}

      {currentTab.key === "trace" ? (
        <TraceDetailPage
          onGoDefense={onGoDefense}
          onGoDetection={() => onTabChange("detection")}
          state={traceState}
        />
      ) : null}

      {currentTab.key === "system" ? <SystemPage state={systemState} /> : null}

      {currentTab.key === "configs" ? (
        <ProjectOverviewPage
          detectionState={detectionState}
          kind="configs"
          summaryState={summaryState}
        />
      ) : null}

    </div>
  );
}
