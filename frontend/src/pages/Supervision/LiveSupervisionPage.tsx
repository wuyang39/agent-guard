import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import { apiBaseUrl } from "../../lib/api/core";
import type {
  AskTimeoutConfig,
  DefenseDetailView,
  LiveSupervisionEvent,
  MainAgentSupervisionStatus,
  PendingSupervisionAsk,
  RealtimeActivePolicyState,
  RealtimePreparedSession,
} from "../../lib/api/types";
import { actionLabel, actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import {
  addObservedMainSessionKey,
  createLatestOperationGate,
  createRealtimeStreamController,
  shouldDisplayRealtimeEvent,
} from "../../lib/models/realtime";
import type {
  LatestOperationToken,
  RealtimeEventSource,
  RealtimeStreamController,
} from "../../lib/models/realtime";

type LiveSupervisionPageProps = {
  onGoDefense: () => void;
  onReportGenerated: (detail: DefenseDetailView) => void;
  onRealtimeEvent?: (event: LiveSupervisionEvent) => void;
};

export const REALTIME_EVENT_TYPES = [
  "active_policy_updated",
  "session_reset",
  "session_created",
  "tool_call_started",
  "supervision_decision",
  "tool_call_result",
  "provider_tools_refreshed",
  "provider_refresh_failed",
  "supervision_batch_started",
  "supervision_batch_completed",
  "defense_report_generated",
  "native_tool_hook",
] as const satisfies readonly LiveSupervisionEvent["type"][];

const REALTIME_MCP_URL = `${apiBaseUrl}/api/v1/openclaw/realtime/mcp`;

export async function startMainSupervision(
  policyPackId: string,
  commands: {
    ensureAccess: () => Promise<void>;
    mintEventCapability: () => Promise<void>;
    start: (policyPackId: string) => Promise<MainAgentSupervisionStatus>;
    openStream: () => void;
    onListeningError?: (error: unknown) => void;
  },
  operation: LatestOperationToken = { isCurrent: () => true },
): Promise<MainAgentSupervisionStatus> {
  await commands.ensureAccess();
  if (!operation.isCurrent()) {
    throw new Error("Native supervision operation is no longer current.");
  }
  await commands.mintEventCapability();
  if (!operation.isCurrent()) {
    throw new Error("Native supervision operation is no longer current.");
  }
  const status = await commands.start(policyPackId);
  if (!operation.isCurrent()) return status;
  if (status.coverage !== "active" || status.mainLeaseCount !== 1) {
    throw Object.assign(
      new Error(
        status.reasonCode ?? status.detail ??
          `原生监督未激活（coverage=${status.coverage}, mainLeaseCount=${status.mainLeaseCount}）。`,
      ),
      { nativeStatus: status },
    );
  }
  try {
    commands.openStream();
  } catch (error) {
    commands.onListeningError?.(error);
  }
  return status;
}

export async function stopMainSupervision(
  stop: () => Promise<MainAgentSupervisionStatus>,
): Promise<MainAgentSupervisionStatus> {
  return stop();
}

export async function openNativeSupervisionStream(
  commands: {
    mintEventCapability: () => Promise<void>;
    openStream: () => void;
  },
  operation: LatestOperationToken = { isCurrent: () => true },
): Promise<void> {
  await commands.mintEventCapability();
  if (operation.isCurrent()) commands.openStream();
}

export function stopNativeSupervisionStream(
  closeStream: () => void,
  invalidatePendingOpen: () => void,
): void {
  invalidatePendingOpen();
  closeStream();
}

export function nativeStatusFromError(error: unknown): MainAgentSupervisionStatus | undefined {
  if (!error || typeof error !== "object" || !("nativeStatus" in error)) return undefined;
  const status = (error as { nativeStatus?: unknown }).nativeStatus;
  if (!status || typeof status !== "object") return undefined;
  const candidate = status as Partial<MainAgentSupervisionStatus> & {
    scope?: { kind?: unknown; agentId?: unknown };
  };
  const coverages = new Set([
    "off",
    "ready",
    "active",
    "recovery",
    "conditional",
    "unsupported",
    "misconfigured",
  ]);
  if (
    !coverages.has(String(candidate.coverage)) ||
    candidate.scope?.kind !== "agent" ||
    candidate.scope.agentId !== "main" ||
    !Number.isInteger(candidate.activeLeaseCount) ||
    (candidate.mainLeaseCount !== 0 && candidate.mainLeaseCount !== 1) ||
    !hasOptionalString(candidate.policyPackId) ||
    !hasOptionalString(candidate.leaseId) ||
    !(candidate.leaseEpoch === undefined || Number.isInteger(candidate.leaseEpoch)) ||
    !hasOptionalString(candidate.expiresAt) ||
    !hasOptionalString(candidate.gatewayInstanceId) ||
    !hasOptionalString(candidate.reasonCode) ||
    !hasOptionalString(candidate.detail)
  ) {
    return undefined;
  }
  return candidate as MainAgentSupervisionStatus;
}

function hasOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export async function reconcileNativeStatusAfterStartFailure(options: {
  error: unknown;
  operation: LatestOperationToken;
  loadStatus: () => Promise<MainAgentSupervisionStatus>;
  applyStatus: (status: MainAgentSupervisionStatus) => void;
  applyError: (message: string) => void;
}): Promise<void> {
  if (!options.operation.isCurrent()) return;
  const errorMessage = options.error instanceof Error
    ? options.error.message
    : String(options.error);
  options.applyError(errorMessage);

  const embeddedStatus = nativeStatusFromError(options.error);
  if (embeddedStatus) {
    if (!options.operation.isCurrent()) return;
    options.applyStatus(embeddedStatus);
    return;
  }

  try {
    const authoritativeStatus = await options.loadStatus();
    if (!options.operation.isCurrent()) return;
    options.applyStatus(authoritativeStatus);
  } catch {
    // The activation error remains authoritative for the command outcome.
  }
}

export function LiveSupervisionPage({
  onGoDefense,
  onReportGenerated,
  onRealtimeEvent,
}: LiveSupervisionPageProps) {
  const [activePolicy, setActivePolicy] = useState<RealtimeActivePolicyState | undefined>();
  const [nativeStatus, setNativeStatus] = useState<MainAgentSupervisionStatus | undefined>();
  const [preparedSession, setPreparedSession] = useState<RealtimePreparedSession | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [listeningError, setListeningError] = useState<string | undefined>();
  const [events, setEvents] = useState<LiveSupervisionEvent[]>([]);
  const [observedMainSessionKeys, setObservedMainSessionKeys] =
    useState<readonly string[]>([]);
  const [selectedMainSessionId, setSelectedMainSessionId] = useState<string | undefined>();
  const [includeHistory, setIncludeHistory] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [nativeCommandPending, setNativeCommandPending] = useState(false);
  const [pendingAsks, setPendingAsks] = useState<PendingSupervisionAsk[]>([]);
  const [askConfig, setAskConfig] = useState<AskTimeoutConfig | undefined>();
  const [respondingAskIds, setRespondingAskIds] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(false);
  const nativeStatusGateRef = useRef(createLatestOperationGate());
  const streamOpenGateRef = useRef(createLatestOperationGate());
  const onRealtimeEventRef = useRef(onRealtimeEvent);
  const streamControllerRef = useRef<RealtimeStreamController | undefined>(undefined);
  onRealtimeEventRef.current = onRealtimeEvent;

  if (!streamControllerRef.current) {
    streamControllerRef.current = createRealtimeStreamController({
      eventTypes: REALTIME_EVENT_TYPES,
      createEventSource(url, init) {
        const source = init?.withCredentials
          ? new EventSource(url, { withCredentials: true })
          : new EventSource(url);
        return source as unknown as RealtimeEventSource;
      },
      onEvent: acceptStreamEvent,
      onAskConfig: setAskConfig,
      onAskDecision(ask) {
        setPendingAsks((current) =>
          upsertAsk(current, ask).filter((item) => item.status === "pending"),
        );
      },
      onAskResolved(ask) {
        setPendingAsks((current) =>
          upsertAsk(current, ask).filter((item) => item.status === "pending"),
        );
        setRespondingAskIds((current) => {
          const next = new Set(current);
          next.delete(ask.askId);
          return next;
        });
      },
      onError: acceptStreamError,
      onStreamingChange(nextStreaming) {
        if (mountedRef.current) setStreaming(nextStreaming);
      },
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    nativeStatusGateRef.current.mount();
    streamOpenGateRef.current.mount();
    void refreshSupervisionStatus();
    void prepareSession();
    return () => {
      mountedRef.current = false;
      nativeStatusGateRef.current.dispose();
      streamOpenGateRef.current.dispose();
      streamControllerRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (nativeCommandPending) return;
    const timer = window.setInterval(() => {
      void refreshNativeSupervisionStatus();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [nativeCommandPending]);

  async function refreshSupervisionStatus() {
    const operation = nativeStatusGateRef.current.begin();
    setStatusError(undefined);
    try {
      const [nextActivePolicy, nextNativeStatus] = await Promise.all([
        agentGuardApi.activeRealtimePolicy(),
        agentGuardApi.nativeSupervisionStatus(),
      ]);
      if (!operation.isCurrent()) return;
      setActivePolicy(nextActivePolicy);
      setNativeStatus(nextNativeStatus);
    } catch (error) {
      if (!operation.isCurrent()) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshActivePolicy() {
    setStatusError(undefined);
    try {
      const policy = await agentGuardApi.activeRealtimePolicy();
      if (!mountedRef.current) return;
      setActivePolicy(policy);
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshNativeSupervisionStatus() {
    const operation = nativeStatusGateRef.current.begin();
    try {
      const status = await agentGuardApi.nativeSupervisionStatus();
      if (!operation.isCurrent()) return;
      setNativeStatus(status);
    } catch {
      // Keep the last authoritative command result during transient background failures.
    }
  }

  async function prepareSession(policyPackId?: string) {
    setStatusError(undefined);
    try {
      const session = await agentGuardApi.createRealtimeSession(policyPackId);
      if (!mountedRef.current) return;
      setPreparedSession(session);
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function resetSession() {
    setStatusError(undefined);
    try {
      streamControllerRef.current?.close();
      if (preparedSession) {
        await agentGuardApi.resetRealtimeSessions(preparedSession.runtimeSessionId);
        if (!mountedRef.current) return;
      }
      const session = await agentGuardApi.createRealtimeSession(
        activePolicy?.resolvedPolicyPackId,
      );
      if (!mountedRef.current) return;
      setPreparedSession(session);
      setEvents([]);
      setPendingAsks([]);
      setObservedMainSessionKeys([]);
      setSelectedMainSessionId(undefined);
      await refreshActivePolicy();
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startSupervision() {
    if (!activePolicy) return;
    const operation = nativeStatusGateRef.current.begin();
    const streamOperation = streamOpenGateRef.current.begin();
    setNativeCommandPending(true);
    setStatusError(undefined);
    setListeningError(undefined);
    try {
      const status = await startMainSupervision(activePolicy.resolvedPolicyPackId, {
        ensureAccess: agentGuardApi.ensureNativeSupervisionAccess,
        mintEventCapability: agentGuardApi.issueNativeSupervisionEventCapability,
        start: agentGuardApi.startNativeSupervision,
        openStream: () => {
          if (streamOperation.isCurrent()) openStream(includeHistory);
        },
        onListeningError(error) {
          if (!operation.isCurrent()) return;
          setListeningError(error instanceof Error ? error.message : String(error));
        },
      }, operation);
      if (!operation.isCurrent()) return;
      setNativeStatus(status);
    } catch (error) {
      if (!operation.isCurrent()) return;
      await reconcileNativeStatusAfterStartFailure({
        error,
        operation,
        loadStatus: agentGuardApi.nativeSupervisionStatus,
        applyStatus: setNativeStatus,
        applyError: setStatusError,
      });
    } finally {
      if (operation.isCurrent()) setNativeCommandPending(false);
    }
  }

  async function stopSupervision() {
    const operation = nativeStatusGateRef.current.begin();
    setNativeCommandPending(true);
    setStatusError(undefined);
    try {
      const status = await stopMainSupervision(agentGuardApi.stopNativeSupervision);
      if (!operation.isCurrent()) return;
      setNativeStatus(status);
    } catch (error) {
      if (!operation.isCurrent()) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation.isCurrent()) setNativeCommandPending(false);
    }
  }

  function openStream(nextIncludeHistory: boolean) {
    setEvents([]);
    setPendingAsks([]);
    const runtimeSessionId = preparedSession?.runtimeSessionId;
    streamControllerRef.current?.open({
      mainUrl: agentGuardApi.liveSupervisionUrl({ includeHistory: nextIncludeHistory }),
      askUrl: agentGuardApi.supervisionAskStreamUrl({ sessionId: runtimeSessionId }),
      runtimeSessionId,
      includeHistory: nextIncludeHistory,
    });
  }

  function acceptStreamEvent(
    event: LiveSupervisionEvent,
    context: { runtimeSessionId: string | undefined; includeHistory: boolean },
  ) {
    if (event.type === "native_tool_hook") {
      setObservedMainSessionKeys((current) => addObservedMainSessionKey(current, event));
    }
    if (!shouldDisplayRealtimeEvent(
      event,
      context.runtimeSessionId,
      context.includeHistory,
    )) return;
    setEvents((current) => [...current, event]);
    if (!context.includeHistory) onRealtimeEventRef.current?.(event);
    if (event.type === "active_policy_updated") void refreshActivePolicy();
  }

  function acceptStreamError(message: string) {
    const errorEvent: LiveSupervisionEvent = {
      timestamp: new Date().toISOString(),
      type: "live_error",
      message,
    };
    setEvents((current) => [...current, errorEvent]);
    setListeningError(message);
    onRealtimeEventRef.current?.(errorEvent);
  }

  async function changeStreamMode(nextIncludeHistory: boolean) {
    setIncludeHistory(nextIncludeHistory);
    if (streaming) {
      const operation = streamOpenGateRef.current.begin();
      try {
        await openNativeSupervisionStream({
          mintEventCapability: agentGuardApi.issueNativeSupervisionEventCapability,
          openStream: () => openStream(nextIncludeHistory),
        }, operation);
      } catch (error) {
        if (!operation.isCurrent()) return;
        setListeningError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  async function respondAsk(askId: string, decision: "approve" | "reject") {
    setRespondingAskIds((current) => new Set(current).add(askId));
    setStatusError(undefined);
    try {
      const resolved = await agentGuardApi.respondSupervisionAsk(askId, decision);
      if (!mountedRef.current) return;
      setPendingAsks((current) =>
        upsertAsk(current, resolved).filter((item) => item.status === "pending"),
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
      setRespondingAskIds((current) => {
        const next = new Set(current);
        next.delete(askId);
        return next;
      });
    }
  }

  async function finalizeReport() {
    setFinalizing(true);
    setStatusError(undefined);
    try {
      const session = preparedSession ?? await agentGuardApi.createRealtimeSession(activePolicy?.resolvedPolicyPackId);
      if (!mountedRef.current) return;
      setPreparedSession(session);
      const detail = await agentGuardApi.finalizeRealtimeDefenseReport(session.runtimeSessionId);
      if (!mountedRef.current) return;
      onReportGenerated(detail);
      onGoDefense();
    } catch (error) {
      if (!mountedRef.current) return;
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current) setFinalizing(false);
    }
  }

  if ((!activePolicy || !nativeStatus) && !statusError) {
    return <LoadingBlock message="正在读取 OpenClaw realtime MCP 与原生监督状态..." />;
  }

  const visibleEvents = events.filter((event) =>
    shouldDisplayRealtimeEvent(
      event,
      preparedSession?.runtimeSessionId,
      includeHistory,
      selectedMainSessionId,
    ),
  );
  const decisionEvents = visibleEvents.filter((event) => event.type === "supervision_decision");
  const denyCount = decisionEvents.filter((event) => event.action === "deny").length;
  const redactCount = decisionEvents.filter((event) => event.action === "redact").length;
  const askCount = decisionEvents.filter((event) => event.action === "ask").length;
  const allowCount = decisionEvents.filter((event) => event.action === "allow").length;
  const newestEvents = [...visibleEvents].reverse();

  return (
    <div className="page-stack fill-page supervision-page">
      <section className="page-hero supervision-hero">
        <div className="hero-copy">
          <p className="eyebrow">实时监督</p>
          <h1>实时监督</h1>
        </div>
        <div className="hero-actions">
          {nativeStatus ? (
            <MainSupervisionToggleButton
              commandPending={nativeCommandPending}
              onStart={() => void startSupervision()}
              onStop={() => void stopSupervision()}
              status={nativeStatus}
            />
          ) : null}
          <button className="primary-button" disabled={finalizing} onClick={finalizeReport}>
            {finalizing ? "生成中..." : "生成防御报告"}
          </button>
        </div>
      </section>

      {statusError ? <ErrorBlock title="实时监督状态读取失败" message={statusError} /> : null}
      {listeningError ? <ErrorBlock title="实时监听失败" message={listeningError} /> : null}

      <section className="workspace-grid supervision-workspace">
        <div className="workspace-main panel grow-panel event-console">
          <div className="section-header compact">
            <div>
              <h2>实时事件流</h2>
            </div>
            <div className="event-toolbar">
              <label className="field event-session-filter">
                <span>原生 main 会话</span>
                <select
                  onChange={(event) =>
                    setSelectedMainSessionId(event.target.value || undefined)
                  }
                  value={selectedMainSessionId ?? ""}
                >
                  <option value="">全部 main 会话</option>
                  {observedMainSessionKeys.map((sessionKey) => (
                    <option key={sessionKey} value={sessionKey}>{sessionKey}</option>
                  ))}
                </select>
              </label>
              <div className="segmented-control" aria-label="实时事件范围">
                <button
                  className={!includeHistory ? "active" : ""}
                  onClick={() => changeStreamMode(false)}
                  type="button"
                >
                  仅实时
                </button>
                <button
                  className={includeHistory ? "active" : ""}
                  onClick={() => changeStreamMode(true)}
                  type="button"
                >
                  含历史
                </button>
              </div>
            </div>
          </div>
          <div className="event-list">
            {visibleEvents.length ? (
              newestEvents.map((event, index) => (
                <article
                  className={`event-row ${eventRowClass(event)}`}
                  key={`${event.eventId ?? event.timestamp}-${index}`}
                >
                  <div className="event-index">{visibleEvents.length - index}</div>
                  <div className="event-body">
                    <div className="event-title">
                      <strong>{eventTitle(event)}</strong>
                      <span>{formatDateTime(event.timestamp)}</span>
                      {event.action ? (
                        <Badge tone={actionTone(event.action)}>
                          {actionLabel(event.action)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="muted">{event.message ?? summarizeEvent(event)}</p>
                    <RealtimeEventDiagnostics event={event} />
                  </div>
                </article>
              ))
            ) : (
              <p className="muted">
                监听后会显示实时监督判定。
              </p>
            )}
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <div className="section-header compact">
              <h2>实时 MCP</h2>
            </div>
            <DeveloperDetails
              defaultOpen
              items={[
                { label: "MCP 地址", value: REALTIME_MCP_URL },
                { label: "策略包", value: activePolicy?.resolvedPolicyPackId },
                {
                  label: "策略来源",
                  value: activePolicy ? activePolicySourceLabel(activePolicy.source) : undefined,
                },
                { label: "策略数量", value: activePolicy?.policyCount },
                { label: "运行组", value: activePolicy?.runGroupId },
                { label: "会话", value: preparedSession?.runtimeSessionId },
                { label: "Trace", value: preparedSession?.traceId },
              ]}
            />
            <div className="button-row rail-actions">
              <button className="secondary-button" onClick={() => void refreshActivePolicy()}>
                刷新策略
              </button>
              <button className="secondary-button" onClick={() => void resetSession()}>
                重置会话
              </button>
            </div>
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>监督判定</h2>
              <Badge>{decisionEvents.length} 条判定</Badge>
            </div>
            <div className="decision-grid">
              <div>
                <span>放行</span>
                <strong>{allowCount}</strong>
              </div>
              <div>
                <span>阻断</span>
                <strong>{denyCount}</strong>
              </div>
              <div>
                <span>脱敏</span>
                <strong>{redactCount}</strong>
              </div>
              <div>
                <span>确认</span>
                <strong>{askCount}</strong>
              </div>
            </div>
          </div>

          <div className="rail-section ask-approval-panel">
            <div className="section-header compact">
              <h2>人工确认</h2>
              <Badge tone={pendingAsks.length ? "tone-high" : "tone-low"}>
                {pendingAsks.length} 个待处理
              </Badge>
            </div>
            {askConfig ? (
              <p className="muted compact-note">
                超时 {Math.round(askConfig.timeoutMs / 1000)} 秒，默认
                {askConfig.defaultAction === "demo_approve" ? "通过" : "拒绝"}。
              </p>
            ) : null}
            <div className="ask-card-list">
              {pendingAsks.length ? (
                pendingAsks.map((ask) => (
                  <article className="ask-card" key={ask.askId}>
                    <div className="ask-card-head">
                      <strong>{ask.targetType}</strong>
                      <Badge tone={ask.riskLevel === "critical" || ask.riskLevel === "high" ? "tone-high" : "tone-medium"}>
                        {ask.riskLevel}
                      </Badge>
                    </div>
                    <p>{ask.reason}</p>
                    <DeveloperDetails
                      items={[
                        { label: "Ask", value: ask.askId },
                        { label: "Policy", value: ask.policyId },
                        { label: "Target", value: ask.targetId },
                        { label: "Created", value: formatDateTime(ask.createdAt) },
                      ]}
                      title="确认详情"
                    />
                    <div className="button-row ask-actions">
                      <button
                        className="primary-button"
                        disabled={respondingAskIds.has(ask.askId)}
                        onClick={() => void respondAsk(ask.askId, "approve")}
                        type="button"
                      >
                        通过
                      </button>
                      <button
                        className="secondary-button ask-reject-button"
                        disabled={respondingAskIds.has(ask.askId)}
                        onClick={() => void respondAsk(ask.askId, "reject")}
                        type="button"
                      >
                        拒绝
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="muted">暂无待确认</p>
              )}
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

export function MainSupervisionToggleButton({
  status,
  commandPending,
  onStart,
  onStop,
}: {
  status: MainAgentSupervisionStatus;
  commandPending: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const supervisionEnabled = status.mainLeaseCount > 0;

  return (
    <button
      aria-label="main Agent 原生工具监督"
      className={`${supervisionEnabled ? "secondary-button" : "primary-button"} hero-button`}
      disabled={commandPending}
      onClick={supervisionEnabled ? onStop : onStart}
      type="button"
    >
      {commandPending ? "处理中..." : supervisionEnabled ? "停止监督" : "开始监督"}
    </button>
  );
}

function upsertAsk(
  current: PendingSupervisionAsk[],
  nextAsk: PendingSupervisionAsk,
): PendingSupervisionAsk[] {
  const rest = current.filter((item) => item.askId !== nextAsk.askId);
  return [nextAsk, ...rest].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function RealtimeEventDiagnostics({ event }: { event: LiveSupervisionEvent }) {
  const record = event.record;
  const detailPayload = {
    detail: event.detail,
    status: event.status,
    runGroup: event.runGroup,
    record: event.record,
  };
  const hasPayload = Boolean(event.detail || event.status || event.runGroup || event.record);

  return (
    <DeveloperDiagnostics count={hasPayload ? 1 : 0} title="事件明细">
      <DiagnosticSection title="事件索引">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Event", value: event.eventId },
            { label: "Type", value: event.type },
            { label: "Runtime session", value: event.runtimeSessionId },
            { label: "Policy pack", value: event.policyPackId },
            { label: "Trace", value: event.traceId },
            { label: "Case", value: event.caseId },
            { label: "Tool ID", value: event.toolId },
            { label: "Tool name", value: event.toolName },
            { label: "Target type", value: event.targetType },
            { label: "Action", value: event.action },
            { label: "Blocked", value: event.blocked },
            { label: "Defense report", value: event.defenseReportId },
            { label: "Risk reports", value: event.riskReportCount },
            { label: "Traces", value: event.traceCount },
            { label: "Events", value: event.eventCount },
            { label: "Timestamp", value: formatDateTime(event.timestamp) },
          ]}
        />
      </DiagnosticSection>
      {record ? (
        <DiagnosticSection title="RuntimeSupervisionRecord">
          <DiagnosticKeyValueGrid
            items={[
              { label: "Record", value: record.recordId },
              { label: "Runtime session", value: record.runtimeSessionId },
              { label: "Agent", value: record.agentId },
              { label: "Policy pack", value: record.policyPackId },
              { label: "Policy", value: record.policyId },
              { label: "Action", value: record.action },
              { label: "Target type", value: record.targetType },
              { label: "Target", value: record.targetId },
              { label: "Input event", value: record.inputEventId },
              { label: "Output event", value: record.outputEventId },
              { label: "Created", value: formatDateTime(record.createdAt) },
            ]}
          />
          <DiagnosticJson value={record.gateway} emptyLabel="暂无 gateway runtime context" />
        </DiagnosticSection>
      ) : null}
      {hasPayload ? (
        <DiagnosticSection title="事件 Payload">
          <DiagnosticJson value={detailPayload} />
        </DiagnosticSection>
      ) : null}
    </DeveloperDiagnostics>
  );
}

function summarizeEvent(event: LiveSupervisionEvent): string {
  if (event.type === "tool_call_started") {
    return event.toolId ? `${event.toolId} 开始调用` : "工具调用已开始";
  }
  if (event.type === "tool_call_result") {
    return `${event.toolId} ${event.blocked ? "已阻断" : "已完成"}`;
  }
  if (event.type === "active_policy_updated") {
    return "监督策略已更新";
  }
  if (event.type === "provider_tools_refreshed") {
    return "外部 MCP 工具已接入";
  }
  if (event.type === "provider_refresh_failed") {
    return "外部 MCP 工具接入失败";
  }
  if (event.type === "supervision_batch_started") {
    return "批量监督测试已开始";
  }
  if (event.type === "supervision_batch_completed") {
    return "批量监督测试已完成";
  }
  if (event.type === "defense_report_generated") {
    return "防御报告已生成";
  }
  return "";
}

function eventTitle(event: LiveSupervisionEvent): string {
  if (event.type === "supervision_decision" && event.action) {
    return `${actionLabel(event.action)} 判定`;
  }
  return eventTypeLabel(event.type);
}

function eventTypeLabel(type: LiveSupervisionEvent["type"]): string {
  const labels: Record<LiveSupervisionEvent["type"], string> = {
    active_policy_updated: "策略已更新",
    session_reset: "会话已重置",
    session_created: "会话已创建",
    tool_call_started: "工具调用开始",
    supervision_decision: "监督判定",
    tool_call_result: "工具调用结果",
    provider_tools_refreshed: "外部工具已接入",
    provider_refresh_failed: "外部工具接入失败",
    supervision_batch_started: "批量测试开始",
    supervision_batch_completed: "批量测试完成",
    defense_report_generated: "防御报告已生成",
    native_tool_hook: "原生工具 Hook",
    live_error: "实时连接错误",
  };
  return labels[type];
}

function eventRowClass(event: LiveSupervisionEvent): string {
  if (event.type === "supervision_decision" && event.action) {
    return `event-row-${event.action}`;
  }
  if (event.type === "tool_call_result" && event.blocked) {
    return "event-row-deny";
  }
  if (event.type === "provider_refresh_failed") {
    return "event-row-warn";
  }
  if (event.type === "live_error") {
    return "event-row-warn";
  }
  return "";
}

function activePolicySourceLabel(source: RealtimeActivePolicyState["source"]): string {
  const labels: Record<RealtimeActivePolicyState["source"], string> = {
    request: "指定策略",
    active: "当前策略",
    env: "环境配置",
    latest: "最新运行",
    fallback: "兜底策略",
  };
  return labels[source];
}
