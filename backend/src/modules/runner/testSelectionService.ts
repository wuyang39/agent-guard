import path from "node:path";
import type {
  AgentUnderTest,
  CandidateCaseCard,
  CoverageSnapshot,
  SelectionEvalStyleResult,
  SelectedCaseSummary,
  SelectionReason,
  TestSelectionPlan,
  TestSelectionRequest,
} from "@agent-guard/contracts";
import { createId, nowIso } from "../../shared";
import {
  CandidateCaseLoadError,
  CandidateCaseRepository,
} from "./candidateCaseRepository";
import {
  applySelectionBudget,
  fillCoverageGaps,
  validateSelectionCoverage,
} from "./coverageValidator";
import { rerankCasesWithLlm } from "./llmAssistedCaseReranker";
import { selectCasesByRule } from "./ruleBasedCaseSelector";
import type { LlmClient } from "../llm/llmClient";
import {
  getSelectionPlan,
  listSelectionPlans,
  saveSelectionPlan,
} from "./selectionPlanStore";

const DEFAULT_REQUIRED_ATTACK_FAMILIES = [
  "prompt_injection",
  "data_leakage",
  "tool_hijack",
];

export class TestSelectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TestSelectionError";
  }
}

export type CreateSelectionPlanInput = Partial<TestSelectionRequest>;

export async function createSelectionPlan(
  input: CreateSelectionPlanInput,
  opts?: { llmClient?: LlmClient },
): Promise<TestSelectionPlan> {
  const request = normalizeSelectionRequest(input);
  const agent = buildSelectionAgent(request);
  const repository = new CandidateCaseRepository({
    configDir: path.resolve(process.cwd(), "configs"),
    agent,
  });
  let loaded;
  try {
    loaded = await repository.loadCandidateCases({
      targetProfile: request.targetProfile,
      manifestId: request.manifestId,
    });
  } catch (error) {
    if (error instanceof CandidateCaseLoadError) {
      throw new TestSelectionError("CANDIDATE_CASE_LOAD_FAILED", error.message);
    }
    throw error;
  }
  const { corpusManifestId, candidates: loadedCandidates } = loaded;
  const candidates =
    request.includeExternalTools === false
      ? loadedCandidates.filter((candidate) => !candidate.requiresExternalTool)
      : loadedCandidates;

  if (candidates.length === 0) {
    throw new TestSelectionError(
      "INSUFFICIENT_CASE_POOL",
      `No candidate cases available for profile ${request.targetProfile}.`,
    );
  }

  const ruleResult = selectCasesByRule(candidates, request);
  let selectedCaseIds = applySelectionBudget(
    candidates,
    ruleResult.selectedCaseIds,
    request,
  );
  let reasons = [...ruleResult.reasons];
  let llmAudit: TestSelectionPlan["llmAudit"];
  const fallbackReasons: string[] = [];

  if (request.selectionMode === "llm_assisted") {
    const llmResult = await rerankCasesWithLlm(
      candidates,
      selectedCaseIds,
      request,
      opts?.llmClient,
    );
    selectedCaseIds = applySelectionBudget(
      candidates,
      llmResult.selectedCaseIds,
      request,
    );
    if (llmResult.reasons.length > 0) {
      reasons = mergeReasons(ruleResult.reasons, llmResult.reasons);
    }
    llmAudit = llmResult.audit;
    if (llmResult.fallbackReason) fallbackReasons.push(llmResult.fallbackReason);
  }

  selectedCaseIds = fillCoverageGaps(candidates, selectedCaseIds, request);
  selectedCaseIds = applySelectionBudget(candidates, selectedCaseIds, request);
  let validation = validateSelectionCoverage(candidates, selectedCaseIds, request);

  if (request.selectionMode === "llm_assisted" && !validation.snapshot.ready) {
    fallbackReasons.push(
      "LLM-ranked selection failed deterministic coverage validation; rule-only selection restored.",
    );
    selectedCaseIds = fillCoverageGaps(
      candidates,
      ruleResult.selectedCaseIds,
      request,
    );
    selectedCaseIds = applySelectionBudget(candidates, selectedCaseIds, request);
    validation = validateSelectionCoverage(candidates, selectedCaseIds, request);
    reasons = [...ruleResult.reasons];
    if (llmAudit) {
      llmAudit = {
        ...llmAudit,
        fallbackUsed: true,
        validationWarnings: [
          ...llmAudit.validationWarnings,
          "LLM-ranked selection did not pass coverage validation.",
        ],
      };
    }
  }
  const selectedCasesSummary = buildSelectedCaseSummaries(
    candidates,
    validation.validCaseIds,
    reasons,
  );

  const now = nowIso();
  const plan: TestSelectionPlan = {
    schemaVersion: "mvp-1",
    selectionPlanId: createId("selection_plan"),
    agentId: agent.agentId,
    corpusManifestId,
    status: validation.snapshot.ready ? "ready" : "draft",
    mode: request.selectionMode,
    targetProfile: request.targetProfile,
    selectionProfile: {
      profileId: `selection_profile.${request.targetProfile}.${request.selectionMode}`,
      targetProfile: request.targetProfile,
      selectionMode: request.selectionMode,
      adapterKind: request.adapterKind,
      maxCaseCount: request.maxCaseCount ?? 7,
      timeBudgetMs: request.timeBudgetMs,
    },
    coverageRequirements: {
      minCaseCount: request.minCaseCount ?? 3,
      minAttackFamilyCount: 3,
      requiredAttackFamilies: request.requiredAttackFamilies ?? [],
      requiredTargetSurfaces: request.requiredTargetSurfaces ?? [],
    },
    requestedCaseCount: request.maxCaseCount ?? 7,
    selectedCaseIds: validation.validCaseIds,
    selectedCasesSummary,
    coverageSnapshot: validation.snapshot,
    selectionRunSummary: {
      candidateCaseCount: candidates.length,
      selectedCaseCount: validation.validCaseIds.length,
      ruleSelectedCount: ruleResult.selectedCaseIds.length,
      llmAcceptedCount: llmAudit?.acceptedCaseIds.length ?? 0,
      llmRejectedCount: llmAudit?.rejectedCaseIds.length ?? 0,
      fallbackUsed: Boolean(llmAudit?.fallbackUsed || fallbackReasons.length),
      ready: validation.snapshot.ready,
    },
    evalStyleResult: buildEvalStyleResult(validation.snapshot),
    selectionReasons: mergeReasons(reasons, buildValidatorReasons(validation.snapshot.warnings)),
    llmAudit,
    fallbackReasons,
    createdAt: now,
    updatedAt: now,
  };

  await saveSelectionPlan(plan);
  return plan;
}

