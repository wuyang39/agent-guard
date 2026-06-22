import type {
  CandidateCaseCard,
  CoverageSnapshot,
  TestSelectionRequest,
} from "@agent-guard/contracts";

export type CoverageValidationResult = {
  snapshot: CoverageSnapshot;
  validCaseIds: string[];
};

export function validateSelectionCoverage(
  candidates: CandidateCaseCard[],
  selectedCaseIds: string[],
  request: TestSelectionRequest,
): CoverageValidationResult {
  const candidateById = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const validCaseIds: string[] = [];

  for (const caseId of selectedCaseIds) {
    if (seen.has(caseId)) {
      blockingIssues.push(`Duplicate caseId selected: ${caseId}`);
      continue;
    }
    seen.add(caseId);

    const candidate = candidateById.get(caseId);
    if (!candidate) {
      blockingIssues.push(`Unknown caseId selected: ${caseId}`);
      continue;
    }
    if (!candidate.enabled) {
      blockingIssues.push(`Disabled caseId selected: ${caseId}`);
      continue;
    }
    validCaseIds.push(caseId);
  }

  const selectedCandidates = validCaseIds
    .map((caseId) => candidateById.get(caseId))
    .filter(isCandidate);
  const coveredAttackFamilies = unique(
    selectedCandidates.flatMap((candidate) => candidate.attackFamilies),
  );
  const coveredTargetSurfaces = unique(
    selectedCandidates.flatMap((candidate) => candidate.targetSurfaces),
  );

  const minCaseCount = normalizeMinCaseCount(request.minCaseCount);
  if (validCaseIds.length < minCaseCount) {
    blockingIssues.push(
      `Selected case count ${validCaseIds.length} is below required minimum ${minCaseCount}.`,
    );
  }

  const timeBudgetMs = normalizeTimeBudget(request.timeBudgetMs);
  const selectedDurationMs = selectedCandidates.reduce(
    (sum, candidate) => sum + estimatedDuration(candidate),
    0,
  );
  if (timeBudgetMs !== undefined && selectedDurationMs > timeBudgetMs) {
    blockingIssues.push(
      `Estimated duration ${selectedDurationMs}ms exceeds time budget ${timeBudgetMs}ms.`,
    );
  }

  const minAttackFamilyCount = 3;
  if (coveredAttackFamilies.length < minAttackFamilyCount) {
    blockingIssues.push(
      `Selected attack family count ${coveredAttackFamilies.length} is below required minimum ${minAttackFamilyCount}.`,
    );
  }

  const missingRequiredAttackFamilies = (request.requiredAttackFamilies ?? [])
    .filter((family) => !coveredAttackFamilies.includes(family));
  const missingRequiredTargetSurfaces = (request.requiredTargetSurfaces ?? [])
    .filter((surface) => !coveredTargetSurfaces.includes(surface));

  for (const family of missingRequiredAttackFamilies) {
    blockingIssues.push(`Missing required attack family: ${family}`);
  }
  for (const surface of missingRequiredTargetSurfaces) {
    blockingIssues.push(`Missing required target surface: ${surface}`);
  }

  if (coveredTargetSurfaces.length < 2) {
    warnings.push("Selected cases cover fewer than 2 target surfaces.");
  }

  return {
    validCaseIds,
    snapshot: {
      attackFamilyCount: coveredAttackFamilies.length,
      targetSurfaceCount: coveredTargetSurfaces.length,
      selectedCaseCount: validCaseIds.length,
      coveredAttackFamilies,
      coveredTargetSurfaces,
      missingRequiredAttackFamilies,
      missingRequiredTargetSurfaces,
      blockingIssues,
      warnings,
      ready: blockingIssues.length === 0,
    },
  };
}

