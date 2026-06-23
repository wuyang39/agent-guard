import type { TraceEvent } from "@agent-guard/contracts";
import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
  DiagnosticTable,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { LoadState, TraceDetailView } from "../../lib/api/types";
import { actionTone, riskLabel, riskTone } from "../../lib/formatters/risk";
import { formatDateTime } from "../../lib/formatters/time";
import { pairToolEvents } from "../../lib/models/trace";

type TraceDetailPageProps = {
  state: LoadState<TraceDetailView>;
};

export function TraceDetailPage({
  state,
}: TraceDetailPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载调用轨迹、风险证据和监督记录..." />;
  }

  if (state.status === "empty") {
    return <EmptyBlock title="没有调用轨迹" message={state.message} />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="调用轨迹加载失败" message={state.message} />;
  }

  const { trace, relatedFindings, relatedRiskReports, supervisionRecords } = state.data;
  const toolPairs = pairToolEvents(trace.events);

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">调用轨迹</p>
            <h1>事件追溯</h1>
          </div>
        </div>
        <div className="id-grid">
          <div>
            <span>用例</span>
            <code>{trace.caseId}</code>
          </div>
          <div>
            <span>事件数</span>
            <code>{trace.events.length}</code>
          </div>
          <div>
            <span>工具调用</span>
            <code>{toolPairs.length}</code>
          </div>
          <div>
            <span>结束时间</span>
            <code>{formatDateTime(trace.endedAt)}</code>
          </div>
        </div>
      </section>
      <TraceDeveloperDiagnostics detail={state.data} />

      <section className="split-grid">
        <div className="panel">
          <h2>工具调用配对</h2>
          <div className="timeline-list">
            {toolPairs.length ? (
              toolPairs.map((pair) => (
                <article className="list-item" key={pair.call.eventId}>
                  <div>
                    <strong>{toolName(pair.call)}</strong>
                    <p>
                      调用 {formatDateTime(pair.call.timestamp)}
                      {pair.result ? (
                        <>
                          {" "}
                          {"->"} 结果 {formatDateTime(pair.result.timestamp)}
                        </>
                      ) : (
                        " -> 暂无结果"
                      )}
                    </p>
                  </div>
                  <Badge tone={pair.result ? "tone-low" : "tone-high"}>
                    {pair.result ? "已配对" : "缺少结果"}
                  </Badge>
                </article>
              ))
            ) : (
              <p className="muted">当前调用轨迹没有工具调用事件。</p>
            )}
          </div>
        </div>

        <div className="panel">
          <h2>风险证据</h2>
          <div className="timeline-list">
            {relatedFindings.length ? (
              relatedFindings.map((finding) => (
                <article className="list-item" key={finding.findingId}>
                  <div>
                    <strong>{finding.title}</strong>
                    <p>{finding.description}</p>
                  </div>
                  <Badge tone={riskTone(finding.riskLevel)}>{riskLabel(finding.riskLevel)}</Badge>
                </article>
              ))
            ) : (
              <p className="muted">没有与当前调用轨迹关联的风险发现。</p>
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
                    <strong>{eventTypeLabel(event.type)}</strong>
                    <span>{formatDateTime(event.timestamp)}</span>
                  </div>
                  <p className="muted">{eventSummary(event)}</p>
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
                  </div>
                  <Badge tone={actionTone(record.action)}>{record.action}</Badge>
                </article>
              ))
            ) : (
              <p className="muted">没有匹配到当前 trace 的运行时监督记录。</p>
            )}
          </div>

          <h2>相关风险报告</h2>
          <div className="report-list">
            {relatedRiskReports.length ? (
              relatedRiskReports.map((report) => (
                <div className="report-row" key={report.reportId}>
                  <Badge tone={riskTone(report.riskLevel)}>{riskLabel(report.riskLevel)}</Badge>
                  <span>{report.caseReport.caseName}</span>
                </div>
              ))
            ) : (
              <p className="muted">没有关联风险报告。</p>
            )}
          </div>
        </div>
        <DeveloperDetails
          items={[
            { label: "Trace", value: trace.traceId },
            { label: "Run", value: trace.runId },
            { label: "Context", value: trace.contextId },
            { label: "智能体", value: trace.agentId },
            { label: "Sandbox", value: trace.sandboxId },
            { label: "选择计划", value: trace.selectionPlanId },
            { label: "开始时间", value: formatDateTime(trace.startedAt) },
            { label: "状态", value: trace.status },
          ]}
          title="轨迹索引"
        />
      </section>
    </div>
  );
}

