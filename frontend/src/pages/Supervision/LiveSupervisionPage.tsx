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
import type {
  AskTimeoutConfig,
  DefenseDetailView,
  LiveSupervisionEvent,
  PendingSupervisionAsk,
  RealtimeActivePolicyState,
  RealtimePreparedSession,
} from "../../lib/api/types";
import { actionLabel, actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { shouldDisplayRealtimeEvent } from "../../lib/models/realtime";

type LiveSupervisionPageProps = {
  onGoDefense: () => void;
  onReportGenerated: (detail: DefenseDetailView) => void;
  onRealtimeEvent?: (event: LiveSupervisionEvent) => void;
};

const REALTIME_EVENT_TYPES: LiveSupervisionEvent["type"][] = [
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
];

const REALTIME_MCP_URL = "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp";

export function LiveSupervisionPage({
  onGoDefense,
  onReportGenerated,
  onRealtimeEvent,
}: LiveSupervisionPageProps) {
  const [activePolicy, setActivePolicy] = useState<RealtimeActivePolicyState | undefined>();
  const [preparedSession, setPreparedSession] = useState<RealtimePreparedSession | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [events, setEvents] = useState<LiveSupervisionEvent[]>([]);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [pendingAsks, setPendingAsks] = useState<PendingSupervisionAsk[]>([]);
  const [askConfig, setAskConfig] = useState<AskTimeoutConfig | undefined>();
  const [respondingAskIds, setRespondingAskIds] = useState<Set<string>>(() => new Set());
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const askSourceRef = useRef<EventSource | undefined>(undefined);

  useEffect(() => {
    void refreshActivePolicy();
    void prepareSession();
    return () => {
      sourceRef.current?.close();
      askSourceRef.current?.close();
    };
  }, []);

  async function refreshActivePolicy() {
    setStatusError(undefined);
    try {
      setActivePolicy(await agentGuardApi.activeRealtimePolicy());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function prepareSession(policyPackId?: string) {
    setStatusError(undefined);
    try {
      setPreparedSession(await agentGuardApi.createRealtimeSession(policyPackId));
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function resetSession() {
    setStatusError(undefined);
    try {
      sourceRef.current?.close();
      askSourceRef.current?.close();
      setStreaming(false);
      if (preparedSession) {
        await agentGuardApi.resetRealtimeSessions(preparedSession.runtimeSessionId);
      }
      setPreparedSession(
        await agentGuardApi.createRealtimeSession(activePolicy?.resolvedPolicyPackId),
      );
      setEvents([]);
      setPendingAsks([]);
      await refreshActivePolicy();
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  function startStream() {
    openStream(includeHistory);
  }

  function openStream(nextIncludeHistory: boolean) {
    sourceRef.current?.close();
    askSourceRef.current?.close();
    setEvents([]);
    setPendingAsks([]);
    setStreaming(true);
    const runtimeSessionId = preparedSession?.runtimeSessionId;
    const source = new EventSource(
      agentGuardApi.liveSupervisionUrl({ includeHistory: nextIncludeHistory }),
    );
    sourceRef.current = source;

    for (const eventType of REALTIME_EVENT_TYPES) {
      source.addEventListener(eventType, (message) => {
        const event = JSON.parse((message as MessageEvent).data) as LiveSupervisionEvent;
        if (!shouldDisplayRealtimeEvent(event, runtimeSessionId, nextIncludeHistory)) {
          return;
        }
        setEvents((current) => [...current, event]);
        if (!nextIncludeHistory) {
          onRealtimeEvent?.(event);
        }
        if (event.type === "active_policy_updated") {
          void refreshActivePolicy();
        }
      });
    }

    source.onerror = () => {
      const errorEvent: LiveSupervisionEvent = {
        timestamp: new Date().toISOString(),
        type: "live_error",
        message: "实时事件连接失败。",
      };
      setEvents((current) => [...current, errorEvent]);
      onRealtimeEvent?.(errorEvent);
      setStreaming(false);
      source.close();
    };

    openAskStream(runtimeSessionId);
  }

  function openAskStream(runtimeSessionId: string | undefined) {
    askSourceRef.current?.close();
    const source = new EventSource(
      agentGuardApi.supervisionAskStreamUrl({ sessionId: runtimeSessionId }),
    );
    askSourceRef.current = source;

    source.addEventListener("config", (message) => {
      setAskConfig(JSON.parse((message as MessageEvent).data) as AskTimeoutConfig);
    });

    source.addEventListener("ask_decision", (message) => {
      const ask = JSON.parse((message as MessageEvent).data) as PendingSupervisionAsk;
      setPendingAsks((current) => upsertAsk(current, ask).filter((item) => item.status === "pending"));
    });

    source.addEventListener("ask_resolved", (message) => {
      const ask = JSON.parse((message as MessageEvent).data) as PendingSupervisionAsk;
      setPendingAsks((current) =>
        upsertAsk(current, ask).filter((item) => item.status === "pending"),
      );
      setRespondingAskIds((current) => {
        const next = new Set(current);
        next.delete(ask.askId);
        return next;
      });
    });

    source.onerror = () => {
      const errorEvent: LiveSupervisionEvent = {
        timestamp: new Date().toISOString(),
        type: "live_error",
        message: "Ask 确认通道连接失败。",
      };
      setEvents((current) => [...current, errorEvent]);
      onRealtimeEvent?.(errorEvent);
      source.close();
    };
  }

  function changeStreamMode(nextIncludeHistory: boolean) {
    setIncludeHistory(nextIncludeHistory);
    if (streaming) {
      openStream(nextIncludeHistory);
    }
  }

  function stopStream() {
    sourceRef.current?.close();
    askSourceRef.current?.close();
    setStreaming(false);
  }

  async function respondAsk(askId: string, decision: "approve" | "reject") {
    setRespondingAskIds((current) => new Set(current).add(askId));
    setStatusError(undefined);
    try {
      const resolved = await agentGuardApi.respondSupervisionAsk(askId, decision);
      setPendingAsks((current) =>
        upsertAsk(current, resolved).filter((item) => item.status === "pending"),
      );
    } catch (error) {
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
      setPreparedSession(session);
      const detail = await agentGuardApi.finalizeRealtimeDefenseReport(session.runtimeSessionId);
      onReportGenerated(detail);
      onGoDefense();
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setFinalizing(false);
    }
  }

  if (!activePolicy && !statusError) {
    return <LoadingBlock message="正在读取 OpenClaw realtime MCP 监督状态..." />;
  }

  const decisionEvents = events.filter((event) => event.type === "supervision_decision");
  const denyCount = decisionEvents.filter((event) => event.action === "deny").length;
  const redactCount = decisionEvents.filter((event) => event.action === "redact").length;
  const askCount = decisionEvents.filter((event) => event.action === "ask").length;
  const allowCount = decisionEvents.filter((event) => event.action === "allow").length;
  const newestEvents = [...events].reverse();

  return (
    <div className="page-stack fill-page supervision-page">
      <section className="page-hero supervision-hero">
        <div className="hero-copy">
          <p className="eyebrow">实时监督</p>
          <h1>实时监督</h1>
        </div>
        <div className="hero-actions">
          <button className="primary-button hero-button" onClick={streaming ? stopStream : startStream}>
            {streaming ? "停止监听" : "监听实时事件"}
          </button>
          <button className="primary-button" disabled={finalizing} onClick={finalizeReport}>
            {finalizing ? "生成中..." : "生成防御报告"}
          </button>
        </div>
      </section>

      {statusError ? <ErrorBlock title="实时监督状态读取失败" message={statusError} /> : null}

      <section className="workspace-grid supervision-workspace">
        <div className="workspace-main panel grow-panel event-console">
          <div className="section-header compact">
            <div>
              <h2>实时事件流</h2>
            </div>
            <div className="event-toolbar">
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
            {events.length ? (
              newestEvents.map((event, index) => (
                <article
                  className={`event-row ${eventRowClass(event)}`}
                  key={`${event.eventId ?? event.timestamp}-${index}`}
                >
                  <div className="event-index">{events.length - index}</div>
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
                <p className="muted">出现 ask 策略命中时，会在这里等待你确认。</p>
              )}
            </div>
          </div>
        </aside>
      </section>
    </div>
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