export async function getRequiredSelectionPlan(
  selectionPlanId: string,
): Promise<TestSelectionPlan> {
  const plan = await getSelectionPlan(selectionPlanId);
  if (!plan) {
    throw new TestSelectionError(
      "TEST_SELECTION_PLAN_NOT_FOUND",
      `Selection plan ${selectionPlanId} not found.`,
    );
  }
  return plan;
}

export { getSelectionPlan, listSelectionPlans };

function normalizeSelectionRequest(
  input: CreateSelectionPlanInput,
): TestSelectionRequest {
  const targetProfile = input.targetProfile ?? "openclaw";
  const selectionMode = input.selectionMode ?? "rule_only";
  if (!["smoke", "openclaw", "regression", "full-corpus"].includes(targetProfile)) {
    throw new TestSelectionError(
      "INVALID_SELECTION_REQUEST",
      `targetProfile must be smoke, openclaw, regression, or full-corpus.`,
    );
  }
  if (!["rule_only", "llm_assisted"].includes(selectionMode)) {
    throw new TestSelectionError(
      "INVALID_SELECTION_REQUEST",
      `selectionMode must be rule_only or llm_assisted.`,
    );
  }

  return {
    schemaVersion: "mvp-1",
    agentId: input.agentId,
    manifestId: input.manifestId,
    targetProfile,
    selectionMode,
    maxCaseCount: normalizePositiveInteger(input.maxCaseCount, 7),
    minCaseCount: normalizePositiveInteger(input.minCaseCount, 3),
    timeBudgetMs: normalizeOptionalPositiveInteger(input.timeBudgetMs),
    requiredAttackFamilies:
      input.requiredAttackFamilies?.length
        ? unique(input.requiredAttackFamilies)
        : DEFAULT_REQUIRED_ATTACK_FAMILIES,
    requiredTargetSurfaces: input.requiredTargetSurfaces
      ? unique(input.requiredTargetSurfaces)
      : [],
    includeExternalTools: input.includeExternalTools,
    adapterKind: input.adapterKind ?? "mock",
  };
}

function buildSelectionAgent(request: TestSelectionRequest): AgentUnderTest {
  return {
    schemaVersion: "mvp-1",
    agentId: request.agentId ?? "agent.selection.default",
    name: "Selection Planning Agent",
    adapterType: "mock",
  };
}

function buildSelectedCaseSummaries(
  candidates: CandidateCaseCard[],
  selectedCaseIds: string[],
  reasons: SelectionReason[],
): SelectedCaseSummary[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));
  const reasonById = new Map(reasons.map((reason) => [reason.caseId, reason.reason]));
  return selectedCaseIds
    .map((caseId) => {
      const candidate = candidateById.get(caseId);
      if (!candidate) return undefined;
      return {
        caseId,
        caseName: candidate.caseName,
        attackFamilies: candidate.attackFamilies,
        targetSurfaces: candidate.targetSurfaces,
        qualityScore: candidate.qualityScore,
        reason: reasonById.get(caseId) ?? "Selected by deterministic coverage planning.",
      } satisfies SelectedCaseSummary;
    })
    .filter((item): item is SelectedCaseSummary => Boolean(item));
}

function buildValidatorReasons(warnings: string[]): SelectionReason[] {
  return warnings.map((warning, index) => ({
    caseId: `coverage.warning.${index + 1}`,
    source: "validator",
    reason: warning,
  }));
}

function buildEvalStyleResult(snapshot: CoverageSnapshot): SelectionEvalStyleResult {
  const passedChecks: string[] = [];
  if (snapshot.selectedCaseCount > 0) {
    passedChecks.push(`selected_case_count=${snapshot.selectedCaseCount}`);
  }
  if (snapshot.attackFamilyCount >= 3) {
    passedChecks.push(`attack_family_coverage=${snapshot.attackFamilyCount}`);
  }
  if (snapshot.targetSurfaceCount >= 2) {
    passedChecks.push(`target_surface_coverage=${snapshot.targetSurfaceCount}`);
  }
  if (snapshot.missingRequiredAttackFamilies.length === 0) {
    passedChecks.push("required_attack_families_covered");
  }
  if (snapshot.missingRequiredTargetSurfaces.length === 0) {
    passedChecks.push("required_target_surfaces_covered");
  }

  return {
    status: snapshot.ready ? "ready" : "needs_review",
    passedChecks,
    failedChecks: [...snapshot.blockingIssues],
    warnings: [...snapshot.warnings],
  };
}

function mergeReasons(
  base: SelectionReason[],
  next: SelectionReason[],
): SelectionReason[] {
  const merged = new Map<string, SelectionReason>();
  for (const reason of base) merged.set(`${reason.source}:${reason.caseId}`, reason);
  for (const reason of next) merged.set(`${reason.source}:${reason.caseId}`, reason);
  return [...merged.values()];
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
