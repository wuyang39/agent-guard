import { useCallback, useEffect, useRef, useState } from "react";
import type { ReportBundle, TestSelectionPlan, TestSelectionRequest } from "@agent-guard/contracts";
import { agentGuardApi } from "./lib/api/client";
import { mockDashboardSummary } from "./lib/api/mockData";
import type {
  AgentConnectionConfig,
  CLineDashboardSummary,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  LoadState,
  LiveSupervisionEvent,
  RealtimeActivePolicyState,
  SystemStatus,
  TraceDetailView,
} from "./lib/api/types";
import { AgentConnectPage } from "./pages/AgentConnect/AgentConnectPage";
import { DashboardPage } from "./pages/Dashboard/DashboardPage";
import { DefenseReportPage } from "./pages/DefenseReports/DefenseReportPage";
import {
  EvidenceCenterPage,
  type EvidenceTabKey,
} from "./pages/EvidenceCenter/EvidenceCenterPage";
import { RuntimeConfigPage } from "./pages/RuntimeConfig/RuntimeConfigPage";
import { RunWorkflowPage } from "./pages/RunWorkflow/RunWorkflowPage";
import { ReportWorkspacePage } from "./pages/ReportWorkspace/ReportWorkspacePage";
import { LiveSupervisionPage } from "./pages/Supervision/LiveSupervisionPage";
import { DEFAULT_SELECTION_CASE_COUNT } from "./selectionDefaults";

type ViewKey =
  | "agent"
  | "dashboard"
  | "run-workflow"
  | "supervision"
  | "runtime-config"
  | "report-workspace"
  | "defense"
  | "evidence";

const AGENT_CONFIG_STORAGE_KEY = "agent-guard.agent-config";
const SELECTION_CASE_COUNT_STORAGE_KEY = "agent-guard.selection-case-count";
const REALTIME_TOAST_LIMIT = 3;
const REALTIME_TOAST_TTL_MS = 7000;
const MIN_SELECTION_CASE_COUNT = 3;
const MAX_SELECTION_CASE_COUNT = 500;
const DEFAULT_AGENT_TIMEOUT_MS = 120000;
const DEFAULT_OPENCLAW_TIMEOUT_MS = 90000;
const PRODUCT_NAME = "AgentSleuth";

const defaultOpenClawCliPath = import.meta.env.VITE_OPENCLAW_CLI_PATH ?? "";

const defaultAgentConfig: AgentConnectionConfig = {
  adapterKind: "openclaw",
  agentId: "agent.openclaw.demo",
  name: "OpenClaw CLI Agent",
  description: "OpenClaw runtime",
  openclawCliPath: defaultOpenClawCliPath,
  gatewayUrl: "http://127.0.0.1:18789",
  endpointUrl: "http://127.0.0.1:7001/agent/run?mode=vulnerable",
  timeoutMs: DEFAULT_OPENCLAW_TIMEOUT_MS,
  caseIds: ["case.resource_injection"],
};

