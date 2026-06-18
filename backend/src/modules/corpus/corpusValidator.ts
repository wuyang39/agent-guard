import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AigStrategyIndex,
  AttackSeed,
  CorpusManifest,
  CorpusRunProfile,
  MutationOperatorSpec,
  PromptDefinition,
  PyritExecutorTemplateIndex,
  PyritScorerTemplateIndex,
  PyritSeedDatasetIndex,
  ResourceDefinition,
  ResourceSeed,
  TestCase,
  TestOracle,
  ToolResponseSeed,
  ToolResponseTemplate,
} from "@agent-guard/contracts";

export type CorpusValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: string;
};

export type CorpusValidationInput = {
  projectRoot: string;
  resourceSeeds: ResourceSeed[];
  attackSeeds: AttackSeed[];
  toolResponseSeeds: ToolResponseSeed[];
  mutationOperators: MutationOperatorSpec[];
  runProfiles: CorpusRunProfile[];
  pyritSeedDatasetIndex: PyritSeedDatasetIndex;
  pyritExecutorTemplateIndex: PyritExecutorTemplateIndex;
  pyritScorerTemplateIndex: PyritScorerTemplateIndex;
  aigStrategyIndex: AigStrategyIndex;
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponses: ToolResponseTemplate[];
  testCases: TestCase[];
  testOracles: TestOracle[];
  manifest: CorpusManifest;
};

