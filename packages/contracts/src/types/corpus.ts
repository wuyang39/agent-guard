import type {
  AttackEntryType,
  JsonObject,
  RiskCategory,
  SchemaVersion,
} from "./common";

export type CorpusSourceOrigin =
  | "manual"
  | "user_supplied"
  | "pyrit"
  | "aig"
  | "synthetic";

export type CorpusExecutionMode =
  | "native_ts_adapter"
  | "pyrit_python_bridge"
  | "template_render"
  | "metadata_only";

export type CorpusRunProfileId =
  | "smoke"
  | "openclaw"
  | "regression"
  | "full-corpus";

export type AttackFamily =
  | "prompt_injection"
  | "data_leakage"
  | "tool_hijack"
  | "auth_bypass"
  | "memory_poisoning"
  | "environment_poisoning"
  | "model_evasion"
  | "dangerous_action"
  | "benign_control";

export type TargetSurface =
  | "input"
  | "output"
  | "context"
  | "tool_call"
  | "file_access"
  | "code_execution"
  | "network"
  | "email"
  | "api"
  | "browser"
  | "memory"
  | "database";

export type SeedSource = {
  origin: CorpusSourceOrigin;
  sourcePath?: string;
  sourceId?: string;
  licenseHint?: string;
  notes?: string;
};

export type ResourceSeed = {
  schemaVersion: SchemaVersion;
  seedId: string;
  name: string;
  resourceType:
    | "document"
    | "file"
    | "secret"
    | "database"
    | "web"
    | "memory"
    | "api"
    | "browser"
    | "email"
    | "calendar"
    | "repo"
    | "ticket"
    | "payment";
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  domain:
    | "rag"
    | "filesystem"
    | "cloud"
    | "identity"
    | "api"
    | "crm"
    | "support"
    | "finance"
    | "devops"
    | "browser"
    | "memory"
    | "email";
  contentTemplate?: string;
  containsInjection: boolean;
  injectionMarkers: string[];
  secretMarkers: string[];
  allowedUseCases: string[];
  riskTagIds: string[];
  source: SeedSource;
  metadata?: JsonObject;
};

export type AttackSeed = {
  schemaVersion: SchemaVersion;
  seedId: string;
  name: string;
  objective: string;
  userPrompt: string;
  attackEntryType: AttackEntryType;
  targetToolIds: string[];
  targetResourceSeedIds: string[];
  riskCategories: RiskCategory[];
  scenarioIds: string[];
  strategyTags: string[];
  pyrit: {
    templateIds: string[];
    converterIds: string[];
    executorTemplateIds: string[];
    scorerTemplateIds: string[];
  };
  source: SeedSource;
  metadata?: JsonObject;
};

export type UserPromptSeed = {
  schemaVersion: SchemaVersion;
  seedId: string;
  name: string;
  promptTemplate: string;
  intent:
    | "direct_task"
    | "ambiguous_task"
    | "roleplay"
    | "delegated_authority"
    | "multi_turn_setup"
    | "benign_control";
  ambiguityLevel: "none" | "low" | "medium" | "high";
  persona?:
    | "security_auditor"
    | "game_master"
    | "movie_script_writer"
    | "compliance_reviewer"
    | "support_operator"
    | "developer_debugger"
    | "executive_assistant"
    | "student_researcher";
  applicableScenarioIds: string[];
  preferredOperatorIds: string[];
  pyrit: {
    templateIds: string[];
    converterIds: string[];
    executorTemplateIds: string[];
  };
  source: SeedSource;
  metadata?: JsonObject;
};

export type ToolResponseSeed = {
  schemaVersion: SchemaVersion;
  seedId: string;
  toolId: string;
  name: string;
  contentTemplate: string;
  containsInjection: boolean;
  responseClass:
    | "benign"
    | "instruction_injection"
    | "secret_leak"
    | "debug_leak"
    | "auth_bypass"
    | "tool_rug_pull";
  riskTagIds: string[];
  source: SeedSource;
  metadata?: JsonObject;
};

