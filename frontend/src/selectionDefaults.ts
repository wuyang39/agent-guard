export const DEFAULT_SELECTION_CASE_COUNT = 5;
export const MIN_SELECTION_CASE_COUNT = 3;
export const MAX_SELECTION_CASE_COUNT = 120;
export const SELECTION_CASE_COUNT_PRESETS = [5, 10, 30, 120] as const;

export function normalizeSelectionCaseCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_SELECTION_CASE_COUNT;
  return Math.max(
    MIN_SELECTION_CASE_COUNT,
    Math.min(MAX_SELECTION_CASE_COUNT, Math.floor(value)),
  );
}
