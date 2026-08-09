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
import {
  OpenClawAdapter,
  type OpenClawAdapterOptions,
} from "../modules/agent/openclawAdapter";
import { canonicalizeOpenClawSessionKey } from "../modules/agent/openclawSessionIdentity";
import { buildRuleBasedToolCapabilityProfile } from "../modules/gateway/toolCapabilityProfiler";
import {
  getRequiredSelectionPlan,
  TestSelectionError,
} from "../modules/runner/testSelectionService";
import { updateSelectionPlanStatus } from "../modules/runner/selectionPlanStore";
import { resolveInsideDirectory } from "../storage/pathSafety";
import {
  DetectionSandboxManager,
  DetectionSandboxError,
  SandboxPreflightError,
  createDetectionSandboxManager,
  type DetectionSandboxEvidence,
  type DetectionSandboxManagerOptions,
  type DetectionSessionContainerFinalization,
} from "../modules/openclaw/detectionSandboxManager";
import {
  DetectionProfileSeedError,
  resolveDetectionProfileSeed,
  type ResolveDetectionProfileSeedOptions,
} from "../modules/openclaw/detectionProfileSeed";
import { createNativeGuardEventStore } from "../storage/nativeGuardEventStore";
import type { NativeGuardEvent, RuntimeSupervisionRecord } from "@agent-guard/contracts";
import type {
  NativeGuardCoverageSummary,
  NativeGuardSessionCoverageSummary,
  SandboxEvidenceSummary,
} from "../api/types";
import type { TestRunResult } from "../modules/runner/runTypes";
import { scrubSecrets } from "../shared/scrubSecrets";
import type { NativeGuardCapability } from "../modules/openclaw/openclawControlClient";
import {
  createOpenClawDetectionRuntimeController,
  OpenClawDetectionRuntimeCleanupError,
  type OpenClawDetectionRuntimeController,
  type StartOpenClawDetectionRuntime,
} from "./openclawDetectionRuntime";

const CONFIGS_DIR = path.resolve(process.cwd(), "configs");
const P2_DEMO_CASES_FILE = path.join(CONFIGS_DIR, "p2_demo_cases.json");
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs", "reports");
const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");
const MAX_PROGRESS_FAILURES = 24;
const MAX_NATIVE_GUARD_DIAGNOSTIC_COUNT = 1_000_000;
export const MAX_OPENCLAW_DETECTION_CASES = 120;
const MISSING_NATIVE_GUARD_RECONCILIATION_FAILURE =
  "NATIVE_GUARD_COVERAGE_BREACH: 1 reconciliation issue(s); native guard reconciliation is missing.";
const GUARDED_FINALIZER_ERROR_CODES = new Set([
  "SESSION_CONTAINER_CLEANUP_FAILED",
  "CONTAINER_ATTESTATION_MISMATCH",
  "SANDBOX_EXPLAIN_MISMATCH",
]);
const RUN_CANCELLED_MESSAGE = "Run cancelled by user.";
const OPENCLAW_DETECTION_RUNTIME_FAILED_PREFIX =
  "OPENCLAW_DETECTION_RUNTIME_FAILED:";
const activeRunControllers = new Map<string, AbortController>();

// ---- Task 14: detection run serialization ----
// Only one OpenClaw sandbox detection run at a time. The app
// coordinator supports a single active lease; concurrent runs
// would fail with NATIVE_GUARD_ALREADY_ACTIVE.
const detectionRunReservationBrand: unique symbol = Symbol("detectionRunReservation");

export type DetectionRunReservation = Readonly<{
  [detectionRunReservationBrand]: true;
}>;

let activeDetectionRunReservation: DetectionRunReservation | undefined;

export class DetectionRunConflictError extends Error {
  constructor() {
    super(
      "Another OpenClaw detection run is already in progress. " +
      "Wait for it to complete or cancel it before starting a new run.",
    );
    this.name = "DetectionRunConflictError";
  }
}

export function reserveDetectionRun(): DetectionRunReservation {
  if (activeDetectionRunReservation) {
    throw new DetectionRunConflictError();
  }
  const reservation = Object.freeze({
    [detectionRunReservationBrand]: true as const,
  });
  activeDetectionRunReservation = reservation;
  return reservation;
}

export function releaseDetectionRunReservation(
  reservation: DetectionRunReservation | undefined,
): boolean {
  if (!reservation || activeDetectionRunReservation !== reservation) {
    return false;
  }
  activeDetectionRunReservation = undefined;
  return true;
}

export async function finalizeDetectionRunReservation(
  reservation: DetectionRunReservation | undefined,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } finally {
    releaseDetectionRunReservation(reservation);
  }
}

function claimDetectionRunReservation(
  reservation: DetectionRunReservation | undefined,
): DetectionRunReservation {
  if (!reservation) {
    return reserveDetectionRun();
  }
  if (activeDetectionRunReservation !== reservation) {
    throw new DetectionRunConflictError();
  }
  return reservation;
}

// ---- Task 14: native-guard lease dependencies ----
// Passed by the API handler when the coordinator is available.
export type GuardLeaseDeps = {
  activate: (input: {
    rootSessionKey: string;
    runGroupId: string;
  }) => Promise<{ leaseId: string; leaseEpoch: number }>;
  revoke: (leaseId: string) => Promise<void>;
};

export type GuardedSessionFinalizationResult = DetectionSessionContainerFinalization;

export type GuardedSessionFinalizer = (input: {
  caseId: string;
  runId: string;
  sessionKey: string;
}) => Promise<GuardedSessionFinalizationResult>;

/** Factory provided by app.ts. Shares the API's lease service and backend
 *  PDP URL, creates a per-run coordinator targeting the sandbox Gateway. */
export type SandboxCoordinatorFactory = (input: {
  gatewayUrl: string;
  gatewayToken: string;
  cliPath?: string;
  capabilitySnapshot: NativeGuardCapability;
  /** Isolated profile env: OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR, etc. */
  profileEnv: Record<string, string>;
}) => {
  activate(input: {
    rootSessionKey: string;
    runGroupId: string;
  }): Promise<{ leaseId: string; leaseEpoch: number }>;
  revoke(leaseId: string): Promise<void>;
  /** The event store shared with the API's decision/event handlers. */
  eventStore: ReturnType<typeof createNativeGuardEventStore>;
};

export type E2ERunDependencies = {
  resolveDetectionProfileSeed?: (
    options: ResolveDetectionProfileSeedOptions,
  ) => ReturnType<typeof resolveDetectionProfileSeed>;
  createDetectionSandboxManager?: (
    options: DetectionSandboxManagerOptions,
  ) => DetectionSandboxManager;
  createOpenClawAdapter?: (options: OpenClawAdapterOptions) => AgentAdapter;
  guardedSessionFinalizer?: GuardedSessionFinalizer;
};

