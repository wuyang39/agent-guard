import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { validateCorpus } from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configDir = join(projectRoot, "configs");
const generatedDir = join(projectRoot, "generated", "a-line");

const input = {
  projectRoot,
  resourceSeeds: await readJson<ResourceSeed[]>(configDir, "resource_seeds.json"),
  attackSeeds: await readJson<AttackSeed[]>(configDir, "attack_seeds.json"),
  userPromptSeeds: await readJson<AttackSeed[]>(configDir, "user_prompt_seeds.json"),
  toolResponseSeeds: await readJson<ToolResponseSeed[]>(configDir, "tool_response_seeds.json"),
  mutationOperators: await readJson<MutationOperatorSpec[]>(configDir, "mutation_operators.json"),
  runProfiles: await readJson<CorpusRunProfile[]>(configDir, "corpus_run_profiles.json"),
  pyritSeedDatasetIndex: await readJson<PyritSeedDatasetIndex>(configDir, "pyrit_seed_dataset_index.json"),
  pyritExecutorTemplateIndex: await readJson<PyritExecutorTemplateIndex>(configDir, "pyrit_executor_template_index.json"),
  pyritScorerTemplateIndex: await readJson<PyritScorerTemplateIndex>(configDir, "pyrit_scorer_template_index.json"),
  aigStrategyIndex: await readJson<AigStrategyIndex>(configDir, "aig_strategy_index.json"),
  resources: await readJson<ResourceDefinition[]>(generatedDir, "resources.generated.json"),
  prompts: await readJson<PromptDefinition[]>(generatedDir, "prompts.generated.json"),
  toolResponses: await readJson<ToolResponseTemplate[]>(generatedDir, "tool_responses.generated.json"),
  testCases: await readJson<TestCase[]>(generatedDir, "test_cases.generated.json"),
  testOracles: await readJson<TestOracle[]>(generatedDir, "test_oracles.generated.json"),
  manifest: await readJson<CorpusManifest>(generatedDir, "corpus_manifest.json"),
};

const issues = validateCorpus(input);
const errors = issues.filter((issue) => issue.severity === "error");
for (const issue of issues) {
  const prefix = issue.severity === "error" ? "FAIL" : "WARN";
  console.log(`${prefix}: ${issue.code} ${issue.path} - ${issue.message}`);
}

if (errors.length > 0) {
  process.exitCode = 1;
} else {
  console.log("PASS: P3-A generated corpus validation passed.");
  console.log(
    `Corpus stats: resources=${input.resources.length}, prompts=${input.prompts.length}, cases=${input.testCases.length}, oracles=${input.testOracles.length}, mutationOperators=${input.mutationOperators.length}`,
  );
}

async function readJson<T>(dir: string, fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, fileName), "utf8")) as T;
}
