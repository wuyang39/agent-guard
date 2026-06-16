import type { LiveSupervisionEvent } from "../api/types";

export function shouldDisplayRealtimeEvent(
  event: LiveSupervisionEvent,
  runtimeSessionId: string | undefined,
  includeHistory: boolean,
): boolean {
  if (includeHistory) return true;
  if (!event.runtimeSessionId || !runtimeSessionId) return true;
  return event.runtimeSessionId === runtimeSessionId;
}
