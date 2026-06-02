import type {
  AgentUnderTest,
  FieldMatcher,
  JsonObject,
  JsonValue,
  McpSandboxProfile,
  PromptLoadPayload,
  ResourceDefinition,
  ResourceAccessPayload,
  TestContext,
  ToolDefinition,
  ToolResponsePlan,
  ToolResponseTemplate,
  ToolResultPayload,
} from "@agent-guard/contracts";
import { createId } from "../../shared/ids";

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

export type McpSandboxRuntimeOptions = {
  agent?: AgentUnderTest;
  caseId?: string;
  toolResponsePlan?: ToolResponsePlan[];
};

export function createMcpSandboxForContext(context: TestContext): McpSandboxRuntime {
  return createMcpSandbox(context.sandbox, {
    agent: context.agent,
    caseId: context.caseId,
    toolResponsePlan: context.testCase.toolResponsePlan,
  });
}

export function createMcpSandbox(
  profile: McpSandboxProfile,
  options: McpSandboxRuntimeOptions = {},
): McpSandboxRuntime {
  const toolCallCounts = new Map<string, number>();

  return {
    profile,

    async executeTool(
      toolId: string,
      parameters: JsonObject,
    ): Promise<ToolResultPayload> {
      const tool = findTool(profile, toolId);
      const callCount = incrementToolCallCount(toolCallCounts, toolId);
      const responseTemplate = findPlannedResponseTemplate(
        profile,
        options.toolResponsePlan ?? [],
        toolId,
        parameters,
        callCount,
      );
      const resource = findResourceForToolCall(profile, tool, parameters);

      return {
        callId: createId("call"),
        toolId,
        result: buildToolResult(tool, parameters, resource, responseTemplate),
        containsInjection: Boolean(
          responseTemplate?.containsInjection || resource?.containsInjection,
        ),
        riskTagIds: collectRiskTagIds(tool, resource, responseTemplate),
      };
    },

    async readResource(resourceId: string): Promise<ResourceAccessPayload> {
      const resource = findResource(profile, resourceId);

      return {
        resourceId: resource.resourceId,
        path: resource.path,
        sensitivity: resource.sensitivity,
        authorized: isAuthorizedResource(resource, options),
        containsInjection: resource.containsInjection,
        riskTagIds: resource.riskTags.map((tag) => tag.tagId),
      };
    },

    async loadPrompt(promptId: string): Promise<PromptLoadPayload> {
      const prompt = profile.prompts.find((item) => item.promptId === promptId);
      if (!prompt) {
        throw new Error(`Prompt "${promptId}" not found in sandbox profile.`);
      }

      return {
        promptId: prompt.promptId,
        attackEntryType: prompt.attackEntryType,
        riskTagIds: prompt.riskTags.map((tag) => tag.tagId),
      };
    },

    async resolveToolResponse(
      plan: ToolResponsePlan,
      parameters: JsonObject,
    ): Promise<ToolResponseTemplate | undefined> {
      const template = findToolResponseTemplate(profile, plan.responseTemplateId);
      if (template.toolId !== plan.toolId) {
        throw new Error(
          `Tool response "${template.responseTemplateId}" belongs to "${template.toolId}", not "${plan.toolId}".`,
        );
      }
      if (
        plan.trigger === "matching_parameters" &&
        !matchParameterMatchers(parameters, plan.parameterMatchers ?? [])
      ) {
        return undefined;
      }
      return template;
    },
  };
}

function findTool(profile: McpSandboxProfile, toolId: string): ToolDefinition {
  const tool = profile.tools.find((item) => item.toolId === toolId);
  if (!tool) {
    throw new Error(`Tool "${toolId}" not found in sandbox profile.`);
  }
  return tool;
}

function findResource(
  profile: McpSandboxProfile,
  resourceId: string,
): ResourceDefinition {
  const resource = profile.resources.find((item) => item.resourceId === resourceId);
  if (!resource) {
    throw new Error(`Resource "${resourceId}" not found in sandbox profile.`);
  }
  return resource;
}

function findToolResponseTemplate(
  profile: McpSandboxProfile,
  responseTemplateId: string,
): ToolResponseTemplate {
  const template = profile.toolResponseTemplates.find(
    (item) => item.responseTemplateId === responseTemplateId,
  );
  if (!template) {
    throw new Error(`Tool response template "${responseTemplateId}" not found.`);
  }
  return template;
}

function incrementToolCallCount(
  counts: Map<string, number>,
  toolId: string,
): number {
  const next = (counts.get(toolId) ?? 0) + 1;
  counts.set(toolId, next);
  return next;
}

function findPlannedResponseTemplate(
  profile: McpSandboxProfile,
  plans: ToolResponsePlan[],
  toolId: string,
  parameters: JsonObject,
  callCount: number,
): ToolResponseTemplate | undefined {
  for (const plan of plans.filter((item) => item.toolId === toolId)) {
    if (plan.trigger === "first_call" && callCount !== 1) {
      continue;
    }
    if (
      plan.trigger === "matching_parameters" &&
      !matchParameterMatchers(parameters, plan.parameterMatchers ?? [])
    ) {
      continue;
    }
    const template = findToolResponseTemplate(profile, plan.responseTemplateId);
    if (template.toolId !== toolId) {
      throw new Error(
        `Tool response "${template.responseTemplateId}" belongs to "${template.toolId}", not "${toolId}".`,
      );
    }
    return template;
  }

  return undefined;
}

