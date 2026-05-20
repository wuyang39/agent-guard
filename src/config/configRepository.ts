import type {
  McpSandboxProfile,
  PromptDefinition,
  ResourceDefinition,
  RiskRule,
  TestCase,
  TestOracle,
  ToolDefinition,
  ToolResponseTemplate,
} from "../shared/contracts";

export type ConfigRepository = {
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponseTemplates: ToolResponseTemplate[];
  riskRules: RiskRule[];
  testCases: TestCase[];
  testOracles: TestOracle[];
};

export type ConfigIndex = {
  toolsById: ReadonlyMap<string, ToolDefinition>;
  resourcesById: ReadonlyMap<string, ResourceDefinition>;
  promptsById: ReadonlyMap<string, PromptDefinition>;
  toolResponsesById: ReadonlyMap<string, ToolResponseTemplate>;
  riskRulesById: ReadonlyMap<string, RiskRule>;
  testCasesById: ReadonlyMap<string, TestCase>;
  testOraclesByCaseId: ReadonlyMap<string, TestOracle>;
};

export function buildConfigIndex(repository: ConfigRepository): ConfigIndex {
  return {
    toolsById: indexBy(repository.tools, (tool) => tool.toolId),
    resourcesById: indexBy(repository.resources, (resource) => resource.resourceId),
    promptsById: indexBy(repository.prompts, (prompt) => prompt.promptId),
    toolResponsesById: indexBy(
      repository.toolResponseTemplates,
      (response) => response.responseTemplateId,
    ),
    riskRulesById: indexBy(repository.riskRules, (rule) => rule.ruleId),
    testCasesById: indexBy(repository.testCases, (testCase) => testCase.caseId),
    testOraclesByCaseId: indexBy(repository.testOracles, (oracle) => oracle.caseId),
  };
}

export function buildSandboxProfile(
  repository: ConfigRepository,
): McpSandboxProfile {
  return {
    schemaVersion: "mvp-1",
    sandboxId: "sandbox.default",
    name: "Default MCP Sandbox",
    tools: repository.tools,
    resources: repository.resources,
    prompts: repository.prompts,
    toolResponseTemplates: repository.toolResponseTemplates,
  };
}

function indexBy<T>(items: T[], getId: (item: T) => string): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [getId(item), item]));
}
