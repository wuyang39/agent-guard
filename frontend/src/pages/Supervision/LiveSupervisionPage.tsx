import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import type {
  DefenseDetailView,
  LiveSupervisionEvent,
  RealtimeActivePolicyState,
  RealtimePreparedSession,
} from "../../lib/api/types";
import { actionLabel, actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { shouldDisplayRealtimeEvent } from "../../lib/models/realtime";

type LiveSupervisionPageProps = {
  onGoRuns: () => void;
  onGoDefense: () => void;
  onReportGenerated: (detail: DefenseDetailView) => void;
};

const REALTIME_EVENT_TYPES: LiveSupervisionEvent["type"][] = [
  "active_policy_updated",
  "session_reset",
  "session_created",
  "tool_call_started",
  "supervision_decision",
  "tool_call_result",
  "defense_report_generated",
];

export function LiveSupervisionPage({
  onGoRuns,
  onGoDefense,
  onReportGenerated,
}: LiveSupervisionPageProps) {
  const [activePolicy, setActivePolicy] = useState<RealtimeActivePolicyState | undefined>();
  const [preparedSession, setPreparedSession] = useState<RealtimePreparedSession | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [events, setEvents] = useState<LiveSupervisionEvent[]>([]);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [latestDefenseReportId, setLatestDefenseReportId] = useState<string | undefined>();
  const sourceRef = useRef<EventSource | undefined>(undefined);

  useEffect(() => {
    void refreshActivePolicy();
    void prepareSession();
    return () => sourceRef.current?.close();
  }, []);

  async function refreshActivePolicy() {
    setStatusError(undefined);
    try {
      setActivePolicy(await agentGuardApi.activeRealtimePolicy());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function useFallbackPolicy() {
    setStatusError(undefined);
    try {
      const policy = await agentGuardApi.setRealtimeActivePolicy("fallback", true);
      setActivePolicy(policy);
      setPreparedSession(await agentGuardApi.createRealtimeSession(policy.resolvedPolicyPackId));
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
      setStreaming(false);
      if (preparedSession) {
        await agentGuardApi.resetRealtimeSessions(preparedSession.runtimeSessionId);
      }
      setPreparedSession(
        await agentGuardApi.createRealtimeSession(activePolicy?.resolvedPolicyPackId),
      );
      setEvents([]);
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
    setEvents([]);
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
        if (event.type === "active_policy_updated") {
          void refreshActivePolicy();
        }
        if (event.type === "defense_report_generated") {
          const id = event.detail?.defenseReportId;
          if (typeof id === "string") setLatestDefenseReportId(id);
        }
      });
    }

    source.onerror = () => {
      setEvents((current) => [
        ...current,
        {
          timestamp: new Date().toISOString(),
          type: "live_error",
          message: "实时事件连接失败。",
        },
      ]);
      setStreaming(false);
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
    setStreaming(false);
  }

  async function finalizeReport() {
    setFinalizing(true);
    setStatusError(undefined);
    try {
      const session = preparedSession ?? await agentGuardApi.createRealtimeSession(activePolicy?.resolvedPolicyPackId);
      setPreparedSession(session);
      const detail = await agentGuardApi.finalizeRealtimeDefenseReport(session.runtimeSessionId);
      setLatestDefenseReportId(detail.defenseReport.defenseReportId);
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
  const newestDecisionEvents = [...decisionEvents].reverse();

  return (
    <div className="page-stack fill-page supervision-page">
      <section className="page-hero supervision-hero">
        <div className="hero-copy">
          <p className="eyebrow">实时监督</p>
          <h1>实时监督</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={streaming ? "tone-medium" : "tone-neutral"}>
            {streaming ? "监听中" : `${events.length} 条事件`}
          </Badge>
          <Badge tone={includeHistory ? "tone-high" : "tone-low"}>
            {includeHistory ? "含历史" : "仅实时"}
          </Badge>
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
              <p className="muted">OpenClaw 调用 agent_guard_* 工具后，监督事件会追加到这里。</p>
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
              <Badge tone={streaming ? "tone-medium" : "tone-neutral"}>
                {streaming ? "实时" : "暂停"}
              </Badge>
              <Badge>{events.length} 条事件</Badge>
              <Badge>最新优先</Badge>
              <span className="session-chip">
                <span>Session</span>
                <code>{preparedSession?.runtimeSessionId ?? "准备中"}</code>
              </span>
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
                    <div className="event-meta">
                      {event.runtimeSessionId ? <span>{event.runtimeSessionId}</span> : null}
                      {event.toolId ? <span>{event.toolId}</span> : null}
                      {event.policyPackId ? <span>{event.policyPackId}</span> : null}
                    </div>
                    <p className="muted">{event.message ?? summarizeEvent(event)}</p>
                  </div>
                </article>
              ))
            ) : (
              <p className="muted">
                先点击“监听实时事件”，再在 OpenClaw 中调用 agent_guard_* 工具，这里会显示监督判定。
              </p>
            )}
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <div className="section-header compact">
              <h2>当前策略</h2>
              <Badge tone={activePolicy?.source === "fallback" ? "tone-medium" : "tone-low"}>
                {activePolicy ? activePolicySourceLabel(activePolicy.source) : "-"}
              </Badge>
            </div>
            <div className="rail-list">
              <div>
                <span>MCP 地址</span>
                <code>http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp</code>
              </div>
              <div>
                <span>当前策略</span>
                <code>{activePolicy?.resolvedPolicyPackId ?? "-"}</code>
              </div>
              <div>
                <span>运行会话</span>
                <code>{preparedSession?.runtimeSessionId ?? "准备中"}</code>
              </div>
            </div>
            <div className="button-row rail-actions">
              <button className="secondary-button" onClick={refreshActivePolicy}>
                刷新策略
              </button>
              <button className="secondary-button" onClick={useFallbackPolicy}>
                使用兜底策略
              </button>
              <button className="secondary-button" onClick={resetSession}>
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
            <div className="button-row">
              <button className="secondary-button" onClick={onGoRuns}>
                测试运行
              </button>
              <button className="secondary-button" onClick={onGoDefense}>
                防御报告
              </button>
            </div>
          </div>

          <div className="rail-section grow-rail-section">
            <h2>判定明细</h2>
            <div className="timeline-list compact-timeline">
            {newestDecisionEvents
              .map((event) => (
                <article className="list-item" key={event.eventId ?? `${event.timestamp}-${event.action}`}>
                  <div>
                    <strong>{event.targetType ?? event.toolId}</strong>
                    <p>{event.message}</p>
                    <code>{event.runtimeSessionId}</code>
                  </div>
                  <Badge tone={event.action ? actionTone(event.action) : "tone-neutral"}>
                    {event.action ?? "decision"}
                  </Badge>
                </article>
              ))}
            {!events.some((event) => event.type === "supervision_decision") ? (
              <p className="muted">还没有监督判定。OpenClaw 工具调用进入 MCP 后会出现阻断、确认、脱敏等记录。</p>
            ) : null}
            </div>
            {latestDefenseReportId ? (
              <p className="muted">最新实时防御报告: {latestDefenseReportId}</p>
            ) : null}
          </div>
        </aside>
      </section>
    </div>
  );
}

function summarizeEvent(event: LiveSupervisionEvent): string {
  if (event.type === "tool_call_started") {
    return `${event.toolId} 已在 ${event.runtimeSessionId} 中开始调用`;
  }
  if (event.type === "tool_call_result") {
    return `${event.toolId} ${event.blocked ? "已阻断" : "已完成"}`;
  }
  if (event.type === "active_policy_updated") {
    return `当前策略=${event.policyPackId}`;
  }
  if (event.type === "defense_report_generated") {
    return `防御报告=${String(event.detail?.defenseReportId ?? "-")}`;
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
