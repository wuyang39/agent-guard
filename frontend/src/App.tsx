import { useCallback, useEffect, useState } from "react";
import type { TestSelectionPlan, TestSelectionRequest } from "@agent-guard/contracts";
import { agentGuardApi } from "./lib/api/client";
import {
  mockDashboardSummary,
  mockDefenseDetail,
  mockDetectionDetail,
  mockTraceDetail,
} from "./lib/api/mockData";
import type {
  AgentConnectionConfig,
  CLineDashboardSummary,
  CLineRunGroup,
  DefenseDetailView,
  DetectionDetailView,
  LoadState,
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
import { LiveSupervisionPage } from "./pages/Supervision/LiveSupervisionPage";

type ViewKey =
  | "agent"
  | "dashboard"
  | "supervision"
  | "runtime-config"
  | "defense"
  | "evidence";

const AGENT_CONFIG_STORAGE_KEY = "agent-guard.agent-config";

const defaultOpenClawCliPath = import.meta.env.VITE_OPENCLAW_CLI_PATH ?? "";

const defaultAgentConfig: AgentConnectionConfig = {
  adapterKind: "openclaw",
  agentId: "agent.openclaw.demo",
  name: "OpenClaw CLI Agent",
  description: "用于检测并生成监督策略包的本地 OpenClaw 智能体。",
  openclawCliPath: defaultOpenClawCliPath,
  gatewayUrl: "http://127.0.0.1:18789",
  endpointUrl: "http://127.0.0.1:7001/agent/run?mode=vulnerable",
  timeoutMs: 120000,
  caseIds: ["case.resource_injection"],
};

export function App() {
  const [view, setView] = useState<ViewKey>("dashboard");
  const [evidenceTab, setEvidenceTab] = useState<EvidenceTabKey>("runs");
  const [agentConfig, setAgentConfig] = useState<AgentConnectionConfig>(() =>
    loadStoredAgentConfig(),
  );
  const [running, setRunning] = useState(false);
  const [planning, setPlanning] = useState(false);
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
  const [runGroupsState, setRunGroupsState] = useState<
    LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>
  >({ status: "idle" });
  const [systemState, setSystemState] = useState<LoadState<SystemStatus>>({
    status: "idle",
  });
  const [selectedRunGroupId, setSelectedRunGroupId] = useState<string | undefined>();

  const useMock = useCallback(() => {
    setSummaryState({ status: "ready", data: mockDashboardSummary, source: "mock" });
    setDetectionState({ status: "ready", data: mockDetectionDetail, source: "mock" });
    setDefenseState({ status: "ready", data: mockDefenseDetail, source: "mock" });
    setTraceState({ status: "ready", data: mockTraceDetail, source: "mock" });
    setSelectionPlanState({ status: "empty", message: "示例数据不包含攻击库选择计划。" });
    setRunGroupsState({
      status: "ready",
      data: { schemaVersion: "mvp-1", runGroups: mockDashboardSummary.recentRunGroups },
      source: "mock",
    });
    setSelectedRunGroupId(mockDashboardSummary.latestRunGroup?.runGroupId);
  }, []);

  const loadDefenseForRunGroup = useCallback(async (runGroup: CLineRunGroup): Promise<void> => {
    if (!runGroup.defenseReportId) {
      setDefenseState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 尚未生成防御报告。完成实时监督后再生成防御报告。`,
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

    if (runGroup.detectionReportId) {
      setDetectionState({ status: "loading" });
    } else {
      setDetectionState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 尚未生成检测报告，当前阶段为 ${runGroup.phase}。`,
      });
    }

    const traceId = runGroup.traceIds[0];
    if (traceId) {
      setTraceState({ status: "loading" });
    } else {
      setTraceState({
        status: "empty",
        message: `运行组 ${runGroup.runGroupId} 尚未产生调用轨迹。`,
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
        message: "尚无攻击库选择计划。请先执行 LLM 选样并生成监督策略包。",
      });
      setDetectionState({
        status: "empty",
        message: "尚无检测报告。请先生成监督策略包。",
      });
      setDefenseState({
        status: "empty",
        message: "尚无防御报告。生成策略包并完成实时监督后即可生成防御报告。",
      });
      setTraceState({
        status: "empty",
        message: "尚无调用轨迹。请先生成监督策略包。",
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
          message: "服务已连接，但当前还没有运行记录。",
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
            ? `${error.message}。请确认后端服务已启动，也可以先使用示例数据查看页面。`
            : "无法连接后端服务。请确认服务已启动，也可以先使用示例数据查看页面。",
        fallback: mockDashboardSummary,
      });
      setDetectionState({ status: "empty", message: "等待服务数据或示例数据。" });
      setDefenseState({ status: "empty", message: "等待服务数据或示例数据。" });
      setTraceState({ status: "empty", message: "等待服务数据或示例数据。" });
      setRunGroupsState({ status: "empty", message: "等待服务数据或示例数据。" });
      setSystemState({
        status: "error",
        message: "无法连接系统状态接口。确认 Agent Guard API 是否已启动。",
      });
    }
  }, [loadDetails]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  async function createSelectionPlan() {
    setPlanning(true);
    setSelectionPlanState({ status: "loading" });
    try {
      const nextConfig = await saveCurrentAgentConfig();
      const selectionPlan = await createSelectionPlanForConfig(nextConfig);
      setSelectionPlanState({ status: "ready", data: selectionPlan, source: "api" });
      setView("dashboard");
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
        selectionPlanState.data.agentId === nextConfig.agentId
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
        acceptRunGroupProgress(started.runGroup);
        await waitForRunGroup(started.runGroup.runGroupId, 1_200_000, acceptRunGroupProgress);
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
      setView("dashboard");
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
        message: error instanceof Error ? error.message : "LLM 攻击库选择或检测运行失败。",
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
    return agentGuardApi.createTestSelectionPlan(buildLlmSelectionRequest(config));
  }

  function acceptRunGroupProgress(runGroup: CLineRunGroup) {
    setSelectedRunGroupId(runGroup.runGroupId);
    setRunGroupsState((current) => mergeRunGroupListState(current, runGroup));
    setSummaryState((current) =>
      current.status === "ready"
        ? {
            ...current,
            data: {
              ...current.data,
              latestRunGroup: runGroup,
              recentRunGroups: mergeRunGroups(current.data.recentRunGroups, runGroup),
            },
          }
        : current,
    );
  }

  function openEvidence(tab: EvidenceTabKey) {
    setEvidenceTab(tab);
    setView("evidence");
  }

  function selectDashboardTarget(target: "detection" | "defense" | "trace") {
    if (target === "defense") {
      setView("defense");
      return;
    }
    openEvidence(target);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <strong>Agent Guard</strong>
          <span>项目控制台</span>
        </div>
        <nav>
          <button className={view === "agent" ? "active" : ""} onClick={() => setView("agent")}>
            智能体接入
          </button>
          <button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>
            总览
          </button>
          <button className={view === "supervision" ? "active" : ""} onClick={() => setView("supervision")}>
            实时监督
          </button>
          <button
            className={view === "runtime-config" ? "active" : ""}
            onClick={() => setView("runtime-config")}
          >
            运行配置
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
        {view === "agent" ? (
          <AgentConnectPage
            config={agentConfig}
            onSave={saveAgentConfig}
            summaryState={summaryState}
            systemState={systemState}
          />
        ) : null}
        {view === "dashboard" ? (
          <DashboardPage
            onCreateSelectionPlan={() => void createSelectionPlan()}
            onRun={() => void runE2E()}
            onSelectView={selectDashboardTarget}
            onUseMock={useMock}
            planning={planning}
            running={running}
            state={summaryState}
            selectionPlanState={selectionPlanState}
          />
        ) : null}
        {view === "supervision" ? (
          <LiveSupervisionPage
            onGoDefense={() => setView("defense")}
            onGoRuns={() => openEvidence("runs")}
            onReportGenerated={acceptRealtimeDefenseReport}
          />
        ) : null}
        {view === "runtime-config" ? <RuntimeConfigPage /> : null}
        {view === "defense" ? (
          <DefenseReportPage
            onGoDetection={() => openEvidence("detection")}
            onGoTrace={() => openEvidence("trace")}
            state={defenseState}
          />
        ) : null}
        {view === "evidence" ? (
          <EvidenceCenterPage
            activeTab={evidenceTab}
            detectionState={detectionState}
            onActivateRealtime={() => void activateRealtimePolicy()}
            onGoDefense={() => setView("defense")}
            onRun={() => void runE2E()}
            onSelectRunGroup={(runGroup) => void loadDetailsForRunGroup(runGroup)}
            onTabChange={setEvidenceTab}
            runGroupsState={runGroupsState}
            running={running || planning}
            selectedRunGroupId={selectedRunGroupId}
            summaryState={summaryState}
            systemState={systemState}
            traceState={traceState}
          />
        ) : null}
      </main>
    </div>
  );
}

function buildLlmSelectionRequest(config: AgentConnectionConfig): TestSelectionRequest {
  return {
    schemaVersion: "mvp-1",
    agentId: config.agentId,
    targetProfile: "openclaw",
    selectionMode: "llm_assisted",
    maxCaseCount: 5,
    minCaseCount: 3,
    requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
    requiredTargetSurfaces: ["tool_call"],
    includeExternalTools: true,
    adapterKind: config.adapterKind,
  };
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
    return {
      ...defaultAgentConfig,
      ...parsed,
      caseIds: Array.isArray(parsed.caseIds) && parsed.caseIds.length
        ? parsed.caseIds.filter((item): item is string => typeof item === "string")
        : defaultAgentConfig.caseIds,
      timeoutMs: Number(parsed.timeoutMs) || defaultAgentConfig.timeoutMs,
    };
  } catch {
    return defaultAgentConfig;
  }
}

function hasStoredAgentConfig(): boolean {
  return Boolean(localStorage.getItem(AGENT_CONFIG_STORAGE_KEY));
}

async function waitForRunGroup(
  runGroupId: string,
  timeoutMs = 180000,
  onProgress?: (runGroup: CLineRunGroup) => void,
): Promise<CLineRunGroup | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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

function mergeRunGroups(
  runGroups: CLineRunGroup[],
  next: CLineRunGroup,
): CLineRunGroup[] {
  const rest = runGroups.filter((item) => item.runGroupId !== next.runGroupId);
  return [next, ...rest].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}
