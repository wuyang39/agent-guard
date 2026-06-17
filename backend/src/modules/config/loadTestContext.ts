import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentUnderTest,
  JsonObject,
  JsonValue,
  PyritAttackLibrary,
  PyritJailbreakTemplateIndex,
  RedTeamScenarioSet,
  TestContext,
  TestOracle,
} from "@agent-guard/contracts";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import {
  buildConfigIndex,
  buildSandboxProfile,
  type ConfigRepository,
} from "./configRepository";
import {
  validateConfigRepository,
  type ValidationIssue,
} from "./configValidator";

export type LoadedConfigRepository = ConfigRepository;

export type LoadTestContextResult = {
  contexts: TestContext[];
  testOracles: TestOracle[];
};

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

export class ConfigValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(formatValidationMessage(issues));
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export async function loadConfigRepository(
  configDir: string,
): Promise<LoadedConfigRepository> {
  const root = resolve(configDir);
  const repository: LoadedConfigRepository = {
    tools: await readJsonArray(root, "tools.json"),
    resources: await readJsonArray(root, "resources.json"),
    prompts: await readJsonArray(root, "prompts.json"),
    toolResponseTemplates: await readJsonArray(root, "tool_responses.json"),
    riskRules: await readJsonArray(root, "risk_rules.json"),
    testCases: await readJsonArray(root, "test_cases.json"),
    testOracles: await readJsonArray(root, "test_oracles.json"),
    redTeamScenarioSet: await readJsonObject<RedTeamScenarioSet>(
      root,
      "red_team_scenarios.json",
    ),
    policyTemplates: await readJsonArray(root, "supervision_policy_templates.json"),
    pyritAttackLibrary: await readJsonObject<PyritAttackLibrary>(
      root,
      "pyrit_attack_library.json",
    ),
    pyritJailbreakTemplateIndex: await readJsonObject<PyritJailbreakTemplateIndex>(
      root,
      "pyrit_jailbreak_template_index.json",
    ),
  };

  const validation = validateConfigRepository(repository);
  if (!validation.ok) {
    throw new ConfigValidationError(validation.issues);
  }

  return repository;
}

export async function loadTestContexts(
  configDir: string,
  agent: AgentUnderTest,
): Promise<LoadTestContextResult> {
  const repository = await loadConfigRepository(configDir);
  const index = buildConfigIndex(repository);
  const sandbox = buildSandboxProfile(repository);
  const contexts = repository.testCases
    .filter((testCase) => testCase.enabled)
    .map<TestContext>((testCase) => ({
      schemaVersion: SCHEMA_VERSION,
      configVersion: SCHEMA_VERSION,
      contextId: createId("context"),
      caseId: testCase.caseId,
      caseName: testCase.caseName,
      agent,
      sandbox,
      testCase,
      riskRules: [...index.riskRulesById.values()],
    }));

  return {
    contexts,
    testOracles: repository.testOracles,
  };
}

async function readJsonArray<T>(configDir: string, fileName: string): Promise<T[]> {
  const parsed = await readJsonValue(configDir, fileName);

  if (!Array.isArray(parsed)) {
    throw new ConfigLoadError(`Config file ${fileName} must contain a JSON array.`);
  }

  return parsed as T[];
}

async function readJsonObject<T>(
  configDir: string,
  fileName: string,
): Promise<T> {
  const parsed = await readJsonValue(configDir, fileName);

  if (!isJsonObject(parsed)) {
    throw new ConfigLoadError(`Config file ${fileName} must contain a JSON object.`);
  }

  return parsed as T;
}

async function readJsonValue(
  configDir: string,
  fileName: string,
): Promise<JsonValue> {
  const filePath = join(configDir, fileName);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as JsonValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`Failed to read ${fileName}: ${detail}`);
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValidationMessage(issues: ValidationIssue[]): string {
  const details = issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  return details ? `Invalid config repository: ${details}` : "Invalid config repository.";
}
