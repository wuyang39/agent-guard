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
  onActivateRealtime: () => void;
  onSelectRunGroup: (runGroup: CLineRunGroup) => void;
};

const TABS: Array<{ key: EvidenceTabKey; label: string }> = [
  { key: "runs", label: "运行" },
  { key: "cases", label: "用例" },
  { key: "detection", label: "检测" },
  { key: "trace", label: "轨迹" },
  { key: "system", label: "系统" },
  { key: "configs", label: "配置" },
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
            </button>
          ))}
        </div>
      </section>

      {currentTab.key === "runs" ? (
        <TestRunsPage
          onSelectRunGroup={onSelectRunGroup}
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
          state={detectionState}
        />
      ) : null}

      {currentTab.key === "trace" ? (
        <TraceDetailPage state={traceState} />
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
