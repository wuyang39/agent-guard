import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  buildCorpusSeeds,
  buildCorpusSourceIndexes,
  generateCorpus,
  validateCorpus,
} from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configDir = join(projectRoot, "configs");
const generatedDir = join(projectRoot, "generated", "a-line");

await mkdir(configDir, { recursive: true });
await mkdir(generatedDir, { recursive: true });

const seeds = buildCorpusSeeds();
const indexes = await buildCorpusSourceIndexes(projectRoot);
const generated = generateCorpus(seeds, {
  generatedAt: "2026-06-18T00:00:00.000Z",
  generatorVersion: "p3-a-generator-1",
  maxCases: 1200,
});

await Promise.all([
  writeJson(configDir, "resource_seeds.json", seeds.resourceSeeds),
  writeJson(configDir, "attack_seeds.json", seeds.attackSeeds),
  writeJson(configDir, "user_prompt_seeds.json", seeds.userPromptSeeds),
  writeJson(configDir, "tool_response_seeds.json", seeds.toolResponseSeeds),
  writeJson(configDir, "mutation_operators.json", seeds.mutationOperators),
  writeJson(configDir, "attack_generation_profiles.json", buildAttackGenerationProfiles()),
  writeJson(configDir, "corpus_run_profiles.json", seeds.runProfiles),
  writeJson(configDir, "pyrit_seed_dataset_index.json", indexes.pyritSeedDatasetIndex),
  writeJson(configDir, "pyrit_executor_template_index.json", indexes.pyritExecutorTemplateIndex),
  writeJson(configDir, "pyrit_scorer_template_index.json", indexes.pyritScorerTemplateIndex),
  writeJson(configDir, "aig_strategy_index.json", indexes.aigStrategyIndex),
  writeJson(generatedDir, "resources.generated.json", generated.resources),
  writeJson(generatedDir, "prompts.generated.json", generated.prompts),
  writeJson(generatedDir, "tool_responses.generated.json", generated.toolResponses),
  writeJson(generatedDir, "test_cases.generated.json", generated.testCases),
  writeJson(generatedDir, "test_oracles.generated.json", generated.testOracles),
  writeJson(generatedDir, "red_team_scenarios.generated.json", generated.redTeamScenarioSet),
  writeJson(generatedDir, "corpus_manifest.json", generated.manifest),
  writeJson(generatedDir, "corpus_stats.json", generated.stats),
]);

const issues = validateCorpus({
  projectRoot,
  ...seeds,
  ...indexes,
  resources: generated.resources,
  prompts: generated.prompts,
  toolResponses: generated.toolResponses,
  testCases: generated.testCases,
  testOracles: generated.testOracles,
  manifest: generated.manifest,
});

const errors = issues.filter((issue) => issue.severity === "error");
for (const issue of issues) {
  const prefix = issue.severity === "error" ? "FAIL" : "WARN";
  console.log(`${prefix}: ${issue.code} ${issue.path} - ${issue.message}`);
}
if (errors.length > 0) {
  process.exitCode = 1;
} else {
  console.log(
    `Generated P3-A corpus: ${generated.prompts.length} prompts, ${generated.testCases.length} cases, ${generated.testOracles.length} oracles.`,
  );
}

async function writeJson(dir: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildAttackGenerationProfiles(): unknown[] {
  return [
    {
      schemaVersion: "mvp-1",
      profileId: "generation.pyrit_primary",
      name: "PyRIT primary generation",
      description: "Use PyRIT dataset/template/converter/executor metadata as the main generator source.",
      sourceRatioTarget: { pyrit: 0.7, aig: 0.2, manualAndUserSupplied: 0.1 },
      maxMutationPerSeed: 6,
    },
    {
      schemaVersion: "mvp-1",
      profileId: "generation.aig_enhanced",
      name: "AIG strategy enhanced generation",
      description: "Use AIG skills, redteam strategies, and PromptSecurity enhancers as supplemental coverage.",
      sourceRatioTarget: { pyrit: 0.65, aig: 0.25, manualAndUserSupplied: 0.1 },
      maxMutationPerSeed: 4,
    },
  ];
}