export type MutationOperatorSpec = {
  schemaVersion: SchemaVersion;
  operatorId: string;
  name: string;
  family:
    | "encoding"
    | "unicode"
    | "obfuscation"
    | "roleplay"
    | "instruction_split"
    | "multi_turn"
    | "context_poison"
    | "tool_response"
    | "language"
    | "format";
  executionMode: CorpusExecutionMode;
  source: SeedSource;
  deterministic: boolean;
  maxFanout: number;
  tags: string[];
  description: string;
  metadata?: JsonObject;
};

export type PyritBridgeMode = "converter_batch" | "attack_cli";

export type PyritBridgeRuntimeUsed = "pyrit" | "fallback" | "not_executed";

export type PyritBridgeItemStatus = "ok" | "unsupported" | "error" | "skipped";

export type PyritAttackMethod =
  | "prompt_sending"
  | "flip"
  | "red_teaming"
  | "crescendo"
  | "context_compliance"
  | "role_play"
  | "many_shot_jailbreak"
  | "renellm";

export type PyritBridgeRequestItem = {
  itemId: string;
  operatorId: string;
  input: string;
  inputType?: "text";
  method?: PyritAttackMethod;
  objective?: string;
  maxTurns?: number;
  renellmMaxRounds?: number;
  renellmRewriteStyle?:
    | "shorten_sentence"
    | "misrewrite_sentence"
    | "change_order"
    | "add_char"
    | "language_mix"
    | "style_change"
    | "random";
  evaluatorSync?: boolean;
  metadata?: JsonObject;
};

export type PyritBridgeRequest = {
  schemaVersion: SchemaVersion;
  bridgeVersion: string;
  requestId: string;
  mode: PyritBridgeMode;
  generatedAt: string;
  items: PyritBridgeRequestItem[];
  options?: JsonObject;
};

export type PyritBridgeResultItem = {
  itemId: string;
  operatorId: string;
  status: PyritBridgeItemStatus;
  input: string;
  output?: string;
  outputType?: string;
  converterClass?: string;
  method?: PyritAttackMethod;
  objective?: string;
  outputJsonPath?: string;
  executedTurns?: number;
  outcome?: string;
  outcomeReason?: string;
  lastScore?: JsonObject;
  lastResponsePreview?: string;
  runtimeUsed: PyritBridgeRuntimeUsed;
  notes: string[];
  error?: string;
  metadata?: JsonObject;
};

export type PyritBridgeResult = {
  schemaVersion: SchemaVersion;
  bridgeVersion: string;
  requestId: string;
  mode: PyritBridgeMode;
  generatedAt: string;
  startedAt: string;
  endedAt: string;
  pythonExecutable?: string;
  pyritAvailable: boolean;
  modelConfigured?: boolean;
  fallbackAllowed: boolean;
  items: PyritBridgeResultItem[];
  errors: string[];
  metadata?: JsonObject;
};

export type CorpusRunProfile = {
  schemaVersion: SchemaVersion;
  profileId: CorpusRunProfileId;
  name: string;
  description: string;
  maxCases: number;
  includeSources: CorpusSourceOrigin[];
  includeOperatorFamilies: MutationOperatorSpec["family"][];
  includeScenarioIds: string[];
  allowPythonBridge: boolean;
  stableForAutomation: boolean;
};

export type SourceIndexEntry = {
  sourceId: string;
  name: string;
  sourcePath: string;
  sourceType: string;
  origin: CorpusSourceOrigin;
  tags: string[];
  sha256?: string;
  byteLength?: number;
  metadata?: JsonObject;
};

export type PyritSeedDatasetIndex = {
  schemaVersion: SchemaVersion;
  indexId: string;
  generatedAt: string;
  sourceRoot: string;
  datasets: SourceIndexEntry[];
};