function TraceDeveloperDiagnostics({ detail }: { detail: TraceDetailView }) {
  const { trace, relatedRiskReports, relatedFindings, supervisionRecords } = detail;
  return (
    <DeveloperDiagnostics
      count={trace.events.length + relatedRiskReports.length + supervisionRecords.length}
      title="轨迹开发者诊断"
    >
      <DiagnosticSection title="Trace 索引">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Trace", value: trace.traceId },
            { label: "Run", value: trace.runId },
            { label: "Context", value: trace.contextId },
            { label: "Case", value: trace.caseId },
            { label: "Agent", value: trace.agentId },
            { label: "Sandbox", value: trace.sandboxId },
            { label: "Selection plan", value: trace.selectionPlanId },
            { label: "Status", value: trace.status },
            { label: "Started", value: formatDateTime(trace.startedAt) },
            { label: "Ended", value: formatDateTime(trace.endedAt) },
          ]}
        />
      </DiagnosticSection>

      <DiagnosticSection title="TraceEvent" count={trace.events.length}>
        <DiagnosticTable
          columns={[
            { header: "Seq", render: (event) => event.sequence },
            { header: "Event", render: (event) => <code>{event.eventId}</code> },
            { header: "Type", render: (event) => event.type },
            { header: "Time", render: (event) => formatDateTime(event.timestamp) },
            { header: "Summary", render: (event) => eventSummary(event) },
            { header: "Payload", render: (event) => <code>{JSON.stringify(event.payload)}</code> },
          ]}
          maxRows={32}
          rowKey={(event) => event.eventId}
          rows={trace.events}
        />
      </DiagnosticSection>

      <DiagnosticSection title="风险关联" count={relatedRiskReports.length + relatedFindings.length}>
        <DiagnosticTable
          columns={[
            { header: "Risk report", render: (report) => <code>{report.reportId}</code> },
            { header: "Case", render: (report) => report.caseReport.caseName },
            { header: "Level", render: (report) => report.riskLevel },
            { header: "Trace", render: (report) => <code>{report.traceId}</code> },
            { header: "Findings", render: (report) => <CodeList values={report.findings.map((finding) => finding.findingId)} /> },
          ]}
          emptyLabel="暂无关联风险报告"
          rowKey={(report) => report.reportId}
          rows={relatedRiskReports}
        />
        <DiagnosticTable
          columns={[
            { header: "Finding", render: (finding) => <code>{finding.findingId}</code> },
            { header: "Title", render: (finding) => finding.title },
            { header: "Category", render: (finding) => finding.category },
            { header: "Level", render: (finding) => finding.riskLevel },
            { header: "Evidence", render: (finding) => <CodeList values={finding.evidenceEventIds} /> },
          ]}
          emptyLabel="暂无关联发现"
          rowKey={(finding) => finding.findingId}
          rows={relatedFindings}
        />
      </DiagnosticSection>

      <DiagnosticSection title="RuntimeSupervisionRecord 关联" count={supervisionRecords.length}>
        <DiagnosticTable
          columns={[
            { header: "Record", render: (record) => <code>{record.recordId}</code> },
            { header: "Session", render: (record) => <code>{record.runtimeSessionId}</code> },
            { header: "Policy", render: (record) => <code>{record.policyId}</code> },
            { header: "Action", render: (record) => record.action },
            { header: "Target", render: (record) => `${record.targetType}${record.targetId ? ` / ${record.targetId}` : ""}` },
            { header: "Input", render: (record) => record.inputEventId ? <code>{record.inputEventId}</code> : "-" },
            { header: "Output", render: (record) => record.outputEventId ? <code>{record.outputEventId}</code> : "-" },
            { header: "Reason", render: (record) => record.decisionReason },
          ]}
          emptyLabel="暂无运行时监督记录"
          rowKey={(record) => record.recordId}
          rows={supervisionRecords}
        />
        <DiagnosticJson value={supervisionRecords.map((record) => ({
          recordId: record.recordId,
          gateway: record.gateway,
        }))} />
      </DiagnosticSection>
    </DeveloperDiagnostics>
  );
}

function toolName(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.toolName === "string") return payload.toolName;
  return typeof payload.toolId === "string" ? payload.toolId : eventTypeLabel(event.type);
}

function CodeList({ values }: { values: string[] }) {
  if (!values.length) return <span className="muted">-</span>;
  return (
    <span className="diagnostic-id-list">
      {values.map((value, index) => (
        <code key={`${value}.${index}`}>{value}</code>
      ))}
    </span>
  );
}

function eventTypeLabel(type: TraceEvent["type"]): string {
  const labels: Record<TraceEvent["type"], string> = {
    test_started: "测试开始",
    task_sent: "任务下发",
    agent_message: "智能体消息",
    tool_call: "工具调用",
    tool_result: "工具结果",
    resource_access: "资源访问",
    prompt_load: "提示词加载",
    system_error: "系统错误",
  };
  return labels[type];
}

function eventSummary(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "agent_message" && typeof payload.message === "string") {
    return payload.message;
  }
  if (event.type === "task_sent" && typeof payload.instruction === "string") {
    return payload.instruction;
  }
  if (event.type === "tool_call") {
    return `调用 ${toolName(event)}`;
  }
  if (event.type === "tool_result") {
    return Boolean(payload.containsInjection) ? "工具结果包含风险内容" : "工具调用完成";
  }
  if (event.type === "resource_access") {
    return Boolean(payload.authorized) ? "资源访问已授权" : "资源访问未授权";
  }
  if (event.type === "system_error" && typeof payload.message === "string") {
    return payload.message;
  }
  return eventTypeLabel(event.type);
}
