import type { JsonObject, ToolDefinition } from "@agent-guard/contracts";

export type StaticDownstreamProviderTool = {
  originalToolName: string;
  canonicalToolId: string;
  description: string;
  inputSchema: JsonObject;
};

export type StaticDownstreamProvider = {
  providerId: string;
  providerName: string;
  listTools(): StaticDownstreamProviderTool[];
};

export function createSandboxDownstreamProvider(
  tools: ToolDefinition[],
): StaticDownstreamProvider {
  return {
    providerId: "sandbox_downstream",
    providerName: "Sandbox Downstream MCP",
    listTools() {
      return tools.map((tool) => ({
        originalToolName: stripAgentGuardPrefix(tool.name),
        canonicalToolId: tool.toolId,
        description: `Downstream sandbox provider tool: ${tool.description}`,
        inputSchema: tool.schema,
      }));
    },
  };
}

function stripAgentGuardPrefix(name: string): string {
  return name
    .replace(/^agent_guard_/, "")
    .replace(/^agent[-_ ]?guard[._-]/i, "");
}
