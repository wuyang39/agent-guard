import type { EvidenceChain, Finding } from "./riskTypes";

export function buildEvidenceChains(findings: Finding[]): EvidenceChain[] {
  return findings.map((finding) => ({
    chainId: `chain.${finding.findingId}`,
    findingId: finding.findingId,
    eventIds: finding.evidenceEventIds,
    summary: finding.description,
  }));
}
