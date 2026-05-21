import type {
  JsonObject,
  McpSandboxProfile,
  PromptLoadPayload,
  ResourceAccessPayload,
  ToolResponsePlan,
  ToolResponseTemplate,
  ToolResultPayload,
} from "./sandboxTypes";
import { NotImplementedError } from "../../shared/errors";

export type McpSandboxRuntime = {
  profile: McpSandboxProfile;
  executeTool(toolId: string, parameters: JsonObject): Promise<ToolResultPayload>;
  readResource(resourceId: string): Promise<ResourceAccessPayload>;
  loadPrompt(promptId: string): Promise<PromptLoadPayload>;
  resolveToolResponse(
    plan: ToolResponsePlan,
    parameters: JsonObject,
  ): Promise<ToolResponseTemplate | undefined>;
};

export function createMcpSandbox(profile: McpSandboxProfile): McpSandboxRuntime {
  return {
    profile,
    async executeTool() {
      throw new NotImplementedError("MCP sandbox executeTool");
    },
    async readResource() {
      throw new NotImplementedError("MCP sandbox readResource");
    },
    async loadPrompt() {
      throw new NotImplementedError("MCP sandbox loadPrompt");
    },
    async resolveToolResponse() {
      throw new NotImplementedError("MCP sandbox resolveToolResponse");
    },
  };
}
