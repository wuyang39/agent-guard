import type { TraceEvent } from "@agent-guard/contracts";
import { Badge } from "../../components/ui/Badge";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { LoadState, TraceDetailView } from "../../lib/api/types";
import { actionTone, riskLabel, riskTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { compactPayload, pairToolEvents } from "../../lib/models/trace";

type TraceDetailPageProps = {
  state: LoadState<TraceDetailView>;
  onGoDetection: () => void;
  onGoDefense: () => void;
};

export function TraceDetailPage({
  state,
  onGoDetection,
  onGoDefense,
}: TraceDetailPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载 trace、finding evidence 和监督记录..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有 Trace" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="Trace 加载失败" message={state.message} />;
  }

  const { trace, relatedFindings, relatedRiskReports, supervisionRecords } = state.data;
  const toolPairs = pairToolEvents(trace.events);

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">Trace Detail</p>
            <h1>事件追溯</h1>
          </div>
          <div className="button-row">
            <button className="secondary-button" onClick={onGoDetection}>
              Detection
            </button>
            <button className="secondary-button" onClick={onGoDefense}>
              Defense
            </button>
          </div>
        </div>
        <div className="id-grid">
          <div>
            <span>Trace</span>
            <code>{trace.traceId}</code>
          </div>
          <div>
            <span>Case</span>
            <code>{trace.caseId}</code>
          </div>
          <div>
            <span>Events</span>
            <code>{trace.events.length}</code>
          </div>
          <div>
            <span>Ended</span>
            <code>{formatDateTime(trace.endedAt)}</code>
          </div>
        </div>
      </section>

      <section className="split-grid">
        <div className="panel">
          <h2>Tool call / result 配对</h2>
          <div className="timeline-list">
            {toolPairs.length ? (
              toolPairs.map((pair) => (
                <article className="list-item" key={pair.call.eventId}>
                  <div>
                    <strong>{toolName(pair.call)}</strong>
                    <p>
                      call <code>{pair.call.eventId}</code>
                      {pair.result ? (
                        <>
                          {" "}
                          {"->"} result <code>{pair.result.eventId}</code>
                        </>
                      ) : (
                        " -> no result"
                      )}
                    </p>
                    <pre>{compactPayload(pair.call.payload)}</pre>
                  </div>
                  <Badge tone={pair.result ? "tone-low" : "tone-high"}>
                    {pair.result ? "paired" : "missing"}
                  </Badge>
                </article>
              ))
            ) : (
              <p className="muted">当前 trace 没有 tool_call 事件。</p>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>Evidence findings</h2>
          <div className="timeline-list">
            {relatedFindings.length ? (
              relatedFindings.map((finding) => (
                <article className="list-item" key={finding.findingId}>
                  <div>
                    <strong>{finding.title}</strong>
                    <p>{finding.description}</p>
                    <code>{finding.evidenceEventIds.join(", ")}</code>
                  </div>
                  <Badge tone={riskTone(finding.riskLevel)}>{riskLabel(finding.riskLevel)}</Badge>
                </article>
              ))
            ) : (
              <p className="muted">没有与当前 trace 关联的 finding。</p>
            )}
          </div>
        </div>
      </section>

      <section className="split-grid">
        <div className="panel">
          <h2>事件时间线</h2>
          <div className="event-list">
            {trace.events.map((event) => (
              <article className="event-row" key={event.eventId}>
                <div className="event-index">{event.sequence}</div>
                <div>
                  <div className="event-title">
                    <strong>{event.type}</strong>
                    <span>{event.actor}</span>
                    <code>{event.eventId}</code>
                  </div>
                  <pre>{compactPayload(event.payload)}</pre>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>监督记录关联</h2>
          <div className="timeline-list">
            {supervisionRecords.length ? (
              supervisionRecords.map((record) => (
                <article className="list-item" key={record.recordId}>
                  <div>
                    <strong>{record.targetType}</strong>
                    <p>{record.decisionReason}</p>
                    <code>{record.inputEventId ?? record.runtimeSessionId}</code>
                  </div>
                  <Badge tone={actionTone(record.action)}>{record.action}</Badge>
                </article>
              ))
            ) : (
              <p className="muted">没有匹配到当前 trace 的运行时监督记录。</p>
            )}
          </div>

          <h2>相关 RiskReport</h2>
          <div className="report-list">
            {relatedRiskReports.map((report) => (
              <div className="report-row" key={report.reportId}>
                <Badge tone={riskTone(report.riskLevel)}>{riskLabel(report.riskLevel)}</Badge>
                <span>{report.caseReport.caseName}</span>
                <code>{report.reportId}</code>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function toolName(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.toolId === "string" ? payload.toolId : event.type;
}
