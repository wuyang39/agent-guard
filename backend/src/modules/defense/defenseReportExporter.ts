import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { ReportArtifact } from "../report/reportTypes";
import type { DefenseReport } from "./defenseTypes";

export async function exportDefenseJsonReport(
  report: DefenseReport,
  outputPath: string,
): Promise<ReportArtifact> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: createId("artifact"),
    reportId: report.defenseReportId,
    format: "json",
    path: outputPath,
    generatedAt: nowIso(),
  };
}

export async function exportDefenseHtmlReport(
  report: DefenseReport,
  outputPath: string,
): Promise<ReportArtifact> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderDefenseHtml(report), "utf8");

  return {
    schemaVersion: SCHEMA_VERSION,
    artifactId: createId("artifact"),
    reportId: report.defenseReportId,
    format: "html",
    path: outputPath,
    generatedAt: nowIso(),
  };
}

function renderDefenseHtml(report: DefenseReport): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Agent Guard Defense Report</title>
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
      max-width: 1120px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #d9e1ec;
      border-radius: 8px;
      padding: 28px;
    }
    h1, h2 {
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
    .grid {
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
      font-size: 20px;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-top: 12px;
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
  </style>
</head>
<body>
  <main>
    <h1>Agent Guard Defense Report</h1>
    <div class="grid">
      <div class="metric">Agent<strong>${escapeHtml(report.agentId)}</strong></div>
      <div class="metric">Blocked High Risk<strong>${report.defenseEffectiveness.blockedHighRiskActionCount}</strong></div>
      <div class="metric">Warnings<strong>${report.defenseEffectiveness.alertedActionCount}</strong></div>
      <div class="metric">Redactions<strong>${report.defenseEffectiveness.redactedActionCount}</strong></div>
      <div class="metric">Ask Decisions<strong>${report.defenseEffectiveness.askDecisionCount}</strong></div>
    </div>

    <h2>Traceability</h2>
    <table>
      <tbody>
        <tr><th>Detection Report</th><td><code>${escapeHtml(report.detectionReportId)}</code></td></tr>
        <tr><th>Risk Profile</th><td><code>${escapeHtml(report.riskProfileId)}</code></td></tr>
        <tr><th>Policy Pack</th><td><code>${escapeHtml(report.policyPackId)}</code></td></tr>
        <tr><th>Runtime Sessions</th><td>${renderCodeList(report.runtimeSessionIds)}</td></tr>
      </tbody>
    </table>

    <h2>Blocked Actions</h2>
    ${renderBlockedActions(report)}

    <h2>Runtime Alerts</h2>
    ${renderRuntimeAlerts(report)}

    <h2>Residual Risk</h2>
    ${renderResidualRisk(report)}
  </main>
</body>
</html>
`;
}

function renderBlockedActions(report: DefenseReport): string {
  if (report.blockedActions.length === 0) {
    return "<p>No blocked runtime actions were recorded.</p>";
  }

  return `<table>
    <thead><tr><th>Target</th><th>Policy</th><th>Reason</th></tr></thead>
    <tbody>
      ${report.blockedActions
        .map(
          (action) => `<tr>
            <td>${escapeHtml(action.targetType)}<br><code>${escapeHtml(action.targetId ?? "")}</code></td>
            <td><code>${escapeHtml(action.policyId)}</code></td>
            <td>${escapeHtml(action.reason)}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderRuntimeAlerts(report: DefenseReport): string {
  if (report.runtimeAlerts.length === 0) {
    return "<p>No runtime warnings were recorded.</p>";
  }

  return `<table>
    <thead><tr><th>Risk</th><th>Title</th><th>Message</th></tr></thead>
    <tbody>
      ${report.runtimeAlerts
        .map(
          (alert) => `<tr>
            <td>${escapeHtml(alert.riskLevel)}</td>
            <td>${escapeHtml(alert.title)}<br><code>${escapeHtml(alert.recordId)}</code></td>
            <td>${escapeHtml(alert.message)}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderResidualRisk(report: DefenseReport): string {
  if (report.residualRisk.length === 0) {
    return "<p>All detected weaknesses have at least one runtime mitigation record.</p>";
  }

  return `<table>
    <thead><tr><th>Category</th><th>Risk</th><th>Description</th></tr></thead>
    <tbody>
      ${report.residualRisk
        .map(
          (risk) => `<tr>
            <td>${escapeHtml(risk.category)}</td>
            <td>${escapeHtml(risk.riskLevel)}</td>
            <td>${escapeHtml(risk.description)}<br>${renderCodeList(risk.relatedWeaknessIds)}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderCodeList(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  return values.map((value) => `<code>${escapeHtml(value)}</code>`).join("<br>");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
