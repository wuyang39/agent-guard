import type {
  McpSandboxProfile,
  PolicyTemplate,
  PromptDefinition,
  PyritAttackLibrary,
  RedTeamScenarioSet,
  ResourceDefinition,
  RiskRule,
  TestCase,
  TestOracle,
  ToolDefinition,
  ToolResponseTemplate,
} from "@agent-guard/contracts";

export type ConfigRepository = {
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponseTemplates: ToolResponseTemplate[];
  riskRules: RiskRule[];
  testCases: TestCase[];
  testOracles: TestOracle[];
  redTeamScenarioSet: RedTeamScenarioSet;
  policyTemplates: PolicyTemplate[];
  pyritAttackLibrary: PyritAttackLibrary;
};

export type ConfigIndex = {
  toolsById: ReadonlyMap<string, ToolDefinition>;
  resourcesById: ReadonlyMap<string, ResourceDefinition>;
  promptsById: ReadonlyMap<string, PromptDefinition>;
  toolResponsesById: ReadonlyMap<string, ToolResponseTemplate>;
  riskRulesById: ReadonlyMap<string, RiskRule>;
  testCasesById: ReadonlyMap<string, TestCase>;
  testOraclesByCaseId: ReadonlyMap<string, TestOracle>;
  redTeamScenariosById: ReadonlyMap<string, RedTeamScenarioSet["scenarios"][number]>;
  policyTemplatesById: ReadonlyMap<string, PolicyTemplate>;
  pyritAttackFamiliesById: ReadonlyMap<string, PyritAttackLibrary["attackFamilies"][number]>;
  pyritConvertersById: ReadonlyMap<string, PyritAttackLibrary["converterCatalog"][number]>;
  pyritSamplesById: ReadonlyMap<string, PyritAttackLibrary["samples"][number]>;
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
    redTeamScenariosById: indexBy(
      repository.redTeamScenarioSet.scenarios,
      (scenario) => scenario.scenarioId,
    ),
    policyTemplatesById: indexBy(
      repository.policyTemplates,
      (template) => template.policyTemplateId,
    ),
    pyritAttackFamiliesById: indexBy(
      repository.pyritAttackLibrary.attackFamilies,
      (family) => family.familyId,
    ),
    pyritConvertersById: indexBy(
      repository.pyritAttackLibrary.converterCatalog,
      (converter) => converter.converterId,
    ),
    pyritSamplesById: indexBy(
      repository.pyritAttackLibrary.samples,
      (sample) => sample.sampleId,
    ),
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
