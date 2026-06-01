import type {
  InteractionTrace,
  TraceActor,
  TraceEventPayload,
  TraceEventType,
} from "./traceTypes";
import type { AgentMcpBridge } from "../agent/agentMcpBridge";
import type { McpSandboxRuntime } from "../sandbox/mcpSandbox";
import type { TraceRecorder } from "./traceRecorder";
import { createMonitorBridge } from "./monitorBridge";

export type MCPMonitor = {
  sandbox: McpSandboxRuntime;
  recorder: TraceRecorder;
  createBridge(): AgentMcpBridge;
  recordEvent(
    type: TraceEventType,
    actor: TraceActor,
    payload: TraceEventPayload,
  ): ReturnType<TraceRecorder["record"]>;
  finalizeTrace(meta: Omit<InteractionTrace, "events">): InteractionTrace;
};

export function createMCPMonitor(
  sandbox: McpSandboxRuntime,
  recorder: TraceRecorder,
): MCPMonitor {
  const bridge = createMonitorBridge(sandbox, recorder);

  return {
    sandbox,
    recorder,
    createBridge() {
      return bridge;
    },
    recordEvent(type, actor, payload) {
      return recorder.record(type, actor, payload);
    },
    finalizeTrace(meta) {
      return recorder.toTrace(meta);
    },
  };
}
