import type { TestContext } from "../config/schemas";
import type { InteractionTrace, TraceEvent } from "../monitor/traceTypes";
import { createId } from "../../shared/ids";
import type { AttackChain, Finding } from "./riskTypes";

export function buildAttackChains(
  context: TestContext,
  trace: InteractionTrace,
  findings: Finding[],
): AttackChain[] {
  return findings.map((finding) => {
    const chainEvents = selectAttackChainEvents(context, trace, finding);
    const steps = chainEvents.map((event, index) => ({
      stepId: createId("step"),
      sequence: index + 1,
      eventId: event.eventId,
      title: formatEventTitle(event),
      description: describeEvent(event),
    }));

    return {
      chainId: createId("attack_chain"),
      findingId: finding.findingId,
      entryType: context.testCase.attackEntryType,
      steps,
      summary: buildAttackSummary(context, finding, chainEvents),
    };
  });
}

function selectAttackChainEvents(
  context: TestContext,
  trace: InteractionTrace,
  finding: Finding,
): TraceEvent[] {
  const evidenceEvents = trace.events.filter((event) =>
    finding.evidenceEventIds.includes(event.eventId),
  );
  const lastEvidenceSequence = Math.max(
    ...evidenceEvents.map((event) => event.sequence),
    0,
  );

  const selected = trace.events.filter((event) => {
    if (finding.evidenceEventIds.includes(event.eventId)) {
      return true;
    }

    if (lastEvidenceSequence > 0 && event.sequence > lastEvidenceSequence) {
      return false;
    }

    return isUsefulAttackStep(context, event);
  });

  return selected
    .filter((event, index, events) =>
      events.findIndex((candidate) => candidate.eventId === event.eventId) === index,
    )
    .sort((left, right) => left.sequence - right.sequence);
}

function isUsefulAttackStep(context: TestContext, event: TraceEvent): boolean {
  if (event.type === "task_sent") {
    return true;
  }

  if (event.type === "prompt_load" && "riskTagIds" in event.payload) {
    const attackEntryType =
      "attackEntryType" in event.payload ? event.payload.attackEntryType : undefined;
    return event.payload.riskTagIds.length > 0 || attackEntryType === context.testCase.attackEntryType;
  }

  if (
    event.type === "resource_access" &&
    "containsInjection" in event.payload &&
    "authorized" in event.payload &&
    "sensitivity" in event.payload
  ) {
    return event.payload.containsInjection || !event.payload.authorized || event.payload.sensitivity === "secret";
  }

  if (
    event.type === "tool_result" &&
    "containsInjection" in event.payload &&
    "riskTagIds" in event.payload
  ) {
    return event.payload.containsInjection || event.payload.riskTagIds.length > 0;
  }

  if (event.type === "tool_call" && "isHighRiskTool" in event.payload) {
    return event.payload.isHighRiskTool;
  }

  if (event.type === "system_error") {
    return true;
  }

  return false;
}

function buildAttackSummary(
  context: TestContext,
  finding: Finding,
  events: TraceEvent[],
): string {
  const firstSequence = events[0]?.sequence;
  const lastSequence = events[events.length - 1]?.sequence;
  const range =
    firstSequence === undefined || lastSequence === undefined
      ? "no trace steps"
      : `trace steps #${firstSequence}-#${lastSequence}`;

  return `${context.testCase.attackEntryType} produced finding "${finding.title}" through ${range}.`;
}

function formatEventTitle(event: TraceEvent): string {
  switch (event.type) {
    case "task_sent":
      return "Task sent to Agent";
    case "prompt_load":
      return "Prompt loaded";
    case "resource_access":
      return "Resource accessed";
    case "tool_call":
      return "Tool called";
    case "tool_result":
      return "Tool result returned";
    case "agent_message":
      return "Agent message";
    case "system_error":
      return "System error";
    case "test_started":
      return "Test started";
  }
}

function describeEvent(event: TraceEvent): string {
  if (event.type === "task_sent" && "instruction" in event.payload) {
    return `Task ${event.payload.taskId}: ${event.payload.instruction}`;
  }

  if (event.type === "prompt_load" && "promptId" in event.payload) {
    return `Loaded prompt ${event.payload.promptId}.`;
  }

  if (event.type === "resource_access" && "resourceId" in event.payload) {
    const status = event.payload.authorized ? "authorized" : "unauthorized";
    const injection = event.payload.containsInjection ? " with injection content" : "";
    return `Accessed ${event.payload.resourceId} (${status}, ${event.payload.sensitivity})${injection}.`;
  }

  if (event.type === "tool_call" && "toolId" in event.payload && "parameters" in event.payload) {
    return `Called ${event.payload.toolId} with parameters ${JSON.stringify(event.payload.parameters)}.`;
  }

  if (event.type === "tool_result" && "toolId" in event.payload && "containsInjection" in event.payload) {
    const injection = event.payload.containsInjection ? " containing injection" : "";
    return `Tool ${event.payload.toolId} returned result${injection}.`;
  }

  if (event.type === "agent_message" && "message" in event.payload) {
    return event.payload.message;
  }

  if (event.type === "system_error" && "message" in event.payload && "code" in event.payload) {
    return `${event.payload.code}: ${event.payload.message}`;
  }

  return `Observed ${event.type}.`;
}
