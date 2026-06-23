import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type {
  AgentRiskProfile,
  DefenseClaim,
  DefenseReport,
  DetectionReport,
  EvidenceBundle,
  EvidenceCoverageMatrix,
  EvidenceCoverageRow,
  EvidenceItem,
  EvidenceKind,
  InteractionTrace,
  JsonObject,
  JsonValue,
  MissingEvidenceItem,
  ReportArtifact,
  ReportBundle,
  ReportQualityCheck,
  ReportQualitySummary,
  RiskReport,
  RuntimeSupervisionRecord,
  SupervisionPolicyPack,
  TestContextView,
  TraceabilityEdge,
  TraceabilityGraph,
  TraceabilityNode,
} from "@agent-guard/contracts";
import type { P2RunGroup } from "../../api/types";
import { createId, nowIso } from "../../shared";
import { loadConfigRepository } from "../config/loadTestContext";
import { buildConfigIndex, type ConfigRepository } from "../config/configRepository";
import { getArtifactEntry, getReportEntry, indexArtifact } from "../../storage/fileReportStore";
import { getRunGroup, getSessionRecords, listRunGroups } from "../../storage/fileRunStore";
import { resolveInsideDirectory } from "../../storage/pathSafety";

const CONFIGS_DIR = path.resolve(process.cwd(), "configs");
const REPORTS_DIR = path.resolve(process.cwd(), "outputs", "reports");
const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");

export class ReportBundleNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportBundleNotFoundError";
  }
}

type LoadedReportSource = {
  runGroup: P2RunGroup;
  detectionReport?: DetectionReport;
  riskProfile?: AgentRiskProfile;
  policyPack?: SupervisionPolicyPack;
  riskReports: RiskReport[];
  defenseReport?: DefenseReport;
  runtimeRecords: RuntimeSupervisionRecord[];
  traces: InteractionTrace[];
  artifacts: ReportArtifact[];
  policyContextSource?: P2RunGroup["policyContextSource"];
};

export type ReportBundleExportJob = {
  exportJobId: string;
  bundleId: string;
  reportId: string;
  format: "markdown" | "html" | "pdf";
  language: ReportBundleExportLanguage;
  artifact: {
    artifactId: string;
    reportId: string;
    format: "markdown" | "html" | "pdf";
    language: ReportBundleExportLanguage;
    url: string;
    generatedAt: string;
  };
  status: "completed";
  generatedAt: string;
};

export type ReportBundleExportLanguage = "en" | "zh";

export type ReportBundleHumanReview = {
  reviewerNote?: string;
  claimDecisions?: Record<string, "accepted" | "needs_changes" | "skipped">;
  reviewedClaimCount?: number;
  reviewedAt?: string;
};

const exportJobs = new Map<string, ReportBundleExportJob>();

export async function composeReportBundleForRunGroup(
  runGroupId: string,
): Promise<ReportBundle> {
  const source = await loadReportSource(runGroupId);
  return composeReportBundle(source);
}

export async function composeReportBundleForDefenseReport(
  reportId: string,
): Promise<ReportBundle> {
  const entry = await getReportEntry(reportId);
  if (!entry || entry.reportType !== "defense_report") {
    throw new ReportBundleNotFoundError(`Defense report ${reportId} not found.`);
  }
  return composeReportBundleForRunGroup(entry.runGroupId);
}

export async function composeReportBundleByBundleId(
  bundleId: string,
): Promise<ReportBundle> {
  const runGroupId = runGroupIdFromBundleId(bundleId);
  if (!runGroupId) {
    throw new ReportBundleNotFoundError(`Report bundle ${bundleId} not found.`);
  }
  return composeReportBundleForRunGroup(runGroupId);
}

export async function exportReportBundle(
  bundle: ReportBundle,
  format: "markdown" | "html" | "pdf",
  humanReview?: ReportBundleHumanReview,
  language: ReportBundleExportLanguage = "en",
): Promise<ReportBundleExportJob> {
  const exportLanguage = language === "zh" ? "zh" : "en";
  const reportId = bundle.source.defenseReportId ?? bundle.bundleId;
  const extension = format === "markdown" ? "md" : format;
  const outputDir = resolveInsideDirectory(REPORTS_DIR, path.join(bundle.runGroupId, "exports"));
  await fs.mkdir(outputDir, { recursive: true });
  const artifact: ReportArtifact = {
    schemaVersion: "mvp-1",
    artifactId: createId("artifact"),
    reportId,
    format,
    path: path.join(outputDir, `report-bundle.${exportLanguage}.${extension}`),
    generatedAt: nowIso(),
  };

  if (format === "pdf") {
    await fs.writeFile(artifact.path, await renderBundlePdf(bundle, humanReview, exportLanguage));
  } else {
    const body =
      format === "markdown"
        ? renderBundleMarkdown(bundle, humanReview, exportLanguage)
        : renderBundleHtml(bundle, humanReview, exportLanguage);
    await fs.writeFile(artifact.path, body, "utf-8");
  }
  await indexArtifact(
    artifact,
    `Report Bundle (${formatLabel(format)}, ${languageLabel(exportLanguage)})`,
  );

  const job: ReportBundleExportJob = {
    exportJobId: createId("export_job"),
    bundleId: bundle.bundleId,
    reportId,
    format,
    language: exportLanguage,
    artifact: {
      artifactId: artifact.artifactId,
      reportId: artifact.reportId,
      format,
      language: exportLanguage,
      url: `/api/v1/artifacts/${artifact.artifactId}`,
      generatedAt: artifact.generatedAt,
    },
    status: "completed",
    generatedAt: artifact.generatedAt,
  };
  exportJobs.set(job.exportJobId, job);
  return job;
}

export function getReportBundleExportJob(
  exportJobId: string,
): ReportBundleExportJob | undefined {
  return exportJobs.get(exportJobId);
}

async function composeReportBundle(
  source: LoadedReportSource,
): Promise<ReportBundle> {
  const testContextViews = await buildTestContextViews(source);
  const claims = buildClaims(source);
  const evidenceItems = buildEvidenceItems(source, testContextViews, claims);
  const missingEvidence = buildMissingEvidence(source, testContextViews, claims);
  const coverage = buildCoverage(claims, evidenceItems);
  const reportId = source.defenseReport?.defenseReportId ?? source.detectionReport?.reportId ?? source.runGroup.runGroupId;
  const evidenceBundle: EvidenceBundle = {
    evidenceBundleId: stableId("evidence_bundle", source.runGroup.runGroupId),
    reportId,
    coverage,
    items: evidenceItems,
    missingEvidence,
  };
  const quality = buildQualitySummary({
    reportId,
    source,
    testContextViews,
    evidenceBundle,
  });
  const traceabilityGraph = buildTraceabilityGraph(source, testContextViews, claims);

  return {
    schemaVersion: "mvp-1",
    bundleId: bundleIdForRunGroup(source.runGroup.runGroupId),
    runGroupId: source.runGroup.runGroupId,
    agentId: source.runGroup.agentId,
    generatedAt: nowIso(),
    source: {
      testContextViewIds: testContextViews.map((view) => view.contextViewId),
      testRunIds: source.runGroup.testRunIds,
      traceIds: source.runGroup.traceIds,
      riskReportIds: source.runGroup.riskReportIds,
      detectionReportId: source.detectionReport?.reportId,
      riskProfileId: source.riskProfile?.profileId,
      policyPackId: source.policyPack?.policyPackId,
      runtimeSessionIds: [
        ...new Set([
          ...source.runGroup.runtimeSessionIds,
          ...(source.defenseReport?.runtimeSessionIds ?? []),
        ]),
      ],
      defenseReportId: source.defenseReport?.defenseReportId,
    },
    testContextViews,
    executiveSummary: buildExecutiveSummary(source, claims, quality),
    claims,
    evidenceBundle,
    traceabilityGraph,
    quality,
    exports: source.artifacts,
  };
}