function createOpenClawRuntimeGenerationFactory(input: {
  request: RunE2ERequest;
  runGroupId: string;
  image: string;
  signal: AbortSignal;
  sandboxCoordinatorFactory?: SandboxCoordinatorFactory;
  resolveProfileSeed: NonNullable<E2ERunDependencies["resolveDetectionProfileSeed"]>;
  createManager: NonNullable<E2ERunDependencies["createDetectionSandboxManager"]>;
  createAdapter: NonNullable<E2ERunDependencies["createOpenClawAdapter"]>;
  onRuntimeStarted: (input: {
    eventStore: ReturnType<typeof createNativeGuardEventStore>;
    preflightEvidence: DetectionSandboxEvidence;
  }) => void;
}): StartOpenClawDetectionRuntime {
  return async () => {
    let manager: DetectionSandboxManager | undefined;
    try {
      throwIfRunCancelled(input.signal);
      const profileSeed = await input.resolveProfileSeed({
        cliPath: input.request.connection?.cliPath,
      });
      throwIfRunCancelled(input.signal);
      manager = input.createManager({
        runGroupId: input.runGroupId,
        image: input.image,
        cliPath: input.request.connection?.cliPath,
        signal: input.signal,
        commandRunner: undefined,
        profileSeed,
      });
      const evidence = await manager.preflight();
      await manager.start();
      const sandboxCreds = manager.getGatewayCredentials();
      const capabilitySnapshot = manager.getAttestedCapabilitySnapshot();
      if (!sandboxCreds || !capabilitySnapshot) {
        throw new Error("Sandbox started but no attested Gateway capability returned.");
      }
      if (!input.sandboxCoordinatorFactory) {
        throw new Error(
          "Sandbox detection requires sandboxCoordinatorFactory. " +
          "Wire it from app.ts via runE2E().",
        );
      }
      const profileEnv: Record<string, string> = {
        OPENCLAW_CONFIG_PATH: evidence.configPath,
        OPENCLAW_STATE_DIR: path.join(evidence.profileRoot, "state"),
        OPENCLAW_WORKSPACE_DIR: path.join(evidence.profileRoot, "workspace"),
        OPENCLAW_HOME: evidence.profileRoot,
      };
      const runGuard = input.sandboxCoordinatorFactory({
        gatewayUrl: sandboxCreds.gatewayUrl,
        gatewayToken: sandboxCreds.gatewayToken,
        cliPath: input.request.connection?.cliPath,
        profileEnv,
        capabilitySnapshot,
      });
      const adapter = input.createAdapter({
        gatewayUrl: sandboxCreds.gatewayUrl,
        gatewayToken: sandboxCreds.gatewayToken,
        cliPath: input.request.connection?.cliPath,
        timeoutMs: getOpenClawDetectionTimeoutMs(input.request),
        env: profileEnv,
        signal: manager.signal,
        nativeGuardRequired: true,
        nativeGuardEventStore: runGuard.eventStore,
        guardLease: { activate: runGuard.activate, revoke: runGuard.revoke },
      });
      input.onRuntimeStarted({
        eventStore: runGuard.eventStore,
        preflightEvidence: evidence,
      });
      return {
        manager,
        adapter,
        nativeGuardEventStore: runGuard.eventStore,
        preflightEvidence: evidence,
      };
    } catch (error) {
      if (manager) {
        try {
          await manager.cleanup();
        } catch (cleanupError) {
          throw new OpenClawDetectionRuntimeCleanupError(
            cleanupError,
            manager,
          );
        }
      }
      throw error;
    }
  };
}

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

export function buildCustomAdapter(request: RunE2ERequest): AgentAdapter | undefined {
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
    default:
      return undefined;
  }
}

// ---- public API ----

export type RunE2EResult = {
  runGroup: P2RunGroup;
  links: EntityLink[];
};

export type DetectionSandboxLifetime = Pick<
  DetectionSandboxManager,
  "signal" | "runWhileGatewayAlive"
>;

export function runDetectionWithSandboxLifetime<T>(
  sandbox: DetectionSandboxLifetime,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return sandbox.runWhileGatewayAlive(operation);
}

export function validateOpenClawDetectionCaseLimit(
  adapterKind: RunE2ERequest["adapterKind"],
  caseCount: number,
): void {
  if (
    adapterKind === "openclaw" &&
    caseCount > MAX_OPENCLAW_DETECTION_CASES
  ) {
    throw new CaseIdValidationError(
      `OpenClaw detection supports at most ${MAX_OPENCLAW_DETECTION_CASES} cases; ` +
      `received ${caseCount}.`,
    );
  }
}

