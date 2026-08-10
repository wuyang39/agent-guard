import type { NativeGuardEvent } from "@agent-guard/contracts";
import type { NativeGuardEventStore } from "../../storage/nativeGuardEventStore";
import { emitNativeToolHookEvent } from "./realtimeMcpServer";

const PROJECTED_EVENT_TYPES = new Set<NativeGuardEvent["type"]>([
  "decision",
  "approval_requested",
  "approval_resolved",
  "tool_outcome",
]);

export function createNativeGuardRealtimeBridge(options: {
  eventStore: Pick<NativeGuardEventStore, "subscribe">;
  emit: typeof emitNativeToolHookEvent;
}): { close(): void } {
  const unsubscribe = options.eventStore.subscribe((event) => {
    if (!PROJECTED_EVENT_TYPES.has(event.type)) return;

    try {
      const toolName = stringValue(event.detail.toolName);
      const action = stringValue(event.detail.action);
      options.emit({
        runtimeSessionId: event.sessionKey,
        toolCallId: event.toolCallId,
        ...(toolName ? { toolName } : {}),
        ...(action ? { action } : {}),
        detail: compactDetail({
          leaseId: event.leaseId,
          leaseEpoch: event.leaseEpoch,
          phase: event.type,
          decisionId: stringValue(event.decisionId),
          reasonCode: stringValue(event.detail.reasonCode),
          outcome: stringValue(event.detail.outcome),
          source: "native_guard",
        }),
      });
    } catch {
      // Realtime delivery is best effort after the event is already durable.
    }
  });

  return { close: unsubscribe };
}

function compactDetail(
  detail: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const projected: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value !== undefined) projected[key] = value;
  }
  return projected;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