async function loadReportSource(runGroupId: string): Promise<LoadedReportSource> {
  const runGroup = await getRunGroup(runGroupId);
  if (!runGroup) {
    throw new ReportBundleNotFoundError(`Run group ${runGroupId} not found.`);
  }

  const runDir = resolveInsideDirectory(REPORTS_DIR, runGroup.runGroupId);
  const [
    detectionReport,
    riskProfile,
    policyPack,
    riskReports,
    defenseReport,
    traces,
    artifactEntries,
  ] = await Promise.all([
    readOptionalJson<DetectionReport>(path.join(runDir, "detection-report.json")),
    readOptionalJson<AgentRiskProfile>(path.join(runDir, "agent-risk-profile.json")),
    readOptionalJson<SupervisionPolicyPack>(path.join(runDir, "supervision-policy-pack.json")),
    readOptionalJson<RiskReport[]>(path.join(runDir, "risk-reports.json")).then((value) => value ?? []),
    readOptionalJson<DefenseReport>(path.join(runDir, "defense-report.json")),
    readTraces(runGroup.traceIds),
    Promise.all(runGroup.artifactIds.map((artifactId) => getArtifactEntry(artifactId))),
  ]);

  const runtimeSessionIds = [
    ...new Set([
      ...runGroup.runtimeSessionIds,
      ...(defenseReport?.runtimeSessionIds ?? []),
    ]),
  ];
  const sessions = await Promise.all(
    runtimeSessionIds.map((runtimeSessionId) => getSessionRecords(runtimeSessionId)),
  );
  const runtimeRecords = sessions.flatMap((session) => session?.records ?? []);
  const policyContextSource =
    runGroup.policyContextSource ??
    sessions.find((session) => session?.policyContextSource)?.policyContextSource;

  return {
    runGroup,
    detectionReport,
    riskProfile,
    policyPack,
    riskReports,
    defenseReport,
    runtimeRecords,
    traces,
    artifacts: artifactEntries
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => ({
        schemaVersion: "mvp-1",
        artifactId: entry.artifactId,
        reportId: entry.reportId,
        format: entry.format,
        path: entry.filePath,
        generatedAt: entry.generatedAt,
      })),
    policyContextSource,
  };
}

async function buildTestContextViews(
  source: LoadedReportSource,
): Promise<TestContextView[]> {
  let repository: ConfigRepository | undefined;
  try {
    repository = await loadConfigRepository(CONFIGS_DIR);
  } catch {
    repository = undefined;
  }
  const index = repository ? buildConfigIndex(repository) : undefined;
  const caseIds = [
    ...new Set([
      ...(source.runGroup.caseIds ?? []),
      ...source.traces.map((trace) => trace.caseId),
      ...source.riskReports.map((report) => report.caseId),
    ].filter(Boolean)),
  ];

  return caseIds.map((caseId) => {
    const trace = source.traces.find((item) => item.caseId === caseId);
    const riskReport = source.riskReports.find((item) => item.caseId === caseId);
    const testCase = index?.testCasesById.get(caseId);
    const scenarioIds =
      repository?.redTeamScenarioSet.scenarios
        .filter((scenario) => scenario.caseIds.includes(caseId))
        .map((scenario) => scenario.scenarioId) ?? [];

    if (!testCase) {
      return {
        schemaVersion: "mvp-1",
        contextViewId: stableId("context_view", caseId),
        contextId: riskReport?.contextId ?? trace?.contextId ?? stableId("context.missing", caseId),
        caseId,
        caseName: caseId,
        agentId: source.runGroup.agentId,
        scenarioIds,
        task: {},
        tools: [],
        resources: [],
        prompts: [],
        riskRuleIds: [],
        source: trace ? "trace_only" : "missing",
        warnings: [
          trace
            ? "TestContext config was not found; view was reconstructed from trace metadata only."
            : "TestContext config and trace metadata were not found.",
        ],
      };
    }

    return {
      schemaVersion: "mvp-1",
      contextViewId: stableId("context_view", caseId),
      contextId: riskReport?.contextId ?? trace?.contextId ?? stableId("context", caseId),
      caseId,
      caseName: testCase.caseName,
      agentId: source.runGroup.agentId,
      scenarioIds,
      attackEntryType: testCase.attackEntryType,
      task: {
        taskId: testCase.task.taskId,
        instructionPreview: preview(testCase.task.instruction, 280),
      },
      tools: testCase.toolIds.map((toolId) => {
        const tool = index?.toolsById.get(toolId);
        return {
          toolId,
          name: tool?.name,
          riskLevel: tool?.riskLevel,
          sideEffect: tool?.sideEffect,
        };
      }),
      resources: testCase.resourceIds.map((resourceId) => {
        const resource = index?.resourcesById.get(resourceId);
        return {
          resourceId,
          name: resource?.name,
          sensitivity: resource?.sensitivity,
        };
      }),
      prompts: testCase.promptIds.map((promptId) => {
        const prompt = index?.promptsById.get(promptId);
        return {
          promptId,
          name: prompt?.name,
          attackEntryType: prompt?.attackEntryType,
        };
      }),
      riskRuleIds: repository?.riskRules.map((rule) => rule.ruleId) ?? [],
      source: "config",
      warnings: trace ? [] : ["Trace for this test context was not found in the run group."],
    };
  });
}

function buildClaims(source: LoadedReportSource): DefenseClaim[] {
  const claims: DefenseClaim[] = [];

  for (const report of source.riskReports) {
    for (const finding of report.findings) {
      claims.push({
        claimId: stableId("claim.risk", finding.findingId),
        title: finding.title,
        statement: finding.description,
        claimType: "risk",
        confidence: finding.evidenceEventIds.length ? "high" : "medium",
        sourceIds: {
          contextIds: [report.contextId],
          traceEventIds: finding.evidenceEventIds,
          findingIds: [finding.findingId],
        },
        reviewStatus: finding.evidenceEventIds.length ? "auto_checked" : "needs_review",
      });
    }
  }

  if (source.detectionReport) {
    claims.push({
      claimId: stableId("claim.detection", source.detectionReport.reportId),
      title: "Detection report summarizes observed risk findings",
      statement:
        `Detection report ${source.detectionReport.reportId} contains ` +
        `${source.detectionReport.riskSummary.totalFindings} findings across ` +
        `${source.detectionReport.riskSummary.totalScenarios} scenarios.`,
      claimType: "detection",
      confidence: source.detectionReport.findingIds.length ? "high" : "medium",
      sourceIds: {
        findingIds: source.detectionReport.findingIds,
        traceEventIds: source.detectionReport.failedScenarios.flatMap((item) => item.evidenceEventIds),
      },
      reviewStatus: source.detectionReport.findingIds.length ? "auto_checked" : "needs_review",
    });
  }

  for (const policy of source.policyPack?.policies ?? []) {
    claims.push({
      claimId: stableId("claim.policy", policy.policyId),
      title: policy.name,
      statement: policy.description || policy.reason,
      claimType: "policy",
      confidence: "high",
      sourceIds: {
        policyIds: [policy.policyId],
      },
      reviewStatus: "auto_checked",
    });
  }

  for (const record of source.runtimeRecords) {
    if (record.action === "allow") continue;
    claims.push({
      claimId: stableId("claim.runtime", record.recordId),
      title: `Runtime ${record.action} decision for ${record.targetType}`,
      statement: record.decisionReason,
      claimType: "runtime_effect",
      confidence: source.policyContextSource === "stored_detection" ? "high" : "medium",
      sourceIds: {
        policyIds: [record.policyId],
        runtimeRecordIds: [record.recordId],
      },
      reviewStatus: "auto_checked",
    });
  }

  for (const residualRisk of source.defenseReport?.residualRisk ?? []) {
    claims.push({
      claimId: stableId("claim.residual", residualRisk.residualRiskId),
      title: `Residual risk: ${residualRisk.category}`,
      statement: residualRisk.description,
      claimType: "residual_risk",
      confidence: "medium",
      sourceIds: {
        findingIds: residualRisk.relatedWeaknessIds,
      },
      reviewStatus: "needs_review",
    });
  }

  if (!source.defenseReport) {
    claims.push({
      claimId: stableId("claim.limitation", source.runGroup.runGroupId),
      title: "Defense effect is not yet reportable",
      statement:
        "No DefenseReport is available for this run group; runtime defense claims must remain disabled.",
      claimType: "limitation",
      confidence: "high",
      sourceIds: {},
      reviewStatus: "blocked_by_missing_evidence",
    });
  }

  if (source.policyContextSource === "synthetic_fallback") {
    claims.push({
      claimId: stableId("claim.limitation", `${source.runGroup.runGroupId}.fallback`),
      title: "Fallback policy context limits submission strength",
      statement:
        "Realtime records were generated with a synthetic fallback policy context, not a stored detection-derived policy pack.",
      claimType: "limitation",
      confidence: "high",
      sourceIds: {
        runtimeRecordIds: source.runtimeRecords.map((record) => record.recordId),
      },
      reviewStatus: "needs_review",
    });
  }

  return claims;
}

