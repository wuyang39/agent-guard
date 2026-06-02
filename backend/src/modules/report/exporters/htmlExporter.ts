import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../../shared/ids";
import { SCHEMA_VERSION } from "../../../shared/schemaVersion";
import { nowIso } from "../../../shared/time";
import type { ReportArtifact, RiskReport } from "../reportTypes";

export async function exportHtmlReport(
  report: RiskReport,
  outputPath: string,
): Promise<ReportArtifact> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderHtmlReport(report), "utf8");

  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: createId("artifact"),
    reportId: report.reportId,
    format: "html",
    path: outputPath,
    generatedAt: nowIso(),
  };
}

function renderHtmlReport(report: RiskReport): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(report.caseReport.caseName)} - Agent Guard Risk Report</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      color: #17202a;
      background: #f5f7fb;
    }
    body {
      margin: 0;
      padding: 32px;
    }
    main {
      max-width: 1080px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #d9e1ec;
      border-radius: 8px;
      padding: 28px;
    }
    h1, h2, h3 {
      margin: 0 0 12px;
      letter-spacing: 0;
    }
    h1 {
      font-size: 28px;
    }
    h2 {
      margin-top: 28px;
      font-size: 20px;
      border-bottom: 1px solid #e6edf5;
      padding-bottom: 8px;
    }
    p {
      line-height: 1.6;
    }
    .meta, .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 18px 0;
    }
    .metric {
      border: 1px solid #e1e8f0;
      border-radius: 6px;
      padding: 12px;
      background: #fbfcfe;
    }
    .metric strong {
      display: block;
      font-size: 18px;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      table-layout: fixed;
    }
    th, td {
      border: 1px solid #dde6f0;
      padding: 10px;
      text-align: left;
      vertical-align: top;
      word-break: break-word;
    }
    th {
      background: #f0f4f9;
    }
    code {
      font-family: Consolas, monospace;
      background: #eef3f8;
      border-radius: 4px;
      padding: 2px 4px;
    }
    .risk-critical { color: #9f1239; font-weight: 700; }
    .risk-high { color: #b45309; font-weight: 700; }
    .risk-medium { color: #1d4ed8; font-weight: 700; }
    .risk-low { color: #047857; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>Agent Guard Risk Report</h1>
    <div class="meta">
      <div class="metric">Case<strong>${escapeHtml(report.caseReport.caseName)}</strong></div>
      <div class="metric">Risk<strong class="risk-${report.riskLevel}">${escapeHtml(report.riskLevel)}</strong></div>
      <div class="metric">Findings<strong>${report.summary.totalFindings}</strong></div>
      <div class="metric">Trace ID<strong><code>${escapeHtml(report.traceId)}</code></strong></div>
    </div>

    <h2>Findings</h2>
    ${renderFindings(report)}

    <h2>Evidence Chains</h2>
    ${renderEvidenceChains(report)}

    <h2>Attack Chains</h2>
    ${renderAttackChains(report)}

    <h2>Tool Call Trace</h2>
    ${renderTraceSteps(report)}
  </main>
</body>
</html>
`;
}

function renderFindings(report: RiskReport): string {
  if (report.findings.length === 0) {
    return "<p>No findings were generated for this trace.</p>";
  }

  return `<table>
    <thead><tr><th>Finding</th><th>Risk</th><th>Category</th><th>Evidence Events</th></tr></thead>
    <tbody>
      ${report.findings
        .map(
          (finding) => `<tr>
            <td><strong>${escapeHtml(finding.title)}</strong><br>${escapeHtml(finding.description)}<br><code>${escapeHtml(finding.ruleId)}</code></td>
            <td class="risk-${finding.riskLevel}">${escapeHtml(finding.riskLevel)}</td>
            <td>${escapeHtml(finding.category)}</td>
            <td>${finding.evidenceEventIds.map((eventId) => `<code>${escapeHtml(eventId)}</code>`).join("<br>")}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderEvidenceChains(report: RiskReport): string {
  if (report.evidenceChains.length === 0) {
    return "<p>No evidence chains were generated.</p>";
  }

  return `<table>
    <thead><tr><th>Finding ID</th><th>Summary</th><th>Event IDs</th></tr></thead>
    <tbody>
      ${report.evidenceChains
        .map(
          (chain) => `<tr>
            <td><code>${escapeHtml(chain.findingId)}</code></td>
            <td>${escapeHtml(chain.summary)}</td>
            <td>${chain.eventIds.map((eventId) => `<code>${escapeHtml(eventId)}</code>`).join("<br>")}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderAttackChains(report: RiskReport): string {
  if (report.attackChains.length === 0) {
    return "<p>No attack chains were generated.</p>";
  }

  return report.attackChains
    .map(
      (chain) => `<section>
        <h3>${escapeHtml(chain.summary)}</h3>
        <table>
          <thead><tr><th>Step</th><th>Event ID</th><th>Description</th></tr></thead>
          <tbody>
            ${chain.steps
              .map(
                (step) => `<tr>
                  <td>${step.sequence}. ${escapeHtml(step.title)}</td>
                  <td><code>${escapeHtml(step.eventId)}</code></td>
                  <td>${escapeHtml(step.description)}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </section>`,
    )
    .join("");
}

function renderTraceSteps(report: RiskReport): string {
  if (report.toolCallTrace.steps.length === 0) {
    return "<p>No trace steps were attached to this report.</p>";
  }

  return `<table>
    <thead><tr><th>#</th><th>Type</th><th>Event ID</th><th>Detail</th></tr></thead>
    <tbody>
      ${report.toolCallTrace.steps
        .map(
          (step) => `<tr>
            <td>${step.sequence}</td>
            <td>${escapeHtml(step.title)}</td>
            <td><code>${escapeHtml(step.eventId)}</code></td>
            <td><code>${escapeHtml(step.detail)}</code></td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
