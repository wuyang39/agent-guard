import { useCallback, useEffect, useState } from "react";
import { agentGuardApi } from "./lib/api/client";
import {
  mockDashboardSummary,
  mockDefenseDetail,
  mockDetectionDetail,
  mockTraceDetail,
} from "./lib/api/mockData";
import type {
  CLineDashboardSummary,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  LoadState,
  SystemStatus,
  TraceDetailView,
} from "./lib/api/types";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { DefenseReportPage } from "./pages/DefenseReports/DefenseReportPage";
import { DetectionPage } from "./pages/Detection/DetectionPage";
import { ProjectOverviewPage } from "./pages/ProjectOverview/ProjectOverviewPage";
import { LiveSupervisionPage } from "./pages/Supervision/LiveSupervisionPage";
import { SystemPage } from "./pages/System/SystemPage";
import { TestRunsPage } from "./pages/TestRuns/TestRunsPage";
import { TraceDetailPage } from "./pages/TraceDetail/TraceDetailPage";

type ViewKey =
  | "dashboard"
  | "agent"
  | "runs"
  | "cases"
  | "configs"
  | "detection"
  | "supervision"
  | "defense"
  | "trace"
  | "system";

export function App() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [running, setRunning] = useState(false);
  const [summaryState, setSummaryState] = useState<LoadState<CLineDashboardSummary>>({
    status: "idle",
  });
  const [detectionState, setDetectionState] = useState<LoadState<DetectionDetailView>>({
    status: "idle",
  });
  const [defenseState, setDefenseState] = useState<LoadState<DefenseDetailView>>({
    status: "idle",
  });
  const [traceState, setTraceState] = useState<LoadState<TraceDetailView>>({
    status: "idle",
  });
  const [runGroupsState, setRunGroupsState] = useState<
    LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>
  >({ status: "idle" });
  const [systemState, setSystemState] = useState<LoadState<SystemStatus>>({
    status: "idle",
  });

  const useMock = useCallback(() => {
    setSummaryState({ status: "ready", data: mockDashboardSummary, source: "mock" });
    setDetectionState({ status: "ready", data: mockDetectionDetail, source: "mock" });
    setDefenseState({ status: "ready", data: mockDefenseDetail, source: "mock" });
    setTraceState({ status: "ready", data: mockTraceDetail, source: "mock" });
    setRunGroupsState({
      status: "ready",
      data: { schemaVersion: "mvp-1", runGroups: mockDashboardSummary.recentRunGroups },
      source: "mock",
    });
  }, []);

  const loadDetails = useCallback(async (summary: CLineDashboardSummary) => {
    const latest = summary.latestRunGroup;
    if (!latest) {
      setDetectionState({
        status: "empty",
        message: "尚无 DetectionReport。请先运行一次 E2E 检测。",
      });
      setDefenseState({
        status: "empty",
        message: "尚无 DefenseReport。请先运行一次 E2E 检测。",
      });
      setTraceState({
        status: "empty",
        message: "尚无 trace。请先运行一次 E2E 检测。",
      });
      return;
    }

    setDetectionState({ status: "loading" });
    setDefenseState({ status: "loading" });
    setTraceState({ status: "loading" });

    const [detection, defense, trace] = await Promise.all([
      agentGuardApi.detectionDetail(latest.detectionReportId),
      agentGuardApi.defenseDetail(latest.defenseReportId),
      agentGuardApi.traceDetail(latest.traceIds[0]),
    ]);

    setDetectionState({ status: "ready", data: detection, source: "api" });
    setDefenseState({ status: "ready", data: defense, source: "api" });
    setTraceState({ status: "ready", data: trace, source: "api" });
  }, []);

  const loadInitial = useCallback(async () => {
    setSummaryState({ status: "loading" });
    setRunGroupsState({ status: "loading" });
    setSystemState({ status: "loading" });
    try {
      const [summary, runGroups, system] = await Promise.all([
        agentGuardApi.dashboardSummary(),
        agentGuardApi.runGroups(),
        agentGuardApi.systemStatus(),
      ]);
      setRunGroupsState({ status: "ready", data: runGroups, source: "api" });
      setSystemState({ status: "ready", data: system, source: "api" });
      if (!summary.latestRunGroup) {
        setSummaryState({
          status: "empty",
          message: "C 线 API 已连接，但文件索引中还没有运行记录。",
        });
        await loadDetails(summary);
        return;
      }

      setSummaryState({ status: "ready", data: summary, source: "api" });
      await loadDetails(summary);
    } catch (error) {
      setSummaryState({
        status: "error",
        message:
          error instanceof Error
            ? `${error.message}。可先启动 API，或使用 typed mock 查看页面。`
            : "无法连接 C 线 API。可先启动 API，或使用 typed mock 查看页面。",
        fallback: mockDashboardSummary,
      });
      setDetectionState({ status: "empty", message: "等待 API 数据或 typed mock。" });
      setDefenseState({ status: "empty", message: "等待 API 数据或 typed mock。" });
      setTraceState({ status: "empty", message: "等待 API 数据或 typed mock。" });
      setRunGroupsState({ status: "empty", message: "等待 API 数据或 typed mock。" });
      setSystemState({
        status: "error",
        message: "无法连接系统状态接口。确认 Agent Guard API 是否已启动。",
      });
    }
  }, [loadDetails]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  async function runE2E() {
    setRunning(true);
    setSummaryState({ status: "loading" });
    try {
      await agentGuardApi.runE2E();
      const [summary, runGroups, system] = await Promise.all([
        agentGuardApi.dashboardSummary(),
        agentGuardApi.runGroups(),
        agentGuardApi.systemStatus(),
      ]);
      setSummaryState({ status: "ready", data: summary, source: "api" });
      setRunGroupsState({ status: "ready", data: runGroups, source: "api" });
      setSystemState({ status: "ready", data: system, source: "api" });
      await loadDetails(summary);
      setView("dashboard");
    } catch (error) {
      setSummaryState({
        status: "error",
        message:
          error instanceof Error
            ? `${error.message}。确认 npm run api:start 是否已启动。`
            : "运行 E2E 检测失败。确认 npm run api:start 是否已启动。",
        fallback: mockDashboardSummary,
      });
    } finally {
      setRunning(false);
    }
  }

  async function activateRealtimePolicy() {
    if (detectionState.status !== "ready") {
      return;
    }
    const policyPackId = detectionState.data.policyPack.policyPackId;
    await agentGuardApi.setRealtimeActivePolicy(policyPackId, true);
    setView("supervision");
  }

  function acceptRealtimeDefenseReport(detail: DefenseDetailView) {
    setDefenseState({ status: "ready", data: detail, source: "api" });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <strong>Agent Guard</strong>
          <span>项目控制台</span>
        </div>
        <nav>
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            总览
          </button>
          <button className={view === "agent" ? "active" : ""} onClick={() => setView("agent")}>
            智能体接入
          </button>
          <button className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}>
            测试运行
          </button>
          <button className={view === "cases" ? "active" : ""} onClick={() => setView("cases")}>
            测试用例
          </button>
          <button className={view === "configs" ? "active" : ""} onClick={() => setView("configs")}>
            配置中心
          </button>
          <button className={view === "detection" ? "active" : ""} onClick={() => setView("detection")}>
            检测与策略
          </button>
          <button className={view === "supervision" ? "active" : ""} onClick={() => setView("supervision")}>
            实时监督
          </button>
          <button className={view === "defense" ? "active" : ""} onClick={() => setView("defense")}>
            防御报告
          </button>
          <button className={view === "trace" ? "active" : ""} onClick={() => setView("trace")}>
            调用轨迹
          </button>
          <button className={view === "system" ? "active" : ""} onClick={() => setView("system")}>
            系统状态
          </button>
        </nav>
      </aside>

      <main className="main-surface">
        {view === "dashboard" ? (
          <DashboardPage
            onRun={() => void runE2E()}
            onSelectView={setView}
            onUseMock={useMock}
            running={running}
            state={summaryState}
          />
        ) : null}
        {view === "detection" ? (
          <DetectionPage
            onActivateRealtime={() => void activateRealtimePolicy()}
            onGoDefense={() => setView("defense")}
            onGoTrace={() => setView("trace")}
            state={detectionState}
          />
        ) : null}
        {view === "agent" ? (
          <ProjectOverviewPage
            detectionState={detectionState}
            kind="agent"
            summaryState={summaryState}
          />
        ) : null}
        {view === "supervision" ? (
          <LiveSupervisionPage
            onGoDefense={() => setView("defense")}
            onGoRuns={() => setView("runs")}
            onReportGenerated={acceptRealtimeDefenseReport}
          />
        ) : null}
        {view === "runs" ? (
          <TestRunsPage
            onRun={() => void runE2E()}
            running={running}
            state={runGroupsState}
          />
        ) : null}
        {view === "cases" ? (
          <ProjectOverviewPage
            detectionState={detectionState}
            kind="cases"
            summaryState={summaryState}
          />
        ) : null}
        {view === "configs" ? (
          <ProjectOverviewPage
            detectionState={detectionState}
            kind="configs"
            summaryState={summaryState}
          />
        ) : null}
        {view === "defense" ? (
          <DefenseReportPage
            onGoDetection={() => setView("detection")}
            onGoTrace={() => setView("trace")}
            state={defenseState}
          />
        ) : null}
        {view === "trace" ? (
          <TraceDetailPage
            onGoDefense={() => setView("defense")}
            onGoDetection={() => setView("detection")}
            state={traceState}
          />
        ) : null}
        {view === "system" ? <SystemPage state={systemState} /> : null}
      </main>
    </div>
  );
}
