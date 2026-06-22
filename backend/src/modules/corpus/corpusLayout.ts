import { join } from "node:path";

export const corpusSeedFiles = {
  resources: "resource_seeds.json",
  attacks: "attack_seeds.json",
  userPrompts: "user_prompt_seeds.json",
  toolResponses: "tool_response_seeds.json",
} as const;

export const corpusOperatorFiles = {
  mutationOperators: "mutation_operators.json",
} as const;

export const corpusProfileFiles = {
  attackGenerationProfiles: "attack_generation_profiles.json",
  runProfiles: "corpus_run_profiles.json",
} as const;

export const corpusSourceFiles = {
  pyritAttackLibrary: "pyrit_attack_library.json",
  pyritJailbreakTemplates: "pyrit_jailbreak_template_index.json",
  pyritSeedDatasets: "pyrit_seed_dataset_index.json",
  pyritExecutors: "pyrit_executor_template_index.json",
  pyritScorers: "pyrit_scorer_template_index.json",
  aigStrategies: "aig_strategy_index.json",
} as const;

export function resolveCorpusLayout(projectRoot: string): {
  configRoot: string;
  seedDir: string;
  operatorDir: string;
  profileDir: string;
  sourceDir: string;
  generatedDir: string;
} {
  const configRoot = join(projectRoot, "configs", "a-line");
  return {
    configRoot,
    seedDir: join(configRoot, "corpus", "seeds"),
    operatorDir: join(configRoot, "corpus", "operators"),
    profileDir: join(configRoot, "corpus", "profiles"),
    sourceDir: join(configRoot, "sources"),
    generatedDir: join(projectRoot, "generated", "a-line"),
  };
}