export function fillCoverageGaps(
  candidates: CandidateCaseCard[],
  selectedCaseIds: string[],
  request: TestSelectionRequest,
): string[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));
  const selected = new Set(
    applySelectionBudget(candidates, selectedCaseIds, request),
  );
  const maxCaseCount = normalizeMaxCaseCount(request.maxCaseCount);
  const timeBudgetMs = normalizeTimeBudget(request.timeBudgetMs);
  let selectedDurationMs = [...selected]
    .map((caseId) => candidateById.get(caseId))
    .filter(isCandidate)
    .reduce((sum, candidate) => sum + estimatedDuration(candidate), 0);

  for (const family of request.requiredAttackFamilies ?? []) {
    if (selectedHasFamily(candidates, selected, family)) continue;
    const candidate = firstCandidate(candidates, selected, (item) =>
      item.attackFamilies.includes(family) &&
      fitsTimeBudget(item, selectedDurationMs, timeBudgetMs),
    );
    if (candidate && selected.size < maxCaseCount) {
      selected.add(candidate.caseId);
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  for (const surface of request.requiredTargetSurfaces ?? []) {
    if (selectedHasSurface(candidates, selected, surface)) continue;
    const candidate = firstCandidate(candidates, selected, (item) =>
      item.targetSurfaces.includes(surface) &&
      fitsTimeBudget(item, selectedDurationMs, timeBudgetMs),
    );
    if (candidate && selected.size < maxCaseCount) {
      selected.add(candidate.caseId);
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  for (const candidate of candidates) {
    if (selected.size >= maxCaseCount) break;
    if (
      !selected.has(candidate.caseId) &&
      fitsTimeBudget(candidate, selectedDurationMs, timeBudgetMs)
    ) {
      selected.add(candidate.caseId);
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  return [...selected];
}

export function applySelectionBudget(
  candidates: CandidateCaseCard[],
  selectedCaseIds: string[],
  request: TestSelectionRequest,
): string[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.caseId, candidate]));
  const maxCaseCount = normalizeMaxCaseCount(request.maxCaseCount);
  const timeBudgetMs = normalizeTimeBudget(request.timeBudgetMs);
  const accepted: string[] = [];
  let durationMs = 0;

  for (const caseId of [...new Set(selectedCaseIds)]) {
    if (accepted.length >= maxCaseCount) break;
    const candidate = candidateById.get(caseId);
    if (!candidate || !candidate.enabled) continue;
    if (!fitsTimeBudget(candidate, durationMs, timeBudgetMs)) continue;
    accepted.push(caseId);
    durationMs += estimatedDuration(candidate);
  }

  return accepted;
}

function firstCandidate(
  candidates: CandidateCaseCard[],
  selected: ReadonlySet<string>,
  predicate: (candidate: CandidateCaseCard) => boolean,
): CandidateCaseCard | undefined {
  return candidates
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => !selected.has(candidate.caseId))
    .filter(predicate)
    .sort((a, b) => b.qualityScore - a.qualityScore || a.caseId.localeCompare(b.caseId))[0];
}

function selectedHasFamily(
  candidates: CandidateCaseCard[],
  selected: ReadonlySet<string>,
  family: string,
): boolean {
  return candidates.some(
    (candidate) => selected.has(candidate.caseId) && candidate.attackFamilies.includes(family),
  );
}

function selectedHasSurface(
  candidates: CandidateCaseCard[],
  selected: ReadonlySet<string>,
  surface: string,
): boolean {
  return candidates.some(
    (candidate) => selected.has(candidate.caseId) && candidate.targetSurfaces.includes(surface),
  );
}

function normalizeMinCaseCount(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 3;
  return Math.max(1, Math.floor(value));
}

function normalizeMaxCaseCount(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return 7;
  return Math.max(1, Math.floor(value));
}

function normalizeTimeBudget(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || !value || value <= 0) return undefined;
  return Math.floor(value);
}

function fitsTimeBudget(
  candidate: CandidateCaseCard,
  selectedDurationMs: number,
  timeBudgetMs: number | undefined,
): boolean {
  return timeBudgetMs === undefined ||
    selectedDurationMs + estimatedDuration(candidate) <= timeBudgetMs;
}

function estimatedDuration(candidate: CandidateCaseCard): number {
  return candidate.estimatedDurationMs && candidate.estimatedDurationMs > 0
    ? candidate.estimatedDurationMs
    : 10_000;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isCandidate(value: CandidateCaseCard | undefined): value is CandidateCaseCard {
  return Boolean(value);
}