export function validateCorpus(input: CorpusValidationInput): CorpusValidationIssue[] {
  const issues: CorpusValidationIssue[] = [];

  assertMin(issues, input.resourceSeeds.length, 100, "resourceSeeds", "resource_seed_count");
  assertMin(issues, input.attackSeeds.length, 800, "attackSeeds", "attack_seed_count");
  assertMin(issues, input.toolResponseSeeds.length, 80, "toolResponseSeeds", "tool_response_seed_count");
  assertMin(issues, input.mutationOperators.length, 45, "mutationOperators", "mutation_operator_count");
  assertMin(issues, input.prompts.length, 2000, "generated.prompts", "generated_prompt_count");
  assertMin(issues, input.testCases.length, 2000, "generated.testCases", "generated_case_count");

  if (input.testOracles.length !== input.testCases.length) {
    issues.push({
      severity: "error",
      code: "oracle_case_count_mismatch",
      message: `Generated oracles ${input.testOracles.length} must equal generated cases ${input.testCases.length}.`,
      path: "generated.testOracles",
    });
  }

  assertUnique(issues, input.resourceSeeds.map((item) => item.seedId), "resourceSeeds.seedId");
  assertUnique(issues, input.attackSeeds.map((item) => item.seedId), "attackSeeds.seedId");
  assertUnique(issues, input.toolResponseSeeds.map((item) => item.seedId), "toolResponseSeeds.seedId");
  assertUnique(issues, input.mutationOperators.map((item) => item.operatorId), "mutationOperators.operatorId");
  assertUnique(issues, input.resources.map((item) => item.resourceId), "generated.resources.resourceId");
  assertUnique(issues, input.prompts.map((item) => item.promptId), "generated.prompts.promptId");
  assertUnique(issues, input.toolResponses.map((item) => item.responseTemplateId), "generated.toolResponses.responseTemplateId");
  assertUnique(issues, input.testCases.map((item) => item.caseId), "generated.testCases.caseId");
  assertUnique(issues, input.testOracles.map((item) => item.oracleId), "generated.testOracles.oracleId");

  const resourceIds = new Set(input.resources.map((item) => item.resourceId));
  const promptIds = new Set(input.prompts.map((item) => item.promptId));
  const responseIds = new Set(input.toolResponses.map((item) => item.responseTemplateId));
  const caseIds = new Set(input.testCases.map((item) => item.caseId));
  const oracleCaseIds = new Set(input.testOracles.map((item) => item.caseId));

  for (const testCase of input.testCases) {
    for (const resourceId of testCase.resourceIds) {
      assertRef(issues, resourceIds, resourceId, `generated.testCases.${testCase.caseId}.resourceIds`);
    }
    for (const promptId of testCase.promptIds) {
      assertRef(issues, promptIds, promptId, `generated.testCases.${testCase.caseId}.promptIds`);
    }
    for (const plan of testCase.toolResponsePlan) {
      assertRef(issues, responseIds, plan.responseTemplateId, `generated.testCases.${testCase.caseId}.toolResponsePlan`);
    }
    if (!oracleCaseIds.has(testCase.caseId)) {
      issues.push({
        severity: "error",
        code: "missing_oracle_for_case",
        message: `Generated case ${testCase.caseId} has no oracle.`,
        path: `generated.testCases.${testCase.caseId}`,
      });
    }
  }

  for (const oracle of input.testOracles) {
    assertRef(issues, caseIds, oracle.caseId, `generated.testOracles.${oracle.oracleId}.caseId`);
  }

  const attackGeneratedItems = input.manifest.items.filter((item) =>
    item.itemType === "prompt" || item.itemType === "test_case" || item.itemType === "oracle",
  );
  const pyritGenerated = attackGeneratedItems.filter((item) => item.source.origin === "pyrit").length;
  const totalGenerated = attackGeneratedItems.length;
  if (totalGenerated > 0 && pyritGenerated / totalGenerated < 0.7) {
    issues.push({
      severity: "error",
      code: "pyrit_source_ratio_low",
      message: `PyRIT generated ratio ${(pyritGenerated / totalGenerated).toFixed(3)} is below 0.7.`,
      path: "manifest.sourceSummary.pyrit",
    });
  }

  if (Object.keys(input.manifest.coverage.scenarios).length < 20) {
    issues.push({
      severity: "error",
      code: "scenario_coverage_low",
      message: `Generated corpus covers ${Object.keys(input.manifest.coverage.scenarios).length} scenarios, expected at least 20.`,
      path: "manifest.coverage.scenarios",
    });
  }

  for (const profile of input.runProfiles) {
    if (!input.manifest.profileSummary[profile.profileId]) {
      issues.push({
        severity: "error",
        code: "empty_run_profile",
        message: `Run profile ${profile.profileId} has no generated cases.`,
        path: `runProfiles.${profile.profileId}`,
      });
    }
  }

  for (const rootOnlyFile of [
    "resource_seeds.json",
    "attack_seeds.json",
    "tool_response_seeds.json",
    "mutation_operators.json",
    "attack_generation_profiles.json",
    "corpus_run_profiles.json",
    "pyrit_seed_dataset_index.json",
    "pyrit_executor_template_index.json",
    "pyrit_scorer_template_index.json",
    "aig_strategy_index.json",
    "pyrit_attack_library.json",
    "pyrit_jailbreak_template_index.json",
  ]) {
    if (existsSync(join(input.projectRoot, "configs", rootOnlyFile))) {
      issues.push({
        severity: "error",
        code: "legacy_root_corpus_config",
        message: `A-line corpus config ${rootOnlyFile} must live under configs/a-line/**, not configs/.`,
        path: `configs/${rootOnlyFile}`,
      });
    }
  }

  for (const index of [
    input.pyritSeedDatasetIndex,
    input.pyritExecutorTemplateIndex,
    input.pyritScorerTemplateIndex,
    input.aigStrategyIndex,
  ]) {
    const entries =
      "datasets" in index
        ? index.datasets
        : "executors" in index
          ? index.executors
          : "scorers" in index
            ? index.scorers
            : index.strategies;
    if (entries.length === 0) {
      issues.push({
        severity: "warning",
        code: "empty_source_index",
        message: `Source index ${index.indexId} has no entries.`,
        path: index.indexId,
      });
    }
    for (const entry of entries.slice(0, 50)) {
      const path = resolveSourcePath(input.projectRoot, entry.sourcePath);
      if (!existsSync(path)) {
        issues.push({
          severity: "warning",
          code: "missing_optional_source_path",
          message: `Source path ${entry.sourcePath} does not exist on this machine.`,
          path: `${index.indexId}.${entry.sourceId}.sourcePath`,
        });
      }
    }
  }

  const serialized = JSON.stringify({
    resourceSeeds: input.resourceSeeds,
    attackSeeds: input.attackSeeds,
    toolResponseSeeds: input.toolResponseSeeds,
    resources: input.resources,
    prompts: input.prompts,
    toolResponses: input.toolResponses,
  });
  if (/sk-[A-Za-z0-9]{20,}/.test(serialized) || /AKIA[A-Z0-9]{16}/.test(serialized)) {
    issues.push({
      severity: "error",
      code: "secret_like_text",
      message: "Corpus contains obvious real-secret-like token pattern.",
      path: "corpus",
    });
  }

  return issues;
}

function assertMin(
  issues: CorpusValidationIssue[],
  actual: number,
  expected: number,
  path: string,
  code: string,
): void {
  if (actual < expected) {
    issues.push({
      severity: "error",
      code,
      message: `${path} count ${actual} is below required ${expected}.`,
      path,
    });
  }
}

function assertUnique(
  issues: CorpusValidationIssue[],
  values: string[],
  path: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      issues.push({
        severity: "error",
        code: "duplicate_id",
        message: `Duplicate id ${value}.`,
        path,
      });
    }
    seen.add(value);
  }
}

function assertRef(
  issues: CorpusValidationIssue[],
  known: Set<string>,
  value: string,
  path: string,
): void {
  if (!known.has(value)) {
    issues.push({
      severity: "error",
      code: "missing_reference",
      message: `Unknown reference ${value}.`,
      path,
    });
  }
}

function resolveSourcePath(projectRoot: string, sourcePath: string): string {
  if (sourcePath.startsWith("../")) {
    return resolve(projectRoot, sourcePath);
  }
  return join(projectRoot, sourcePath);
}