export type PyritExecutorTemplateIndex = {
  schemaVersion: SchemaVersion;
  indexId: string;
  generatedAt: string;
  sourceRoot: string;
  executors: SourceIndexEntry[];
};

export type PyritScorerTemplateIndex = {
  schemaVersion: SchemaVersion;
  indexId: string;
  generatedAt: string;
  sourceRoot: string;
  scorers: SourceIndexEntry[];
};

export type AigStrategyIndex = {
  schemaVersion: SchemaVersion;
  indexId: string;
  generatedAt: string;
  sourceRoot: string;
  strategies: SourceIndexEntry[];
};

export type CorpusManifestItem = {
  generatedId: string;
  itemType: "prompt" | "resource" | "tool_response" | "test_case" | "oracle";
  profileIds: CorpusRunProfileId[];
  source: SeedSource;
  seedIds: string[];
  operatorIds: string[];
  caseId?: string;
  promptId?: string;
  resourceId?: string;
  oracleId?: string;
  scenarioIds: string[];
  riskCategories: RiskCategory[];
  sha256: string;
};

export type CorpusCoverageSummary = {
  riskCategories: Record<string, number>;
  attackEntryTypes: Record<string, number>;
  tools: Record<string, number>;
  resources: Record<string, number>;
  scenarios: Record<string, number>;
  mutationOperators: Record<string, number>;
};

export type CorpusManifest = {
  schemaVersion: SchemaVersion;
  corpusId: string;
  generatedAt: string;
  generatorVersion: string;
  sourceSummary: Record<CorpusSourceOrigin, number>;
  profileSummary: Record<CorpusRunProfileId, number>;
  coverage: CorpusCoverageSummary;
  items: CorpusManifestItem[];
};

export type AttackCaseCard = {
  schemaVersion: SchemaVersion;
  cardId: string;
  caseId: string;
  caseName: string;
  enabled: boolean;
  runProfiles: CorpusRunProfileId[];
  attackFamilies: AttackFamily[];
  targetSurfaces: TargetSurface[];
  targetToolHints: string[];
  targetResourceHints: string[];
  sensitivityTags: string[];
  estimatedCost: "low" | "medium" | "high";
  estimatedDurationMs: number;
  requiresExternalTool: boolean;
  requiresNetwork: boolean;
  requiresOpenClaw: boolean;
  sourceOrigin: CorpusSourceOrigin;
  sourceRefs: string[];
  promptSummary: string;
  payloadRiskSummary: string;
  expectedSafeBehaviorSummary: string;
  oracleSummary: string;
  qualityScore: number;
  qualityWarnings: string[];
  digest: string;
};

export type LlmSelectionCatalogItem = Pick<
  AttackCaseCard,
  | "caseId"
  | "runProfiles"
  | "attackFamilies"
  | "targetSurfaces"
  | "targetToolHints"
  | "sensitivityTags"
  | "estimatedCost"
  | "sourceOrigin"
  | "promptSummary"
  | "payloadRiskSummary"
  | "qualityScore"
  | "digest"
>;

export type CoverageTaxonomy = {
  schemaVersion: SchemaVersion;
  taxonomyId: string;
  generatedAt: string;
  corpusId: string;
  totalCards: number;
  profileSummary: Record<CorpusRunProfileId, number>;
  attackFamilySummary: Record<AttackFamily, number>;
  targetSurfaceSummary: Record<TargetSurface, number>;
  riskCategorySummary: Record<RiskCategory, number>;
  sourceOriginSummary: Record<CorpusSourceOrigin, number>;
};

export type CaseQualityIssue = {
  caseId: string;
  severity: "warning" | "error";
  code: string;
  message: string;
};

export type CaseQualityReport = {
  schemaVersion: SchemaVersion;
  reportId: string;
  generatedAt: string;
  corpusId: string;
  totalCards: number;
  minQualityScore: number;
  averageQualityScore: number;
  lowQualityCaseIds: string[];
  duplicateDigestCaseIds: string[];
  issues: CaseQualityIssue[];
};
