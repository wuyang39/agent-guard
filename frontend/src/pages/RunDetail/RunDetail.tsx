import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Box, FileJson, FileText, Fingerprint, ListChecks, Route, ShieldCheck, ShieldHalf, Timeline } from "lucide-react";
import type { DemoRunResult, Finding, Policy, RiskLevel, SupervisionRecord, TraceEvent } from "../../lib/api/demoRuntime";
import { eventTypeLabel, formatDate, formatDuration, toTitleCase } from "../../lib/formatters/display";
import { getRun, summarizeRun } from "../../lib/models/runStore";
import { RiskBadge } from "../../components/ui/RiskBadge";
import { StateBlock } from "../../components/ui/StateBlock";

type TabId = "overview" | "trace" | "risk" | "detection" | "policy" | "supervision" | "defense" | "artifacts";

const tabs: Array<{ id: TabId; label: string; icon: typeof Box }> = [
  { id: "overview", label: "Overview", icon: Box },
  { id: "trace", label: "Trace", icon: Timeline },
  { id: "risk", label: "Risk Report", icon: ShieldHalf },
  { id: "detection", label: "Detection Report", icon: Fingerprint },
  { id: "policy", label: "Policy Pack", icon: ListChecks },
  { id: "supervision", label: "Supervision Records", icon: Route },
  { id: "defense", label: "Defense Report", icon: ShieldCheck },
  { id: "artifacts", label: "Artifacts", icon: FileJson },
];

