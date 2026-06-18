import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  buildCorpusSeeds,
  buildCorpusSourceIndexes,
  corpusOperatorFiles,
  corpusProfileFiles,
  corpusSeedFiles,
  corpusSourceFiles,
  generateCorpus,
  resolveCorpusLayout,
  validateCorpus,
} from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const layout = resolveCorpusLayout(projectRoot);

await Promise.all([
  mkdir(layout.seedDir, { recursive: true }),
  mkdir(layout.operatorDir, { recursive: true }),
  mkdir(layout.profileDir, { recursive: true }),
  mkdir(layout.sourceDir, { recursive: true }),
  mkdir(layout.generatedDir, { recursive: true }),
]);

const seeds = buildCorpusSeeds();
const indexes = await buildCorpusSourceIndexes(projectRoot);
const generated = generateCorpus(seeds, {
  generatedAt: "2026-06-18T00:00:00.000Z",
  generatorVersion: "p3-a-generator-2",
  maxCases: 2400,
});

await Promise.all([
  writeJson(layout.seedDir, corpusSeedFiles.resources, seeds.resourceSeeds),
  writeJson(layout.seedDir, corpusSeedFiles.attacks, seeds.attackSeeds),
  writeJson(layout.seedDir, corpusSeedFiles.userPrompts, seeds.userPromptSeeds),
  writeJson(layout.seedDir, corpusSeedFiles.toolResponses, seeds.toolResponseSeeds),
  writeJson(layout.operatorDir, corpusOperatorFiles.mutationOperators, seeds.mutationOperators),
  writeJson(layout.profileDir, corpusProfileFiles.attackGenerationProfiles, buildAttackGenerationProfiles()),
  writeJson(layout.profileDir, corpusProfileFiles.runProfiles, seeds.runProfiles),
  writeJson(layout.sourceDir, corpusSourceFiles.pyritSeedDatasets, indexes.pyritSeedDatasetIndex),
  writeJson(layout.sourceDir, corpusSourceFiles.pyritExecutors, indexes.pyritExecutorTemplateIndex),
  writeJson(layout.sourceDir, corpusSourceFiles.pyritScorers, indexes.pyritScorerTemplateIndex),
  writeJson(layout.sourceDir, corpusSourceFiles.aigStrategies, indexes.aigStrategyIndex),
  writeJson(layout.generatedDir, "resources.generated.json", generated.resources),
  writeJson(layout.generatedDir, "prompts.generated.json", generated.prompts),
  writeJson(layout.generatedDir, "tool_responses.generated.json", generated.toolResponses),
  writeJson(layout.generatedDir, "test_cases.generated.json", generated.testCases),
  writeJson(layout.generatedDir, "test_oracles.generated.json", generated.testOracles),
  writeJson(layout.generatedDir, "red_team_scenarios.generated.json", generated.redTeamScenarioSet),
  writeJson(layout.generatedDir, "corpus_manifest.json", generated.manifest),
  writeJson(layout.generatedDir, "corpus_stats.json", generated.stats),
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
