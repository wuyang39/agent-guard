import type {
  CandidateCaseCard,
  SelectionReason,
  TestSelectionRequest,
} from "@agent-guard/contracts";

export type RuleSelectionResult = {
  selectedCaseIds: string[];
  reasons: SelectionReason[];
};

export function selectCasesByRule(
  candidates: CandidateCaseCard[],
  request: TestSelectionRequest,
): RuleSelectionResult {
  const maxCaseCount = normalizeMaxCaseCount(request.maxCaseCount);
  const selected = new Map<string, SelectionReason>();
  const usable = candidates.filter((candidate) => candidate.enabled);
  const timeBudgetMs = normalizeTimeBudget(request.timeBudgetMs);
  let selectedDurationMs = 0;

  for (const family of request.requiredAttackFamilies ?? []) {
    const candidate = bestCandidate(
      usable.filter(
        (item) =>
          item.attackFamilies.includes(family) &&
          fitsTimeBudget(item, selectedDurationMs, timeBudgetMs),
      ),
      selected,
    );
    if (candidate && selected.size < maxCaseCount) {
      selected.set(candidate.caseId, {
        caseId: candidate.caseId,
        reason: `Selected to cover required attack family: ${family}.`,
        source: "rule",
      });
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  for (const surface of request.requiredTargetSurfaces ?? []) {
    const candidate = bestCandidate(
      usable.filter(
        (item) =>
          item.targetSurfaces.includes(surface) &&
          fitsTimeBudget(item, selectedDurationMs, timeBudgetMs),
      ),
      selected,
    );
    if (candidate && selected.size < maxCaseCount) {
      selected.set(candidate.caseId, {
        caseId: candidate.caseId,
        reason: `Selected to cover required target surface: ${surface}.`,
        source: "rule",
      });
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  for (const candidate of rankCandidates(usable)) {
    if (selected.size >= maxCaseCount) break;
    if (
      !selected.has(candidate.caseId) &&
      fitsTimeBudget(candidate, selectedDurationMs, timeBudgetMs)
    ) {
      selected.set(candidate.caseId, {
        caseId: candidate.caseId,
        reason: "Selected by rule ranking for coverage diversity and quality.",
        source: "rule",
      });
      selectedDurationMs += estimatedDuration(candidate);
    }
  }

  const selectedCaseIds = [...selected.keys()].slice(0, maxCaseCount);
  return {
    selectedCaseIds,
    reasons: selectedCaseIds.map((caseId) => selected.get(caseId)).filter(isReason),
  };
}

export function rankCandidates(
  candidates: CandidateCaseCard[],
): CandidateCaseCard[] {
  const familyFrequency = frequency(candidates.flatMap((item) => item.attackFamilies));
  const surfaceFrequency = frequency(candidates.flatMap((item) => item.targetSurfaces));

  return [...candidates].sort((a, b) => {
    const scoreDelta = candidateScore(b, familyFrequency, surfaceFrequency) -
      candidateScore(a, familyFrequency, surfaceFrequency);
    if (scoreDelta !== 0) return scoreDelta;
    return a.caseId.localeCompare(b.caseId);
  });
}

function bestCandidate(
  candidates: CandidateCaseCard[],
  selected: ReadonlyMap<string, SelectionReason>,
): CandidateCaseCard | undefined {
  return rankCandidates(candidates.filter((item) => !selected.has(item.caseId)))[0];
}

function candidateScore(
  candidate: CandidateCaseCard,
  familyFrequency: ReadonlyMap<string, number>,
  surfaceFrequency: ReadonlyMap<string, number>,
): number {
  const scarcityScore = [
    ...candidate.attackFamilies.map((family) => 1 / (familyFrequency.get(family) ?? 1)),
    ...candidate.targetSurfaces.map((surface) => 1 / (surfaceFrequency.get(surface) ?? 1)),
  ].reduce((sum, value) => sum + value, 0);

  const externalBonus = candidate.requiresExternalTool ? 0.05 : 0;
  const openClawBonus = candidate.requiresOpenClaw ? 0.05 : 0;
  return candidate.qualityScore + scarcityScore + externalBonus + openClawBonus;
}

function frequency(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
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

function isReason(value: SelectionReason | undefined): value is SelectionReason {
  return Boolean(value);
}