export function App() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [supervisionMounted, setSupervisionMounted] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTabKey>("runs");
  const [agentConfig, setAgentConfig] = useState<AgentConnectionConfig>(() =>
    loadStoredAgentConfig(),
  );
  const [selectionCaseCount, setSelectionCaseCount] = useState(() =>
    loadStoredSelectionCaseCount(),
  );
  const [running, setRunning] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const cancelledRunIdsRef = useRef(new Set<string>());
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
  const [selectionPlanState, setSelectionPlanState] = useState<LoadState<TestSelectionPlan>>({
    status: "idle",
  });
  const [reportBundleState, setReportBundleState] = useState<LoadState<ReportBundle>>({
    status: "idle",
  });
  const [runGroupsState, setRunGroupsState] = useState<
    LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>
  >({ status: "idle" });
  const [systemState, setSystemState] = useState<LoadState<SystemStatus>>({
    status: "idle",
  });
  const [selectedRunGroupId, setSelectedRunGroupId] = useState<string | undefined>();
  const [realtimeToasts, setRealtimeToasts] = useState<RealtimeToast[]>([]);
  const [activeRealtimePolicy, setActiveRealtimePolicy] =
    useState<RealtimeActivePolicyState>();
  const [activatingRealtimePolicyPackId, setActivatingRealtimePolicyPackId] =
    useState<string>();
  const [realtimePolicyActivationError, setRealtimePolicyActivationError] =
    useState<string>();

  const refreshActiveRealtimePolicy = useCallback(async () => {
    try {
      const activePolicy = await agentGuardApi.activeRealtimePolicy();
      setActiveRealtimePolicy(activePolicy);
    } catch (error) {
      console.warn("Failed to load active realtime policy", error);
    }
  }, []);

  const loadDefenseForRunGroup = useCallback(async (runGroup: CLineRunGroup): Promise<void> => {
    if (!runGroup.defenseReportId) {
      setDefenseState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 未生成防御报告。`,
      });
      return;
    }

    setDefenseState({ status: "loading" });
    try {
      const defense = await agentGuardApi.defenseDetail(runGroup.defenseReportId);
      setDefenseState({ status: "ready", data: defense, source: "api" });
    } catch (error) {
      setDefenseState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const loadDetailsForRunGroup = useCallback(async (runGroup: CLineRunGroup) => {
    setSelectedRunGroupId(runGroup.runGroupId);
    await loadSelectionPlanForRunGroup(runGroup, setSelectionPlanState);
    setReportBundleState({ status: "loading" });

    if (runGroup.detectionReportId) {
      setDetectionState({ status: "loading" });
    } else {
      setDetectionState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 未生成检测报告。阶段：${runGroup.phase}`,
      });
    }

    const traceId = runGroup.traceIds[0];
    if (traceId) {
      setTraceState({ status: "loading" });
    } else {
      setTraceState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 未产生调用轨迹。`,
      });
    }

    await Promise.all([
      runGroup.detectionReportId
        ? agentGuardApi
            .detectionDetail(runGroup.detectionReportId)
            .then((detection) =>
              setDetectionState({ status: "ready", data: detection, source: "api" }),
            )
            .catch((error) =>
              setDetectionState({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            )
        : Promise.resolve(),
      agentGuardApi
        .reportBundleForRunGroup(runGroup.runGroupId)
        .then((bundle) =>
          setReportBundleState({ status: "ready", data: bundle, source: "api" }),
        )
        .catch((error) =>
          setReportBundleState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      traceId
        ? agentGuardApi
            .traceDetail(traceId)
            .then((trace) =>
              setTraceState({ status: "ready", data: trace, source: "api" }),
            )
            .catch((error) =>
              setTraceState({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            )
        : Promise.resolve(),
      loadDefenseForRunGroup(runGroup),
    ]);
  }, [loadDefenseForRunGroup]);

  const loadDetails = useCallback(async (summary: CLineDashboardSummary) => {
    const latest = summary.latestRunGroup;
    if (!latest) {
      setSelectedRunGroupId(undefined);
      setSelectionPlanState({
        status: "empty",
        message: "暂无攻击库选择计划。",
      });
      setDetectionState({
        status: "empty",
        message: "暂无检测报告。",
      });
      setDefenseState({
        status: "empty",
        message: "暂无防御报告。",
      });
      setTraceState({
        status: "empty",
        message: "暂无调用轨迹。",
      });
      setReportBundleState({
        status: "empty",
        message: "暂无报告包。",
      });
      return;
    }

    await loadDetailsForRunGroup(latest);
  }, [loadDetailsForRunGroup]);

  const loadInitial = useCallback(async () => {
    setSummaryState({ status: "loading" });
    setRunGroupsState({ status: "loading" });
    setSystemState({ status: "loading" });
    try {
      const [summary, runGroups, system, agents] = await Promise.all([
        agentGuardApi.dashboardSummary(),
        agentGuardApi.runGroups(),
        agentGuardApi.systemStatus(),
        agentGuardApi.agents(),
      ]);
      if (!hasStoredAgentConfig()) {
        persistAgentConfig(agents.activeAgent);
      }
      setRunGroupsState({ status: "ready", data: runGroups, source: "api" });
      setSystemState({ status: "ready", data: system, source: "api" });
      if (!summary.latestRunGroup) {
        setSummaryState({
          status: "empty",
          message: "服务已连接，暂无运行记录。",
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
            ? `${error.message}。确认 AgentSleuth API 已启动。`
            : "无法连接 AgentSleuth API。",
        fallback: mockDashboardSummary,
      });
      setDetectionState({ status: "empty", message: "暂无服务数据。" });
      setDefenseState({ status: "empty", message: "暂无服务数据。" });
      setTraceState({ status: "empty", message: "暂无服务数据。" });
      setReportBundleState({ status: "empty", message: "暂无服务数据。" });
      setRunGroupsState({ status: "empty", message: "暂无服务数据。" });
      setSystemState({
        status: "error",
        message: "系统状态接口不可用。",
      });
    }
  }, [loadDetails]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    void refreshActiveRealtimePolicy();
  }, [refreshActiveRealtimePolicy]);

  async function createSelectionPlan() {
    setPlanning(true);
    setSelectionPlanState({ status: "loading" });
    try {
      const nextConfig = await saveCurrentAgentConfig();
      const selectionPlan = await createSelectionPlanForConfig(nextConfig);
      setSelectionPlanState({ status: "ready", data: selectionPlan, source: "api" });
      setView("run-workflow");
    } catch (error) {
      setSelectionPlanState({
        status: "error",
        message: error instanceof Error ? error.message : "LLM 攻击库选择失败。",
      });
    } finally {
      setPlanning(false);
    }
  }

  async function runE2E() {
    setRunning(true);
    try {
      const nextConfig = await saveCurrentAgentConfig();
      const selectionPlan =
        selectionPlanState.status === "ready" &&
        selectionPlanState.data.status === "ready" &&
        selectionPlanState.data.agentId === nextConfig.agentId &&
        selectionPlanState.data.requestedCaseCount === selectionCaseCount
          ? selectionPlanState.data
          : await createSelectionPlanForConfig(nextConfig);
      setSelectionPlanState({ status: "ready", data: selectionPlan, source: "api" });
      if (selectionPlan.status !== "ready") {
        throw new Error(
          `攻击库选择计划未就绪，当前状态为 ${selectionPlan.status}。请检查覆盖率要求。`,
        );
      }
      const started = await agentGuardApi.runE2E(nextConfig, {
        selectionPlanId: selectionPlan.selectionPlanId,
        generateDefenseReport: nextConfig.adapterKind !== "openclaw",
      });
      if (started.runGroup?.runGroupId) {
        cancelledRunIdsRef.current.delete(started.runGroup.runGroupId);
        acceptRunGroupProgress(started.runGroup);
        await waitForRunGroup(
          started.runGroup.runGroupId,
          1_200_000,
          acceptRunGroupProgress,
          () => cancelledRunIdsRef.current.has(started.runGroup.runGroupId),
        );
      }
      const [summary, runGroups, system] = await Promise.all([
        agentGuardApi.dashboardSummary(),
        agentGuardApi.runGroups(),
        agentGuardApi.systemStatus(),
      ]);
      setSummaryState({ status: "ready", data: summary, source: "api" });
      setRunGroupsState({ status: "ready", data: runGroups, source: "api" });
      setSystemState({ status: "ready", data: system, source: "api" });
      await loadDetails(summary);
      setView("run-workflow");
    } catch (error) {
      setSummaryState((current) =>
        current.status === "ready"
          ? current
          : {
              status: "error",
              message:
                error instanceof Error
                  ? `${error.message}。确认 npm run api:start 是否已启动。`
                  : "生成监督策略包失败。确认 npm run api:start 是否已启动。",
              fallback: mockDashboardSummary,
            },
      );
      setSelectionPlanState({
        status: "error",
        message: error instanceof Error ? error.message : "LLM 攻击库选择或检测编排失败。",
      });
    } finally {
      setRunning(false);
    }
  }

  async function cancelRun(runGroupId: string) {
    setCanceling(true);
    cancelledRunIdsRef.current.add(runGroupId);
    try {
      const result = await agentGuardApi.cancelRunGroup(runGroupId);
      acceptRunGroupProgress(result.runGroup);
      const [summary, runGroups, system] = await Promise.all([
        agentGuardApi.dashboardSummary(),
        agentGuardApi.runGroups(),
        agentGuardApi.systemStatus(),
      ]);
      setSummaryState({ status: "ready", data: summary, source: "api" });
      setRunGroupsState({ status: "ready", data: runGroups, source: "api" });
      setSystemState({ status: "ready", data: system, source: "api" });
      await loadDetails(summary);
    } catch (error) {
      setSelectionPlanState({
        status: "error",
        message: error instanceof Error ? error.message : "停止检测失败。",
      });
    } finally {
      setRunning(false);
      setCanceling(false);
    }
  }

  async function activateRealtimePolicy() {
    if (detectionState.status !== "ready") {
      return;
    }
    const policyPackId = detectionState.data.policyPack.policyPackId;
    await activateRealtimePolicyPack(policyPackId, { openSupervisionAfterActivation: true });
  }

  async function activateRunGroupRealtimePolicy(runGroup: CLineRunGroup) {
    if (!runGroup.policyPackId) {
      setRealtimePolicyActivationError(`运行组 ${runGroup.runGroupId} 尚未生成策略包。`);
      return;
    }
    setSelectedRunGroupId(runGroup.runGroupId);
    await activateRealtimePolicyPack(runGroup.policyPackId, {
      openSupervisionAfterActivation: false,
    });
  }

  async function activateRealtimePolicyPack(
    policyPackId: string,
    options: { openSupervisionAfterActivation: boolean },
  ) {
    setActivatingRealtimePolicyPackId(policyPackId);
    setRealtimePolicyActivationError(undefined);
    try {
      const activePolicy = await agentGuardApi.setRealtimeActivePolicy(policyPackId, true);
      setActiveRealtimePolicy(activePolicy);
      if (options.openSupervisionAfterActivation) {
        openSupervision();
      }
    } catch (error) {
      setRealtimePolicyActivationError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setActivatingRealtimePolicyPackId(undefined);
    }
  }

  function openSupervision() {
    setSupervisionMounted(true);
    setView("supervision");
  }

  function acceptRealtimeEvent(event: LiveSupervisionEvent) {
    if (!shouldShowRealtimeToast(event)) return;
    const id = event.eventId ?? `${event.type}.${event.timestamp}.${Math.random().toString(36).slice(2)}`;
    setRealtimeToasts((current) =>
      [{ id, event }, ...current.filter((item) => item.id !== id)].slice(0, REALTIME_TOAST_LIMIT),
    );
    window.setTimeout(() => dismissRealtimeToast(id), REALTIME_TOAST_TTL_MS);
  }

  function dismissRealtimeToast(id: string) {
    setRealtimeToasts((current) => current.filter((item) => item.id !== id));
  }

  function acceptRealtimeDefenseReport(detail: DefenseDetailView) {
    setDefenseState({ status: "ready", data: detail, source: "api" });
    if (detail.reportBundle) {
      setReportBundleState({ status: "ready", data: detail.reportBundle, source: "api" });
    }
  }

  async function saveAgentConfig(next: AgentConnectionConfig) {
    persistAgentConfig(next);
    try {
      const saved = await agentGuardApi.saveAgent(next);
      persistAgentConfig({ ...next, ...saved.agent });
    } catch (error) {
      console.error("Failed to persist agent config to API", error);
    }
  }

  function persistAgentConfig(next: AgentConnectionConfig) {
    setAgentConfig(next);
    localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(next));
  }

  async function saveCurrentAgentConfig(): Promise<AgentConnectionConfig> {
    const saved = await agentGuardApi.saveAgent(agentConfig);
    const nextConfig = { ...agentConfig, ...saved.agent };
    persistAgentConfig(nextConfig);
    return nextConfig;
  }

  async function createSelectionPlanForConfig(
    config: AgentConnectionConfig,
  ): Promise<TestSelectionPlan> {
    return agentGuardApi.createTestSelectionPlan(
      buildLlmSelectionRequest(config, selectionCaseCount),
    );
  }

  function updateSelectionCaseCount(nextCount: number) {
    const normalized = normalizeSelectionCaseCount(nextCount);
    setSelectionCaseCount(normalized);
    localStorage.setItem(SELECTION_CASE_COUNT_STORAGE_KEY, String(normalized));
  }

  function acceptRunGroupProgress(runGroup: CLineRunGroup) {
    setSelectedRunGroupId(runGroup.runGroupId);
    setRunGroupsState((current) => mergeRunGroupListState(current, runGroup));
    setSummaryState((current) => mergeDashboardSummaryState(current, runGroup));
  }

  const desktopStatus = desktopServiceStatus(systemState);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">AS</div>
          <div>
            <strong>{PRODUCT_NAME}</strong>
          </div>
        </div>
        <div className="sidebar-runtime-card">
          <span>API</span>
          <strong>{desktopStatus.apiPort}</strong>
          <small>{desktopStatus.endpoint}</small>
        </div>
        <nav>
          <button className={view === "agent" ? "active" : ""} onClick={() => setView("agent")}>
            智能体接入
          </button>
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            总览
          </button>
          <button
            className={view === "run-workflow" ? "active" : ""}
            onClick={() => setView("run-workflow")}
          >
            检测编排
          </button>
          <button className={view === "supervision" ? "active" : ""} onClick={openSupervision}>
            实时监督
          </button>
          <button
            className={view === "runtime-config" ? "active" : ""}
            onClick={() => setView("runtime-config")}
          >
            运行配置
          </button>
          <button
            className={view === "report-workspace" ? "active" : ""}
            onClick={() => setView("report-workspace")}
          >
            报告工作台
          </button>
          <button className={view === "defense" ? "active" : ""} onClick={() => setView("defense")}>
            防御报告
          </button>
          <button className={view === "evidence" ? "active" : ""} onClick={() => setView("evidence")}>
            证据中心
          </button>
        </nav>
      </aside>

      <main className="main-surface">
        <section className="desktop-topbar" aria-label="桌面运行状态">
          <div className="desktop-health-strip">
            <span className={`health-dot ${desktopStatus.tone}`} />
            <span>{desktopStatus.label}</span>
            <code>{desktopStatus.endpoint}</code>
          </div>
        </section>
        {view === "agent" ? (
          <AgentConnectPage
            config={agentConfig}
            onSave={saveAgentConfig}
          />
        ) : null}
        {view === "dashboard" ? (
          <DashboardPage state={summaryState} />
        ) : null}
        {view === "run-workflow" ? (
          <RunWorkflowPage
            onCreateSelectionPlan={() => void createSelectionPlan()}
            onCancelRun={(runGroupId) => void cancelRun(runGroupId)}
            onRun={() => void runE2E()}
            onSelectionCaseCountChange={updateSelectionCaseCount}
            canceling={canceling}
            planning={planning}
            running={running}
            selectionCaseCount={selectionCaseCount}
            selectionPlanState={selectionPlanState}
            summaryState={summaryState}
          />
        ) : null}
        {supervisionMounted ? (
          <div hidden={view !== "supervision"}>
            <LiveSupervisionPage
              onGoDefense={() => setView("defense")}
              onRealtimeEvent={acceptRealtimeEvent}
              onReportGenerated={acceptRealtimeDefenseReport}
            />
          </div>
        ) : null}
        {view === "runtime-config" ? <RuntimeConfigPage /> : null}
        {view === "report-workspace" ? (
          <ReportWorkspacePage
            selectionPlanState={selectionPlanState}
            state={reportBundleState}
          />
        ) : null}
        {view === "defense" ? (
          <DefenseReportPage
            state={defenseState}
          />
        ) : null}
        {view === "evidence" ? (
          <EvidenceCenterPage
            activeTab={evidenceTab}
            activeRealtimePolicyPackId={activeRealtimePolicy?.resolvedPolicyPackId}
            activatingRealtimePolicyPackId={activatingRealtimePolicyPackId}
            detectionState={detectionState}
            onActivateRealtime={() => void activateRealtimePolicy()}
            onActivateRunPolicy={(runGroup) => void activateRunGroupRealtimePolicy(runGroup)}
            onSelectRunGroup={(runGroup) => void loadDetailsForRunGroup(runGroup)}
            onTabChange={setEvidenceTab}
            realtimePolicyActivationError={realtimePolicyActivationError}
            runGroupsState={runGroupsState}
            selectedRunGroupId={selectedRunGroupId}
            summaryState={summaryState}
            systemState={systemState}
            traceState={traceState}
          />
        ) : null}
      </main>
      {realtimeToasts.length ? (
        <div className="realtime-toast-stack" aria-live="polite">
          {realtimeToasts.map((toast) => (
            <article className={`realtime-toast ${realtimeToastTone(toast.event)}`} key={toast.id}>
              <button
                aria-label="关闭实时事件提示"
                className="toast-close"
                onClick={() => dismissRealtimeToast(toast.id)}
                type="button"
              >
                ×
              </button>
              <strong>{realtimeToastTitle(toast.event)}</strong>
              <p>{realtimeToastMessage(toast.event)}</p>
              <button className="secondary-button" onClick={openSupervision} type="button">
                查看实时监督
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function desktopServiceStatus(state: LoadState<SystemStatus>): {
  apiPort: string;
  endpoint: string;
  label: string;
  tone: "is-ready" | "is-warn" | "is-loading";
} {
  const endpoint = "127.0.0.1:3100";
  if (state.status === "ready") {
    const openClawReady = state.data.health?.openclawCli === true;
    return {
      apiPort: "3100",
      endpoint,
      label: openClawReady ? "服务在线，OpenClaw 可用" : "服务在线，OpenClaw 待配置",
      tone: openClawReady ? "is-ready" : "is-warn",
    };
  }
  if (state.status === "error") {
    return {
      apiPort: "3100",
      endpoint,
      label: "等待 API",
      tone: "is-warn",
    };
  }
  return {
    apiPort: "3100",
    endpoint,
    label: "启动中",
    tone: "is-loading",
  };
}

type RealtimeToast = {
  id: string;
  event: LiveSupervisionEvent;
};

function shouldShowRealtimeToast(event: LiveSupervisionEvent): boolean {
  if (event.type === "supervision_decision") return true;
  if (event.type === "tool_call_result" && event.blocked) return true;
  if (event.type === "provider_tools_refreshed" || event.type === "provider_refresh_failed") {
    return true;
  }
  return event.type === "live_error" || event.type === "defense_report_generated";
}

function realtimeToastTitle(event: LiveSupervisionEvent): string {
  if (event.type === "supervision_decision" && event.action) {
    return `实时监督判定: ${eventActionLabel(event.action)}`;
  }
  if (event.type === "tool_call_result" && event.blocked) {
    return "工具调用已阻断";
  }
  if (event.type === "provider_tools_refreshed") {
    return "外部 MCP 工具已接入";
  }
  if (event.type === "provider_refresh_failed") {
    return "外部 MCP 接入失败";
  }
  if (event.type === "defense_report_generated") {
    return "防御报告已生成";
  }
  return "实时监听异常";
}

function realtimeToastMessage(event: LiveSupervisionEvent): string {
  if (event.message) return event.message;
  if (event.toolId) return `${event.toolId}${event.blocked ? " 被阻断" : " 已完成"}`;
  if (event.detail && typeof event.detail.toolCount === "number") {
    return `已加载 ${event.detail.toolCount} 个外部工具`;
  }
  if (event.record?.policyId) return `命中策略 ${event.record.policyId}`;
  return event.runtimeSessionId ? `会话 ${event.runtimeSessionId}` : "收到实时监督事件";
}

function realtimeToastTone(event: LiveSupervisionEvent): string {
  if (event.type === "live_error") return "tone-critical";
  if (event.type === "provider_refresh_failed") return "tone-critical";
  if (event.blocked || event.action === "deny") return "tone-critical";
  if (event.action === "ask" || event.action === "redact" || event.action === "warn") {
    return "tone-high";
  }
  return "tone-medium";
}

function eventActionLabel(action: NonNullable<LiveSupervisionEvent["action"]>): string {
  const labels: Record<NonNullable<LiveSupervisionEvent["action"]>, string> = {
    allow: "放行",
    deny: "阻断",
    ask: "确认",
    warn: "告警",
    redact: "脱敏",
    isolate: "隔离",
  };
  return labels[action];
}

function buildLlmSelectionRequest(
  config: AgentConnectionConfig,
  selectionCaseCount: number,
): TestSelectionRequest {
  const useLargeCorpus = config.adapterKind === "openclaw";
  const maxCaseCount = normalizeSelectionCaseCount(selectionCaseCount);
  const requiredAttackFamilies = requiredAttackFamiliesForBudget(maxCaseCount);
  const requiredTargetSurfaces = requiredTargetSurfacesForBudget(maxCaseCount);
  return {
    schemaVersion: "mvp-1",
    agentId: config.agentId,
    targetProfile: selectionTargetProfile(config, maxCaseCount),
    selectionMode: "llm_assisted",
    maxCaseCount,
    minCaseCount: Math.max(3, Math.min(maxCaseCount, useLargeCorpus ? 120 : 48)),
    requiredAttackFamilies,
    requiredTargetSurfaces,
    includeExternalTools: true,
    adapterKind: config.adapterKind,
  };
}

function selectionTargetProfile(
  config: AgentConnectionConfig,
  maxCaseCount: number,
): TestSelectionRequest["targetProfile"] {
  if (config.adapterKind !== "openclaw") {
    return maxCaseCount <= 30 ? "smoke" : "regression";
  }
  if (maxCaseCount <= 80) return "openclaw";
  if (maxCaseCount <= 160) return "regression";
  return "full-corpus";
}

function requiredAttackFamiliesForBudget(
  maxCaseCount: number,
): string[] {
  if (maxCaseCount >= 30) {
    return [
      "prompt_injection",
      "data_leakage",
      "tool_hijack",
      "auth_bypass",
      "dangerous_action",
      "model_evasion",
      "memory_poisoning",
    ];
  }
  if (maxCaseCount >= 8) {
    return ["prompt_injection", "data_leakage", "tool_hijack", "dangerous_action"];
  }
  return ["prompt_injection", "data_leakage", "tool_hijack"];
}

function requiredTargetSurfacesForBudget(maxCaseCount: number): string[] {
  if (maxCaseCount >= 30) {
    return ["tool_call", "file_access", "api", "network", "memory", "output"];
  }
  if (maxCaseCount >= 10) {
    return ["tool_call", "file_access", "api", "network"];
  }
  if (maxCaseCount >= 8) {
    return ["tool_call", "file_access", "api"];
  }
  return ["tool_call", "file_access"];
}

async function loadSelectionPlanForRunGroup(
  runGroup: CLineRunGroup,
  setSelectionPlanState: (state: LoadState<TestSelectionPlan>) => void,
): Promise<void> {
  if (!runGroup.selectionPlanId) {
    setSelectionPlanState({
      status: "empty",
      message: `运行组 ${runGroup.runGroupId} 未绑定攻击库选择计划。`,
    });
    return;
  }

  setSelectionPlanState({ status: "loading" });
  try {
    const plan = await agentGuardApi.testSelectionPlan(runGroup.selectionPlanId);
    setSelectionPlanState({ status: "ready", data: plan, source: "api" });
  } catch (error) {
    setSelectionPlanState({
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function loadStoredAgentConfig(): AgentConnectionConfig {
  try {
    const raw = localStorage.getItem(AGENT_CONFIG_STORAGE_KEY);
    if (!raw) return defaultAgentConfig;
    const parsed = JSON.parse(raw) as Partial<AgentConnectionConfig>;
    const adapterKind = parsed.adapterKind ?? defaultAgentConfig.adapterKind;
    const migratedOpenClawCliPath =
      adapterKind === "openclaw" &&
      defaultOpenClawCliPath &&
      parsed.openclawCliPath?.toLowerCase().startsWith("f:\\openclaw\\")
        ? defaultOpenClawCliPath
        : parsed.openclawCliPath;
    return {
      ...defaultAgentConfig,
      ...parsed,
      adapterKind,
      openclawCliPath: migratedOpenClawCliPath ?? defaultAgentConfig.openclawCliPath,
      caseIds: Array.isArray(parsed.caseIds) && parsed.caseIds.length
        ? parsed.caseIds.filter((item): item is string => typeof item === "string")
        : defaultAgentConfig.caseIds,
      timeoutMs: normalizeAgentTimeoutMs(adapterKind, parsed.timeoutMs),
    };
  } catch {
    return defaultAgentConfig;
  }
}

function hasStoredAgentConfig(): boolean {
  return Boolean(localStorage.getItem(AGENT_CONFIG_STORAGE_KEY));
}

function loadStoredSelectionCaseCount(): number {
  const stored = Number(localStorage.getItem(SELECTION_CASE_COUNT_STORAGE_KEY));
  return normalizeSelectionCaseCount(stored || DEFAULT_SELECTION_CASE_COUNT);
}

function normalizeSelectionCaseCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SELECTION_CASE_COUNT;
  return Math.max(
    MIN_SELECTION_CASE_COUNT,
    Math.min(MAX_SELECTION_CASE_COUNT, Math.floor(value)),
  );
}

async function waitForRunGroup(
  runGroupId: string,
  timeoutMs = 180000,
  onProgress?: (runGroup: CLineRunGroup) => void,
  shouldStop?: () => boolean,
): Promise<CLineRunGroup | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (shouldStop?.()) {
      return undefined;
    }
    const result = await agentGuardApi.runGroup(runGroupId);
    onProgress?.(result.runGroup);
    if (result.runGroup.status !== "running") {
      return result.runGroup;
    }
    await sleep(2000);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mergeRunGroupListState(
  current: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>,
  runGroup: CLineRunGroup,
): LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }> {
  if (current.status === "ready") {
    return {
      ...current,
      data: {
        ...current.data,
        runGroups: mergeRunGroups(current.data.runGroups, runGroup),
      },
    };
  }

  return {
    status: "ready",
    source: "api",
    data: {
      schemaVersion: "mvp-1",
      runGroups: [runGroup],
    },
  };
}

function mergeDashboardSummaryState(
  current: LoadState<CLineDashboardSummary>,
  runGroup: CLineRunGroup,
): LoadState<CLineDashboardSummary> {
  if (current.status === "ready") {
    const recentRunGroups = mergeRunGroups(current.data.recentRunGroups, runGroup);
    return {
      ...current,
      data: {
        ...current.data,
        latestRunGroup: runGroup,
        latestRunMetrics:
          current.data.latestRunMetrics?.runGroupId === runGroup.runGroupId
            ? current.data.latestRunMetrics
            : undefined,
        recentRunGroups,
        historicalWindow: current.data.historicalWindow
          ? {
              ...current.data.historicalWindow,
              runCount: Math.max(current.data.historicalWindow.runCount, recentRunGroups.length),
            }
          : undefined,
        totals: {
          ...current.data.totals,
          runGroups: Math.max(current.data.totals.runGroups, recentRunGroups.length),
          traces: Math.max(current.data.totals.traces, runGroup.traceIds.length),
          riskReports: Math.max(current.data.totals.riskReports, runGroup.riskReportIds.length),
        },
      },
    };
  }

  return {
    status: "ready",
    source: "api",
    data: buildRunningDashboardSummary(runGroup),
  };
}

function buildRunningDashboardSummary(runGroup: CLineRunGroup): CLineDashboardSummary {
  return {
    schemaVersion: "mvp-1",
    latestRunGroup: runGroup,
    recentRunGroups: [runGroup],
    historicalWindow: {
      runLimit: 100,
      runCount: 1,
    },
    totals: {
      runGroups: 1,
      traces: runGroup.traceIds.length,
      riskReports: runGroup.riskReportIds.length,
      findings: 0,
      blockedActions: 0,
      redactions: 0,
      askDecisions: 0,
      residualRisks: 0,
    },
    highestRiskLevel: "low",
    countsByCategory: emptyRiskCategoryCounts(),
  };
}

function emptyRiskCategoryCounts(): CLineDashboardSummary["countsByCategory"] {
  return {
    tool_misuse: 0,
    unauthorized_access: 0,
    data_leakage: 0,
    dangerous_action: 0,
    instruction_injection_following: 0,
  };
}

function mergeRunGroups(
  runGroups: CLineRunGroup[],
  next: CLineRunGroup,
): CLineRunGroup[] {
  const rest = runGroups.filter((item) => item.runGroupId !== next.runGroupId);
  return [next, ...rest].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function normalizeAgentTimeoutMs(
  adapterKind: AgentConnectionConfig["adapterKind"],
  value: unknown,
): number {
  const parsed = Number(value);
  const fallback =
    adapterKind === "openclaw" ? DEFAULT_OPENCLAW_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (adapterKind === "openclaw") {
    return Math.max(DEFAULT_OPENCLAW_TIMEOUT_MS, Math.floor(parsed));
  }
  return Math.max(5000, Math.floor(parsed));
}
