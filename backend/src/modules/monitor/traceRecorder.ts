import type { InteractionTrace, TraceEvent } from "./traceTypes";

export class TraceRecorder {
  private readonly events: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.events.push(event);
  }

  toTrace(trace: Omit<InteractionTrace, "events">): InteractionTrace {
    return {
      ...trace,
      events: [...this.events].sort((left, right) => left.sequence - right.sequence),
    };
  }
}
