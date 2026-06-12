import { useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import type { LiveSupervisionEvent, SampleAgentStatus } from "../../lib/api/types";
import { actionTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";

type LiveSupervisionPageProps = {
  onGoRuns: () => void;
  onGoDefense: () => void;
};

export function LiveSupervisionPage({
  onGoRuns,
  onGoDefense,
}: LiveSupervisionPageProps) {
  const [status, setStatus] = useState<SampleAgentStatus | undefined>();
  const [statusError, setStatusError] = useState<string | undefined>();
  const [events, setEvents] = useState<LiveSupervisionEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const completedRef = useRef(false);

  useEffect(() => {
    void refreshStatus();
    return () => sourceRef.current?.close();
  }, []);

  async function refreshStatus() {
    setStatusError(undefined);
    try {
      setStatus(await agentGuardApi.sampleAgentStatus());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startAgent() {
    setStatusError(undefined);
    try {
      setStatus(await agentGuardApi.startSampleAgent());
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    }
  }

  function startStream() {
    sourceRef.current?.close();
    setEvents([]);
    completedRef.current = false;
    setStreaming(true);
    const source = new EventSource(agentGuardApi.liveSupervisionUrl());
    sourceRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as LiveSupervisionEvent;
      setEvents((current) => [...current, event]);
      if (event.type === "agent_status" && event.status) {
        setStatus(event.status);
      }
      if (event.type === "live_complete" || event.type === "live_error") {
        completedRef.current = true;
        setStreaming(false);
        source.close();
      }
    };
    source.onerror = () => {
      if (completedRef.current) {
        source.close();
        return;
      }
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

  if (!status && !statusError) {
    return <LoadingBlock message="正在检查本地 sample agent 连接状态..." />;
  }

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Project Console</p>
            <h1>Live Supervision</h1>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={refreshStatus}>
              刷新状态
            </button>
            <button className="secondary-button" onClick={startAgent}>
              启动 sample agent
            </button>
            <button className="primary-button" disabled={streaming} onClick={startStream}>
              {streaming ? "监督中..." : "开始实时监督"}
            </button>
          </div>
        </div>

        {statusError ? (
          <ErrorBlock title="Agent 状态读取失败" message={statusError} />
        ) : (
          <div className="id-grid">
            <div>
              <span>Sample Agent</span>
              <Badge tone={status?.running ? "tone-low" : "tone-high"}>
                {status?.running ? "running" : "stopped"}
              </Badge>
            </div>
            <div>
              <span>Endpoint</span>
              <code>{status?.endpoint ?? "-"}</code>
            </div>
            <div>
              <span>Health</span>
              <code>{status?.healthEndpoint ?? "-"}</code>
            </div>
            <div>
              <span>PID</span>
              <code>{status?.pid ?? "-"}</code>
            </div>
          </div>
        )}
      </section>

      <section className="split-grid">
        <div className="panel">
          <div className="section-header compact">
            <h2>实时事件流</h2>
            <Badge tone={streaming ? "tone-medium" : "tone-neutral"}>
              {streaming ? "streaming" : `${events.length} events`}
            </Badge>
          </div>
          <div className="event-list">
            {events.length ? (
              events.map((event, index) => (
                <article className="event-row" key={`${event.timestamp}-${index}`}>
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
              <p className="muted">点击“开始实时监督”后，这里会显示 API adapter、trace、监督记录和防御报告事件。</p>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="section-header compact">
            <h2>监督防护记录</h2>
            <div className="button-row">
              <button className="secondary-button" onClick={onGoRuns}>
                Test Runs
              </button>
              <button className="secondary-button" onClick={onGoDefense}>
                Defense
              </button>
            </div>
          </div>
          <div className="timeline-list">
            {events
              .filter((event) => event.type === "supervision_record" && event.record)
              .map((event) => event.record!)
              .map((record) => (
                <article className="list-item" key={record.recordId}>
                  <div>
                    <strong>{record.targetType}</strong>
                    <p>{record.decisionReason}</p>
                    <code>{record.runtimeSessionId}</code>
                  </div>
                  <Badge tone={actionTone(record.action)}>{record.action}</Badge>
                </article>
              ))}
            {!events.some((event) => event.type === "supervision_record") ? (
              <p className="muted">还没有监督记录。实时流完成后会展示 deny、redact、ask 等动作。</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function summarizeEvent(event: LiveSupervisionEvent): string {
  if (event.type === "run_group") {
    return `runGroup=${event.runGroup?.runGroupId}, reports=${event.riskReportCount}, traces=${event.traceCount}`;
  }
  if (event.type === "trace_summary") {
    return `${event.caseId}: ${event.eventCount} events, trace=${event.traceId}`;
  }
  if (event.type === "defense_report") {
    return `defense=${event.defenseReportId}, blocked=${event.blockedActions}, redacted=${event.redactions}, ask=${event.askDecisions}`;
  }
  if (event.type === "agent_status") {
    return event.status?.message ?? `sample agent ${event.status?.running ? "running" : "stopped"}`;
  }
  return "";
}
