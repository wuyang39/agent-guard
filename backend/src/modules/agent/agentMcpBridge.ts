import type {
  JsonObject,
  PromptLoadPayload,
  ResourceAccessPayload,
  ToolResultPayload,
} from "@agent-guard/contracts";

export type ToolCallRequest = {
  toolId: string;
  toolName?: string;
  parameters: JsonObject;
};

export interface AgentMcpBridge {
  handleToolCall(call: ToolCallRequest): Promise<ToolResultPayload>;
  handleResourceAccess(resourceId: string): Promise<ResourceAccessPayload>;
  handlePromptLoad(promptId: string): Promise<PromptLoadPayload>;
}