function buildEvidenceItems(
  source: LoadedReportSource,
  testContextViews: TestContextView[],
  claims: DefenseClaim[],
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const relatedClaimIdsByObject = buildRelatedClaimIndex(claims);

  for (const view of testContextViews) {
    items.push(evidenceItem("test_context", view.contextViewId, view.caseName, view.caseId, relatedClaimIdsByObject, {
      contextId: view.contextId,
      caseId: view.caseId,
      source: view.source,
    }));
  }
  for (const trace of source.traces) {
    items.push(evidenceItem("trace", trace.traceId, `Trace ${trace.traceId}`, `${trace.events.length} events`, relatedClaimIdsByObject, {
      traceId: trace.traceId,
      caseId: trace.caseId,
      status: trace.status,
    }));
    for (const event of trace.events) {
      items.push(evidenceItem("trace_event", event.eventId, `${event.type} #${event.sequence}`, event.actor, relatedClaimIdsByObject, {
        traceId: event.traceId,
        sequence: event.sequence,
        type: event.type,
      }));
    }
  }
  for (const report of source.riskReports) {
    items.push(evidenceItem("risk_report", report.reportId, `RiskReport ${report.reportId}`, report.caseId, relatedClaimIdsByObject, {
      riskLevel: report.riskLevel,
      findingCount: report.findings.length,
    }));
    for (const finding of report.findings) {
      items.push(evidenceItem("finding", finding.findingId, finding.title, finding.description, relatedClaimIdsByObject, {
        category: finding.category,
        riskLevel: finding.riskLevel,
      }));
    }
  }
  if (source.detectionReport) {
    items.push(evidenceItem("detection_report", source.detectionReport.reportId, "Detection report", `${source.detectionReport.riskSummary.totalFindings} findings`, relatedClaimIdsByObject, {
      highestRiskLevel: source.detectionReport.riskSummary.highestRiskLevel,
      failedScenarioCount: source.detectionReport.riskSummary.failedScenarioCount,
    }));
  }
  if (source.riskProfile) {
    items.push(evidenceItem("risk_profile", source.riskProfile.profileId, "Agent risk profile", `${source.riskProfile.weaknesses.length} weaknesses`, relatedClaimIdsByObject, {
      confidence: source.riskProfile.confidence,
      weaknessCount: source.riskProfile.weaknesses.length,
    }));
  }
  if (source.policyPack) {
    items.push(evidenceItem("policy_pack", source.policyPack.policyPackId, "Supervision policy pack", `${source.policyPack.policies.length} policies`, relatedClaimIdsByObject, {
      policyCount: source.policyPack.policies.length,
      defaultAction: source.policyPack.defaultAction,
    }));
    for (const policy of source.policyPack.policies) {
      items.push(evidenceItem("policy", policy.policyId, policy.name, policy.reason, relatedClaimIdsByObject, {
        action: policy.action,
        targetType: policy.targetType,
        riskLevel: policy.riskLevel,
      }));
    }
  }
  for (const runtimeSessionId of [
    ...new Set([
      ...source.runGroup.runtimeSessionIds,
      ...(source.defenseReport?.runtimeSessionIds ?? []),
    ]),
  ]) {
    items.push(evidenceItem("runtime_session", runtimeSessionId, `Runtime session ${runtimeSessionId}`, source.policyContextSource ?? "unknown policy context", relatedClaimIdsByObject, {
      runtimeSessionId,
      policyContextSource: source.policyContextSource ?? "unknown",
    }));
  }
  for (const record of source.runtimeRecords) {
    items.push(evidenceItem("runtime_record", record.recordId, `${record.action} ${record.targetType}`, record.decisionReason, relatedClaimIdsByObject, {
      runtimeSessionId: record.runtimeSessionId,
      policyId: record.policyId,
      action: record.action,
      targetType: record.targetType,
      targetId: record.targetId ?? "",
    }));
  }
  if (source.defenseReport) {
    items.push(evidenceItem("defense_report", source.defenseReport.defenseReportId, "Defense report", `${source.defenseReport.blockedActions.length} blocked actions`, relatedClaimIdsByObject, {
      blockedActionCount: source.defenseReport.blockedActions.length,
      runtimeSessionCount: source.defenseReport.runtimeSessionIds.length,
    }));
  }
  for (const artifact of source.artifacts) {
    items.push(evidenceItem("artifact", artifact.artifactId, `${artifact.format} artifact`, artifact.reportId, relatedClaimIdsByObject, {
      reportId: artifact.reportId,
      format: artifact.format,
    }));
  }

  return items;
}

function buildMissingEvidence(
  source: LoadedReportSource,
  testContextViews: TestContextView[],
  claims: DefenseClaim[],
): MissingEvidenceItem[] {
  const missing: MissingEvidenceItem[] = [];
  if (!source.detectionReport) {
    missing.push(missingEvidence("detection_report", "DetectionReport was not found for this run group.", "blocking"));
  }
  if (!source.riskProfile) {
    missing.push(missingEvidence("risk_profile", "AgentRiskProfile was not found for this run group.", "blocking"));
  }
  if (!source.policyPack) {
    missing.push(missingEvidence("policy_pack", "SupervisionPolicyPack was not found for this run group.", "blocking"));
  }
  if (!source.defenseReport) {
    missing.push(missingEvidence("defense_report", "DefenseReport has not been generated yet.", "warning"));
  }
  if (source.defenseReport && source.runtimeRecords.length === 0) {
    missing.push(missingEvidence("runtime_record", "DefenseReport references no persisted RuntimeSupervisionRecord.", "blocking"));
  }
  if (source.policyContextSource === "synthetic_fallback") {
    missing.push(missingEvidence("policy_pack", "Policy context is synthetic fallback, so the report cannot prove detection-derived policy execution.", "warning"));
  }
  for (const view of testContextViews) {
    if (view.source !== "config") {
      missing.push(missingEvidence("test_context", `TestContextView for ${view.caseId} is ${view.source}.`, "warning", view.contextViewId));
    }
  }
  for (const claim of claims) {
    if (
      claim.claimType === "runtime_effect" &&
      !(claim.sourceIds.runtimeRecordIds?.length)
    ) {
      missing.push(missingEvidence("runtime_record", `Runtime effect claim ${claim.claimId} has no runtime record.`, "blocking", undefined, claim.claimId));
    }
  }
  return missing;
}

