import { createId, nowIso } from "../../shared";
import type {
  InteractionTrace,
  TraceActor,
  TraceEvent,
  TraceEventPayload,
  TraceEventType,
} from "./traceTypes";

export type TraceRecorderMeta = {
  traceId: string;
  runId: string;
  contextId: string;
  caseId: string;
};

export class TraceRecorder {
  private readonly meta: TraceRecorderMeta;
  private readonly events: TraceEvent[] = [];
  private nextSequence = 1;

  constructor(meta: TraceRecorderMeta) {
    this.meta = meta;
  }

  record(
    type: TraceEventType,
    actor: TraceActor,
    payload: TraceEventPayload,
  ): TraceEvent {
    const event: TraceEvent = {
      eventId: createId("evt"),
      traceId: this.meta.traceId,
      runId: this.meta.runId,
      caseId: this.meta.caseId,
      timestamp: nowIso(),
      sequence: this.nextSequence++,
      type,
      actor,
      payload,
    };
    this.events.push(event);
    return event;
  }

  toTrace(overrides: Omit<InteractionTrace, "events">): InteractionTrace {
    return {
      ...overrides,
      events: [...this.events].sort((a, b) => a.sequence - b.sequence),
    };
  }
}
