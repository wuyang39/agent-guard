import type {
  PromptLoadPayload,
  ResourceAccessPayload,
  ToolResultPayload,
} from "@agent-guard/contracts";
import type { AgentMcpBridge, ToolCallRequest } from "../agent/agentMcpBridge";
import type { McpSandboxRuntime } from "../sandbox/mcpSandbox";
import type { TraceRecorder } from "./traceRecorder";
import type { SystemErrorPayload, ToolCallPayload } from "./traceTypes";

let callIdCounter = 0;

function generateCallId(): string {
  callIdCounter++;
  return `call.${Date.now().toString(36)}.${callIdCounter}`;
}

export function createMonitorBridge(
  sandbox: McpSandboxRuntime,
  recorder: TraceRecorder,
): AgentMcpBridge {
  return {
    async handleToolCall(request: ToolCallRequest): Promise<ToolResultPayload> {
      const callId = generateCallId();
      const tool = sandbox.profile.tools.find(
        (t) => t.toolId === request.toolId,
      );
      const isHighRiskTool =
        tool?.riskLevel === "high" || tool?.riskLevel === "critical";

      const callPayload: ToolCallPayload = {
        callId,
        toolId: request.toolId,
        toolName: request.toolName ?? tool?.name ?? request.toolId,
        parameters: request.parameters,
        isHighRiskTool,
      };

      recorder.record("tool_call", "agent", callPayload);

      try {
        const result = await sandbox.executeTool(
          request.toolId,
          request.parameters,
        );
        const normalized: ToolResultPayload = { ...result, callId };
        recorder.record("tool_result", "mcp_server", normalized);
        return normalized;
      } catch (error) {
        const errPayload: SystemErrorPayload = {
          code: "TOOL_ERROR",
          message: error instanceof Error ? error.message : String(error),
          detail: { toolId: request.toolId },
        };
        recorder.record("system_error", "system", errPayload);
        throw error;
      }
    },

    async handleResourceAccess(
      resourceId: string,
    ): Promise<ResourceAccessPayload> {
      try {
        const payload = await sandbox.readResource(resourceId);
        recorder.record("resource_access", "agent", payload);
        return payload;
      } catch (error) {
        const errPayload: SystemErrorPayload = {
          code: "RESOURCE_ERROR",
          message: error instanceof Error ? error.message : String(error),
          detail: { resourceId },
        };
        recorder.record("system_error", "system", errPayload);
        throw error;
      }
    },

    async handlePromptLoad(promptId: string): Promise<PromptLoadPayload> {
      try {
        const payload = await sandbox.loadPrompt(promptId);
        recorder.record("prompt_load", "agent", payload);
        return payload;
      } catch (error) {
        const errPayload: SystemErrorPayload = {
          code: "PROMPT_ERROR",
          message: error instanceof Error ? error.message : String(error),
          detail: { promptId },
        };
        recorder.record("system_error", "system", errPayload);
        throw error;
      }
    },
  };
}
