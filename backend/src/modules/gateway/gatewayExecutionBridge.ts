import type { ToolResultPayload } from "@agent-guard/contracts";
import type { AgentMcpBridge, ToolCallRequest } from "../agent/agentMcpBridge";
import type { TraceRecorder } from "../monitor/traceRecorder";
import type { SystemErrorPayload, ToolCallPayload } from "../monitor/traceTypes";
import type { DownstreamMcpProvider } from "./downstreamMcpProvider";
import { createId } from "../../shared";

export type GatewayExecutionBridgeOptions = {
  fallbackBridge: AgentMcpBridge;
  providers: DownstreamMcpProvider[];
  recorder: TraceRecorder;
};

export function createGatewayExecutionBridge(
  opts: GatewayExecutionBridgeOptions,
): AgentMcpBridge {
  const providers = new Map(opts.providers.map((provider) => [provider.providerId, provider]));

  return {
    async handleToolCall(request: ToolCallRequest): Promise<ToolResultPayload> {
      const providerId = request.gateway?.providerId;
      const provider = providerId ? providers.get(providerId) : undefined;

      if (!provider) {
        return opts.fallbackBridge.handleToolCall(request);
      }

      const callId = createId("call");
      const callPayload: ToolCallPayload = {
        callId,
        toolId: request.toolId,
        toolName:
          request.gateway?.exposedToolName ??
          request.toolName ??
          request.gateway?.originalToolName ??
          request.toolId,
        parameters: request.parameters,
        isHighRiskTool: (request.gateway?.capabilityProfileSnapshot.riskTags.length ?? 0) > 0,
      };
      opts.recorder.record("tool_call", "agent", callPayload);

      try {
        const result = await provider.callTool(
          request.gateway?.originalToolName ?? request.toolName ?? request.toolId,
          request.parameters,
        );
        const normalized: ToolResultPayload = {
          ...result,
          callId,
          toolId: request.toolId,
        };
        opts.recorder.record("tool_result", "mcp_server", normalized);
        return normalized;
      } catch (error) {
        const detail: Record<string, string> = { toolId: request.toolId };
        if (providerId) detail.providerId = providerId;
        const toolName = request.gateway?.originalToolName ?? request.toolName;
        if (toolName) detail.toolName = toolName;
        const errPayload: SystemErrorPayload = {
          code: "DOWNSTREAM_MCP_ERROR",
          message: error instanceof Error ? error.message : String(error),
          detail,
        };
        opts.recorder.record("system_error", "system", errPayload);
        throw error;
      }
    },

    handleResourceAccess(resourceId) {
      return opts.fallbackBridge.handleResourceAccess(resourceId);
    },

    handlePromptLoad(promptId) {
      return opts.fallbackBridge.handlePromptLoad(promptId);
    },
  };
}