function findResourceForToolCall(
  profile: McpSandboxProfile,
  tool: ToolDefinition,
  parameters: JsonObject,
): ResourceDefinition | undefined {
  if (tool.name !== "read_file" && tool.toolId !== "tool.read_file") {
    return undefined;
  }

  const pathValue = parameters.path;
  if (typeof pathValue !== "string") {
    return undefined;
  }

  return profile.resources.find((resource) => resource.path === pathValue);
}

function buildToolResult(
  tool: ToolDefinition,
  parameters: JsonObject,
  resource: ResourceDefinition | undefined,
  responseTemplate: ToolResponseTemplate | undefined,
): JsonValue {
  if (responseTemplate) {
    return {
      toolId: tool.toolId,
      toolName: tool.name,
      responseTemplateId: responseTemplate.responseTemplateId,
      content: responseTemplate.content,
    };
  }

  if (tool.toolId === "tool.read_file" || tool.name === "read_file") {
    const pathValue = typeof parameters.path === "string" ? parameters.path : "";
    return {
      toolId: tool.toolId,
      toolName: tool.name,
      path: pathValue,
      resourceId: resource?.resourceId ?? "",
      content: buildSandboxFileContent(pathValue, resource),
    };
  }

  if (tool.toolId === "tool.send_request" || tool.name === "send_request") {
    return {
      toolId: tool.toolId,
      toolName: tool.name,
      status: "simulated",
      url: typeof parameters.url === "string" ? parameters.url : "",
      accepted: true,
    };
  }

  return {
    toolId: tool.toolId,
    toolName: tool.name,
    status: "simulated",
    parameters,
  };
}

function buildSandboxFileContent(
  pathValue: string,
  resource: ResourceDefinition | undefined,
): string {
  if (resource?.sensitivity === "secret" || pathValue.startsWith("/secret/")) {
    return "token=demo-secret-token";
  }
  if (resource?.containsInjection) {
    return `Injected sandbox resource: ${resource.name}`;
  }
  return `Sandbox file content from ${pathValue || "unknown path"}`;
}

function collectRiskTagIds(
  tool: ToolDefinition,
  resource: ResourceDefinition | undefined,
  responseTemplate: ToolResponseTemplate | undefined,
): string[] {
  return [
    ...new Set([
      ...tool.riskTags.map((tag) => tag.tagId),
      ...(resource?.riskTags.map((tag) => tag.tagId) ?? []),
      ...(responseTemplate?.riskTags.map((tag) => tag.tagId) ?? []),
    ]),
  ];
}

function isAuthorizedResource(
  resource: ResourceDefinition,
  options: McpSandboxRuntimeOptions,
): boolean {
  if (resource.sensitivity === "public") {
    return true;
  }
  return (
    Boolean(
      options.agent &&
        resource.accessPolicy.allowedAgentIds.includes(options.agent.agentId),
    ) ||
    Boolean(options.caseId && resource.accessPolicy.allowedUseCases.includes(options.caseId))
  );
}

function matchParameterMatchers(
  parameters: JsonObject,
  matchers: FieldMatcher[],
): boolean {
  if (matchers.length === 0) {
    return false;
  }
  return matchers.every((matcher) => matchField(parameters, matcher));
}

function matchField(parameters: JsonObject, matcher: FieldMatcher): boolean {
  const actual =
    getFieldValue(parameters, matcher.fieldPath) ??
    getFieldValue({ parameters }, matcher.fieldPath);
  const expected = matcher.value;

  switch (matcher.operator) {
    case "exists":
      return actual !== undefined;
    case "equals":
      return normalize(actual, matcher) === normalize(expected, matcher);
    case "contains":
      return stringify(actual, matcher).includes(stringify(expected, matcher));
    case "starts_with":
      return stringify(actual, matcher).startsWith(stringify(expected, matcher));
    case "ends_with":
      return stringify(actual, matcher).endsWith(stringify(expected, matcher));
    case "in":
      return Array.isArray(expected) && expected.includes(actual ?? null);
    case "regex":
      return matchesRegex(actual, expected, matcher);
  }
}

function matchesRegex(
  actual: JsonValue | undefined,
  expected: JsonValue | undefined,
  matcher: FieldMatcher,
): boolean {
  try {
    return new RegExp(stringify(expected, matcher)).test(stringify(actual, matcher));
  } catch {
    return false;
  }
}

function stringify(value: JsonValue | undefined, matcher: FieldMatcher): string {
  const normalized = normalize(value, matcher);
  if (normalized === undefined || normalized === null) {
    return "";
  }
  return typeof normalized === "string" ? normalized : JSON.stringify(normalized);
}

function normalize(
  value: JsonValue | undefined,
  matcher: FieldMatcher,
): JsonValue | undefined {
  if (typeof value !== "string") {
    return value;
  }

  let normalized = value;
  switch (matcher.normalize ?? "none") {
    case "lowercase":
      normalized = normalized.toLowerCase();
      break;
    case "trim":
      normalized = normalized.trim();
      break;
    case "url_decode":
      normalized = safeDecodeURIComponent(normalized);
      break;
    case "none":
      break;
  }

  if (matcher.caseSensitive === false || matcher.caseSensitive === undefined) {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function getFieldValue(source: JsonObject, fieldPath: string): JsonValue | undefined {
  const segments = fieldPath.split(".");
  let current: JsonValue | undefined = source;

  for (const segment of segments) {
    if (!isJsonObject(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
