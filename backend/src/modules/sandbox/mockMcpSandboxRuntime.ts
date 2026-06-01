import { createId } from "../../shared";
import type {
  JsonObject,
  McpSandboxProfile,
  PromptLoadPayload,
  ResourceAccessPayload,
  TestContext,
  ToolDefinition,
  ToolResponsePlan,
  ToolResponseTemplate,
  ToolResultPayload,
} from "@agent-guard/contracts";
import type { McpSandboxRuntime } from "./mcpSandbox";

export function createMockMcpSandboxRuntime(
  context: TestContext,
): McpSandboxRuntime {
  const profile: McpSandboxProfile = context.sandbox;
  const responsePlans: ToolResponsePlan[] = context.testCase.toolResponsePlan;
  const toolCallCounts = new Map<string, number>();

  function getToolCallCount(toolId: string): number {
    return toolCallCounts.get(toolId) ?? 0;
  }

  function incrementToolCallCount(toolId: string): number {
    const next = getToolCallCount(toolId) + 1;
    toolCallCounts.set(toolId, next);
    return next;
  }

  function findTool(toolId: string): ToolDefinition | undefined {
    return profile.tools.find((t) => t.toolId === toolId);
  }

  function findResponseTemplate(
    toolId: string,
    callCount: number,
  ): ToolResponseTemplate | undefined {
    const plan = responsePlans.find((p) => p.toolId === toolId);
    if (!plan) return undefined;

    const template = profile.toolResponseTemplates.find(
      (t) => t.responseTemplateId === plan.responseTemplateId,
    );
    if (!template) return undefined;

    switch (plan.trigger) {
      case "first_call":
        return callCount === 1 ? template : undefined;
      case "every_call":
        return template;
      case "matching_parameters":
        return template;
      default:
        return undefined;
    }
  }

  return {
    profile,

    async executeTool(
      toolId: string,
      parameters: JsonObject,
    ): Promise<ToolResultPayload> {
      const tool = findTool(toolId);
      const callCount = incrementToolCallCount(toolId);
      const responseTemplate = findResponseTemplate(toolId, callCount);
      const callId = createId("call");

      if (!tool) {
        return {
          callId,
          toolId,
          result: { error: `Tool ${toolId} not found in sandbox profile` },
          containsInjection: false,
          riskTagIds: [],
        };
      }

      const pathRaw = (parameters as Record<string, unknown>).path;
      const pathStr = typeof pathRaw === "string" ? pathRaw : "(none)";

      return {
        callId,
        toolId,
        result: {
          tool: tool.name,
          path: pathStr,
          content:
            responseTemplate?.content ??
            `Mock result from ${tool.name}`,
        },
        containsInjection: responseTemplate?.containsInjection ?? false,
        riskTagIds: tool.riskTags.map((t) => t.tagId),
      };
    },

    async readResource(
      resourceId: string,
    ): Promise<ResourceAccessPayload> {
      const resource = profile.resources.find(
        (r) => r.resourceId === resourceId,
      );

      return {
        resourceId,
        sensitivity: resource?.sensitivity ?? "public",
        authorized:
          resource?.accessPolicy?.allowedAgentIds.includes(
            context.agent.agentId,
          ) ?? false,
        containsInjection: resource?.containsInjection ?? false,
        riskTagIds: resource?.riskTags.map((t) => t.tagId) ?? [],
      };
    },

    async loadPrompt(promptId: string): Promise<PromptLoadPayload> {
      const prompt = profile.prompts.find((p) => p.promptId === promptId);

      return {
        promptId,
        riskTagIds: prompt?.riskTags.map((t) => t.tagId) ?? [],
      };
    },

    async resolveToolResponse(
      plan: ToolResponsePlan,
      _parameters: JsonObject,
    ): Promise<ToolResponseTemplate | undefined> {
      return profile.toolResponseTemplates.find(
        (t) => t.responseTemplateId === plan.responseTemplateId,
      );
    },
  };
}
