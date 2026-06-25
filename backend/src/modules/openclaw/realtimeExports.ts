export function emitRealtimeEvent(event: Omit<RealtimeEvent, "eventId"> & { eventId?: string }): void {
  const fullEvent: RealtimeEvent = {
    ...event,
    eventId: event.eventId ?? createId("evt"),
  } as RealtimeEvent;
  realtimeEvents.emit("event", fullEvent);
  eventHistory.push(fullEvent);
  if (eventHistory.length > MAX_EVENT_HISTORY) {
    eventHistory.splice(0, eventHistory.length - MAX_EVENT_HISTORY);
  }
}

export function getActivePolicyPack(): SupervisionPolicyPack | undefined {
  // 查找当前活跃 session 的策略包
  for (const session of sessions.values()) {
    return session.policyPack;
  }
  return undefined;
}
