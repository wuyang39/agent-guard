import type { TraceEvent, TraceEventPayload } from "@agent-guard/contracts";

export type ToolPair = {
  call: TraceEvent;
  result?: TraceEvent;
};

export function pairToolEvents(events: TraceEvent[]): ToolPair[] {
  const resultsByCallId = new Map<string, TraceEvent>();
  for (const event of events) {
    if (event.type === "tool_result") {
      const callId = getPayloadString(event.payload, "callId");
      if (callId) {
        resultsByCallId.set(callId, event);
      }
    }
  }

  return events
    .filter((event) => event.type === "tool_call")
    .map((call) => ({
      call,
      result: resultsByCallId.get(getPayloadString(call.payload, "callId") ?? ""),
    }));
}

export function compactPayload(payload: TraceEventPayload): string {
  return JSON.stringify(payload, null, 2);
}

function getPayloadString(payload: TraceEventPayload, key: string): string | undefined {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
