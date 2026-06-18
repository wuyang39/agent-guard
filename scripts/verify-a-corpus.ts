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
import {
  corpusOperatorFiles,
  corpusProfileFiles,
  corpusSeedFiles,
  corpusSourceFiles,
  loadGeneratedCorpusProfile,
  resolveCorpusLayout,
  validateCorpus,
} from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const layout = resolveCorpusLayout(projectRoot);

const input = {
  projectRoot,
  resourceSeeds: await readJson<ResourceSeed[]>(layout.seedDir, corpusSeedFiles.resources),
  attackSeeds: await readJson<AttackSeed[]>(layout.seedDir, corpusSeedFiles.attacks),
  toolResponseSeeds: await readJson<ToolResponseSeed[]>(layout.seedDir, corpusSeedFiles.toolResponses),
  mutationOperators: await readJson<MutationOperatorSpec[]>(layout.operatorDir, corpusOperatorFiles.mutationOperators),
  runProfiles: await readJson<CorpusRunProfile[]>(layout.profileDir, corpusProfileFiles.runProfiles),
  pyritSeedDatasetIndex: await readJson<PyritSeedDatasetIndex>(layout.sourceDir, corpusSourceFiles.pyritSeedDatasets),
  pyritExecutorTemplateIndex: await readJson<PyritExecutorTemplateIndex>(layout.sourceDir, corpusSourceFiles.pyritExecutors),
  pyritScorerTemplateIndex: await readJson<PyritScorerTemplateIndex>(layout.sourceDir, corpusSourceFiles.pyritScorers),
  aigStrategyIndex: await readJson<AigStrategyIndex>(layout.sourceDir, corpusSourceFiles.aigStrategies),
  resources: await readJson<ResourceDefinition[]>(layout.generatedDir, "resources.generated.json"),
  prompts: await readJson<PromptDefinition[]>(layout.generatedDir, "prompts.generated.json"),
  toolResponses: await readJson<ToolResponseTemplate[]>(layout.generatedDir, "tool_responses.generated.json"),
  testCases: await readJson<TestCase[]>(layout.generatedDir, "test_cases.generated.json"),
  testOracles: await readJson<TestOracle[]>(layout.generatedDir, "test_oracles.generated.json"),
  manifest: await readJson<CorpusManifest>(layout.generatedDir, "corpus_manifest.json"),
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
  for (const profile of input.runProfiles) {
    const selection = await loadGeneratedCorpusProfile(projectRoot, profile.profileId);
    assert(
      selection.testCases.length === profile.maxCases,
      `Profile ${profile.profileId} should select ${profile.maxCases} cases, got ${selection.testCases.length}.`,
    );
    assert(
      selection.testOracles.length === selection.testCases.length,
      `Profile ${profile.profileId} should select one oracle per case.`,
    );
    assert(selection.resources.length > 0, `Profile ${profile.profileId} should include resources.`);
    assert(selection.prompts.length === selection.testCases.length, `Profile ${profile.profileId} should include prompts.`);
  }
  console.log("PASS: P3-A generated corpus validation passed.");
  console.log(
    `Corpus stats: resources=${input.resources.length}, prompts=${input.prompts.length}, cases=${input.testCases.length}, oracles=${input.testOracles.length}, mutationOperators=${input.mutationOperators.length}`,
  );
}

async function readJson<T>(dir: string, fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, fileName), "utf8")) as T;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
