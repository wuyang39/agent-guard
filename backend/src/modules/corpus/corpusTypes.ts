import type {
  AigStrategyIndex,
  AttackSeed,
  CorpusManifest,
  CorpusRunProfile,
  CorpusRunProfileId,
  MutationOperatorSpec,
  PromptDefinition,
  PyritExecutorTemplateIndex,
  PyritScorerTemplateIndex,
  PyritSeedDatasetIndex,
  RedTeamScenarioSet,
  ResourceDefinition,
  ResourceSeed,
  SchemaVersion,
  TestCase,
  TestOracle,
  ToolResponseSeed,
  ToolResponseTemplate,
  UserPromptSeed,
} from "@agent-guard/contracts";

export type CorpusSeedBundle = {
  resourceSeeds: ResourceSeed[];
  attackSeeds: AttackSeed[];
  userPromptSeeds: UserPromptSeed[];
  toolResponseSeeds: ToolResponseSeed[];
  mutationOperators: MutationOperatorSpec[];
  runProfiles: CorpusRunProfile[];
};

export type CorpusSourceIndexes = {
  pyritSeedDatasetIndex: PyritSeedDatasetIndex;
  pyritExecutorTemplateIndex: PyritExecutorTemplateIndex;
  pyritScorerTemplateIndex: PyritScorerTemplateIndex;
  aigStrategyIndex: AigStrategyIndex;
};

export type GeneratedCorpus = {
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponses: ToolResponseTemplate[];
  testCases: TestCase[];
  testOracles: TestOracle[];
  redTeamScenarioSet: RedTeamScenarioSet;
  manifest: CorpusManifest;
  stats: CorpusStats;
};

export type CorpusStats = {
  schemaVersion: SchemaVersion;
  corpusId: string;
  generatedAt: string;
  totalResources: number;
  totalPrompts: number;
  totalToolResponses: number;
  totalTestCases: number;
  totalTestOracles: number;
  totalMutationOperators: number;
  totalResourceSeeds: number;
  totalAttackSeeds: number;
  totalUserPromptSeeds: number;
  totalToolResponseSeeds: number;
  sourceSummary: CorpusManifest["sourceSummary"];
  profileSummary: CorpusManifest["profileSummary"];
  coverage: CorpusManifest["coverage"];
};

export type GeneratedCorpusSelection = {
  profileId: CorpusRunProfileId;
  profile: CorpusRunProfile;
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponses: ToolResponseTemplate[];
  testCases: TestCase[];
  testOracles: TestOracle[];
  manifest: CorpusManifest;
};

export type CorpusGenerationOptions = {
  generatedAt?: string;
  generatorVersion?: string;
  maxCases?: number;
};
