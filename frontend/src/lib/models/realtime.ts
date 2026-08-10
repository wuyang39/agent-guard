import type { LiveSupervisionEvent } from "../api/types";

const OPENCLAW_SESSION_KEY_PATTERN =
  /^agent:([A-Za-z0-9._-]{1,64}):([A-Za-z0-9._:-]{1,180})$/;

export function isCanonicalMainAgentSessionKey(
  runtimeSessionId: string | undefined,
): runtimeSessionId is string {
  if (!runtimeSessionId) return false;
  const match = OPENCLAW_SESSION_KEY_PATTERN.exec(runtimeSessionId);
  return match?.[0] === runtimeSessionId && match[1] === "main";
}

export function collectObservedMainSessionKeys(
  events: LiveSupervisionEvent[],
): string[] {
  const observed = new Set<string>();
  for (const event of events) {
    if (
      event.type === "native_tool_hook" &&
      isCanonicalMainAgentSessionKey(event.runtimeSessionId)
    ) {
      observed.add(event.runtimeSessionId);
    }
  }
  return [...observed];
}

export function shouldDisplayRealtimeEvent(
  event: LiveSupervisionEvent,
  runtimeSessionId: string | undefined,
  includeHistory: boolean,
  selectedMainSessionId?: string,
): boolean {
  if (event.type === "native_tool_hook") {
    if (!isCanonicalMainAgentSessionKey(event.runtimeSessionId)) return false;
    if (selectedMainSessionId) {
      return event.runtimeSessionId === selectedMainSessionId;
    }
    return true;
  }
  if (includeHistory) return true;
  if (!event.runtimeSessionId || !runtimeSessionId) return true;
  return event.runtimeSessionId === runtimeSessionId;
}