function buildCoverage(
  claims: DefenseClaim[],
  evidenceItems: EvidenceItem[],
): EvidenceCoverageMatrix {
  const rows = claims.map((claim) => coverageRow(claim, evidenceItems));
  return {
    riskClaims: rows.filter((row) => claimType(claims, row.claimId) === "risk"),
    detectionClaims: rows.filter((row) => claimType(claims, row.claimId) === "detection"),
    policyClaims: rows.filter((row) => claimType(claims, row.claimId) === "policy"),
    runtimeEffectClaims: rows.filter((row) => claimType(claims, row.claimId) === "runtime_effect"),
    residualRiskClaims: rows.filter((row) => claimType(claims, row.claimId) === "residual_risk"),
  };
}

function coverageRow(
  claim: DefenseClaim,
  evidenceItems: EvidenceItem[],
): EvidenceCoverageRow {
  const requiredEvidenceKinds = requiredKindsForClaim(claim);
  const related = evidenceItems.filter((item) =>
    item.relatedClaimIds.includes(claim.claimId),
  );
  const available = new Set(related.map((item) => item.kind));
  for (const kind of requiredEvidenceKinds) {
    if (isGlobalEvidenceAvailable(kind, evidenceItems)) {
      available.add(kind);
    }
  }
  const availableEvidenceKinds = [...available].filter((kind) =>
    requiredEvidenceKinds.includes(kind),
  );
  const missingEvidenceKinds = requiredEvidenceKinds.filter(
    (kind) => !availableEvidenceKinds.includes(kind),
  );
  return {
    claimId: claim.claimId,
    requiredEvidenceKinds,
    availableEvidenceKinds,
    missingEvidenceKinds,
    coverageStatus:
      missingEvidenceKinds.length === 0
        ? "complete"
        : availableEvidenceKinds.length > 0
          ? "partial"
          : "missing",
  };
}

function isGlobalEvidenceAvailable(
  kind: EvidenceKind,
  evidenceItems: EvidenceItem[],
): boolean {
  return (
    kind === "detection_report" ||
    kind === "risk_profile" ||
    kind === "policy_pack" ||
    kind === "defense_report" ||
    kind === "missing_evidence"
  ) && evidenceItems.some((item) => item.kind === kind);
}

function requiredKindsForClaim(claim: DefenseClaim): EvidenceKind[] {
  switch (claim.claimType) {
    case "risk":
      return ["finding", "trace_event"];
    case "detection":
      return ["detection_report", "finding"];
    case "policy":
      return ["policy_pack", "policy"];
    case "runtime_effect":
      return ["runtime_record", "policy"];
    case "residual_risk":
      return ["defense_report", "risk_profile"];
    case "limitation":
      return ["missing_evidence"];
  }
}

function buildQualitySummary(input: {
  reportId: string;
  source: LoadedReportSource;
  testContextViews: TestContextView[];
  evidenceBundle: EvidenceBundle;
}): ReportQualitySummary {
  const checks: ReportQualityCheck[] = [];
  const blockingIssues = input.evidenceBundle.missingEvidence
    .filter((item) => item.severity === "blocking")
    .map((item) => item.reason);
  const hasRuntimeRecords = input.source.runtimeRecords.length > 0;
  const hasConfigContext = input.testContextViews.every((view) => view.source === "config");
  const usesSyntheticFallback = input.source.policyContextSource === "synthetic_fallback";
  const hasDefenseReport = Boolean(input.source.defenseReport);

  checks.push(check("detection_report", Boolean(input.source.detectionReport), "DetectionReport is available."));
  checks.push(check("risk_profile", Boolean(input.source.riskProfile), "AgentRiskProfile is available."));
  checks.push(check("policy_pack", Boolean(input.source.policyPack), "SupervisionPolicyPack is available."));
  checks.push(check("runtime_records", hasRuntimeRecords, "RuntimeSupervisionRecord evidence is available."));
  checks.push(check("test_context_views", hasConfigContext, "TestContextView is backed by config data."));
  checks.push({
    checkId: "check.policy_context_source",
    title: "Policy context source",
    status: usesSyntheticFallback ? "warn" : "pass",
    detail: usesSyntheticFallback
      ? "Realtime report uses synthetic fallback policy context."
      : "Policy context is stored detection output or not applicable.",
  });

  let score = 100;
  score -= input.evidenceBundle.missingEvidence.filter((item) => item.severity === "blocking").length * 25;
  score -= input.evidenceBundle.missingEvidence.filter((item) => item.severity === "warning").length * 10;
  if (!hasRuntimeRecords) score -= 20;
  if (!hasDefenseReport) score -= 15;
  if (usesSyntheticFallback) score -= 10;
  score = Math.max(0, Math.min(100, score));

  const level =
    blockingIssues.length > 0 || !input.source.detectionReport || !input.source.policyPack
      ? "draft"
      : !hasRuntimeRecords || !hasDefenseReport || !hasConfigContext || usesSyntheticFallback
        ? "reviewable"
        : "submission_ready";

  return {
    reportId: input.reportId,
    score,
    level,
    checks,
    blockingIssues,
    generatedAt: nowIso(),
  };
}

function buildTraceabilityGraph(
  source: LoadedReportSource,
  testContextViews: TestContextView[],
  claims: DefenseClaim[],
): TraceabilityGraph {
  const nodes = new Map<string, TraceabilityNode>();
  const edges: TraceabilityEdge[] = [];
  const addNode = (node: TraceabilityNode) => nodes.set(node.nodeId, node);
  const addEdge = (from: string, to: string, relation: TraceabilityEdge["relation"]) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    edges.push({
      edgeId: stableId("edge", `${from}.${relation}.${to}`),
      from,
      to,
      relation,
    });
  };

  addNode(node("test_run", source.runGroup.runGroupId, source.runGroup.agentName));
  for (const view of testContextViews) addNode(node("test_context", view.contextViewId, view.caseName));
  for (const trace of source.traces) {
    addNode(node("trace", trace.traceId, `Trace ${trace.traceId}`));
    for (const event of trace.events) addNode(node("trace_event", event.eventId, `${event.type} ${event.sequence}`));
  }
  for (const report of source.riskReports) {
    addNode(node("risk_report", report.reportId, `RiskReport ${report.caseId}`));
    for (const finding of report.findings) addNode(node("finding", finding.findingId, finding.title));
  }
  if (source.detectionReport) addNode(node("detection_report", source.detectionReport.reportId, "DetectionReport"));
  if (source.riskProfile) addNode(node("risk_profile", source.riskProfile.profileId, "AgentRiskProfile"));
  if (source.policyPack) {
    addNode(node("policy_pack", source.policyPack.policyPackId, "SupervisionPolicyPack"));
    for (const policy of source.policyPack.policies) addNode(node("policy", policy.policyId, policy.name));
  }
  for (const runtimeSessionId of [
    ...new Set([
      ...source.runGroup.runtimeSessionIds,
      ...(source.defenseReport?.runtimeSessionIds ?? []),
    ]),
  ]) addNode(node("runtime_session", runtimeSessionId, `Runtime ${runtimeSessionId}`));
  for (const record of source.runtimeRecords) addNode(node("runtime_record", record.recordId, `${record.action} ${record.targetType}`));
  if (source.defenseReport) addNode(node("defense_report", source.defenseReport.defenseReportId, "DefenseReport"));
  for (const artifact of source.artifacts) addNode(node("artifact", artifact.artifactId, `${artifact.format} artifact`));
  for (const claim of claims) addNode(node("claim", claim.claimId, claim.title));

  for (const view of testContextViews) addEdge(view.contextViewId, source.runGroup.runGroupId, "produced_by");
  for (const trace of source.traces) {
    addEdge(source.runGroup.runGroupId, trace.traceId, "produced_by");
    for (const event of trace.events) addEdge(trace.traceId, event.eventId, "produced_by");
  }
  for (const report of source.riskReports) {
    addEdge(report.traceId, report.reportId, "derived_from");
    for (const finding of report.findings) {
      addEdge(report.reportId, finding.findingId, "produced_by");
      for (const eventId of finding.evidenceEventIds) addEdge(eventId, finding.findingId, "supports_claim");
    }
  }
  if (source.detectionReport) {
    for (const riskReportId of source.detectionReport.sourceRiskReportIds) addEdge(riskReportId, source.detectionReport.reportId, "derived_from");
  }
  if (source.riskProfile && source.detectionReport) addEdge(source.detectionReport.reportId, source.riskProfile.profileId, "derived_from");
  if (source.policyPack && source.riskProfile) addEdge(source.riskProfile.profileId, source.policyPack.policyPackId, "derived_from");
  for (const policy of source.policyPack?.policies ?? []) addEdge(source.policyPack?.policyPackId ?? "", policy.policyId, "produced_by");
  for (const record of source.runtimeRecords) {
    addEdge(record.runtimeSessionId, record.recordId, "observed_in");
    addEdge(record.policyId, record.recordId, "uses_policy");
  }
  if (source.defenseReport) {
    for (const record of source.runtimeRecords) addEdge(record.recordId, source.defenseReport.defenseReportId, "derived_from");
    for (const artifact of source.artifacts) addEdge(source.defenseReport.defenseReportId, artifact.artifactId, "exported_as");
  }
  for (const claim of claims) {
    for (const id of claim.sourceIds.findingIds ?? []) addEdge(id, claim.claimId, "supports_claim");
    for (const id of claim.sourceIds.policyIds ?? []) addEdge(id, claim.claimId, "supports_claim");
    for (const id of claim.sourceIds.runtimeRecordIds ?? []) addEdge(id, claim.claimId, "supports_claim");
    for (const id of claim.sourceIds.traceEventIds ?? []) addEdge(id, claim.claimId, "supports_claim");
  }

  return {
    graphId: stableId("graph", source.runGroup.runGroupId),
    nodes: [...nodes.values()],
    edges,
  };
}

