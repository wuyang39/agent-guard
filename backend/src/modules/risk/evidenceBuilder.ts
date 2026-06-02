import type { InteractionTrace } from "../monitor/traceTypes";
import type { EvidenceChain, Finding } from "./riskTypes";

export function buildEvidenceChains(
  findings: Finding[],
  trace?: InteractionTrace,
): EvidenceChain[] {
  return findings.map((finding) => ({
    chainId: `chain.${finding.findingId}`,
    findingId: finding.findingId,
    eventIds: finding.evidenceEventIds,
    summary: buildEvidenceSummary(finding, trace),
  }));
}

function buildEvidenceSummary(finding: Finding, trace?: InteractionTrace): string {
  if (!trace) {
    return `${finding.title}: ${finding.description}`;
  }

  const evidenceEvents = trace.events.filter((event) =>
    finding.evidenceEventIds.includes(event.eventId),
  );

  if (evidenceEvents.length === 0) {
    return `${finding.title}: evidence event was not found in trace ${trace.traceId}.`;
  }

  const eventRefs = evidenceEvents
    .map((event) => `#${event.sequence} ${event.type}`)
    .join(", ");

  return `${finding.title}: ${finding.description} Evidence: ${eventRefs}.`;
}
