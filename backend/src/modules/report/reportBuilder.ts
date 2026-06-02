import type { TestContext } from "../config/schemas";
import type { InteractionTrace, TraceEvent } from "../monitor/traceTypes";
import type { RiskEvaluationResult } from "../risk/riskTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { HighRiskIssue, ReportSummary, RiskReport, ToolCallTraceStep } from "./reportTypes";

const emptyCounts = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

const emptyCategoryCounts = {
  tool_misuse: 0,
  unauthorized_access: 0,
  data_leakage: 0,
  dangerous_action: 0,
  instruction_injection_following: 0,
};

export function buildRiskReport(
  context: TestContext,
  evaluation: RiskEvaluationResult,
  trace?: InteractionTrace,
): RiskReport {
  const summary: ReportSummary = {
    totalFindings: evaluation.findings.length,
    countsByRiskLevel: { ...emptyCounts },
    countsByCategory: { ...emptyCategoryCounts },
  };

  for (const finding of evaluation.findings) {
    summary.countsByRiskLevel[finding.riskLevel] += 1;
    summary.countsByCategory[finding.category] += 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    reportId: createId("report"),
    evaluationId: evaluation.evaluationId,
    contextId: context.contextId,
    caseId: context.caseId,
    traceId: evaluation.traceId,
    riskLevel: evaluation.riskLevel,
    summary,
    caseReport: {
      caseId: context.caseId,
      caseName: context.caseName,
      attackEntryType: context.testCase.attackEntryType,
      riskLevel: evaluation.riskLevel,
      findingIds: evaluation.findings.map((finding) => finding.findingId),
    },
    findings: evaluation.findings,
    evidenceChains: evaluation.evidenceChains,
    attackChains: evaluation.attackChains,
    highRiskIssues: buildHighRiskIssues(evaluation, trace),
    toolCallTrace: buildToolCallTrace(evaluation.traceId, trace),
    attackChainViews: evaluation.attackChains.map((chain) => ({
      chainId: chain.chainId,
      findingId: chain.findingId,
      entryType: chain.entryType,
      summary: chain.summary,
      eventIds: chain.steps.map((step) => step.eventId),
    })),
    generatedAt: nowIso(),
  };
}

function buildHighRiskIssues(
  evaluation: RiskEvaluationResult,
  trace?: InteractionTrace,
): HighRiskIssue[] {
  return evaluation.findings
    .filter((finding) => finding.riskLevel === "high" || finding.riskLevel === "critical")
    .map((finding) => {
      const evidenceEvent = findEvidenceEvent(trace, finding.evidenceEventIds);

      return {
        issueId: createId("issue"),
        findingId: finding.findingId,
        title: finding.title,
        category: finding.category,
        riskLevel: finding.riskLevel,
        triggeredToolId: getTriggeredToolId(evidenceEvent),
        triggeredResourceId: getTriggeredResourceId(evidenceEvent),
        triggeredRuleId: finding.ruleId,
      };
    });
}

function buildToolCallTrace(
  traceId: string,
  trace?: InteractionTrace,
): RiskReport["toolCallTrace"] {
  return {
    traceId,
    steps: trace ? trace.events.map(toTraceStep) : [],
  };
}

function toTraceStep(event: TraceEvent): ToolCallTraceStep {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    type: event.type,
    title: formatTraceStepTitle(event),
    detail: JSON.stringify(event.payload),
  };
}

function findEvidenceEvent(
  trace: InteractionTrace | undefined,
  evidenceEventIds: string[],
): TraceEvent | undefined {
  if (!trace) {
    return undefined;
  }
  return trace.events.find((event) => evidenceEventIds.includes(event.eventId));
}

function getTriggeredToolId(event: TraceEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }

  if ((event.type === "tool_call" || event.type === "tool_result") && "toolId" in event.payload) {
    return event.payload.toolId;
  }

  return undefined;
}

function getTriggeredResourceId(event: TraceEvent | undefined): string | undefined {
  if (!event) {
    return undefined;
  }

  if (event.type === "resource_access" && "resourceId" in event.payload) {
    return event.payload.resourceId;
  }

  return undefined;
}

function formatTraceStepTitle(event: TraceEvent): string {
  if (event.type === "tool_call" && "toolName" in event.payload) {
    return `${event.type}: ${event.payload.toolName}`;
  }

  if ((event.type === "tool_result" || event.type === "tool_call") && "toolId" in event.payload) {
    return `${event.type}: ${event.payload.toolId}`;
  }

  if (event.type === "resource_access" && "resourceId" in event.payload) {
    return `${event.type}: ${event.payload.resourceId}`;
  }

  if (event.type === "prompt_load" && "promptId" in event.payload) {
    return `${event.type}: ${event.payload.promptId}`;
  }

  return event.type;
}
