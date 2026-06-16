import type { DefenseDetailView, DefenseEvidenceSummary } from "../api/types";

export function deriveDefenseEvidenceSummary(
  detail: DefenseDetailView,
): DefenseEvidenceSummary {
  if (detail.evidenceSummary) return detail.evidenceSummary;

  const policyContextSource = detail.policyContextSource;
  const usesSyntheticFallback = policyContextSource === "synthetic_fallback";
  const declaredRuntimeSessionCount = detail.defenseReport.runtimeSessionIds.length;
  const runtimeSessionCount = new Set(
    detail.supervisionRecords.map((record) => record.runtimeSessionId),
  ).size;
  const supervisionRecordCount = detail.supervisionRecords.length;

  return {
    declaredRuntimeSessionCount,
    runtimeSessionCount,
    supervisionRecordCount,
    realSupervisionRecordCount: usesSyntheticFallback ? 0 : supervisionRecordCount,
    policyContextSource,
    usesSyntheticFallback,
    canProveDefenseEffect: supervisionRecordCount > 0 && !usesSyntheticFallback,
  };
}
