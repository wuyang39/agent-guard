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
import { actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";

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
    sourceRef.current?.close();
    setEvents([]);
    setStreaming(true);
    const source = new EventSource(agentGuardApi.liveSupervisionUrl());
    sourceRef.current = source;

    for (const eventType of REALTIME_EVENT_TYPES) {
      source.addEventListener(eventType, (message) => {
        const event = JSON.parse((message as MessageEvent).data) as LiveSupervisionEvent;
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
          message: "SSE connection failed.",
        },
      ]);
      setStreaming(false);
      source.close();
    };
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

  return (
    <div className="page-stack fill-page supervision-page">
      <section className="page-hero supervision-hero">
        <div className="hero-copy">
          <p className="eyebrow">OpenClaw Realtime MCP</p>
          <h1>实施监督</h1>
          <p className="hero-lead">
            监听 OpenClaw 工具调用，把策略判定、阻断和报告生成过程实时展示出来。
          </p>
        </div>
        <div className="hero-actions">
          <Badge tone={streaming ? "tone-medium" : "tone-neutral"}>
            {streaming ? "streaming" : `${events.length} events`}
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
            <Badge tone={streaming ? "tone-medium" : "tone-neutral"}>
              {streaming ? "streaming" : `${events.length} events`}
            </Badge>
          </div>
          <div className="event-list">
            {events.length ? (
              events.map((event, index) => (
                <article className="event-row" key={`${event.eventId ?? event.timestamp}-${index}`}>
                  <div className="event-index">{index + 1}</div>
                  <div>
                    <div className="event-title">
                      <strong>{event.type}</strong>
                      <span>{formatDateTime(event.timestamp)}</span>
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
                {activePolicy?.source ?? "-"}
              </Badge>
            </div>
            <div className="rail-list">
              <div>
                <span>MCP URL</span>
                <code>http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp</code>
              </div>
              <div>
                <span>Active Policy</span>
                <code>{activePolicy?.resolvedPolicyPackId ?? "-"}</code>
              </div>
              <div>
                <span>Runtime Session</span>
                <code>{preparedSession?.runtimeSessionId ?? "preparing"}</code>
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
              <Badge>{decisionEvents.length} decisions</Badge>
            </div>
            <div className="decision-grid">
              <div>
                <span>allow</span>
                <strong>{allowCount}</strong>
              </div>
              <div>
                <span>deny</span>
                <strong>{denyCount}</strong>
              </div>
              <div>
                <span>redact</span>
                <strong>{redactCount}</strong>
              </div>
              <div>
                <span>ask</span>
                <strong>{askCount}</strong>
              </div>
            </div>
            <div className="button-row">
              <button className="secondary-button" onClick={onGoRuns}>
                Test Runs
              </button>
              <button className="secondary-button" onClick={onGoDefense}>
                Defense
              </button>
            </div>
          </div>

          <div className="rail-section grow-rail-section">
            <h2>判定明细</h2>
            <div className="timeline-list compact-timeline">
            {events
              .filter((event) => event.type === "supervision_decision")
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
              <p className="muted">还没有监督判定。OpenClaw 工具调用进入 MCP 后会出现 deny、ask、redact 等记录。</p>
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
    return `${event.toolId} started in ${event.runtimeSessionId}`;
  }
  if (event.type === "tool_call_result") {
    return `${event.toolId} ${event.blocked ? "blocked" : "completed"}`;
  }
  if (event.type === "active_policy_updated") {
    return `active policy=${event.policyPackId}`;
  }
  if (event.type === "defense_report_generated") {
    return `defense=${String(event.detail?.defenseReportId ?? "-")}`;
  }
  return "";
}
