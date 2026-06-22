/**
 * e2eRunService — 编排完整的三阶段 E2E 检测+监督+防御链路
 *
 * 复用现有:
 *   loadTestContexts()  → 加载 TestContext + TestOracle
 *   runTestCase()       → Agent + Sandbox + Monitor + SupervisionBridge
 *   evaluateRisk()      → RiskEvaluationResult
 *   buildRiskReport()   → RiskReport
 *   buildDetectionReport()    → DetectionReport
 *   buildAgentRiskProfile()   → AgentRiskProfile
 *   buildSupervisionPolicyPack() → SupervisionPolicyPack
 *   buildDefenseReport() → DefenseReport
 *   exportDefenseJsonReport() / exportDefenseHtmlReport()
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createId, nowIso } from "../shared";
import type {
  AgentUnderTest,
  AgentAdapterConfig,
  RiskLevel,
} from "@agent-guard/contracts";
import type { TestContext } from "../modules/config/schemas";
import { loadTestContexts } from "../modules/config/loadTestContext";
import { runTestCase } from "../modules/runner/testRunner";
import { evaluateRisk } from "../modules/risk/riskEvaluator";
import { buildRiskReport } from "../modules/report/reportBuilder";
import { buildDetectionReport } from "../modules/detection/detectionReportBuilder";
import { buildAgentRiskProfile } from "../modules/detection/agentRiskProfileBuilder";
import { buildSupervisionPolicyPack } from "../modules/policy/policyPackBuilder";
import { buildDefenseReport } from "../modules/defense/defenseReportBuilder";
import {
  exportDefenseJsonReport,
  exportDefenseHtmlReport,
} from "../modules/defense/defenseReportExporter";
import type {
  RunE2ERequest,
  P2RunGroup,
  P2RunProgress,
  EntityLink,
} from "../api/types";
import { buildInitialRunGroup, saveRunGroup } from "../storage/fileRunStore";
import type { SupervisionSessionSummary } from "../storage/fileRunStore";
import { saveSessionRecords } from "../storage/fileRunStore";
import { indexReport, indexArtifact } from "../storage/fileReportStore";
import type { AgentAdapter } from "../modules/agent/agentAdapter";
import { HttpAgentAdapter } from "../modules/agent/httpAgentAdapter";
import { OpenClawAdapter } from "../modules/agent/openclawAdapter";
import {
  getRequiredSelectionPlan,
  TestSelectionError,
} from "../modules/runner/testSelectionService";
import { updateSelectionPlanStatus } from "../modules/runner/selectionPlanStore";

const CONFIGS_DIR = path.resolve(process.cwd(), "configs");
const P2_DEMO_CASES_FILE = path.join(CONFIGS_DIR, "p2_demo_cases.json");
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs", "reports");
const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");

export class CaseIdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseIdValidationError";
  }
}

export class SelectionPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionPlanValidationError";
  }
}

// ---- helpers ----

function mapAdapterKind(kind: string): AgentUnderTest["adapterType"] {
  switch (kind) {
    case "http_sample":
      return "http_sample" as AgentUnderTest["adapterType"];
    case "openclaw":
      return "openclaw" as AgentUnderTest["adapterType"];
    default:
      return "mock";
  }
}

function buildCustomAdapter(request: RunE2ERequest): AgentAdapter | undefined {
  switch (request.adapterKind) {
    case "http_sample": {
      const endpointUrl =
        request.connection?.endpointUrl ??
        `http://127.0.0.1:${process.env.SAMPLE_AGENT_PORT ?? 7001}/agent/run`;
      return new HttpAgentAdapter({
        endpointUrl,
        timeoutMs: request.connection?.timeoutMs ?? 15_000,
        mode: "vulnerable",
      });
    }
    case "openclaw": {
      return new OpenClawAdapter({
        gatewayUrl:
          request.connection?.endpointUrl ??
          process.env.OPENCLAW_GATEWAY_URL ??
          "http://localhost:18789",
        cliPath: request.connection?.cliPath,
        timeoutMs: request.connection?.timeoutMs ?? 120_000,
      });
    }
    default:
      return undefined;
  }
}

// ---- public API ----

export type RunE2EResult = {
  runGroup: P2RunGroup;
  links: EntityLink[];
};

export function createInitialE2ERunGroup(request: RunE2ERequest): P2RunGroup {
  return buildInitialRunGroup(
    request,
    request.agent.agentId ?? createId("agent"),
  );
}

export async function runE2E(
  request: RunE2ERequest,
  existingRunGroup?: P2RunGroup,
): Promise<RunE2EResult> {
  // P2 adapterKind 映射到 contracts adapterType + 自定义 adapter。
  const adapterType = mapAdapterKind(request.adapterKind);
  const customAdapter = buildCustomAdapter(request);
  const provisionalAgentId =
    existingRunGroup?.agentId ?? request.agent.agentId ?? createId("agent");
  const runGroup =
    existingRunGroup ?? buildInitialRunGroup(request, provisionalAgentId);
  runGroup.selectionPlanId = request.selectionPlanId;

  try {
    if (request.selectionPlanId && request.caseIds?.length) {
      throw new SelectionPlanValidationError(
        "selectionPlanId and caseIds cannot be provided together.",
      );
    }

    let selectedCaseIdsFromPlan: string[] | undefined;
    let selectionPlanAgentId: string | undefined;
    let selectionPlanCorpusManifestId: string | undefined;
    if (request.selectionPlanId) {
      try {
        const plan = await getRequiredSelectionPlan(request.selectionPlanId);
        if (plan.status !== "ready" && plan.status !== "completed") {
          throw new SelectionPlanValidationError(
            `Selection plan ${request.selectionPlanId} is not ready. Current status: ${plan.status}.`,
          );
        }
        if (
          request.agent.agentId &&
          plan.agentId !== "agent.selection.default" &&
          plan.agentId !== request.agent.agentId
        ) {
          throw new SelectionPlanValidationError(
            `Selection plan agentId ${plan.agentId} does not match requested agentId ${request.agent.agentId}.`,
          );
        }
        selectionPlanAgentId = plan.agentId;
        selectionPlanCorpusManifestId = plan.corpusManifestId;
        selectedCaseIdsFromPlan = plan.selectedCaseIds;
      } catch (error) {
        if (error instanceof TestSelectionError) {
          throw new SelectionPlanValidationError(error.message);
        }
        throw error;
      }
    }

    const resolvedAgentId =
      request.agent.agentId ??
      selectionPlanAgentId ??
      runGroup.agentId;
    runGroup.agentId = resolvedAgentId;

    const agent: AgentUnderTest = {
      schemaVersion: "mvp-1",
      agentId: resolvedAgentId,
      name: request.agent.name,
      adapterType,
    };

    const adapterConfig: AgentAdapterConfig = {
      schemaVersion: "mvp-1",
      adapterId: createId("adapter"),
      agentId: agent.agentId,
      adapterType: agent.adapterType,
      timeoutMs: request.connection?.timeoutMs ?? 30000,
    };

    if (request.selectionPlanId) {
      await updateSelectionPlanStatus(
        request.selectionPlanId,
        "running",
        {
          runGroupId: runGroup.runGroupId,
          agentId: resolvedAgentId,
        },
      );
    }

    // ====== 阶段 1: 监督前检测 ======
    runGroup.status = "running";
    runGroup.phase = "detecting";
    await saveRunGroup(runGroup);

    const requiresGeneratedALineCorpus =
      selectionPlanCorpusManifestId === "corpus.p3_a.generated" ||
      Boolean(selectedCaseIdsFromPlan?.some((caseId) => caseId.startsWith("case.generated.")));
    const { contexts, repository } = await loadTestContexts(CONFIGS_DIR, agent, {
      requireGeneratedALineCorpus: requiresGeneratedALineCorpus,
    });
    const selectedCaseIds = selectedCaseIdsFromPlan?.length
      ? selectedCaseIdsFromPlan
      : request.caseIds?.length
      ? request.caseIds
      : await getDefaultP2CaseIds(request.adapterKind);

    // caseIds 有效性校验：传入不存在的 caseId 时返回 400 级别错误
    if (selectedCaseIds.length > 0) {
      const validIds = new Set(contexts.map((ctx) => ctx.caseId));
      const invalid = selectedCaseIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new CaseIdValidationError(
          `Unknown caseIds: ${invalid.join(", ")}. ` +
          `Available: ${[...validIds].join(", ")}`,
        );
      }
    }

    const targetCases = selectedCaseIds.length
      ? contexts.filter((ctx: (typeof contexts)[number]) => selectedCaseIds.includes(ctx.caseId))
      : contexts;

    if (targetCases.length === 0) {
      throw new CaseIdValidationError(
        "No test cases matched. Provide valid caseIds or omit the field to run all enabled cases.",
      );
    }

    runGroup.caseCount = targetCases.length;
    runGroup.caseIds = targetCases.map((context) => context.caseId);
    startRunProgress(runGroup, "detecting", targetCases.length, getDetectionConcurrency(request));
    await saveRunGroup(runGroup);

    const riskReports = await runDetectionCasesConcurrently({
      targetCases,
      agent,
      adapterConfig,
      customAdapter,
      runGroup,
      request,
    });

    // ====== 阶段 2: 检测报告 → 画像 → 策略包 ======
    updateRunProgress(runGroup, {
      phase: "policy_building",
      runningCaseIds: [],
      completedCases: targetCases.length,
      failedCases: runGroup.progress?.failedCases ?? 0,
    });
    await saveRunGroup(runGroup);

    const detectionReport = buildDetectionReport({
      agentId: agent.agentId,
      riskReports,
      redTeamScenarioSet: repository.redTeamScenarioSet,
      policyTemplates: repository.policyTemplates,
    });
    runGroup.detectionReportId = detectionReport.reportId;

    const riskProfile = buildAgentRiskProfile(detectionReport, riskReports, {
      policyTemplates: repository.policyTemplates,
    });
    runGroup.riskProfileId = riskProfile.profileId;

    const policyPack = buildSupervisionPolicyPack(riskProfile, {
      policyTemplates: repository.policyTemplates,
    });
    runGroup.policyPackId = policyPack.policyPackId;
    runGroup.highestRiskLevel = getHighestRiskLevel(riskReports);
    runGroup.policyContextSource = "stored_detection";
    await persistDetectionArtifacts({
      runGroup,
      riskReports,
      detectionReport,
      riskProfile,
      policyPack,
    });
    runGroup.phase = "policy_ready";
    updateRunProgress(runGroup, {
      phase: "completed",
      runningCaseIds: [],
      completedCases: targetCases.length,
    });
    await saveRunGroup(runGroup);

    // mock/http_sample 仍可在同一次回归链路中带 PolicyPack 再跑一轮。
    // OpenClaw CLI 检测阶段只产出策略包；实时监督由 OpenClaw MCP 路径承接。
    const allSupervisionRecords: Awaited<
      ReturnType<typeof runTestCase>
    >["supervisionRecords"] = [];

    const isOpenClaw = request.adapterKind === "openclaw";

    if (!isOpenClaw) {
      runGroup.phase = "supervising";
      await saveRunGroup(runGroup);

      for (const context of targetCases) {
        const runtimeSessionId = createId("session");
        const { testRun, supervisionRecords } = await runTestCase(
          agent,
          adapterConfig,
          context,
          {
            supervisionPolicyPack: policyPack,
            runtimeSessionId,
            customAdapter,
            selectionPlanId: runGroup.selectionPlanId,
          },
        );

        allSupervisionRecords.push(...supervisionRecords);
        runGroup.runtimeSessionIds.push(runtimeSessionId);

        if (testRun.status === "failed") {
          // 监督 pass 失败：记录但继续处理其他 case，最后标记 runGroup failed
          runGroup.status = "failed";
          if (!runGroup.error) {
            runGroup.error = `Supervision pass failed for ${context.caseId}: ${testRun.error ?? "unknown error"}`;
          }
        }

        const actionCounts: Record<string, number> = {};
        let blockedCount = 0;
        let redactedCount = 0;
        let askCount = 0;

        for (const rec of supervisionRecords) {
          actionCounts[rec.action] = (actionCounts[rec.action] ?? 0) + 1;
          if (rec.action === "deny") blockedCount++;
          if (rec.action === "redact") redactedCount++;
          if (rec.action === "ask") askCount++;
        }

        const sessionSummary: SupervisionSessionSummary = {
          runtimeSessionId,
          runGroupId: runGroup.runGroupId,
          agentId: agent.agentId,
          policyPackId: policyPack.policyPackId,
          policyContextSource: "stored_detection",
          recordCount: supervisionRecords.length,
          blockedCount,
          redactedCount,
          askCount,
          actionCounts,
        };
        await saveSessionRecords(sessionSummary, supervisionRecords);
      }
      runGroup.phase = "supervision_completed";
      await saveRunGroup(runGroup);
    }

    // 监督 pass 失败 → 不生成 DefenseReport，直接终止
    if (runGroup.status === "failed") {
      await saveRunGroup(runGroup);
      throw new Error(runGroup.error ?? "Supervision pass failed");
    }

    // ====== 阶段 3: 防御报告 ======
    if (request.generateDefenseReport && !isOpenClaw) {
      const defenseReport = buildDefenseReport({
        detectionReport,
        riskProfile,
        policyPack,
        runtimeRecords: allSupervisionRecords,
      });
      runGroup.defenseReportId = defenseReport.defenseReportId;

      const runOutputDir = path.join(OUTPUT_DIR, runGroup.runGroupId);
      const jsonArtifact = await exportDefenseJsonReport(
        defenseReport,
        path.join(runOutputDir, "defense-report.json"),
      );
      const htmlArtifact = await exportDefenseHtmlReport(
        defenseReport,
        path.join(runOutputDir, "defense-report.html"),
      );

      await indexArtifact(jsonArtifact, "Defense Report (JSON)");
      await indexArtifact(htmlArtifact, "Defense Report (HTML)");
      runGroup.artifactIds.push(jsonArtifact.artifactId, htmlArtifact.artifactId);

      // 索引报告
      await indexReport({
        reportId: defenseReport.defenseReportId,
        reportType: "defense_report",
        runGroupId: runGroup.runGroupId,
        artifactIds: [jsonArtifact.artifactId, htmlArtifact.artifactId],
        generatedAt: defenseReport.generatedAt,
      });
      runGroup.phase = "defense_report_ready";
    }

    // ====== Complete ======
    runGroup.status = "completed";
    if (!runGroup.defenseReportId && runGroup.phase !== "policy_ready") {
      runGroup.phase = "supervision_completed";
    }
    runGroup.endedAt = nowIso();

    const links = buildLinks(runGroup);

    await saveRunGroup(runGroup);
    if (runGroup.selectionPlanId) {
      await updateSelectionPlanStatus(
        runGroup.selectionPlanId,
        "completed",
        { runGroupId: runGroup.runGroupId },
      );
    }

    return { runGroup, links };
  } catch (err) {
    runGroup.status = "failed";
    runGroup.phase = "failed";
    runGroup.endedAt = nowIso();
    runGroup.error = err instanceof Error ? err.message : String(err);
    updateRunProgress(runGroup, {
      phase: "failed",
      runningCaseIds: [],
      failedCases: Math.max(runGroup.progress?.failedCases ?? 0, 1),
    });
    await saveRunGroup(runGroup);
    if (runGroup.selectionPlanId) {
      await updateSelectionPlanStatus(
        runGroup.selectionPlanId,
        "failed",
        {
          runGroupId: runGroup.runGroupId,
          error: runGroup.error,
        },
      );
    }
    throw err;
  }
}

// ---- helpers ----

async function runDetectionCasesConcurrently(input: {
  targetCases: TestContext[];
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  request: RunE2ERequest;
}): Promise<ReturnType<typeof buildRiskReport>[]> {
  const {
    targetCases,
    agent,
    adapterConfig,
    customAdapter,
    runGroup,
    request,
  } = input;
  const concurrency = runGroup.progress?.concurrency ?? getDetectionConcurrency(request);
  const runningCaseIds = new Set<string>();
  const riskReportsByIndex: Array<ReturnType<typeof buildRiskReport> | undefined> =
    new Array(targetCases.length);
  let completedCases = 0;
  let failedCases = 0;
  let fatalError: Error | undefined;

  await runWithConcurrency(
    targetCases,
    concurrency,
    async (context, index) => {
      if (fatalError) return;
      runningCaseIds.add(context.caseId);
      updateRunProgress(runGroup, {
        runningCaseIds: [...runningCaseIds],
        completedCases,
        failedCases,
      });
      await saveRunGroup(runGroup);

      try {
        const { testRun, trace } = await runTestCase(
          agent,
          adapterConfig,
          context,
          {
            customAdapter,
            selectionPlanId: runGroup.selectionPlanId,
          },
        );

        runGroup.testRunIds.push(testRun.runId);
        runGroup.traceIds.push(trace.traceId);

        // 落盘 trace 文件供 GET /traces/:id 查询
        await writeTraceFile(trace);

        if (testRun.status === "failed") {
          throw new Error(testRun.error ?? "Detection test run failed");
        }

        const evaluation = evaluateRisk(context, trace);
        const riskReport = buildRiskReport(context, evaluation, trace);
        riskReportsByIndex[index] = riskReport;

        runGroup.riskReportIds.push(riskReport.reportId);
        completedCases++;
        updateRunProgress(runGroup, {
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
          lastCompletedCaseId: context.caseId,
        });
      } catch (error) {
        failedCases++;
        const message = error instanceof Error ? error.message : String(error);
        fatalError = new Error(`Detection pass failed for ${context.caseId}: ${message}`);
        runGroup.status = "failed";
        runGroup.phase = "failed";
        runGroup.error = fatalError.message;
        updateRunProgress(runGroup, {
          phase: "failed",
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
        });
      } finally {
        runningCaseIds.delete(context.caseId);
        updateRunProgress(runGroup, {
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
        });
        await saveRunGroup(runGroup);
      }
    },
    () => fatalError !== undefined,
  );

  if (fatalError) {
    throw fatalError;
  }

  return riskReportsByIndex.filter(
    (item): item is ReturnType<typeof buildRiskReport> => Boolean(item),
  );
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        if (shouldStop()) return;
        const index = nextIndex++;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }),
  );
}

function getDetectionConcurrency(request: RunE2ERequest): number {
  const configured = Number(
    process.env.AGENT_GUARD_E2E_DETECTION_CONCURRENCY ??
      process.env.AGENT_GUARD_E2E_CONCURRENCY,
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(Math.floor(configured), 8));
  }
  if (request.adapterKind === "openclaw") return 2;
  if (request.adapterKind === "http_sample") return 4;
  return 6;
}

function startRunProgress(
  runGroup: P2RunGroup,
  phase: P2RunProgress["phase"],
  totalCases: number,
  concurrency: number,
): void {
  const now = nowIso();
  runGroup.progress = {
    phase,
    totalCases,
    completedCases: 0,
    failedCases: 0,
    runningCaseIds: [],
    concurrency,
    percent: 0,
    startedAt: now,
    updatedAt: now,
  };
}

function updateRunProgress(
  runGroup: P2RunGroup,
  patch: Partial<Omit<P2RunProgress, "totalCases" | "concurrency" | "startedAt">> & {
    totalCases?: number;
    concurrency?: number;
  },
): void {
  const previous = runGroup.progress;
  const now = nowIso();
  const totalCases = patch.totalCases ?? previous?.totalCases ?? runGroup.caseCount ?? 0;
  const completedCases = patch.completedCases ?? previous?.completedCases ?? 0;
  const failedCases = patch.failedCases ?? previous?.failedCases ?? 0;
  const finishedCases = completedCases + failedCases;
  const percent =
    patch.percent ??
    (totalCases > 0
      ? Math.min(100, Math.round((finishedCases / totalCases) * 100))
      : runGroup.status === "completed"
        ? 100
        : 0);

  runGroup.progress = {
    phase: patch.phase ?? previous?.phase ?? runGroup.phase,
    totalCases,
    completedCases,
    failedCases,
    runningCaseIds: patch.runningCaseIds ?? previous?.runningCaseIds ?? [],
    lastCompletedCaseId: patch.lastCompletedCaseId ?? previous?.lastCompletedCaseId,
    concurrency: patch.concurrency ?? previous?.concurrency ?? getDetectionConcurrency({
      adapterKind: runGroup.adapterKind,
      agent: { name: runGroup.agentName },
      generateDefenseReport: Boolean(runGroup.defenseReportId),
    }),
    percent,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
  };
}

function buildLinks(runGroup: P2RunGroup): EntityLink[] {
  const links: EntityLink[] = [];

  for (const id of runGroup.testRunIds) {
    links.push({ kind: "test_run", id, label: `TestRun ${id}` });
  }
  for (const id of runGroup.traceIds) {
    links.push({ kind: "trace", id, label: `Trace ${id}` });
  }
  for (const id of runGroup.riskReportIds) {
    links.push({ kind: "risk_report", id, label: `RiskReport ${id}` });
  }
  if (runGroup.detectionReportId) {
    links.push({
      kind: "detection_report",
      id: runGroup.detectionReportId,
      label: "Detection Report",
    });
  }
  if (runGroup.riskProfileId) {
    links.push({
      kind: "risk_profile",
      id: runGroup.riskProfileId,
      label: "Agent Risk Profile",
    });
  }
  if (runGroup.policyPackId) {
    links.push({
      kind: "policy_pack",
      id: runGroup.policyPackId,
      label: "Supervision Policy Pack",
    });
  }
  for (const id of runGroup.runtimeSessionIds) {
    links.push({
      kind: "runtime_session",
      id,
      label: `Runtime Session ${id}`,
    });
  }
  if (runGroup.defenseReportId) {
    links.push({
      kind: "defense_report",
      id: runGroup.defenseReportId,
      label: "Defense Report",
    });
  }
  for (const id of runGroup.artifactIds) {
    links.push({ kind: "artifact", id, label: `Artifact ${id}` });
  }

  return links;
}

async function writeTraceFile(trace: unknown): Promise<void> {
  const traceId = (trace as Record<string, unknown>).traceId as string | undefined;
  if (!traceId) return;
  await fs.mkdir(TRACES_DIR, { recursive: true });
  await fs.writeFile(
    path.join(TRACES_DIR, `${traceId}.json`),
    JSON.stringify(trace, null, 2),
    "utf-8",
  );
}

type DetectionArtifactsInput = {
  runGroup: P2RunGroup;
  riskReports: Awaited<ReturnType<typeof buildRiskReport>>[];
  detectionReport: ReturnType<typeof buildDetectionReport>;
  riskProfile: ReturnType<typeof buildAgentRiskProfile>;
  policyPack: ReturnType<typeof buildSupervisionPolicyPack>;
};

async function persistDetectionArtifacts(input: DetectionArtifactsInput): Promise<void> {
  const { runGroup, riskReports, detectionReport, riskProfile, policyPack } = input;
  const runOutputDir = path.join(OUTPUT_DIR, runGroup.runGroupId);
  await fs.mkdir(runOutputDir, { recursive: true });

  await Promise.all([
    fs.writeFile(
      path.join(runOutputDir, "detection-report.json"),
      JSON.stringify(detectionReport, null, 2),
      "utf-8",
    ),
    fs.writeFile(
      path.join(runOutputDir, "agent-risk-profile.json"),
      JSON.stringify(riskProfile, null, 2),
      "utf-8",
    ),
    fs.writeFile(
      path.join(runOutputDir, "risk-reports.json"),
      JSON.stringify(riskReports, null, 2),
      "utf-8",
    ),
    fs.writeFile(
      path.join(runOutputDir, "supervision-policy-pack.json"),
      JSON.stringify(policyPack, null, 2),
      "utf-8",
    ),
  ]);

  for (const riskReport of riskReports) {
    await indexReport({
      reportId: riskReport.reportId,
      reportType: "risk_report",
      runGroupId: runGroup.runGroupId,
      artifactIds: [],
      generatedAt: riskReport.generatedAt,
    });
  }
  await indexReport({
    reportId: detectionReport.reportId,
    reportType: "detection_report",
    runGroupId: runGroup.runGroupId,
    artifactIds: [],
    generatedAt: detectionReport.generatedAt,
  });
  await indexReport({
    reportId: riskProfile.profileId,
    reportType: "risk_profile",
    runGroupId: runGroup.runGroupId,
    artifactIds: [],
    generatedAt: riskProfile.generatedAt,
  });
  await indexReport({
    reportId: policyPack.policyPackId,
    reportType: "policy_pack",
    runGroupId: runGroup.runGroupId,
    artifactIds: [],
    generatedAt: policyPack.createdAt,
  });
}

function getHighestRiskLevel(
  riskReports: Awaited<ReturnType<typeof buildRiskReport>>[],
): RiskLevel {
  const rank: Record<RiskLevel, number> = {
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };

  return riskReports.reduce<RiskLevel>(
    (highest, report) =>
      rank[report.riskLevel] > rank[highest] ? report.riskLevel : highest,
    "low",
  );
}

type P2DemoCasesConfig = {
  defaultOpenClawCaseIds?: string[];
  fallbackAdapterCaseIds?: string[];
};

async function getDefaultP2CaseIds(adapterKind: RunE2ERequest["adapterKind"]): Promise<string[]> {
  const config = await readP2DemoCasesConfig();
  const configured =
    adapterKind === "openclaw"
      ? config.defaultOpenClawCaseIds
      : config.fallbackAdapterCaseIds;
  return Array.isArray(configured)
    ? configured.filter((caseId): caseId is string => typeof caseId === "string" && caseId.length > 0)
    : [];
}

async function readP2DemoCasesConfig(): Promise<P2DemoCasesConfig> {
  try {
    return JSON.parse(await fs.readFile(P2_DEMO_CASES_FILE, "utf-8")) as P2DemoCasesConfig;
  } catch {
    return {};
  }
}
