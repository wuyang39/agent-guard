/**
 * e2eRunService — 编排完整的三阶段 E2E 检测+监督+防御链路
 *
 * 复用现有:
 *   loadTestContexts()  → 加载 TestContext + TestOracle
 *   runTestCase()       → Agent + Sandbox + Monitor + SupervisionBridge
 *   evaluateRiskWithSemanticScoring() → RiskEvaluationResult
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
  ToolCapabilityProfile,
} from "@agent-guard/contracts";
import type { TestContext } from "../modules/config/schemas";
import { loadTestContexts } from "../modules/config/loadTestContext";
import { runTestCase } from "../modules/runner/testRunner";
import { evaluateRiskWithSemanticScoring } from "../modules/risk/riskEvaluator";
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
  P2RunCaseFailure,
  EntityLink,
} from "../api/types";
import { buildInitialRunGroup, getRunGroup, saveRunGroup } from "../storage/fileRunStore";
import type { SupervisionSessionSummary } from "../storage/fileRunStore";
import { saveSessionRecords } from "../storage/fileRunStore";
import { getReportEntry, indexReport, indexArtifact } from "../storage/fileReportStore";
import type { AgentAdapter } from "../modules/agent/agentAdapter";
import { HttpAgentAdapter } from "../modules/agent/httpAgentAdapter";
import { OpenClawAdapter } from "../modules/agent/openclawAdapter";
import { buildRuleBasedToolCapabilityProfile } from "../modules/gateway/toolCapabilityProfiler";
import {
  getRequiredSelectionPlan,
  TestSelectionError,
} from "../modules/runner/testSelectionService";
import { updateSelectionPlanStatus } from "../modules/runner/selectionPlanStore";
import { resolveInsideDirectory } from "../storage/pathSafety";

const CONFIGS_DIR = path.resolve(process.cwd(), "configs");
const P2_DEMO_CASES_FILE = path.join(CONFIGS_DIR, "p2_demo_cases.json");
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs", "reports");
const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");
const MAX_PROGRESS_FAILURES = 24;
const RUN_CANCELLED_MESSAGE = "Run cancelled by user.";
const activeRunControllers = new Map<string, AbortController>();

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

export class PolicyPackReuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyPackReuseError";
  }
}

class RunCancelledError extends Error {
  constructor(message = RUN_CANCELLED_MESSAGE) {
    super(message);
    this.name = "RunCancelledError";
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

export async function cancelRunGroup(runGroupId: string): Promise<P2RunGroup | undefined> {
  const runGroup = await getRunGroup(runGroupId);
  if (!runGroup) return undefined;

  activeRunControllers.get(runGroupId)?.abort();

  if (runGroup.status !== "running") {
    return runGroup;
  }

  runGroup.status = "failed";
  runGroup.phase = "failed";
  runGroup.endedAt = nowIso();
  runGroup.error = RUN_CANCELLED_MESSAGE;
  appendProgressWarning(runGroup, RUN_CANCELLED_MESSAGE);
  updateRunProgress(runGroup, {
    phase: "failed",
    runningCaseIds: [],
    retryingCaseIds: [],
  });
  await saveRunGroup(runGroup);

  if (runGroup.selectionPlanId) {
    await updateSelectionPlanStatus(runGroup.selectionPlanId, "failed", {
      runGroupId: runGroup.runGroupId,
      error: RUN_CANCELLED_MESSAGE,
    });
  }

  return runGroup;
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
  const controller = new AbortController();
  activeRunControllers.set(runGroup.runGroupId, controller);

  try {
    throwIfRunCancelled(controller.signal);
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
      includeDisabledGeneratedCases: Boolean(selectedCaseIdsFromPlan?.length),
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

    if (request.reusePolicyPackId) {
      const reused = await loadReusablePolicyContext(request.reusePolicyPackId);
      const { detectionReport, riskProfile, policyPack } = reused;
      const isOpenClaw = request.adapterKind === "openclaw";

      runGroup.detectionReportId = detectionReport.reportId;
      runGroup.riskProfileId = riskProfile.profileId;
      runGroup.policyPackId = policyPack.policyPackId;
      runGroup.highestRiskLevel = detectionReport.riskSummary.highestRiskLevel;
      runGroup.policyContextSource = "stored_detection";

      startRunProgress(
        runGroup,
        isOpenClaw ? "policy_ready" : "supervising",
        targetCases.length,
        1,
      );
      await saveRunGroup(runGroup);

      const allSupervisionRecords = isOpenClaw
        ? []
        : await runSupervisionCases({
            targetCases,
            agent,
            adapterConfig,
            customAdapter,
            runGroup,
            policyPack,
            sourceRunGroupId: reused.sourceRunGroupId,
            signal: controller.signal,
          });

      if (runGroup.error) {
        await saveRunGroup(runGroup);
        throw new Error(runGroup.error ?? "Supervision pass failed");
      }

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
        await indexReport({
          reportId: defenseReport.defenseReportId,
          reportType: "defense_report",
          runGroupId: runGroup.runGroupId,
          artifactIds: [jsonArtifact.artifactId, htmlArtifact.artifactId],
          generatedAt: defenseReport.generatedAt,
        });
        runGroup.phase = "defense_report_ready";
      }

      runGroup.status = "completed";
      if (!runGroup.defenseReportId) {
        runGroup.phase = isOpenClaw ? "policy_ready" : "supervision_completed";
      }
      runGroup.endedAt = nowIso();
      updateRunProgress(runGroup, {
        phase: "completed",
        runningCaseIds: [],
        completedCases: targetCases.length,
      });
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
    }

    startRunProgress(runGroup, "detecting", targetCases.length, getDetectionConcurrency(request));
    await saveRunGroup(runGroup);

    const detectionResult = await runDetectionCasesConcurrently({
      targetCases,
      agent,
      adapterConfig,
      customAdapter,
      runGroup,
      request,
      signal: controller.signal,
    });
    const riskReports = detectionResult.riskReports;

    // ====== 阶段 2: 检测报告 → 画像 → 策略包 ======
    updateRunProgress(runGroup, {
      phase: "policy_building",
      runningCaseIds: [],
      completedCases: detectionResult.completedCases,
      failedCases: detectionResult.failedCases,
      skippedCases: detectionResult.skippedCases,
      retriedCases: detectionResult.retriedCases,
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
      toolProfiles: buildToolProfilesForPolicyGeneration(targetCases),
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
      completedCases: detectionResult.completedCases,
      failedCases: detectionResult.failedCases,
      skippedCases: detectionResult.skippedCases,
      retriedCases: detectionResult.retriedCases,
    });
    await saveRunGroup(runGroup);

    // mock/http_sample 仍可在同一次回归链路中带 PolicyPack 再跑一轮。
    // OpenClaw CLI 检测阶段只产出策略包；实时监督由 OpenClaw MCP 路径承接。
    const allSupervisionRecords: Awaited<
      ReturnType<typeof runTestCase>
    >["supervisionRecords"] = [];

    const isOpenClaw = request.adapterKind === "openclaw";

    if (!isOpenClaw) {
      allSupervisionRecords.push(
        ...(await runSupervisionCases({
          targetCases,
          agent,
          adapterConfig,
          customAdapter,
          runGroup,
          policyPack,
          signal: controller.signal,
        })),
      );
    }

    // 监督 pass 失败 → 不生成 DefenseReport，直接终止
    if (runGroup.error) {
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
    const errorMessage = isRunCancelledError(err)
      ? RUN_CANCELLED_MESSAGE
      : err instanceof Error
        ? err.message
        : String(err);
    runGroup.status = "failed";
    runGroup.phase = "failed";
    runGroup.endedAt = nowIso();
    runGroup.error = errorMessage;
    updateRunProgress(runGroup, {
      phase: "failed",
      runningCaseIds: [],
      retryingCaseIds: [],
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
  } finally {
    if (activeRunControllers.get(runGroup.runGroupId) === controller) {
      activeRunControllers.delete(runGroup.runGroupId);
    }
  }
}

// ---- helpers ----

type DetectionBatchResult = {
  riskReports: ReturnType<typeof buildRiskReport>[];
  completedCases: number;
  failedCases: number;
  skippedCases: number;
  retriedCases: number;
};

class DetectionCaseError extends Error {
  readonly category: P2RunCaseFailure["category"];
  readonly attempts: number;
  readonly retryable: boolean;
  readonly skipAllowed: boolean;

  constructor(input: {
    message: string;
    category: P2RunCaseFailure["category"];
    attempts: number;
    retryable: boolean;
    skipAllowed: boolean;
  }) {
    super(input.message);
    this.name = "DetectionCaseError";
    this.category = input.category;
    this.attempts = input.attempts;
    this.retryable = input.retryable;
    this.skipAllowed = input.skipAllowed;
  }
}

async function runDetectionCasesConcurrently(input: {
  targetCases: TestContext[];
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  request: RunE2ERequest;
  signal: AbortSignal;
}): Promise<DetectionBatchResult> {
  const {
    targetCases,
    agent,
    adapterConfig,
    customAdapter,
    runGroup,
    request,
    signal,
  } = input;
  const concurrency = runGroup.progress?.concurrency ?? getDetectionConcurrency(request);
  const runningCaseIds = new Set<string>();
  const riskReportsByIndex: Array<ReturnType<typeof buildRiskReport> | undefined> =
    new Array(targetCases.length);
  let completedCases = 0;
  let failedCases = 0;
  let skippedCases = 0;
  let retriedCases = 0;
  let fatalError: Error | undefined;

  await runWithConcurrency(
    targetCases,
    concurrency,
    async (context, index) => {
      if (fatalError) return;
      throwIfRunCancelled(signal);
      runningCaseIds.add(context.caseId);
      updateRunProgress(runGroup, {
        runningCaseIds: [...runningCaseIds],
        completedCases,
        failedCases,
        skippedCases,
        retriedCases,
      });
      await saveRunGroup(runGroup);

      try {
        const result = await runDetectionCaseWithRetry({
          agent,
          adapterConfig,
          context,
          customAdapter,
          runGroup,
          request,
          signal,
          getCounters: () => ({ completedCases, failedCases, skippedCases, retriedCases }),
          setRetried: () => {
            retriedCases++;
          },
        });

        riskReportsByIndex[index] = result.riskReport;

        runGroup.riskReportIds.push(result.riskReport.reportId);
        completedCases++;
        updateRunProgress(runGroup, {
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
          skippedCases,
          retriedCases,
          lastCompletedCaseId: context.caseId,
        });
      } catch (error) {
        if (isRunCancelledError(error) || signal.aborted) {
          fatalError = new RunCancelledError();
          runGroup.status = "failed";
          runGroup.phase = "failed";
          runGroup.error = RUN_CANCELLED_MESSAGE;
          updateRunProgress(runGroup, {
            phase: "failed",
            runningCaseIds: [...runningCaseIds],
            retryingCaseIds: [],
            completedCases,
            failedCases,
            skippedCases,
            retriedCases,
          });
          return;
        }
        failedCases++;
        const caseError = normalizeDetectionCaseError(error);
        const skipped = caseError.skipAllowed;
        if (skipped) {
          skippedCases++;
        } else {
          fatalError = new Error(`Detection pass failed for ${context.caseId}: ${caseError.message}`);
          runGroup.status = "failed";
          runGroup.phase = "failed";
          runGroup.error = fatalError.message;
        }
        appendDetectionFailure(runGroup, {
          caseId: context.caseId,
          phase: "detecting",
          reason: caseError.message,
          category: caseError.category,
          attempts: caseError.attempts,
          retryable: caseError.retryable,
          skipped,
          occurredAt: nowIso(),
        });
        updateRunProgress(runGroup, {
          phase: fatalError ? "failed" : "detecting",
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
          skippedCases,
          retriedCases,
          lastFailedCaseId: context.caseId,
        });
      } finally {
        runningCaseIds.delete(context.caseId);
        updateRunProgress(runGroup, {
          runningCaseIds: [...runningCaseIds],
          completedCases,
          failedCases,
          skippedCases,
          retriedCases,
        });
        await saveRunGroup(runGroup);
      }
    },
    () => fatalError !== undefined || signal.aborted,
  );

  throwIfRunCancelled(signal);
  if (fatalError) {
    throw fatalError;
  }

  const riskReports = riskReportsByIndex.filter(
    (item): item is ReturnType<typeof buildRiskReport> => Boolean(item),
  );
  const minSuccessfulCases = getMinimumSuccessfulDetectionCases(request, targetCases.length);
  if (riskReports.length < minSuccessfulCases) {
    throw new Error(
      `Detection pass produced only ${riskReports.length}/${targetCases.length} usable reports; ` +
      `minimum required is ${minSuccessfulCases}. Failed/skipped cases: ${failedCases}.`,
    );
  }

  if (skippedCases > 0) {
    appendProgressWarning(
      runGroup,
      `检测阶段有 ${skippedCases} 个 OpenClaw/Provider 临时失败样本已跳过，策略包基于 ${riskReports.length} 个成功样本生成。`,
    );
  }

  return {
    riskReports,
    completedCases,
    failedCases,
    skippedCases,
    retriedCases,
  };
}

async function runDetectionCaseWithRetry(input: {
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  context: TestContext;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  request: RunE2ERequest;
  signal: AbortSignal;
  getCounters: () => {
    completedCases: number;
    failedCases: number;
    skippedCases: number;
    retriedCases: number;
  };
  setRetried: () => void;
}): Promise<{ riskReport: ReturnType<typeof buildRiskReport> }> {
  const {
    agent,
    adapterConfig,
    context,
    customAdapter,
    runGroup,
    request,
    signal,
    getCounters,
    setRetried,
  } = input;
  const maxAttempts = getDetectionMaxAttempts(request);
  let attempt = 0;
  let countedRetry = false;
  let lastClassification: ReturnType<typeof classifyDetectionError> | undefined;
  let lastMessage = "unknown error";

  while (attempt < maxAttempts) {
    throwIfRunCancelled(signal);
    attempt++;
    const spacingMs = getOpenClawCaseSpacingMs(request, attempt);
    if (spacingMs > 0) {
      await sleep(spacingMs, signal);
    }

    try {
      return {
        riskReport: await runSingleDetectionAttempt({
          agent,
          adapterConfig,
          context,
          customAdapter,
          runGroup,
          signal,
        }),
      };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      lastClassification = classifyDetectionError(lastMessage, request);
      const shouldRetry =
        lastClassification.retryable && attempt < maxAttempts;

      if (!shouldRetry) {
        break;
      }

      if (!countedRetry) {
        countedRetry = true;
        setRetried();
      }

      const delayMs = getDetectionRetryDelayMs(attempt);
      const cooldownUntil = new Date(Date.now() + delayMs).toISOString();
      const counters = getCounters();
      appendProgressWarning(
        runGroup,
        `${context.caseId} 遇到 ${lastClassification.category}，${Math.round(delayMs / 1000)}s 后重试。`,
      );
      updateRunProgress(runGroup, {
        runningCaseIds: runGroup.progress?.runningCaseIds ?? [context.caseId],
        retryingCaseIds: uniqueStrings([
          ...(runGroup.progress?.retryingCaseIds ?? []),
          context.caseId,
        ]),
        providerCooldownUntil: cooldownUntil,
        completedCases: counters.completedCases,
        failedCases: counters.failedCases,
        skippedCases: counters.skippedCases,
        retriedCases: counters.retriedCases,
      });
      await saveRunGroup(runGroup);
      await sleep(delayMs, signal);
      updateRunProgress(runGroup, {
        retryingCaseIds: (runGroup.progress?.retryingCaseIds ?? []).filter(
          (caseId) => caseId !== context.caseId,
        ),
      });
      await saveRunGroup(runGroup);
    }
  }

  const classification =
    lastClassification ?? classifyDetectionError(lastMessage, request);
  throw new DetectionCaseError({
    message: lastMessage,
    category: classification.category,
    attempts: attempt,
    retryable: classification.retryable,
    skipAllowed: classification.skipAllowed,
  });
}

async function runSingleDetectionAttempt(input: {
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  context: TestContext;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  signal: AbortSignal;
}): Promise<ReturnType<typeof buildRiskReport>> {
  const { agent, adapterConfig, context, customAdapter, runGroup, signal } = input;
  throwIfRunCancelled(signal);
  const { testRun, trace } = await runTestCase(agent, adapterConfig, context, {
    customAdapter,
    selectionPlanId: runGroup.selectionPlanId,
    signal,
  });
  throwIfRunCancelled(signal);

  runGroup.testRunIds.push(testRun.runId);
  runGroup.traceIds.push(trace.traceId);
  await writeTraceFile(trace);

  if (testRun.status === "failed") {
    throw new Error(testRun.error ?? "Detection test run failed");
  }

  const evaluation = await evaluateRiskWithSemanticScoring(context, trace);
  return buildRiskReport(context, evaluation, trace);
}

function normalizeDetectionCaseError(error: unknown): DetectionCaseError {
  if (error instanceof DetectionCaseError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DetectionCaseError({
    message,
    category: "fatal",
    attempts: 1,
    retryable: false,
    skipAllowed: false,
  });
}

async function runSupervisionCases(input: {
  targetCases: TestContext[];
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  policyPack: ReturnType<typeof buildSupervisionPolicyPack>;
  sourceRunGroupId?: string;
  signal: AbortSignal;
}): Promise<Awaited<ReturnType<typeof runTestCase>>["supervisionRecords"]> {
  const {
    targetCases,
    agent,
    adapterConfig,
    customAdapter,
    runGroup,
    policyPack,
    sourceRunGroupId,
    signal,
  } = input;
  const allSupervisionRecords: Awaited<
    ReturnType<typeof runTestCase>
  >["supervisionRecords"] = [];
  let completedCases = 0;
  let failedCases = 0;

  runGroup.phase = "supervising";
  startRunProgress(runGroup, "supervising", targetCases.length, 1);
  await saveRunGroup(runGroup);

  for (const context of targetCases) {
    throwIfRunCancelled(signal);
    updateRunProgress(runGroup, {
      runningCaseIds: [context.caseId],
      completedCases,
      failedCases,
    });
    await saveRunGroup(runGroup);

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
        signal,
      },
    );
    throwIfRunCancelled(signal);

    allSupervisionRecords.push(...supervisionRecords);
    runGroup.runtimeSessionIds.push(runtimeSessionId);

    if (testRun.status === "failed") {
      failedCases++;
      runGroup.status = "failed";
      if (!runGroup.error) {
        runGroup.error = `Supervision pass failed for ${context.caseId}: ${testRun.error ?? "unknown error"}`;
      }
    } else {
      completedCases++;
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
      sourceRunGroupId,
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
    updateRunProgress(runGroup, {
      runningCaseIds: [],
      completedCases,
      failedCases,
      lastCompletedCaseId: context.caseId,
    });
    await saveRunGroup(runGroup);
  }

  runGroup.phase = "supervision_completed";
  updateRunProgress(runGroup, {
    phase: "completed",
    runningCaseIds: [],
    completedCases,
    failedCases,
  });
  await saveRunGroup(runGroup);
  return allSupervisionRecords;
}

type ReusablePolicyContext = {
  sourceRunGroupId: string;
  detectionReport: ReturnType<typeof buildDetectionReport>;
  riskProfile: ReturnType<typeof buildAgentRiskProfile>;
  policyPack: ReturnType<typeof buildSupervisionPolicyPack>;
};

async function loadReusablePolicyContext(
  policyPackId: string,
): Promise<ReusablePolicyContext> {
  const entry = await getReportEntry(policyPackId);
  if (!entry || entry.reportType !== "policy_pack") {
    throw new PolicyPackReuseError(
      `Policy pack ${policyPackId} was not found in report index.`,
    );
  }
  const runDir = resolveInsideDirectory(OUTPUT_DIR, entry.runGroupId);
  const [detectionReport, riskProfile, policyPack] = await Promise.all([
    readJsonFile<ReturnType<typeof buildDetectionReport>>(
      path.join(runDir, "detection-report.json"),
    ),
    readJsonFile<ReturnType<typeof buildAgentRiskProfile>>(
      path.join(runDir, "agent-risk-profile.json"),
    ),
    readJsonFile<ReturnType<typeof buildSupervisionPolicyPack>>(
      path.join(runDir, "supervision-policy-pack.json"),
    ),
  ]);
  if (!detectionReport || !riskProfile || !policyPack) {
    throw new PolicyPackReuseError(
      `Policy pack ${policyPackId} is missing reusable detection artifacts.`,
    );
  }
  if (policyPack.policyPackId !== policyPackId) {
    throw new PolicyPackReuseError(
      `Policy pack artifact mismatch: requested ${policyPackId}, loaded ${policyPack.policyPackId}.`,
    );
  }
  return {
    sourceRunGroupId: entry.runGroupId,
    detectionReport,
    riskProfile,
    policyPack,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
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
  if (request.adapterKind === "openclaw") return 1;
  if (request.adapterKind === "http_sample") return 4;
  return 6;
}

function getDetectionMaxAttempts(request: RunE2ERequest): number {
  if (request.adapterKind !== "openclaw") return 1;
  const configured = Number(process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(Math.floor(configured), 5));
  }
  return 3;
}

function getDetectionRetryDelayMs(attempt: number): number {
  const configured = Number(process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS);
  const baseMs =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : 15_000;
  const cappedAttempt = Math.max(1, Math.min(attempt, 4));
  return Math.min(120_000, baseMs * 2 ** (cappedAttempt - 1));
}

function getOpenClawCaseSpacingMs(
  request: RunE2ERequest,
  attempt: number,
): number {
  if (request.adapterKind !== "openclaw") return 0;
  const configured = Number(process.env.AGENT_GUARD_OPENCLAW_CASE_SPACING_MS);
  const baseMs =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : 1_500;
  return attempt === 1 ? baseMs : 0;
}

function getMinimumSuccessfulDetectionCases(
  request: RunE2ERequest,
  totalCases: number,
): number {
  if (totalCases <= 0) return 1;
  if (request.adapterKind !== "openclaw") return totalCases;
  const configuredRatio = Number(process.env.AGENT_GUARD_OPENCLAW_MIN_SUCCESS_RATIO);
  const ratio =
    Number.isFinite(configuredRatio) && configuredRatio > 0 && configuredRatio <= 1
      ? configuredRatio
      : 0.7;
  const configuredAbsolute = Number(process.env.AGENT_GUARD_OPENCLAW_MIN_SUCCESS_CASES);
  const absolute =
    Number.isFinite(configuredAbsolute) && configuredAbsolute > 0
      ? Math.floor(configuredAbsolute)
      : 1;
  return Math.min(totalCases, Math.max(absolute, Math.ceil(totalCases * ratio)));
}

function classifyDetectionError(
  message: string,
  request: RunE2ERequest,
): {
  category: P2RunCaseFailure["category"];
  retryable: boolean;
  skipAllowed: boolean;
} {
  if (request.adapterKind !== "openclaw") {
    return {
      category: "fatal",
      retryable: false,
      skipAllowed: false,
    };
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("cooldown") ||
    normalized.includes("suspending lanes")
  ) {
    return {
      category: "provider_cooldown",
      retryable: true,
      skipAllowed: true,
    };
  }
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("etimedout")
  ) {
    return {
      category: "provider_timeout",
      retryable: true,
      skipAllowed: true,
    };
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("too many requests")
  ) {
    return {
      category: "provider_rate_limit",
      retryable: true,
      skipAllowed: true,
    };
  }
  if (
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("gatewayclientrequesterror") ||
    normalized.includes("all models failed")
  ) {
    return {
      category: "transient_provider",
      retryable: true,
      skipAllowed: true,
    };
  }
  if (
    normalized.includes("cannot execute openclaw cli") ||
    normalized.includes("cli not available") ||
    normalized.includes("enoent") ||
    normalized.includes("spawn enametoolong")
  ) {
    return {
      category: "fatal",
      retryable: false,
      skipAllowed: false,
    };
  }
  return {
    category: "agent_error",
    retryable: false,
    skipAllowed: false,
  };
}

function throwIfRunCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RunCancelledError();
  }
}

function isRunCancelledError(error: unknown): boolean {
  if (error instanceof RunCancelledError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("cancelled by user");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  throwIfRunCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new RunCancelledError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function buildToolProfilesForPolicyGeneration(
  targetCases: TestContext[],
): ToolCapabilityProfile[] {
  const byToolId = new Map<string, ToolCapabilityProfile>();

  for (const context of targetCases) {
    for (const tool of context.sandbox.tools ?? []) {
      if (byToolId.has(tool.toolId)) continue;
      const baseProfile = buildRuleBasedToolCapabilityProfile({
        originalToolName: tool.name ?? tool.toolId,
        canonicalToolId: tool.toolId,
        providerType: "agent_guard",
        description: tool.description,
        inputSchema: tool.schema,
      });
      const riskTagIds = tool.riskTags.map((tag) => tag.tagId);
      const riskCategories = tool.riskTags.map((tag) => tag.category);
      byToolId.set(tool.toolId, {
        ...baseProfile,
        riskTags: uniqueStrings([
          ...baseProfile.riskTags,
          ...riskTagIds,
          ...riskCategories,
        ]),
        sideEffect:
          tool.sideEffect === "command"
            ? "destructive"
            : tool.sideEffect === "network"
            ? "external"
            : tool.sideEffect === "read" || tool.sideEffect === "write"
            ? tool.sideEffect
            : baseProfile.sideEffect,
        confidence:
          tool.riskTags.length > 0 || tool.riskLevel === "high" || tool.riskLevel === "critical"
            ? "high"
            : baseProfile.confidence,
      });
    }
  }

  return [...byToolId.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
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
    skippedCases: 0,
    retriedCases: 0,
    retryingCaseIds: [],
    warnings: [],
    caseFailures: [],
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
  const skippedCases = patch.skippedCases ?? previous?.skippedCases ?? 0;
  const retriedCases = patch.retriedCases ?? previous?.retriedCases ?? 0;
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
    skippedCases,
    retriedCases,
    retryingCaseIds: patch.retryingCaseIds ?? previous?.retryingCaseIds ?? [],
    lastFailedCaseId: patch.lastFailedCaseId ?? previous?.lastFailedCaseId,
    providerCooldownUntil:
      patch.providerCooldownUntil ?? previous?.providerCooldownUntil,
    warnings: patch.warnings ?? previous?.warnings ?? [],
    caseFailures: patch.caseFailures ?? previous?.caseFailures ?? [],
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

function appendProgressWarning(runGroup: P2RunGroup, warning: string): void {
  const previous = runGroup.progress?.warnings ?? [];
  const next = uniqueStrings([...previous, warning]).slice(-MAX_PROGRESS_FAILURES);
  updateRunProgress(runGroup, { warnings: next });
}

function appendDetectionFailure(
  runGroup: P2RunGroup,
  failure: P2RunCaseFailure,
): void {
  const previous = runGroup.progress?.caseFailures ?? [];
  const next = [...previous, failure].slice(-MAX_PROGRESS_FAILURES);
  updateRunProgress(runGroup, { caseFailures: next });
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