function buildExecutiveSummary(
  source: LoadedReportSource,
  claims: DefenseClaim[],
  quality: ReportQualitySummary,
) {
  const runtimeClaims = claims.filter((claim) => claim.claimType === "runtime_effect");
  const blockedCount = source.runtimeRecords.filter((record) => record.action === "deny").length;
  const redactedCount = source.runtimeRecords.filter((record) => record.action === "redact").length;
  const askCount = source.runtimeRecords.filter((record) => record.action === "ask").length;
  return {
    sectionId: stableId("section", `${source.runGroup.runGroupId}.summary`),
    title: "Executive Summary",
    summary:
      `Run ${source.runGroup.runGroupId} is ${quality.level} with quality score ${quality.score}.`,
    bullets: [
      `Detection findings: ${source.detectionReport?.riskSummary.totalFindings ?? 0}.`,
      `Runtime records: ${source.runtimeRecords.length}; deny=${blockedCount}, redact=${redactedCount}, ask=${askCount}.`,
      `Runtime effect claims backed by records: ${runtimeClaims.length}.`,
      `Policy context source: ${source.policyContextSource ?? "unknown"}.`,
    ],
    sourceIds: [
      source.runGroup.runGroupId,
      source.detectionReport?.reportId,
      source.policyPack?.policyPackId,
      source.defenseReport?.defenseReportId,
    ].filter((value): value is string => Boolean(value)),
  };
}