export function resolveNativeGuardSessionKeys(
  runGroup: Pick<P2RunGroup, "testRunIds" | "runGroupId">,
): string[] {
  const runIds = runGroup.testRunIds.length > 0
    ? runGroup.testRunIds
    : [runGroup.runGroupId];
  return runIds.map(canonicalizeOpenClawSessionKey);
}

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
  sandboxCoordinatorFactory?: SandboxCoordinatorFactory,
  reservedDetectionRun?: DetectionRunReservation,
  dependencies: E2ERunDependencies = {},
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
  let openClawRuntimeController: OpenClawDetectionRuntimeController | undefined;
  const runtimeEventStores: Array<ReturnType<typeof createNativeGuardEventStore>> = [];
  let isOpenClaw = false;
  let detectionRunReservation = reservedDetectionRun;

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

    const matchedCases = selectedCaseIds.length
      ? contexts.filter((ctx: (typeof contexts)[number]) => selectedCaseIds.includes(ctx.caseId))
      : contexts;
    const targetCases = request.adapterKind === "openclaw"
      ? orderDetectionCasesForExecution(matchedCases)
      : matchedCases;

    validateOpenClawDetectionCaseLimit(request.adapterKind, targetCases.length);

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

    // ====== Task 12: OpenClaw sandbox lifecycle ======
    isOpenClaw = request.adapterKind === "openclaw";
    const detectionImage = process.env.AGENT_GUARD_DETECTION_IMAGE;

    if (isOpenClaw) {
      // OpenClaw detection requires Docker isolation. Only one detection
      // run at a time — the app coordinator supports a single active lease.
      detectionRunReservation = claimDetectionRunReservation(detectionRunReservation);

      // OpenClaw detection requires Docker isolation. Without an immutable
      // image the sandbox cannot be provisioned. Fail immediately —
      // zero attack samples are executed.
      if (!detectionImage) {
        const message = "OpenClaw detection requires AGENT_GUARD_DETECTION_IMAGE env var set to an immutable image digest (registry/image@sha256:...).";
        runGroup.status = "failed";
        runGroup.phase = "failed";
        runGroup.error = message;
        runGroup.nativeGuardCoverage = {
          coverage: "misconfigured",
          eventsTotal: 0,
          reconciled: false,
          coverageBreachCount: 0,
          mismatchCount: 0,
          sessions: [],
          runtimeFailures: [],
        };
        updateRunProgress(runGroup, { phase: "failed", runningCaseIds: [], retryingCaseIds: [] });
        await saveRunGroup(runGroup);
        throw new Error(message);
      }

      try {
        openClawRuntimeController = createOpenClawDetectionRuntimeController({
          start: createOpenClawRuntimeGenerationFactory({
            request,
            runGroupId: runGroup.runGroupId,
            image: detectionImage,
            signal: controller.signal,
            sandboxCoordinatorFactory,
            resolveProfileSeed:
              dependencies.resolveDetectionProfileSeed ?? resolveDetectionProfileSeed,
            createManager:
              dependencies.createDetectionSandboxManager ?? createDetectionSandboxManager,
            createAdapter: dependencies.createOpenClawAdapter ??
              ((options) => new OpenClawAdapter(options)),
            onRuntimeStarted: ({ eventStore, preflightEvidence }) => {
              runtimeEventStores.push(eventStore);
              runGroup.sandboxEvidence = buildSandboxEvidenceSummary(
                preflightEvidence,
                undefined,
              );
            },
          }),
        });
        await openClawRuntimeController.ensure();
        runGroup.nativeGuardCoverage = {
          coverage: "conditional",
          eventsTotal: 0,
          reconciled: false,
          coverageBreachCount: 0,
          mismatchCount: 0,
          sessions: [],
          runtimeFailures: [],
        };
        // Sandbox coordinator allows only one active lease. Force
        // sequential execution regardless of env var override.
        if (runGroup.progress) runGroup.progress.concurrency = 1;
        await saveRunGroup(runGroup);
      } catch (error) {
        // Docker / sandbox failure: zero attack samples executed.
        const category = sandboxPreflightFailureCategory(error);
        runGroup.sandboxEvidence = buildSandboxEvidenceSummary(undefined, category);
        runGroup.nativeGuardCoverage = {
          coverage: "misconfigured",
          eventsTotal: 0,
          reconciled: false,
          coverageBreachCount: 0,
          mismatchCount: 0,
          sessions: [],
          runtimeFailures: [],
        };
        runGroup.status = "failed";
        runGroup.phase = "failed";
        runGroup.error = error instanceof Error ? error.message : String(error);
        updateRunProgress(runGroup, { phase: "failed", runningCaseIds: [], retryingCaseIds: [] });
        appendDetectionFailure(runGroup, {
          caseId: "sandbox_preflight",
          phase: "detecting",
          reason: runGroup.error!,
          category,
          attempts: 1,
          retryable: false,
          skipped: false,
          occurredAt: nowIso(),
        });
        await saveRunGroup(runGroup);
        throw error;
      }
    }

    const detectionResult = await runDetectionCasesConcurrently({
      targetCases,
      agent,
      adapterConfig,
      customAdapter: isOpenClaw ? undefined : customAdapter,
      runGroup,
      request,
      signal: controller.signal,
      guardedSessionFinalizer: dependencies.guardedSessionFinalizer,
      openClawRuntimeController,
    });

    if (openClawRuntimeController && !controller.signal.aborted) {
      const sessionKeys = resolveNativeGuardSessionKeys(runGroup);
      // Verify guard produced real decisions and no coverage breaches.
      // Per-session reconciliation against JSONL happens inside
      // runOpenClawSession; breaches cause the session to fail.
      if (runGroup.nativeGuardCoverage && runtimeEventStores.length > 0) {
        let anyDecisions = false;
        for (const sessionKey of sessionKeys) {
          for (const eventStore of runtimeEventStores) {
            try {
              const events = await eventStore.listBySession(sessionKey);
              if (events.some((e: NativeGuardEvent) => e.type === "decision")) {
                anyDecisions = true;
                break;
              }
            } catch { /* store unavailable — leave coverage as-is */ }
          }
        }
        const reconciled = runGroup.nativeGuardCoverage.sessions.length > 0 &&
          runGroup.nativeGuardCoverage.sessions.every((session) => session.reconciled);
        runGroup.nativeGuardCoverage.reconciled = reconciled;
        runGroup.nativeGuardCoverage.coverage = (anyDecisions && reconciled)
          ? "active" : "conditional";
      }
    }
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
    try {
      await finalizeDetectionRunReservation(detectionRunReservation, async () => {
        if (openClawRuntimeController) {
          try {
            await openClawRuntimeController.dispose();
          } catch (cleanupError) {
            const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            appendDetectionFailure(runGroup, {
              caseId: "sandbox_cleanup",
              phase: "detecting",
              reason: `Sandbox cleanup failed: ${message}`,
              category: "sandbox_cleanup_failed",
              attempts: 1, retryable: true, skipped: false,
              occurredAt: nowIso(),
            });
            if (runGroup.nativeGuardCoverage) {
              runGroup.nativeGuardCoverage.reconciled = false;
            }
            // Persist cleanup failure with consistent phase and status.
            runGroup.status = "failed";
            runGroup.phase = "failed";
            if (!runGroup.error) {
              runGroup.error = `Sandbox cleanup failed: ${message}`;
            }
            runGroup.endedAt = nowIso();
            await saveRunGroup(runGroup);
          }
        }
      });
    } finally {
      if (activeRunControllers.get(runGroup.runGroupId) === controller) {
        activeRunControllers.delete(runGroup.runGroupId);
      }
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

type DetectionAttemptEvidencePersister = typeof persistDetectionAttemptEvidence;

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

export async function runDetectionCasesConcurrently(input: {
  targetCases: TestContext[];
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  request: RunE2ERequest;
  signal: AbortSignal;
  guardedSessionFinalizer?: GuardedSessionFinalizer;
  detectionAttemptEvidencePersister?: DetectionAttemptEvidencePersister;
  openClawRuntimeController?: OpenClawDetectionRuntimeController;
}): Promise<DetectionBatchResult> {
  const {
    targetCases,
    agent,
    adapterConfig,
    customAdapter,
    runGroup,
    request,
    signal,
    guardedSessionFinalizer,
    detectionAttemptEvidencePersister,
    openClawRuntimeController,
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
          guardedSessionFinalizer,
          detectionAttemptEvidencePersister,
          openClawRuntimeController,
          getCounters: () => ({ completedCases, failedCases, skippedCases, retriedCases }),
          setRetried: () => {
            retriedCases++;
          },
        });
        throwIfRunCancelled(signal);

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
  guardedSessionFinalizer?: GuardedSessionFinalizer;
  detectionAttemptEvidencePersister?: DetectionAttemptEvidencePersister;
  openClawRuntimeController?: OpenClawDetectionRuntimeController;
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
    guardedSessionFinalizer,
    detectionAttemptEvidencePersister,
    openClawRuntimeController,
    getCounters,
    setRetried,
  } = input;
  const maxAttempts = getDetectionMaxAttempts(request);
  let attempt = 0;
  let providerAttempts = 0;
  let countedRetry = false;
  let lastClassification: ReturnType<typeof classifyDetectionError> | undefined;
  let lastMessage = "unknown error";
  let restartedRuntime = false;

  while (true) {
    throwIfRunCancelled(signal);
    attempt++;
    const spacingMs = getOpenClawCaseSpacingMs(request, attempt);
    if (spacingMs > 0) {
      await sleep(spacingMs, signal);
    }

    try {
      const runAttempt = (attemptInput: {
        customAdapter?: AgentAdapter;
        signal: AbortSignal;
        guardedSessionFinalizer?: GuardedSessionFinalizer;
      }) => runSingleDetectionAttempt({
        agent,
        adapterConfig,
        context,
        customAdapter: attemptInput.customAdapter,
        runGroup,
        signal: attemptInput.signal,
        guardedSessionFinalizer: attemptInput.guardedSessionFinalizer,
        detectionAttemptEvidencePersister,
      });
      const riskReport = openClawRuntimeController
        ? await runOpenClawDetectionAttempt(
            openClawRuntimeController,
            runAttempt,
          )
        : await runAttempt({ customAdapter, signal, guardedSessionFinalizer });
      return { riskReport };
    } catch (error) {
      lastMessage = scrubDetectionMessage(
        error instanceof Error ? error.message : String(error),
      );
      lastClassification = classifyDetectionErrorWithProvenance(
        error,
        lastMessage,
        request,
      );
      if (!lastClassification.restartRuntime) {
        providerAttempts += 1;
      }
      const shouldRestartRuntime =
        lastClassification.restartRuntime &&
        !restartedRuntime &&
        Boolean(openClawRuntimeController) &&
        !signal.aborted;
      const shouldRetry = lastClassification.restartRuntime
        ? shouldRestartRuntime
        : lastClassification.retryable && providerAttempts < maxAttempts;

      if (!shouldRetry) {
        break;
      }

      if (shouldRestartRuntime) {
        restartedRuntime = true;
        throwIfRunCancelled(signal);
        try {
          await openClawRuntimeController!.restart();
        } catch (restartError) {
          const normalizedError = normalizeOpenClawRuntimeError(restartError);
          const message = scrubDetectionMessage(normalizedError.message);
          const classified = classifyDetectionErrorWithProvenance(
            normalizedError,
            message,
            request,
          );
          throw new DetectionCaseError({
            message,
            category: classified.category,
            attempts: attempt,
            retryable: classified.retryable,
            skipAllowed: false,
          });
        }
        throwIfRunCancelled(signal);
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

class OpenClawDetectionRuntimeFailure extends Error {
  constructor(message: string) {
    super(`${OPENCLAW_DETECTION_RUNTIME_FAILED_PREFIX} ${message}`);
    this.name = "OpenClawDetectionRuntimeFailure";
  }
}

async function runOpenClawDetectionAttempt<T>(
  runtimeController: OpenClawDetectionRuntimeController,
  operation: (input: {
    customAdapter: AgentAdapter;
    signal: AbortSignal;
    guardedSessionFinalizer: GuardedSessionFinalizer;
  }) => Promise<T>,
): Promise<T> {
  try {
    return await runtimeController.run(async (runtime, signal) => operation({
      customAdapter: runtime.adapter,
      signal,
      guardedSessionFinalizer: ({ sessionKey }) =>
        runtime.manager.finalizeSessionContainer(sessionKey, {
          allowNotCreated: true,
        }),
    }));
  } catch (error) {
    throw normalizeOpenClawRuntimeError(error);
  }
}

function normalizeOpenClawRuntimeError(error: unknown): Error {
  if (
    error instanceof SandboxPreflightError &&
    (error.code === "GATEWAY_EXITED" || error.code === "GATEWAY_LIFETIME_UNAVAILABLE")
  ) {
    return new OpenClawDetectionRuntimeFailure(
      scrubDetectionMessage(error.message),
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function classifyDetectionErrorWithProvenance(
  error: unknown,
  message: string,
  request: RunE2ERequest,
): ReturnType<typeof classifyDetectionError> {
  if (error instanceof OpenClawDetectionRuntimeFailure) {
    return classifyDetectionError(message, request);
  }
  if (error instanceof OpenClawDetectionRuntimeCleanupError) {
    return nonRestartingDetectionClassification("sandbox_cleanup_failed");
  }
  if (error instanceof DetectionProfileSeedError) {
    return nonRestartingDetectionClassification("sandbox_profile_seed_failed");
  }
  if (error instanceof DetectionSandboxError) {
    if (error.code === "MODEL_PROFILE_SEED_INVALID") {
      return nonRestartingDetectionClassification("sandbox_profile_seed_failed");
    }
    if (error.code === "SESSION_CONTAINER_CLEANUP_FAILED") {
      return nonRestartingDetectionClassification("sandbox_cleanup_failed");
    }
    if (
      error.code === "CONTAINER_ATTESTATION_MISMATCH" ||
      error.code === "SANDBOX_EXPLAIN_MISMATCH"
    ) {
      return nonRestartingDetectionClassification("sandbox_attestation_failed");
    }
    if (
      error.code === "OPENCLAW_CAPABILITY_UNAVAILABLE" ||
      error.code === "OPENCLAW_UNSUPPORTED"
    ) {
      return nonRestartingDetectionClassification("native_guard_unavailable");
    }
    if (error instanceof SandboxPreflightError) {
      return nonRestartingDetectionClassification("sandbox_preflight_failed");
    }
  }
  if (
    message.toLowerCase().startsWith(
      OPENCLAW_DETECTION_RUNTIME_FAILED_PREFIX.toLowerCase(),
    )
  ) {
    const untrustedMessage = message
      .slice(OPENCLAW_DETECTION_RUNTIME_FAILED_PREFIX.length)
      .trim();
    const classified = classifyDetectionError(untrustedMessage, request);
    return classified.restartRuntime
      ? nonRestartingDetectionClassification("agent_error")
      : { ...classified, restartRuntime: false };
  }
  return classifyDetectionError(message, request);
}

function nonRestartingDetectionClassification(
  category: P2RunCaseFailure["category"],
): ReturnType<typeof classifyDetectionError> {
  return {
    category,
    retryable: false,
    skipAllowed: false,
    restartRuntime: false,
  };
}

async function runSingleDetectionAttempt(input: {
  agent: AgentUnderTest;
  adapterConfig: AgentAdapterConfig;
  context: TestContext;
  customAdapter?: AgentAdapter;
  runGroup: P2RunGroup;
  signal: AbortSignal;
  guardedSessionFinalizer?: GuardedSessionFinalizer;
  detectionAttemptEvidencePersister?: DetectionAttemptEvidencePersister;
}): Promise<ReturnType<typeof buildRiskReport>> {
  const {
    agent,
    adapterConfig,
    context,
    customAdapter,
    runGroup,
    signal,
    guardedSessionFinalizer,
    detectionAttemptEvidencePersister = persistDetectionAttemptEvidence,
  } = input;
  throwIfRunCancelled(signal);
  const result = await runTestCase(agent, adapterConfig, context, {
    customAdapter,
    selectionPlanId: runGroup.selectionPlanId,
    signal,
    requireNativeGuardRuntimeEvidence: Boolean(runGroup.nativeGuardCoverage),
  });
  const { testRun, trace } = result;
  let coverageFailure: string | undefined;
  let persistenceError: unknown;
  try {
    coverageFailure = await detectionAttemptEvidencePersister({
      runGroup,
      result,
      signal,
    });
  } catch (error) {
    persistenceError = new Error(
      `DETECTION_EVIDENCE_PERSISTENCE_FAILED: ${scrubDetectionMessage(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    coverageFailure = runGroup.nativeGuardCoverage
      ? recoverNativeGuardCoverageFailure(
          runGroup.nativeGuardCoverage,
          testRun.runId,
        )
      : undefined;
  }
  if (runGroup.nativeGuardCoverage) {
    const sandboxEvidence = await finalizeGuardedDetectionSession({
      caseId: context.caseId,
      result,
      guardedSessionFinalizer,
      expectedRunGroupId: runGroup.runGroupId,
      expectedSandboxEvidence: runGroup.sandboxEvidence,
    });
    if (sandboxEvidence) {
      runGroup.sandboxEvidence = buildSandboxEvidenceSummary(sandboxEvidence);
    } else if (normalizeProvenAbsentNativeGuardCoverage({
      coverage: runGroup.nativeGuardCoverage,
      runtime: result.nativeGuardRuntime!,
      testRunId: testRun.runId,
      testRunStatus: testRun.status,
      coverageFailure,
      persistenceError,
    })) {
      coverageFailure = undefined;
    }
  }
  throwIfRunCancelled(signal);

  const attemptFailure = resolveDetectionAttemptFailure(testRun, coverageFailure);
  if (coverageFailure && attemptFailure) throw new Error(attemptFailure);
  if (persistenceError) throw persistenceError;
  if (attemptFailure) throw new Error(attemptFailure);

  const evaluation = await evaluateRiskWithSemanticScoring(context, trace);
  throwIfRunCancelled(signal);
  return buildRiskReport(context, evaluation, trace);
}

export async function persistDetectionAttemptEvidence(input: {
  runGroup: P2RunGroup;
  result: Pick<TestRunResult, "testRun" | "trace" | "nativeGuardRuntime">;
  signal: AbortSignal;
  traceWriter?: (trace: TestRunResult["trace"]) => Promise<void>;
}): Promise<string | undefined> {
  const {
    runGroup,
    result: { testRun, trace, nativeGuardRuntime },
    signal,
    traceWriter = writeTraceFile,
  } = input;
  const alreadyAssociated = runGroup.testRunIds.includes(testRun.runId);
  let coverageFailure: string | undefined;

  if (!alreadyAssociated) {
    runGroup.testRunIds.push(testRun.runId);
    coverageFailure = nativeGuardRuntime
      ? recordNativeGuardSessionCoverage(
          runGroup,
          nativeGuardRuntime,
          testRun.runId,
        )
      : undefined;
  } else if (runGroup.nativeGuardCoverage) {
    coverageFailure = recoverNativeGuardCoverageFailure(
      runGroup.nativeGuardCoverage,
      testRun.runId,
    );
  }

  throwIfRunCancelled(signal);
  await traceWriter(trace);
  if (!runGroup.traceIds.includes(trace.traceId)) {
    runGroup.traceIds.push(trace.traceId);
  }
  return coverageFailure;
}

export function resolveDetectionAttemptFailure(
  testRun: Pick<TestRunResult["testRun"], "status" | "error">,
  coverageFailure?: string,
): string | undefined {
  if (coverageFailure) return scrubDetectionMessage(coverageFailure);
  if (testRun.status === "failed") {
    return scrubDetectionMessage(testRun.error ?? "Detection test run failed");
  }
  return undefined;
}

function scrubbedDetectionError(error: unknown): Error {
  return new Error(scrubDetectionMessage(error instanceof Error ? error.message : String(error)));
}

function scrubDetectionMessage(message: string): string {
  return scrubSecrets(message).replace(/\[REDACTED\]\]+/g, "[REDACTED]");
}

export async function finalizeGuardedDetectionSession(input: {
  caseId: string;
  result: Pick<TestRunResult, "testRun" | "nativeGuardRuntime">;
  guardedSessionFinalizer?: GuardedSessionFinalizer;
  expectedRunGroupId?: string;
  expectedSandboxEvidence?: SandboxEvidenceSummary;
}): Promise<DetectionSandboxEvidence | undefined> {
  const { guardedSessionFinalizer } = input;
  if (!guardedSessionFinalizer) {
    throw new Error(
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Guarded session finalizer is unavailable.",
    );
  }

  const runtime = input.result.nativeGuardRuntime;
  if (!runtime) {
    throw new Error(
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Native guard runtime evidence is missing.",
    );
  }
  const sessionKey = runtime.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error(
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Native guard session key is missing.",
    );
  }
  let finalizationResult: GuardedSessionFinalizationResult;
  try {
    finalizationResult = await guardedSessionFinalizer({
      caseId: input.caseId,
      runId: input.result.testRun.runId,
      sessionKey,
    });
  } catch (error) {
    if (isRunCancelledError(error)) throw scrubbedDetectionError(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const candidateCode = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    const stableCode = typeof candidateCode === "string" &&
        GUARDED_FINALIZER_ERROR_CODES.has(candidateCode)
      ? candidateCode
      : undefined;
    const message = scrubDetectionMessage(
      stableCode && !rawMessage.startsWith(`${stableCode}:`)
        ? `${stableCode}: ${rawMessage}`
        : rawMessage,
    );
    if (
      /NATIVE_GUARD_(?:EVIDENCE_UNAVAILABLE|REVOKE_FAILED|COVERAGE_BREACH):/i.test(message) ||
      /^(?:SESSION_CONTAINER_CLEANUP_FAILED|CONTAINER_ATTESTATION_MISMATCH|SANDBOX_EXPLAIN_MISMATCH):/i.test(message)
    ) {
      throw new Error(message);
    }
    throw new Error(
      `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Guarded session finalization failed: ${message}`,
    );
  }

  if (!finalizationResult || typeof finalizationResult !== "object") {
    throw new Error(
      "SESSION_CONTAINER_CLEANUP_FAILED: Guarded session finalizer returned an invalid outcome.",
    );
  }
  if (finalizationResult.outcome !== "cleaned" && finalizationResult.outcome !== "not_created") {
    throw new Error(
      "SESSION_CONTAINER_CLEANUP_FAILED: Guarded session finalizer returned an ambiguous outcome.",
    );
  }
  if (finalizationResult.sessionKey !== sessionKey) {
    throw new Error(
      finalizationResult.outcome === "not_created"
        ? "CONTAINER_ATTESTATION_MISMATCH: Not-created proof does not match the guarded session."
        : "CONTAINER_ATTESTATION_MISMATCH: Cleaned proof does not match the guarded session.",
    );
  }
  if (finalizationResult.outcome === "not_created") {
    const finalizationFailure = validateFinalizedSandboxEvidence(
      finalizationResult.evidence,
      "not_created",
      input.expectedRunGroupId,
      input.expectedSandboxEvidence,
    );
    if (finalizationFailure) throw new Error(finalizationFailure);
    const integrityFailure = resolveNativeGuardRuntimeDiagnosticFailure(runtime);
    if (integrityFailure) throw new Error(integrityFailure);
    if (!Array.isArray(runtime.events) || runtime.events.length !== 0) {
      const eventCount = Array.isArray(runtime.events)
        ? Math.min(runtime.events.length, MAX_NATIVE_GUARD_DIAGNOSTIC_COUNT)
        : 1;
      throw new Error(
        `NATIVE_GUARD_COVERAGE_BREACH: ${String(Math.max(1, eventCount))} reconciliation issue(s); not-created proof contains runtime events.`,
      );
    }
    if (input.result.testRun.status !== "failed") {
      throw new Error(
        "SESSION_CONTAINER_CLEANUP_FAILED: Successful guarded attempt cannot use a not-created outcome.",
      );
    }
    if (runtime.reconciliation) {
      const reconciliationFailure = assessNativeGuardReconciliation(
        runtime.reconciliation,
      ).failure;
      if (reconciliationFailure) throw new Error(reconciliationFailure);
    }
    return undefined;
  }
  const sandboxEvidence = finalizationResult.evidence;
  const finalizationFailure = validateFinalizedSandboxEvidence(
    sandboxEvidence,
    "cleaned",
    input.expectedRunGroupId,
    input.expectedSandboxEvidence,
  );
  if (finalizationFailure) throw new Error(finalizationFailure);
  const integrityFailure = resolveNativeGuardRuntimeIntegrityFailure(runtime);
  if (integrityFailure) throw new Error(integrityFailure);
  return sandboxEvidence;
}

function validateFinalizedSandboxEvidence(
  evidence: DetectionSandboxEvidence | undefined,
  outcome: DetectionSessionContainerFinalization["outcome"],
  expectedRunGroupId?: string,
  expected?: SandboxEvidenceSummary,
): string | undefined {
  const label = outcome === "cleaned" ? "Cleaned" : "Not-created";
  if (!evidence || typeof evidence !== "object") {
    return `CONTAINER_ATTESTATION_MISMATCH: ${label} evidence identity is incomplete.`;
  }
  if (
    !nonEmptyEvidenceString(evidence.runGroupId) ||
    !nonEmptyEvidenceString(evidence.image) ||
    !nonEmptyEvidenceString(evidence.imageId) ||
    !nonEmptyEvidenceString(evidence.openclawVersion) ||
    !nonEmptyEvidenceString(evidence.profileRoot) ||
    !nonEmptyEvidenceString(evidence.configPath) ||
    !nonEmptyEvidenceString(evidence.configDigest) ||
    (evidence.networkMode !== "none" && evidence.networkMode !== "internal")
  ) {
    return `CONTAINER_ATTESTATION_MISMATCH: ${label} evidence identity is incomplete.`;
  }
  if (outcome === "cleaned") {
    if (evidence.status !== "cleaned") {
      return "SESSION_CONTAINER_CLEANUP_FAILED: Guarded session finalizer did not return cleaned evidence.";
    }
    if (
      typeof evidence.containerId !== "string" ||
      !/^[a-f0-9]{64}$/.test(evidence.containerId)
    ) {
      return "SESSION_CONTAINER_CLEANUP_FAILED: Cleaned evidence does not contain an exact container identity.";
    }
  } else if (evidence.status !== "attested" || evidence.containerId !== undefined) {
    return "CONTAINER_ATTESTATION_MISMATCH: Not-created evidence does not prove container absence.";
  }
  if (expectedRunGroupId && evidence.runGroupId !== expectedRunGroupId) {
    return `CONTAINER_ATTESTATION_MISMATCH: ${label} evidence belongs to a different run group.`;
  }
  if (
    expected &&
    (
      (expected.imageId !== undefined && evidence.imageId !== expected.imageId) ||
      (expected.imageDigest !== undefined && evidence.image !== expected.imageDigest) ||
      (expected.openclawVersion !== undefined && evidence.openclawVersion !== expected.openclawVersion) ||
      evidence.networkMode !== expected.networkMode ||
      (expected.configDigest !== undefined && evidence.configDigest !== expected.configDigest)
    )
  ) {
    return `CONTAINER_ATTESTATION_MISMATCH: ${label} evidence does not match sandbox preflight identity.`;
  }
  return undefined;
}

function nonEmptyEvidenceString(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveNativeGuardRuntimeIntegrityFailure(
  runtime: NonNullable<TestRunResult["nativeGuardRuntime"]>,
): string | undefined {
  return resolveNativeGuardRuntimeDiagnosticFailure(runtime) ??
    assessNativeGuardReconciliation(runtime.reconciliation).failure;
}

function resolveNativeGuardRuntimeDiagnosticFailure(
  runtime: NonNullable<TestRunResult["nativeGuardRuntime"]>,
): string | undefined {
  if (runtime.evidenceError) {
    return `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${scrubDetectionMessage(runtime.evidenceError)}`;
  }
  if (runtime.revokeError) {
    return `NATIVE_GUARD_REVOKE_FAILED: ${scrubDetectionMessage(runtime.revokeError)}`;
  }
  return undefined;
}

function cappedNativeGuardDiagnosticCount(value: number): number | undefined {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return Math.min(value, MAX_NATIVE_GUARD_DIAGNOSTIC_COUNT);
}

function addNativeGuardDiagnosticCounts(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    const capped = cappedNativeGuardDiagnosticCount(value);
    if (capped === undefined) return MAX_NATIVE_GUARD_DIAGNOSTIC_COUNT;
    total = Math.min(MAX_NATIVE_GUARD_DIAGNOSTIC_COUNT, total + capped);
  }
  return total;
}

function assessNativeGuardReconciliation(
  reconciliation: NonNullable<TestRunResult["nativeGuardRuntime"]>["reconciliation"],
): {
  reconciled: boolean;
  coverageBreachCount: number;
  mismatchCount: number;
  failure?: string;
} {
  if (!reconciliation) {
    return {
      reconciled: false,
      coverageBreachCount: 0,
      mismatchCount: 0,
      failure: MISSING_NATIVE_GUARD_RECONCILIATION_FAILURE,
    };
  }
  const coverageBreachCount = cappedNativeGuardDiagnosticCount(
    reconciliation.coverageBreachCount,
  );
  const mismatchCount = cappedNativeGuardDiagnosticCount(
    reconciliation.mismatchCount,
  );
  if (coverageBreachCount === undefined || mismatchCount === undefined) {
    return {
      reconciled: false,
      coverageBreachCount: 0,
      mismatchCount: 0,
      failure: "NATIVE_GUARD_COVERAGE_BREACH: 1 reconciliation issue(s); native guard reconciliation counts are invalid.",
    };
  }
  const issueCount = addNativeGuardDiagnosticCounts(
    coverageBreachCount,
    mismatchCount,
  );
  const reconciled = reconciliation.reconciled === true && issueCount === 0;
  return {
    reconciled,
    coverageBreachCount,
    mismatchCount,
    ...(!reconciled
      ? {
          failure: `NATIVE_GUARD_COVERAGE_BREACH: ${String(Math.max(1, issueCount))} reconciliation issue(s); native guard reconciliation is incomplete.`,
        }
      : {}),
  };
}

export function recordNativeGuardSessionCoverage(
  runGroup: P2RunGroup,
  runtime: NonNullable<TestRunResult["nativeGuardRuntime"]>,
  testRunId: string,
): string | undefined {
  const coverage = runGroup.nativeGuardCoverage;
  if (!coverage) return undefined;

  const { sessionKey, leaseId, leaseEpoch } = runtime;
  const runtimeIdentity = compactLeaseIdentity({ sessionKey, leaseId, leaseEpoch });
  const identityMissing = !hasCompleteLeaseIdentity(runtimeIdentity);
  const conflictingEvents = runtime.events.filter((event) =>
    event.sessionKey !== sessionKey ||
    event.leaseId !== leaseId ||
    event.leaseEpoch !== leaseEpoch
  );
  const identityError = conflictingEvents.length > 0
    ? `Native guard event lease identity conflict for session (${String(conflictingEvents.length)} event(s)).`
    : undefined;
  const missingIdentityError = identityMissing
    ? "Native guard session lease identity is missing."
    : undefined;
  const evidenceError = joinNativeGuardDiagnostics(
    runtime.evidenceError,
    identityError,
    missingIdentityError,
  );
  const revokeError = runtime.revokeError
    ? scrubSecrets(runtime.revokeError)
    : undefined;
  const reconciliation = assessNativeGuardReconciliation(runtime.reconciliation);
  if (identityMissing) {
    const failure = {
      testRunId,
      ...(runtimeIdentity.sessionKey
        ? { sessionKey: runtimeIdentity.sessionKey }
        : {}),
      kind: "identity_missing" as const,
      identityMissing: true as const,
      eventsTotal: runtime.events.length,
      reconciled: false as const,
      coverageBreachCount: reconciliation.coverageBreachCount,
      mismatchCount: addNativeGuardDiagnosticCounts(
        reconciliation.mismatchCount,
        1,
      ),
      evidenceError: evidenceError!,
      ...(revokeError ? { revokeError } : {}),
    };
    const existingFailureIndex = coverage.runtimeFailures.findIndex(
      (item) => item.testRunId === testRunId,
    );
    if (existingFailureIndex >= 0) {
      coverage.runtimeFailures[existingFailureIndex] = failure;
    } else {
      coverage.runtimeFailures.push(failure);
    }
    aggregateNativeGuardCoverage(coverage);
    return `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${failure.evidenceError}`;
  }

  const summary: NativeGuardSessionCoverageSummary = {
    sessionKey: runtimeIdentity.sessionKey,
    leaseId: runtimeIdentity.leaseId,
    leaseEpoch: runtimeIdentity.leaseEpoch,
    testRunIds: [testRunId],
    eventsTotal: runtime.events.length,
    reconciled: Boolean(reconciliation.reconciled && !evidenceError && !revokeError),
    coverageBreachCount: reconciliation.coverageBreachCount,
    mismatchCount: addNativeGuardDiagnosticCounts(
      reconciliation.mismatchCount,
      conflictingEvents.length,
    ),
    ...(conflictingEvents.length > 0
      ? {
          leaseIdentityConflict: {
            expected: runtimeIdentity,
            observed: uniqueLeaseIdentities(
              conflictingEvents.map((event) => compactLeaseIdentity(event)),
            ),
          },
        }
      : {}),
    ...(revokeError ? { revokeError } : {}),
    ...(evidenceError ? { evidenceError } : {}),
  };

  const existingIndex = sessionKey
    ? coverage.sessions.findIndex((session) => session.sessionKey === sessionKey)
    : -1;
  let persistedSummary = summary;
  if (existingIndex >= 0) {
    const existing = coverage.sessions[existingIndex]!;
    const runtimeIdentityConflict =
      hasCompleteLeaseIdentity(existing) &&
      hasCompleteLeaseIdentity(summary) &&
      (existing.leaseId !== summary.leaseId || existing.leaseEpoch !== summary.leaseEpoch);
    const conflictError = runtimeIdentityConflict
      ? "Native guard runtime lease identity conflict for session."
      : undefined;
    const mergedConflict = mergeLeaseIdentityConflicts(
      existing,
      summary,
      runtimeIdentityConflict,
    );
    const mergedEvidenceError = joinNativeGuardDiagnostics(
      existing.evidenceError,
      summary.evidenceError,
      conflictError,
    );
    const mergedRevokeError = joinNativeGuardDiagnostics(
      existing.revokeError,
      summary.revokeError,
    );
    persistedSummary = {
      sessionKey: existing.sessionKey,
      leaseId: existing.leaseId,
      leaseEpoch: existing.leaseEpoch,
      testRunIds: uniqueStrings([
        ...(existing.testRunIds ?? []),
        ...(summary.testRunIds ?? []),
      ]),
      eventsTotal: existing.eventsTotal + summary.eventsTotal,
      reconciled: Boolean(
        existing.reconciled &&
        summary.reconciled &&
        !runtimeIdentityConflict &&
        !mergedEvidenceError &&
        !mergedRevokeError
      ),
      coverageBreachCount: addNativeGuardDiagnosticCounts(
        existing.coverageBreachCount,
        summary.coverageBreachCount,
      ),
      mismatchCount: addNativeGuardDiagnosticCounts(
        existing.mismatchCount,
        summary.mismatchCount,
        runtimeIdentityConflict ? 1 : 0,
      ),
      ...(mergedConflict ? { leaseIdentityConflict: mergedConflict } : {}),
      ...(mergedRevokeError ? { revokeError: mergedRevokeError } : {}),
      ...(mergedEvidenceError ? { evidenceError: mergedEvidenceError } : {}),
    };
    coverage.sessions[existingIndex] = persistedSummary;
  } else {
    coverage.sessions.push(summary);
  }

  aggregateNativeGuardCoverage(coverage);

  if (persistedSummary.evidenceError) {
    return `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${persistedSummary.evidenceError}`;
  }
  if (persistedSummary.revokeError) {
    return `NATIVE_GUARD_REVOKE_FAILED: ${persistedSummary.revokeError}`;
  }
  if (runtime.reconciliation === undefined) {
    return MISSING_NATIVE_GUARD_RECONCILIATION_FAILURE;
  }
  return assessNativeGuardReconciliation(persistedSummary).failure;
}

function recoverNativeGuardCoverageFailure(
  coverage: NativeGuardCoverageSummary,
  testRunId: string,
): string | undefined {
  const runtimeFailure = coverage.runtimeFailures.find(
    (failure) => failure.testRunId === testRunId,
  );
  if (runtimeFailure?.evidenceError) {
    return `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${runtimeFailure.evidenceError}`;
  }
  if (runtimeFailure?.revokeError) {
    return `NATIVE_GUARD_REVOKE_FAILED: ${runtimeFailure.revokeError}`;
  }
  if (runtimeFailure) {
    return assessNativeGuardReconciliation(runtimeFailure).failure;
  }

  const session = coverage.sessions.find(
    (summary) => summary.testRunIds?.includes(testRunId),
  );
  if (session?.evidenceError) {
    return `NATIVE_GUARD_EVIDENCE_UNAVAILABLE: ${session.evidenceError}`;
  }
  if (session?.revokeError) {
    return `NATIVE_GUARD_REVOKE_FAILED: ${session.revokeError}`;
  }
  return session
    ? assessNativeGuardReconciliation(session).failure
    : undefined;
}

function aggregateNativeGuardCoverage(
  coverage: NativeGuardCoverageSummary,
): void {
  const summaries = [...coverage.sessions, ...coverage.runtimeFailures];
  coverage.eventsTotal = summaries.reduce(
    (total, summary) => total + summary.eventsTotal,
    0,
  );
  coverage.coverageBreachCount = addNativeGuardDiagnosticCounts(
    ...summaries.map((summary) => summary.coverageBreachCount),
  );
  coverage.mismatchCount = addNativeGuardDiagnosticCounts(
    ...summaries.map((summary) => summary.mismatchCount),
  );
  coverage.reconciled = summaries.length > 0 &&
    summaries.every((summary) => summary.reconciled);

  const primary = coverage.sessions[0];
  coverage.leaseId = primary?.leaseId;
  coverage.leaseEpoch = primary?.leaseEpoch;
}

function normalizeProvenAbsentNativeGuardCoverage(input: {
  coverage: NativeGuardCoverageSummary;
  runtime: NonNullable<TestRunResult["nativeGuardRuntime"]>;
  testRunId: string;
  testRunStatus: TestRunResult["testRun"]["status"];
  coverageFailure?: string;
  persistenceError?: unknown;
}): boolean {
  const {
    coverage,
    runtime,
    testRunId,
    testRunStatus,
    coverageFailure,
    persistenceError,
  } = input;
  const identity = compactLeaseIdentity(runtime);
  let canonicalSessionKey = false;
  if (identity.sessionKey) {
    try {
      canonicalSessionKey = canonicalizeOpenClawSessionKey(identity.sessionKey) === identity.sessionKey;
    } catch {
      canonicalSessionKey = false;
    }
  }
  if (
    testRunStatus !== "failed" ||
    persistenceError !== undefined ||
    (coverageFailure !== undefined &&
      coverageFailure !== MISSING_NATIVE_GUARD_RECONCILIATION_FAILURE) ||
    !canonicalSessionKey ||
    !hasCompleteLeaseIdentity(identity) ||
    runtime.events.length !== 0 ||
    runtime.reconciliation !== undefined ||
    Boolean(runtime.evidenceError) ||
    Boolean(runtime.revokeError) ||
    coverage.runtimeFailures.length !== 0
  ) {
    return false;
  }

  const matchingIndexes = coverage.sessions
    .map((session, index) => session.testRunIds?.includes(testRunId) ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length !== 1) return false;
  const matchingIndex = matchingIndexes[0]!;
  const session = coverage.sessions[matchingIndex]!;
  if (
    session.sessionKey !== identity.sessionKey ||
    session.leaseId !== identity.leaseId ||
    session.leaseEpoch !== identity.leaseEpoch ||
    session.eventsTotal !== 0 ||
    session.coverageBreachCount !== 0 ||
    session.mismatchCount !== 0 ||
    Boolean(session.evidenceError) ||
    Boolean(session.revokeError) ||
    session.leaseIdentityConflict !== undefined ||
    coverage.sessions.some((candidate, index) =>
      index !== matchingIndex &&
      (
        !candidate.reconciled ||
        candidate.coverageBreachCount !== 0 ||
        candidate.mismatchCount !== 0 ||
        Boolean(candidate.evidenceError) ||
        Boolean(candidate.revokeError) ||
        candidate.leaseIdentityConflict !== undefined
      )
    )
  ) {
    return false;
  }

  coverage.sessions[matchingIndex] = { ...session, reconciled: true };
  aggregateNativeGuardCoverage(coverage);
  return true;
}

type NativeGuardLeaseIdentitySummary = {
  sessionKey?: string;
  leaseId?: string;
  leaseEpoch?: number;
};

function compactLeaseIdentity(
  value: NativeGuardLeaseIdentitySummary,
): NativeGuardLeaseIdentitySummary {
  return {
    ...(typeof value.sessionKey === "string" && value.sessionKey
      ? { sessionKey: value.sessionKey }
      : {}),
    ...(typeof value.leaseId === "string" && value.leaseId
      ? { leaseId: value.leaseId }
      : {}),
    ...(Number.isSafeInteger(value.leaseEpoch) && (value.leaseEpoch as number) > 0
      ? { leaseEpoch: value.leaseEpoch }
      : {}),
  };
}

function hasCompleteLeaseIdentity(
  value: NativeGuardLeaseIdentitySummary,
): value is Required<NativeGuardLeaseIdentitySummary> {
  return Boolean(
    value.sessionKey &&
    value.leaseId &&
    Number.isSafeInteger(value.leaseEpoch) &&
    (value.leaseEpoch as number) > 0,
  );
}

function uniqueLeaseIdentities(
  identities: NativeGuardLeaseIdentitySummary[],
): NativeGuardLeaseIdentitySummary[] {
  const byIdentity = new Map<string, NativeGuardLeaseIdentitySummary>();
  for (const identity of identities) {
    const key = JSON.stringify([
      identity.sessionKey ?? null,
      identity.leaseId ?? null,
      identity.leaseEpoch ?? null,
    ]);
    if (!byIdentity.has(key)) byIdentity.set(key, identity);
  }
  return [...byIdentity.values()];
}

function mergeLeaseIdentityConflicts(
  existing: NativeGuardSessionCoverageSummary,
  incoming: NativeGuardSessionCoverageSummary,
  runtimeIdentityConflict: boolean,
): NativeGuardSessionCoverageSummary["leaseIdentityConflict"] {
  const observed = [
    ...(existing.leaseIdentityConflict?.observed ?? []),
    ...(incoming.leaseIdentityConflict?.observed ?? []),
    ...(runtimeIdentityConflict ? [compactLeaseIdentity(incoming)] : []),
  ];
  if (observed.length === 0) return existing.leaseIdentityConflict;
  return {
    expected: {
      sessionKey: existing.sessionKey,
      leaseId: existing.leaseId,
      leaseEpoch: existing.leaseEpoch,
    },
    observed: uniqueLeaseIdentities(observed),
  };
}

function joinNativeGuardDiagnostics(
  ...messages: Array<string | undefined>
): string | undefined {
  const unique = new Set(
    messages
      .filter((message): message is string => Boolean(message))
      .map(scrubSecrets),
  );
  return unique.size > 0 ? [...unique].join("; ") : undefined;
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

export function getOpenClawDetectionTimeoutMs(request: RunE2ERequest): number {
  return request.connection?.timeoutMs ?? 90_000;
}

type DetectionCaseOrderInput = {
  caseId: string;
  caseName?: string;
  testCase: {
    description?: string;
    task: {
      instruction?: string;
      metadata?: unknown;
    };
  };
};

const DEFERRED_DETECTION_CASE_PATTERN =
  /(?:encoding|obfuscat|smuggl|base(?:32|64|85|2048)|braille|unicode|morse|rot\d*|caesar|vigenere|binary|bin_ascii|hex|octal|a1z26|atbash|ecoji|zero_width|character_(?:space|split)|ascii_art|leetspeak|superscript|variation_selector|sneaky_bits|percent_double_encode|python_chr|powershell_join)/i;

export function orderDetectionCasesForExecution<T extends DetectionCaseOrderInput>(
  cases: readonly T[],
): T[] {
  return cases
    .map((item, index) => ({ item, index, deferred: isDeferredDetectionCase(item) }))
    .sort((left, right) => Number(left.deferred) - Number(right.deferred) || left.index - right.index)
    .map(({ item }) => item);
}

function isDeferredDetectionCase(testContext: DetectionCaseOrderInput): boolean {
  const metadata = testContext.testCase.task.metadata;
  const operatorId =
    typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) &&
    typeof (metadata as Record<string, unknown>).operatorId === "string"
      ? (metadata as Record<string, string>).operatorId
      : "";
  return DEFERRED_DETECTION_CASE_PATTERN.test([
    operatorId,
    testContext.caseName,
    testContext.testCase.description,
  ].filter((value): value is string => typeof value === "string").join(" "));
}

export function getDetectionMaxAttempts(request: RunE2ERequest): number {
  if (request.adapterKind !== "openclaw") return 1;
  const configured = Number(process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(Math.floor(configured), 5));
  }
  return 2;
}

export function getDetectionRetryDelayMs(attempt: number): number {
  const configured = Number(process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS);
  const baseMs =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : 3_000;
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

export function classifyDetectionError(
  message: string,
  request: RunE2ERequest,
): {
  category: P2RunCaseFailure["category"];
  retryable: boolean;
  skipAllowed: boolean;
  restartRuntime: boolean;
} {
  if (request.adapterKind !== "openclaw") {
    return {
      category: "fatal",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }

  const normalized = message.toLowerCase();
  if (
    normalized.startsWith(
      OPENCLAW_DETECTION_RUNTIME_FAILED_PREFIX.toLowerCase(),
    )
  ) {
    return {
      category: "sandbox_runtime_failed",
      retryable: true,
      skipAllowed: false,
      restartRuntime: true,
    };
  }
  if (normalized.startsWith("detection_evidence_persistence_failed:")) {
    return {
      category: "fatal",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  if (normalized.includes("session_container_cleanup_failed")) {
    return {
      category: "sandbox_cleanup_failed",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  if (
    normalized.includes("container_attestation_mismatch") ||
    normalized.includes("sandbox_explain_mismatch")
  ) {
    return {
      category: "sandbox_attestation_failed",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  if (normalized.includes("native_guard_evidence_unavailable")) {
    return {
      category: "native_guard_evidence_unavailable",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  if (normalized.includes("native_guard_revoke_failed")) {
    return {
      category: "native_guard_revoke_failed",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  // Coverage breach: Hook missed tool calls. Fatal per spec —
  // coverage breach must cause the run to fail.
  if (
    normalized.includes("native_guard_coverage_breach") ||
    normalized.includes("coverage breach")
  ) {
    return {
      category: "native_guard_coverage_breach",
      retryable: false,
      skipAllowed: false,
      restartRuntime: false,
    };
  }
  if (
    normalized.includes("cooldown") ||
    normalized.includes("suspending lanes")
  ) {
    return {
      category: "provider_cooldown",
      retryable: true,
      skipAllowed: true,
      restartRuntime: false,
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
      restartRuntime: false,
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
      restartRuntime: false,
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
      restartRuntime: false,
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
      restartRuntime: false,
    };
  }
  return {
    category: "agent_error",
    retryable: false,
    skipAllowed: false,
    restartRuntime: false,
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
  if (failure.category === "native_guard_coverage_breach" && runGroup.nativeGuardCoverage) {
    runGroup.nativeGuardCoverage.reconciled = false;
  }
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

// ---- Task 12: sandbox evidence helpers ----

function sandboxPreflightFailureCategory(
  error: unknown,
): P2RunCaseFailure["category"] {
  if (error instanceof OpenClawDetectionRuntimeCleanupError) {
    return "sandbox_cleanup_failed";
  }
  if (
    error instanceof DetectionProfileSeedError ||
    (error instanceof SandboxPreflightError && error.code === "MODEL_PROFILE_SEED_INVALID")
  ) {
    return "sandbox_profile_seed_failed";
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("docker") || normalized.includes("unavailable")) return "sandbox_preflight_failed";
  if (normalized.includes("attestation")) return "sandbox_attestation_failed";
  if (normalized.includes("cleanup")) return "sandbox_cleanup_failed";
  if (normalized.includes("openclaw") || normalized.includes("capability")) return "native_guard_unavailable";
  return "sandbox_preflight_failed";
}

function buildSandboxEvidenceSummary(
  evidence?: DetectionSandboxEvidence,
  failureCategory?: string,
): SandboxEvidenceSummary {
  if (evidence) {
    return {
      preflightPassed: true,
      attested: evidence.status === "attested" || evidence.status === "cleaned",
      imageId: evidence.imageId,
      imageDigest: evidence.image,
      openclawVersion: evidence.openclawVersion,
      networkMode: evidence.networkMode,
      containerId: evidence.containerId,
      configDigest: evidence.configDigest,
    };
  }
  return {
    preflightPassed: false,
    attested: false,
    networkMode: "none",
    failureCategory,
  };
}