function artifactHref(path: string) {
  if (path.startsWith("outputs/")) return `/${path}`;
  return path;
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getArray<T>(value: unknown, key: string): T[] {
  const record = getRecord(value);
  return Array.isArray(record[key]) ? (record[key] as T[]) : [];
}

function allFindings(results: DemoRunResult[]) {
  return results.flatMap((result) =>
    result.evaluation.findings.map((finding) => ({
      ...finding,
      caseId: result.context.caseId,
      caseName: result.context.caseName,
    })),
  );
}

function allEvents(results: DemoRunResult[]) {
  return results.flatMap((result) =>
    result.trace.events.map((event) => ({
      ...event,
      caseId: result.context.caseId,
      caseName: result.context.caseName,
    })),
  );
}

function allPolicies(results: DemoRunResult[]) {
  return results.flatMap((result) =>
    (result.policyPack.policies || []).map((policy) => ({
      ...policy,
      caseId: result.context.caseId,
      policyPackId: result.policyPack.policyPackId,
    })),
  );
}

function allSupervisionRecords(results: DemoRunResult[]) {
  return results.flatMap((result) =>
    result.supervisionRecords.map((record) => ({
      ...record,
      caseId: result.context.caseId,
    })),
  );
}

export function RunDetail() {
  const { runGroupId } = useParams();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const run = runGroupId ? getRun(runGroupId) : undefined;
  const summary = run ? summarizeRun(run) : undefined;

  const findings = useMemo(() => (run ? allFindings(run.results) : []), [run]);
  const events = useMemo(() => (run ? allEvents(run.results) : []), [run]);
  const policies = useMemo(() => (run ? allPolicies(run.results) : []), [run]);
  const supervisionRecords = useMemo(() => (run ? allSupervisionRecords(run.results) : []), [run]);

  if (!run || !summary) {
    return (
      <section className="page">
        <StateBlock kind="error" title="Run not found" detail="该运行只保存在当前浏览器本地历史中。" />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Run Detail</p>
          <h1>{run.runGroupId.slice(0, 32)}</h1>
        </div>
        <Link className="ghost-action" to="/runs">
          <FileText size={17} />
          <span>Back to runs</span>
        </Link>
      </header>

      <div className="tab-bar" role="tablist" aria-label="Run result sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} className={activeTab === tab.id ? "active" : ""} type="button" onClick={() => setActiveTab(tab.id)}>
              <Icon size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {activeTab === "overview" ? <OverviewTab run={run} summary={summary} /> : null}
      {activeTab === "trace" ? <TraceTab events={events} findings={findings} /> : null}
      {activeTab === "risk" ? <RiskTab results={run.results} findings={findings} /> : null}
      {activeTab === "detection" ? <DetectionTab results={run.results} /> : null}
      {activeTab === "policy" ? <PolicyTab policies={policies} /> : null}
      {activeTab === "supervision" ? <SupervisionTab records={supervisionRecords} /> : null}
      {activeTab === "defense" ? <DefenseTab results={run.results} /> : null}
      {activeTab === "artifacts" ? <ArtifactsTab results={run.results} /> : null}
    </section>
  );
}

function OverviewTab({ run, summary }: { run: NonNullable<ReturnType<typeof getRun>>; summary: ReturnType<typeof summarizeRun> }) {
  return (
    <div className="content-band">
      <div className="metric-grid compact">
        <div className="metric-tile">
          <span>Agent</span>
          <strong>{summary.agentName}</strong>
        </div>
        <div className="metric-tile">
          <span>Highest Risk</span>
          <strong>
            <RiskBadge level={summary.highestRisk} />
          </strong>
        </div>
        <div className="metric-tile">
          <span>Findings</span>
          <strong>{summary.findingCount}</strong>
        </div>
        <div className="metric-tile">
          <span>Blocked</span>
          <strong>{summary.blockedCount}</strong>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Risk</th>
              <th>Findings</th>
              <th>Events</th>
              <th>Duration</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((result) => (
              <tr key={result.trace.traceId}>
                <td>
                  <strong>{result.context.caseName}</strong>
                  <small>{result.context.caseId}</small>
                </td>
                <td>
                  <RiskBadge level={result.risk.riskLevel} />
                </td>
                <td>{result.risk.findingCount}</td>
                <td>{result.trace.events.length}</td>
                <td>{formatDuration(result.trace.startedAt, result.trace.endedAt)}</td>
                <td>{result.trace.traceId.slice(0, 24)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TraceTab({
  events,
  findings,
}: {
  events: Array<TraceEvent & { caseId: string; caseName: string }>;
  findings: Array<Finding & { caseId: string; caseName: string }>;
}) {
  const findingEventIds = new Set(findings.flatMap((finding) => finding.evidenceEventIds || []));
  return (
    <div className="timeline-list">
      {events.map((event) => (
        <details key={`${event.caseId}-${event.eventId}`} className={`timeline-item ${findingEventIds.has(event.eventId) ? "flagged" : ""}`}>
          <summary>
            <span className="event-sequence">{event.sequence}</span>
            <span>
              <strong>{eventTypeLabel[event.eventType] || toTitleCase(event.eventType)}</strong>
              <small>
                {event.caseName} · {formatDate(event.timestamp)}
              </small>
            </span>
          </summary>
          <pre>{stringify(event.payload)}</pre>
        </details>
      ))}
    </div>
  );
}

function RiskTab({ results, findings }: { results: DemoRunResult[]; findings: Array<Finding & { caseId: string; caseName: string }> }) {
  return (
    <div className="content-band">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Finding</th>
              <th>Risk</th>
              <th>Category</th>
              <th>Rule</th>
              <th>Evidence Events</th>
              <th>Case</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.findingId}>
                <td>{finding.title || finding.name}</td>
                <td>
                  <RiskBadge level={finding.riskLevel} />
                </td>
                <td>{finding.category}</td>
                <td>{finding.ruleId}</td>
                <td>{(finding.evidenceEventIds || []).join(", ") || "-"}</td>
                <td>{finding.caseId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <JsonDisclosure title="Risk report payloads" value={results.map((result) => result.report)} />
    </div>
  );
}

function DetectionTab({ results }: { results: DemoRunResult[] }) {
  type DetectionDigestRow = {
    findingId?: string;
    title?: string;
    riskLevel?: RiskLevel;
    category?: string;
    evidenceEventIds?: string[];
    caseId: string;
  };
  const digests: DetectionDigestRow[] = results.flatMap((result) =>
    getArray<Record<string, unknown>>(result.detectionReport, "findingDigest").map((digest) => ({
      findingId: typeof digest.findingId === "string" ? digest.findingId : undefined,
      title: typeof digest.title === "string" ? digest.title : undefined,
      riskLevel: typeof digest.riskLevel === "string" ? (digest.riskLevel as RiskLevel) : undefined,
      category: typeof digest.category === "string" ? digest.category : undefined,
      evidenceEventIds: Array.isArray(digest.evidenceEventIds) ? digest.evidenceEventIds.map(String) : undefined,
      caseId: result.context.caseId,
    })),
  );
  return (
    <div className="content-band">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Risk</th>
              <th>Category</th>
              <th>Evidence</th>
              <th>Case</th>
            </tr>
          </thead>
          <tbody>
            {digests.map((digest, index) => (
              <tr key={`${digest.findingId || "finding"}-${index}`}>
                <td>{digest.title || digest.findingId || "-"}</td>
                <td>
                  <RiskBadge level={digest.riskLevel || "none"} />
                </td>
                <td>{digest.category || "-"}</td>
                <td>{digest.evidenceEventIds?.join(", ") || "-"}</td>
                <td>{digest.caseId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <JsonDisclosure title="Detection report payloads" value={results.map((result) => result.detectionReport)} />
    </div>
  );
}

function PolicyTab({ policies }: { policies: Array<Policy & { caseId: string; policyPackId?: string }> }) {
  return (
    <div className="content-band">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Policy</th>
              <th>Action</th>
              <th>Target</th>
              <th>Severity</th>
              <th>Case</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy, index) => (
              <tr key={`${policy.policyId || policy.title}-${index}`}>
                <td>{policy.title || policy.name || policy.policyId || "-"}</td>
                <td>{policy.action || "-"}</td>
                <td>{policy.targetType || "-"}</td>
                <td>{policy.severity ? <RiskBadge level={policy.severity} /> : "-"}</td>
                <td>{policy.caseId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SupervisionTab({ records }: { records: Array<SupervisionRecord & { caseId: string }> }) {
  return (
    <div className="content-band">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Record</th>
              <th>Action</th>
              <th>Target</th>
              <th>Reason</th>
              <th>Case</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.recordId || record.eventId}-${index}`}>
                <td>{record.recordId || record.eventId || "-"}</td>
                <td>{record.decision?.action || "-"}</td>
                <td>{record.target?.targetId || record.target?.targetType || "-"}</td>
                <td>{record.decision?.reason || "-"}</td>
                <td>{record.caseId}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DefenseTab({ results }: { results: DemoRunResult[] }) {
  return (
    <div className="content-band">
      <div className="defense-grid">
        {results.map((result) => {
          const defense = getRecord(result.defenseReport);
          const summary = getRecord(defense.summary);
          return (
            <section key={result.context.caseId} className="defense-panel">
              <h3>{result.context.caseName}</h3>
              <dl>
                <div>
                  <dt>Defense Report</dt>
                  <dd>{String(defense.defenseReportId || "-")}</dd>
                </div>
                <div>
                  <dt>Policies</dt>
                  <dd>{String(summary.policyCount || result.policyPack.policies?.length || 0)}</dd>
                </div>
                <div>
                  <dt>Runtime Records</dt>
                  <dd>{String(summary.supervisionRecordCount || result.supervisionRecords.length)}</dd>
                </div>
                <div>
                  <dt>Blocked Actions</dt>
                  <dd>{String(summary.blockedActionCount || 0)}</dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
      <JsonDisclosure title="Defense report payloads" value={results.map((result) => result.defenseReport)} />
    </div>
  );
}

function ArtifactsTab({ results }: { results: DemoRunResult[] }) {
  const artifacts = results.flatMap((result) =>
    Object.entries(result.artifacts || {}).map(([key, path]) => ({
      key,
      path,
      caseId: result.context.caseId,
    })),
  );
  return (
    <div className="content-band">
      <div className="artifact-grid">
        {artifacts.map((artifact) => (
          <a key={`${artifact.caseId}-${artifact.key}`} className="artifact-link" href={artifactHref(artifact.path)} target="_blank" rel="noreferrer">
            <FileJson size={18} />
            <span>
              <strong>{artifact.key}</strong>
              <small>{artifact.caseId}</small>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

function JsonDisclosure({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="json-disclosure">
      <summary>{title}</summary>
      <pre>{stringify(value)}</pre>
    </details>
  );
}