function buildRelatedClaimIndex(claims: DefenseClaim[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const add = (id: string | undefined, claimId: string) => {
    if (!id) return;
    result.set(id, [...(result.get(id) ?? []), claimId]);
  };
  for (const claim of claims) {
    for (const id of claim.sourceIds.contextIds ?? []) add(id, claim.claimId);
    for (const id of claim.sourceIds.traceEventIds ?? []) add(id, claim.claimId);
    for (const id of claim.sourceIds.findingIds ?? []) add(id, claim.claimId);
    for (const id of claim.sourceIds.policyIds ?? []) add(id, claim.claimId);
    for (const id of claim.sourceIds.runtimeRecordIds ?? []) add(id, claim.claimId);
  }
  return result;
}

function evidenceItem(
  kind: EvidenceKind,
  objectId: string,
  title: string,
  summary: string,
  relatedClaimIdsByObject: Map<string, string[]>,
  data?: JsonObject,
): EvidenceItem {
  return {
    evidenceId: stableId("evidence", `${kind}.${objectId}`),
    kind,
    objectId,
    title,
    summary: preview(summary, 360),
    relatedClaimIds: relatedClaimIdsByObject.get(objectId) ?? [],
    data,
  };
}

function missingEvidence(
  requiredKind: EvidenceKind,
  reason: string,
  severity: MissingEvidenceItem["severity"],
  sourceId?: string,
  relatedClaimId?: string,
): MissingEvidenceItem {
  return {
    missingEvidenceId: stableId("missing", `${requiredKind}.${sourceId ?? relatedClaimId ?? reason}`),
    requiredKind,
    sourceId,
    relatedClaimId,
    reason,
    severity,
  };
}

function check(
  checkId: string,
  pass: boolean,
  detail: string,
): ReportQualityCheck {
  return {
    checkId: `check.${checkId}`,
    title: checkId.replaceAll("_", " "),
    status: pass ? "pass" : "fail",
    detail: pass ? detail : `${detail} Missing or incomplete.`,
  };
}

function node(kind: TraceabilityNode["kind"], id: string, label: string): TraceabilityNode {
  return { nodeId: id, kind, label };
}

function claimType(claims: DefenseClaim[], claimId: string): DefenseClaim["claimType"] | undefined {
  return claims.find((claim) => claim.claimId === claimId)?.claimType;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function readTraces(traceIds: string[]): Promise<InteractionTrace[]> {
  const traces = await Promise.all(
    traceIds.map((traceId) =>
      readOptionalJson<InteractionTrace>(path.join(TRACES_DIR, `${traceId}.json`)),
    ),
  );
  return traces.filter((trace): trace is InteractionTrace => Boolean(trace));
}

function bundleIdForRunGroup(runGroupId: string): string {
  return stableId("bundle", runGroupId);
}

function runGroupIdFromBundleId(bundleId: string): string | undefined {
  const prefix = "bundle.";
  if (!bundleId.startsWith(prefix)) return undefined;
  return bundleId.slice(prefix.length);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}.${value.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function preview(value: string | undefined, maxLength: number): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

const CLAIM_TITLE_ZH: Record<string, string> = {
  "API sensitive payload": "API 敏感载荷",
  "Execute dangerous code": "危险代码执行",
  "Write secret path": "写入敏感路径",
  "Detection report summarizes observed risk findings": "检测报告汇总已观察风险发现",
  "Deny external exfiltration": "阻断外部外传",
  "Redact secret outbound payload": "脱敏外发敏感载荷",
  "Ask before email send": "邮件发送前人工确认",
  "Deny system prompt read": "阻断系统提示词读取",
  "Deny code execution": "阻断代码执行",
  "Ask before file write": "文件写入前人工确认",
  "Realtime deny secret-path reads": "实时阻断敏感路径读取",
  "Realtime deny exfiltration API calls": "实时阻断外传 API 调用",
  "Realtime redact sensitive API payload": "实时脱敏敏感 API 载荷",
  "Realtime redact sensitive email body": "实时脱敏敏感邮件正文",
  "Realtime ask before code execution": "代码执行前实时人工确认",
  "Realtime ask before file write": "文件写入前实时人工确认",
  "Defense effect is not yet reportable": "防御效果暂不可报告",
  "Fallback policy context limits submission strength": "回退策略上下文限制提交强度",
};

function renderBundleMarkdown(
  bundle: ReportBundle,
  humanReview?: ReportBundleHumanReview,
  language: ReportBundleExportLanguage = "en",
): string {
  const labels = reportTextLabels(language);
  const coverageRows = coverageRowsForExport(bundle);
  const lines = [
    `# ${labels.title}`,
    ``,
    `${labels.bundle}: \`${bundle.bundleId}\``,
    `${labels.runGroup}: \`${bundle.runGroupId}\``,
    `${labels.quality}: **${qualityLevelLabel(bundle.quality.level, language)}** (${bundle.quality.score})`,
    ``,
    `## ${labels.executiveSummary}`,
    executiveSummaryText(bundle, language),
    ``,
    ...executiveSummaryBullets(bundle, language).map((item) => `- ${item}`),
    ``,
    `## ${labels.claims}`,
    ...bundle.claims.map((claim) =>
      `- **${claimTypeLabel(claim.claimType, language)}** \`${claim.claimId}\`: ${localizedClaimTitle(claim, language)} (${reviewStatusLabel(claim.reviewStatus, language)})`,
    ),
    ``,
    `## ${labels.evidenceCoverage}`,
    ...coverageRows.map((row) =>
      `- \`${row.claimId}\`: ${coverageStatusLabel(row.coverageStatus, language)}; ${labels.missing}=${missingKindsText(row.missingEvidenceKinds, language)}`,
    ),
    ``,
    `## ${labels.missingEvidence}`,
    ...(bundle.evidenceBundle.missingEvidence.length
      ? bundle.evidenceBundle.missingEvidence.map((item) =>
          `- **${severityLabel(item.severity, language)}** ${evidenceKindLabel(item.requiredKind, language)}: ${localizedReason(item.reason, language)}`,
        )
      : [`- ${labels.none}`]),
    ``,
    ...renderHumanReviewMarkdown(humanReview, language),
    ``,
    `## ${labels.reproducibility}`,
    `${labels.generatedAt}: ${bundle.generatedAt}`,
  ];
  return `${lines.join("\n")}\n`;
}

function renderBundleHtml(
  bundle: ReportBundle,
  humanReview?: ReportBundleHumanReview,
  language: ReportBundleExportLanguage = "en",
): string {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const labels = reportTextLabels(language);
  const coverageRows = coverageRowsForExport(bundle);
  const reviewEntries = Object.entries(humanReview?.claimDecisions ?? {});
  return `<!doctype html>
<html lang="${language === "zh" ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <title>${escape(labels.title)}</title>
  <style>
    body { font-family: Arial, "Microsoft YaHei", sans-serif; margin: 32px; color: #17202a; }
    main { max-width: 1120px; margin: 0 auto; }
    code { background: #eef3f8; padding: 2px 4px; border-radius: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d8e1ec; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f0f4f9; }
  </style>
</head>
<body>
<main>
  <h1>${escape(labels.title)}</h1>
  <p>${escape(labels.bundle)} <code>${escape(bundle.bundleId)}</code> · ${escape(labels.quality)} <strong>${escape(qualityLevelLabel(bundle.quality.level, language))}</strong> (${bundle.quality.score})</p>
  <h2>${escape(labels.executiveSummary)}</h2>
  <p>${escape(executiveSummaryText(bundle, language))}</p>
  <ul>${executiveSummaryBullets(bundle, language).map((item) => `<li>${escape(item)}</li>`).join("")}</ul>
  <h2>${escape(labels.claims)}</h2>
  <table><thead><tr><th>${escape(labels.type)}</th><th>${escape(labels.claim)}</th><th>${escape(labels.status)}</th></tr></thead><tbody>
    ${bundle.claims.map((claim) => `<tr><td>${escape(claimTypeLabel(claim.claimType, language))}</td><td><code>${escape(claim.claimId)}</code><br>${escape(localizedClaimTitle(claim, language))}</td><td>${escape(reviewStatusLabel(claim.reviewStatus, language))}</td></tr>`).join("")}
  </tbody></table>
  <h2>${escape(labels.evidenceCoverage)}</h2>
  <table><thead><tr><th>${escape(labels.area)}</th><th>${escape(labels.claim)}</th><th>${escape(labels.status)}</th><th>${escape(labels.missing)}</th></tr></thead><tbody>
    ${coverageRows.map((row) => `<tr><td>${escape(claimTypeLabel(row.area, language))}</td><td><code>${escape(row.claimId)}</code></td><td>${escape(coverageStatusLabel(row.coverageStatus, language))}</td><td>${escape(missingKindsText(row.missingEvidenceKinds, language))}</td></tr>`).join("")}
  </tbody></table>
  <h2>${escape(labels.missingEvidence)}</h2>
  <ul>${bundle.evidenceBundle.missingEvidence.map((item) => `<li><strong>${escape(severityLabel(item.severity, language))}</strong> ${escape(evidenceKindLabel(item.requiredKind, language))}: ${escape(localizedReason(item.reason, language))}</li>`).join("") || `<li>${escape(labels.none)}</li>`}</ul>
  <h2>${escape(labels.humanReview)}</h2>
  <p>${escape(humanReview?.reviewerNote?.trim() || emptyReviewNote(language))}</p>
  <p>${escape(labels.reviewedClaims)}: ${humanReview?.reviewedClaimCount ?? 0}. ${escape(labels.reviewedAt)}: ${escape(humanReview?.reviewedAt ?? labels.notRecorded)}.</p>
  <ul>${reviewEntries.map(([claimId, decision]) => `<li><code>${escape(claimId)}</code>: ${escape(decisionLabel(decision, language))}</li>`).join("") || `<li>${escape(labels.none)}</li>`}</ul>
</main>
</body>
</html>
`;
}

async function renderBundlePdf(
  bundle: ReportBundle,
  humanReview?: ReportBundleHumanReview,
  language: ReportBundleExportLanguage = "en",
): Promise<Buffer> {
  const labels = reportTextLabels(language);
  const coverageRows = coverageRowsForExport(bundle);
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const regularFont = await embedReportPdfFont(pdfDoc, "regular");
  const boldFont = await embedReportPdfFont(pdfDoc, "bold").catch(() => regularFont);

  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 48;
  const maxWidth = pageSize[0] - margin * 2;
  let page = pdfDoc.addPage(pageSize);
  let y = pageSize[1] - margin;

  const draw = (line: PdfReportLine) => {
    const size = line.size ?? 10;
    const lineHeight = size * 1.36;
    const font = line.weight === "bold" ? boldFont : regularFont;
    const color = line.color ?? rgb(0.12, 0.15, 0.2);
    const wrapped = line.text
      ? wrapPdfTextForFont(line.text, font, size, maxWidth)
      : [""];

    for (const segment of wrapped) {
      if (y - lineHeight < margin) {
        page = pdfDoc.addPage(pageSize);
        y = pageSize[1] - margin;
      }
      if (segment) {
        page.drawText(segment, {
          x: margin,
          y,
          size,
          font,
          color,
        });
      }
      y -= lineHeight;
    }
    y -= line.gapAfter ?? 0;
  };

  for (const line of buildPdfReportLines(bundle, humanReview, language, labels, coverageRows)) {
    draw(line);
  }

  return Buffer.from(await pdfDoc.save());
}

type PdfReportLine = {
  text: string;
  size?: number;
  weight?: "regular" | "bold";
  color?: RGB;
  gapAfter?: number;
};

function buildPdfReportLines(
  bundle: ReportBundle,
  humanReview: ReportBundleHumanReview | undefined,
  language: ReportBundleExportLanguage,
  labels: ReturnType<typeof reportTextLabels>,
  coverageRows: (EvidenceCoverageRow & { area: DefenseClaim["claimType"] })[],
): PdfReportLine[] {
  const muted = rgb(0.34, 0.42, 0.53);
  const accent = rgb(0.06, 0.35, 0.34);
  const section = (text: string): PdfReportLine => ({
    text,
    size: 13,
    weight: "bold",
    color: accent,
    gapAfter: 4,
  });
  const blank = (): PdfReportLine => ({ text: "", size: 6 });

  return [
    { text: labels.title, size: 18, weight: "bold", color: rgb(0.05, 0.08, 0.12), gapAfter: 8 },
    { text: `${labels.bundle}: ${bundle.bundleId}`, size: 10, color: muted },
    { text: `${labels.runGroup}: ${bundle.runGroupId}`, size: 10, color: muted },
    {
      text: `${labels.quality}: ${qualityLevelLabel(bundle.quality.level, language)} (${bundle.quality.score})`,
      size: 11,
      weight: "bold",
      color: accent,
      gapAfter: 10,
    },
    section(labels.executiveSummary),
    { text: executiveSummaryText(bundle, language), size: 10.5 },
    ...executiveSummaryBullets(bundle, language).map((item) => ({ text: `- ${item}`, size: 10 })),
    blank(),
    section(labels.claims),
    ...bundle.claims.map((claim) => ({
      text: `${claimTypeLabel(claim.claimType, language)} ${claim.claimId}: ${localizedClaimTitle(claim, language)} [${reviewStatusLabel(claim.reviewStatus, language)}]`,
      size: 9.4,
    })),
    blank(),
    section(labels.evidenceCoverage),
    ...coverageRows.map((row) => ({
      text: `${claimTypeLabel(row.area, language)} ${row.claimId}: ${coverageStatusLabel(row.coverageStatus, language)}; ${labels.missing}=${missingKindsText(row.missingEvidenceKinds, language)}`,
      size: 9.2,
    })),
    blank(),
    section(labels.missingEvidence),
    ...(bundle.evidenceBundle.missingEvidence.length
      ? bundle.evidenceBundle.missingEvidence.map((item) => ({
          text: `${severityLabel(item.severity, language)} ${evidenceKindLabel(item.requiredKind, language)}: ${localizedReason(item.reason, language)}`,
          size: 9.6,
        }))
      : [{ text: labels.none, size: 10 }]),
    blank(),
    section(labels.humanReview),
    { text: humanReview?.reviewerNote?.trim() || emptyReviewNote(language), size: 10 },
    { text: `${labels.reviewedClaims}: ${humanReview?.reviewedClaimCount ?? 0}`, size: 9.6, color: muted },
    { text: `${labels.reviewedAt}: ${humanReview?.reviewedAt ?? labels.notRecorded}`, size: 9.6, color: muted },
    ...Object.entries(humanReview?.claimDecisions ?? {}).map(([claimId, decision]) => ({
      text: `${claimId}: ${decisionLabel(decision, language)}`,
      size: 8.8,
    })),
    blank(),
    section(labels.reproducibility),
    { text: `${labels.generatedAt}: ${bundle.generatedAt}`, size: 9.6, color: muted },
  ];
}

async function embedReportPdfFont(
  pdfDoc: PDFDocument,
  weight: "regular" | "bold",
): Promise<PDFFont> {
  const fontPath = await resolveReportPdfFontPath(weight);
  const fontBytes = await fs.readFile(fontPath);
  return pdfDoc.embedFont(fontBytes, { subset: true });
}

async function resolveReportPdfFontPath(
  weight: "regular" | "bold",
): Promise<string> {
  const envPath =
    weight === "bold"
      ? process.env.AGENT_GUARD_PDF_BOLD_FONT_PATH
      : process.env.AGENT_GUARD_PDF_FONT_PATH;
  const candidates = [
    envPath,
    ...(weight === "bold"
      ? [
          "C:\\Windows\\Fonts\\Dengb.ttf",
          "C:\\Windows\\Fonts\\simhei.ttf",
          "C:\\Windows\\Fonts\\Deng.ttf",
        ]
      : [
          "C:\\Windows\\Fonts\\Deng.ttf",
          "C:\\Windows\\Fonts\\simhei.ttf",
          "C:\\Windows\\Fonts\\STSONG.TTF",
        ]),
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next configured font path.
    }
  }
  throw new Error(
    "No embeddable CJK font found for PDF export. Set AGENT_GUARD_PDF_FONT_PATH to a .ttf font.",
  );
}

function wrapPdfTextForFont(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  let current = "";
  for (const char of normalized) {
    const next = current ? `${current}${char}` : char;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = char.trimStart();
  }
  if (current) lines.push(current);
  return lines.length ? lines : [normalized];
}

function wrapPdfLine(value: string, maxLength: number): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const result: string[] = [];
  for (let start = 0; start < normalized.length; start += maxLength) {
    result.push(normalized.slice(start, start + maxLength));
  }
  return result;
}

function pdfLineOperators(value: string, y: number): string[] {
  const runs = splitPdfTextRuns(value.replace(/[\u0000-\u001f\u007f]/g, " "));
  if (!runs.length) {
    return [`1 0 0 1 50 ${y} Tm`];
  }
  return [
    `1 0 0 1 50 ${y} Tm`,
    ...runs.map((run) =>
      run.ascii
        ? `/F2 10 Tf ${pdfAsciiToken(run.text)} Tj`
        : `/F1 10 Tf ${pdfTextToken(run.text)} Tj`,
    ),
  ];
}

function splitPdfTextRuns(value: string): { text: string; ascii: boolean }[] {
  const runs: { text: string; ascii: boolean }[] = [];
  let current = "";
  let currentAscii: boolean | undefined;
  for (const char of value) {
    const ascii = isPdfAscii(char);
    if (currentAscii === undefined || currentAscii === ascii) {
      current += char;
      currentAscii = ascii;
      continue;
    }
    runs.push({ text: current, ascii: currentAscii });
    current = char;
    currentAscii = ascii;
  }
  if (current && currentAscii !== undefined) {
    runs.push({ text: current, ascii: currentAscii });
  }
  return runs;
}

function isPdfAscii(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code >= 0x20 && code <= 0x7e;
}

function pdfAsciiToken(value: string): string {
  return `(${value
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")})`;
}

function pdfTextToken(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  const buffer = Buffer.from(cleaned, "utf16le");
  for (let index = 0; index < buffer.length; index += 2) {
    const low = buffer[index];
    buffer[index] = buffer[index + 1] ?? 0;
    buffer[index + 1] = low;
  }
  return `<${buffer.toString("hex").toUpperCase()}>`;
}

function renderHumanReviewMarkdown(
  humanReview: ReportBundleHumanReview | undefined,
  language: ReportBundleExportLanguage,
): string[] {
  const labels = reportTextLabels(language);
  const decisions = Object.entries(humanReview?.claimDecisions ?? {});
  return [
    `## ${labels.humanReview}`,
    ``,
    humanReview?.reviewerNote?.trim() || emptyReviewNote(language),
    ``,
    `${labels.reviewedClaims}: ${humanReview?.reviewedClaimCount ?? 0}`,
    `${labels.reviewedAt}: ${humanReview?.reviewedAt ?? labels.notRecorded}`,
    ``,
    ...(decisions.length
      ? decisions.map(([claimId, decision]) => `- \`${claimId}\`: ${decisionLabel(decision, language)}`)
      : [`- ${labels.none}`]),
  ];
}

function formatLabel(format: "markdown" | "html" | "pdf"): string {
  if (format === "markdown") return "Markdown";
  if (format === "html") return "HTML";
  return "PDF";
}

function languageLabel(language: ReportBundleExportLanguage): string {
  return language === "zh" ? "中文" : "English";
}

function reportTextLabels(language: ReportBundleExportLanguage) {
  if (language === "zh") {
    return {
      title: "Agent Guard 报告包",
      bundle: "报告包",
      runGroup: "运行组",
      quality: "质量",
      executiveSummary: "执行摘要",
      claims: "结论",
      evidenceCoverage: "证据覆盖",
      missingEvidence: "缺失证据",
      humanReview: "人工复核",
      reproducibility: "可复现性",
      generatedAt: "生成时间",
      reviewedClaims: "已复核结论",
      reviewedAt: "复核时间",
      type: "类型",
      claim: "结论",
      status: "状态",
      area: "区域",
      missing: "缺失",
      none: "无",
      notRecorded: "未记录",
    };
  }
  return {
    title: "Agent Guard Report Bundle",
    bundle: "Bundle",
    runGroup: "Run Group",
    quality: "Quality",
    executiveSummary: "Executive Summary",
    claims: "Claims",
    evidenceCoverage: "Evidence Coverage",
    missingEvidence: "Missing Evidence",
    humanReview: "Human Review",
    reproducibility: "Reproducibility",
    generatedAt: "Generated at",
    reviewedClaims: "Reviewed claims",
    reviewedAt: "Reviewed at",
    type: "Type",
    claim: "Claim",
    status: "Status",
    area: "Area",
    missing: "missing",
    none: "none",
    notRecorded: "not recorded",
  };
}

function executiveSummaryText(
  bundle: ReportBundle,
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return bundle.executiveSummary.summary;
  return `本次运行 ${bundle.runGroupId} 的报告质量为${qualityLevelLabel(bundle.quality.level, language)}，质量分 ${bundle.quality.score}。`;
}

function executiveSummaryBullets(
  bundle: ReportBundle,
  language: ReportBundleExportLanguage,
): string[] {
  if (language === "en") return bundle.executiveSummary.bullets;
  const riskClaims = bundle.claims.filter((claim) => claim.claimType === "risk").length;
  const runtimeRecords = bundle.evidenceBundle.items.filter((item) => item.kind === "runtime_record").length;
  const runtimeClaims = bundle.claims.filter((claim) => claim.claimType === "runtime_effect").length;
  return [
    `检测发现: ${riskClaims}。`,
    `运行时监督记录: ${runtimeRecords}。`,
    `由运行时记录支撑的防御效果结论: ${runtimeClaims}。`,
    `策略包: ${bundle.source.policyPackId ?? "未生成"}。`,
  ];
}

function coverageRowsForExport(bundle: ReportBundle): (EvidenceCoverageRow & { area: DefenseClaim["claimType"] })[] {
  return [
    ...bundle.evidenceBundle.coverage.riskClaims.map((row) => ({ ...row, area: "risk" as const })),
    ...bundle.evidenceBundle.coverage.detectionClaims.map((row) => ({ ...row, area: "detection" as const })),
    ...bundle.evidenceBundle.coverage.policyClaims.map((row) => ({ ...row, area: "policy" as const })),
    ...bundle.evidenceBundle.coverage.runtimeEffectClaims.map((row) => ({ ...row, area: "runtime_effect" as const })),
    ...bundle.evidenceBundle.coverage.residualRiskClaims.map((row) => ({ ...row, area: "residual_risk" as const })),
  ];
}

function missingKindsText(
  kinds: EvidenceKind[],
  language: ReportBundleExportLanguage,
): string {
  if (!kinds.length) return reportTextLabels(language).none;
  return kinds.map((kind) => evidenceKindLabel(kind, language)).join(", ");
}

function localizedClaimTitle(
  claim: DefenseClaim,
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return claim.title;
  const direct = CLAIM_TITLE_ZH[claim.title];
  if (direct) return direct;
  const runtimeMatch = /^Runtime ([a-z_]+) decision for (.+)$/.exec(claim.title);
  if (runtimeMatch) {
    return `运行时${actionLabel(runtimeMatch[1], language)} ${runtimeMatch[2]}`;
  }
  const residualMatch = /^Residual risk: (.+)$/.exec(claim.title);
  if (residualMatch) {
    return `残余风险: ${residualMatch[1]}`;
  }
  return claim.title;
}

function localizedReason(
  reason: string,
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return reason;
  if (reason === "Policy context is synthetic fallback, so the report cannot prove detection-derived policy execution.") {
    return "策略上下文来自合成回退，无法证明策略执行确实由检测结果派生。";
  }
  const traceOnlyMatch = /^TestContextView for (.+) is trace_only\.$/.exec(reason);
  if (traceOnlyMatch) {
    return `测试上下文 ${traceOnlyMatch[1]} 仅由轨迹元数据重建。`;
  }
  const missingRuntimeMatch = /^Runtime effect claim (.+) has no runtime record\.$/.exec(reason);
  if (missingRuntimeMatch) {
    return `运行时效果结论 ${missingRuntimeMatch[1]} 缺少运行时记录。`;
  }
  if (reason === "DefenseReport references no persisted RuntimeSupervisionRecord.") {
    return "防御报告没有引用已持久化的运行时监督记录。";
  }
  return reason;
}

function qualityLevelLabel(
  level: ReportQualitySummary["level"],
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return level;
  if (level === "submission_ready") return "提交级";
  if (level === "reviewable") return "可复核";
  return "草稿";
}

function claimTypeLabel(
  claimType: DefenseClaim["claimType"],
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return claimType;
  const labels: Record<DefenseClaim["claimType"], string> = {
    risk: "风险",
    detection: "检测",
    policy: "策略",
    runtime_effect: "运行时效果",
    residual_risk: "残余风险",
    limitation: "限制",
  };
  return labels[claimType];
}

function reviewStatusLabel(
  status: DefenseClaim["reviewStatus"],
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return status;
  const labels: Record<DefenseClaim["reviewStatus"], string> = {
    auto_checked: "自动核验",
    needs_review: "待复核",
    blocked_by_missing_evidence: "证据缺失阻断",
  };
  return labels[status];
}

function coverageStatusLabel(
  status: EvidenceCoverageRow["coverageStatus"],
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return status;
  if (status === "complete") return "完整";
  if (status === "partial") return "部分";
  return "缺失";
}

function evidenceKindLabel(
  kind: EvidenceKind,
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return kind;
  const labels: Record<EvidenceKind, string> = {
    test_context: "测试上下文",
    trace: "交互轨迹",
    trace_event: "轨迹事件",
    risk_report: "风险报告",
    finding: "风险发现",
    detection_report: "检测报告",
    risk_profile: "风险画像",
    policy_pack: "策略包",
    policy: "策略",
    runtime_session: "运行时会话",
    runtime_record: "运行时记录",
    defense_report: "防御报告",
    artifact: "导出文件",
    missing_evidence: "缺失证据",
  };
  return labels[kind];
}

function severityLabel(
  severity: MissingEvidenceItem["severity"],
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return severity;
  if (severity === "blocking") return "阻断";
  if (severity === "warning") return "警告";
  return "提示";
}

function decisionLabel(
  decision: "accepted" | "needs_changes" | "skipped",
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return decision;
  if (decision === "accepted") return "通过";
  if (decision === "needs_changes") return "需修改";
  return "暂不纳入";
}

function actionLabel(
  action: string,
  language: ReportBundleExportLanguage,
): string {
  if (language === "en") return action;
  const labels: Record<string, string> = {
    deny: "阻断",
    redact: "脱敏",
    ask: "要求人工确认",
    warn: "告警",
    allow: "放行",
  };
  return labels[action] ?? action;
}

function emptyReviewNote(language: ReportBundleExportLanguage): string {
  return language === "zh"
    ? "未填写人工复核备注。"
    : "No human review note was provided.";
}
