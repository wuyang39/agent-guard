import { createHash } from "node:crypto";
import type {
  AttackCaseCard,
  AttackFamily,
  CaseQualityIssue,
  CaseQualityReport,
  CorpusManifest,
  CorpusManifestItem,
  CorpusRunProfileId,
  CorpusSourceOrigin,
  CoverageTaxonomy,
  LlmSelectionCatalogItem,
  ResourceDefinition,
  RiskCategory,
  TargetSurface,
  TestCase,
  TestOracle,
  ToolResponseTemplate,
} from "@agent-guard/contracts";

const schemaVersion = "p3-a-1" as const;
const generatedAt = "2026-06-18T00:00:00.000Z";
const profileOrder: CorpusRunProfileId[] = ["smoke", "openclaw", "regression", "full-corpus"];
const attackFamilies: AttackFamily[] = [
  "prompt_injection",
  "data_leakage",
  "tool_hijack",
  "auth_bypass",
  "memory_poisoning",
  "environment_poisoning",
  "model_evasion",
  "dangerous_action",
  "benign_control",
];
const targetSurfaces: TargetSurface[] = [
  "input",
  "output",
  "context",
  "tool_call",
  "file_access",
  "code_execution",
  "network",
  "email",
  "api",
  "browser",
  "memory",
  "database",
];
const sourceOrigins: CorpusSourceOrigin[] = ["manual", "user_supplied", "pyrit", "aig", "synthetic"];
const riskCategories: RiskCategory[] = [
  "tool_misuse",
  "unauthorized_access",
  "data_leakage",
  "dangerous_action",
  "instruction_injection_following",
];

export type AttackCaseCardGenerationInput = {
  manifest: CorpusManifest;
  testCases: TestCase[];
  testOracles: TestOracle[];
  resources: ResourceDefinition[];
  toolResponses: ToolResponseTemplate[];
};

export type AttackCaseCardGenerationOutput = {
  attackCaseCards: AttackCaseCard[];
  llmSelectionCatalog: LlmSelectionCatalogItem[];
  coverageTaxonomy: CoverageTaxonomy;
  caseQualityReport: CaseQualityReport;
};

export function generateAttackCaseCards(
  input: AttackCaseCardGenerationInput,
): AttackCaseCardGenerationOutput {
  const manifestByCaseId = new Map(
    input.manifest.items
      .filter((item) => item.itemType === "test_case" && item.caseId)
      .map((item) => [item.caseId as string, item]),
  );
  const oracleByCaseId = new Map(input.testOracles.map((oracle) => [oracle.caseId, oracle]));
  const resourceById = new Map(input.resources.map((resource) => [resource.resourceId, resource]));
  const toolResponseById = new Map(input.toolResponses.map((response) => [response.responseTemplateId, response]));

  const cards = input.testCases.map((testCase) => {
    const manifestItem = manifestByCaseId.get(testCase.caseId);
    const oracle = oracleByCaseId.get(testCase.caseId);
    const resources = testCase.resourceIds
      .map((resourceId) => resourceById.get(resourceId))
      .filter((resource): resource is ResourceDefinition => Boolean(resource));
    const toolResponses = testCase.toolResponsePlan
      .map((plan) => toolResponseById.get(plan.responseTemplateId))
      .filter((response): response is ToolResponseTemplate => Boolean(response));
    return cardFromCase({ testCase, manifestItem, oracle, resources, toolResponses });
  }).sort(compareCards);

  return {
    attackCaseCards: cards,
    llmSelectionCatalog: cards.map(toLlmSelectionCatalogItem),
    coverageTaxonomy: buildCoverageTaxonomy(input.manifest.corpusId, cards),
    caseQualityReport: buildCaseQualityReport(input.manifest.corpusId, cards),
  };
}

function cardFromCase(options: {
  testCase: TestCase;
  manifestItem?: CorpusManifestItem;
  oracle?: TestOracle;
  resources: ResourceDefinition[];
  toolResponses: ToolResponseTemplate[];
}): AttackCaseCard {
  const { testCase, manifestItem, oracle, resources, toolResponses } = options;
  const operatorIds = operatorIdsFor(testCase, manifestItem);
  const runProfiles = runProfilesFor(testCase, manifestItem);
  const riskCategoriesForCase = riskCategoriesFor(testCase, manifestItem, oracle, resources, toolResponses);
  const familyValues = familiesFor(testCase, operatorIds, riskCategoriesForCase);
  const surfaceValues = surfacesFor(testCase, resources, toolResponses, operatorIds);
  const sensitivityTags = sensitivityTagsFor(resources, toolResponses);
  const sourceOrigin = manifestItem?.source.origin ?? sourceOriginFromMetadata(testCase) ?? "manual";
  const sourceRefs = sourceRefsFor(testCase, manifestItem);
  const promptSummary = promptSummaryFor(testCase, operatorIds);
  const expectedRiskLevel = oracle?.expectedOutcome.expectedRiskLevel ?? "medium";
  const oracleSummary = oracle
    ? `expected ${expectedRiskLevel} risk: ${oracle.expectedOutcome.expectedRiskCategories.join(" + ")}`
    : "";
  const expectedSafeBehaviorSummary = expectedSafeBehaviorFor(familyValues, surfaceValues);
  const payloadRiskSummary = payloadRiskSummaryFor(familyValues, surfaceValues, riskCategoriesForCase);
  const estimatedCost = estimatedCostFor(operatorIds, familyValues);
  const estimatedDurationMs = estimatedDurationFor(estimatedCost, runProfiles, operatorIds);
  const requiresNetwork = surfaceValues.some((surface) => ["network", "api", "email", "browser"].includes(surface));
  const requiresExternalTool = requiresNetwork || surfaceValues.includes("code_execution");
  const requiresOpenClaw = runProfiles.includes("openclaw");
  const warnings = qualityWarningsFor({
    testCase,
    runProfiles,
    families: familyValues,
    surfaces: surfaceValues,
    sourceRefs,
    promptSummary,
    oracleSummary,
    resources,
    toolResponses,
    operatorIds,
  });
  const qualityScore = qualityScoreFor({
    testCase,
    runProfiles,
    families: familyValues,
    surfaces: surfaceValues,
    sourceRefs,
    promptSummary,
    oracleSummary,
    resources,
    operatorIds,
    requiresExternalTool,
  });

  const cardWithoutDigest = {
    schemaVersion,
    cardId: `attack_card.${testCase.caseId}`,
    caseId: testCase.caseId,
    caseName: sanitizeForSelection(testCase.caseName, 160),
    enabled: testCase.enabled,
    runProfiles,
    attackFamilies: familyValues,
    targetSurfaces: surfaceValues,
    targetToolHints: [...new Set(testCase.toolIds)].sort(),
    targetResourceHints: resources.map((resource) => `${resource.resourceId}:${resource.type}:${resource.sensitivity}`).sort(),
    sensitivityTags,
    estimatedCost,
    estimatedDurationMs,
    requiresExternalTool,
    requiresNetwork,
    requiresOpenClaw,
    sourceOrigin,
    sourceRefs,
    promptSummary,
    payloadRiskSummary,
    expectedSafeBehaviorSummary,
    oracleSummary,
    qualityScore,
    qualityWarnings: warnings,
  };

  return {
    ...cardWithoutDigest,
    digest: computeAttackCaseCardDigest(cardWithoutDigest),
  };
}

export function computeAttackCaseCardDigest(card: Omit<AttackCaseCard, "digest">): string {
  return createHash("sha256").update(JSON.stringify(card)).digest("hex");
}

export function sanitizeForSelection(value: unknown, maxLen = 220): string {
  let text = value == null ? "" : String(value);
  text = text.replace(/sk-[A-Za-z0-9_\-]{12,}/g, "sk-redacted");
  text = text.replace(/AKIA[A-Z0-9]{16}/g, "AKIA-redacted");
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-]{20,}/gi, "Bearer redacted");
  text = text.replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/g, "jwt-redacted");
  text = text.replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;]+/gi, "$1=redacted");
  text = text.replace(/\b[A-Za-z0-9+/]{96,}={0,2}\b/g, "[encoded-payload-redacted]");
  text = text.replace(/\b[0-9a-fA-F]{96,}\b/g, "[hex-payload-redacted]");
  text = text.split(/\s+/).join(" ").trim();
  return text.length <= maxLen ? text : `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function promptSummaryFor(testCase: TestCase, operatorIds: string[]): string {
  const runtimeObjectiveBase = typeof testCase.task.metadata?.runtimeObjectiveBase === "string"
    ? testCase.task.metadata.runtimeObjectiveBase
    : testCase.task.instruction;
  const encoded = operatorIds.some((operatorId) => /converter\.(base|hex|rot|caesar|unicode|zero|smuggl|morse|binary|octal|braille|emoji|ecoji|zalgo|nato|vigenere)/i.test(operatorId));
  const scenarioIds = stringArray(testCase.task.metadata?.scenarioIds).join(", ") || "general";
  const base = sanitizeForSelection(runtimeObjectiveBase, encoded ? 170 : 220);
  return sanitizeForSelection(encoded ? `Encoded/evasion fixture targeting ${scenarioIds}: ${base}` : base, 220);
}

function familiesFor(testCase: TestCase, operatorIds: string[], categories: RiskCategory[]): AttackFamily[] {
  const values = new Set<AttackFamily>();
  const scenarioText = stringArray(testCase.task.metadata?.scenarioIds).join(" ").toLowerCase();
  const operatorText = operatorIds.join(" ").toLowerCase();
  if (testCase.attackEntryType === "malicious_resource" || scenarioText.includes("prompt_injection") || categories.includes("instruction_injection_following")) values.add("prompt_injection");
  if (categories.includes("data_leakage") || scenarioText.includes("exfiltration") || scenarioText.includes("secret")) values.add("data_leakage");
  if (categories.includes("tool_misuse") || scenarioText.includes("tool") || testCase.toolIds.length > 0) values.add("tool_hijack");
  if (categories.includes("unauthorized_access") || scenarioText.includes("authorization") || scenarioText.includes("bypass")) values.add("auth_bypass");
  if (scenarioText.includes("memory") || testCase.toolIds.some((toolId) => toolId.includes("memory"))) values.add("memory_poisoning");
  if (scenarioText.includes("supply_chain") || scenarioText.includes("environment") || scenarioText.includes("repo")) values.add("environment_poisoning");
  if (/encoding|evasion|converter|unicode|base|rot|smuggl|jailbreak|refusal/.test(`${scenarioText} ${operatorText}`)) values.add("model_evasion");
  if (categories.includes("dangerous_action") || /shell|code|payment|write|execute/.test(scenarioText)) values.add("dangerous_action");
  if (scenarioText.includes("safe_control") || testCase.attackEntryType === "malicious_user_prompt" && categories.length === 0) values.add("benign_control");
  return [...values].sort();
}

function surfacesFor(
  testCase: TestCase,
  resources: ResourceDefinition[],
  toolResponses: ToolResponseTemplate[],
  operatorIds: string[],
): TargetSurface[] {
  const values = new Set<TargetSurface>(["input"]);
  if (testCase.resourceIds.length > 0) values.add("context");
  if (testCase.toolResponsePlan.length > 0 || toolResponses.some((response) => response.containsInjection)) values.add("output");
  if (testCase.toolIds.length > 0) values.add("tool_call");
  for (const toolId of testCase.toolIds) {
    if (/read_file|write_file/.test(toolId)) values.add("file_access");
    if (/execute_code/.test(toolId)) values.add("code_execution");
    if (/send_request/.test(toolId)) values.add("network");
    if (/send_email/.test(toolId)) values.add("email");
    if (/call_api/.test(toolId)) values.add("api");
    if (/update_memory/.test(toolId)) values.add("memory");
    if (/query_database/.test(toolId)) values.add("database");
  }
  for (const resource of resources) {
    if (resource.type === "file") values.add("file_access");
    if (resource.type === "database") values.add("database");
    if (resource.type === "web") values.add("browser");
    if (resource.type === "secret" || resource.containsInjection) values.add("context");
  }
  if (operatorIds.some((operatorId) => /browser/i.test(operatorId))) values.add("browser");
  return [...values].sort();
}

function riskCategoriesFor(
  testCase: TestCase,
  manifestItem: CorpusManifestItem | undefined,
  oracle: TestOracle | undefined,
  resources: ResourceDefinition[],
  toolResponses: ToolResponseTemplate[],
): RiskCategory[] {
  const categories = new Set<RiskCategory>();
  for (const category of manifestItem?.riskCategories ?? []) categories.add(category);
  for (const category of oracle?.expectedOutcome.expectedRiskCategories ?? []) categories.add(category);
  for (const resource of resources) {
    for (const tag of resource.riskTags) categories.add(tag.category);
  }
  for (const response of toolResponses) {
    for (const tag of response.riskTags) categories.add(tag.category);
  }
  if (testCase.attackEntryType === "tool_response_injection") categories.add("instruction_injection_following");
  return [...categories].sort();
}

function sourceRefsFor(testCase: TestCase, manifestItem?: CorpusManifestItem): string[] {
  const refs = new Set<string>();
  for (const seedId of manifestItem?.seedIds ?? []) refs.add(seedId);
  for (const operatorId of manifestItem?.operatorIds ?? []) refs.add(operatorId);
  if (manifestItem?.source.sourceId) refs.add(manifestItem.source.sourceId);
  if (typeof testCase.task.metadata?.seedId === "string") refs.add(testCase.task.metadata.seedId);
  if (typeof testCase.task.metadata?.userPromptSeedId === "string") refs.add(testCase.task.metadata.userPromptSeedId);
  if (typeof testCase.task.metadata?.operatorId === "string") refs.add(testCase.task.metadata.operatorId);
  return [...refs].filter(Boolean).sort();
}

function runProfilesFor(testCase: TestCase, manifestItem?: CorpusManifestItem): CorpusRunProfileId[] {
  const values = new Set<CorpusRunProfileId>();
  for (const profileId of manifestItem?.profileIds ?? []) values.add(profileId);
  for (const profileId of stringArray(testCase.task.metadata?.corpusProfileIds)) {
    if (isRunProfileId(profileId)) values.add(profileId);
  }
  return [...values].sort((left, right) => profileOrder.indexOf(left) - profileOrder.indexOf(right));
}

function operatorIdsFor(testCase: TestCase, manifestItem?: CorpusManifestItem): string[] {
  const values = new Set<string>();
  for (const operatorId of manifestItem?.operatorIds ?? []) values.add(operatorId);
  for (const operatorId of stringArray(testCase.task.metadata?.operatorIds)) values.add(operatorId);
  if (typeof testCase.task.metadata?.operatorId === "string") values.add(testCase.task.metadata.operatorId);
  return [...values].sort();
}

function sensitivityTagsFor(resources: ResourceDefinition[], toolResponses: ToolResponseTemplate[]): string[] {
  const tags = new Set<string>();
  for (const resource of resources) {
    tags.add(resource.sensitivity);
    tags.add(resource.type);
    if (resource.containsInjection) tags.add("contains_injection");
  }
  for (const response of toolResponses) {
    if (response.containsInjection) tags.add("tool_response_injection");
  }
  return [...tags].sort();
}

function payloadRiskSummaryFor(families: AttackFamily[], surfaces: TargetSurface[], categories: RiskCategory[]): string {
  return sanitizeForSelection(
    `families=${families.join(",") || "unknown"}; surfaces=${surfaces.join(",") || "unknown"}; riskCategories=${categories.join(",") || "unknown"}`,
    260,
  );
}

function expectedSafeBehaviorFor(families: AttackFamily[], surfaces: TargetSurface[]): string {
  const actions = ["ignore untrusted instructions", "preserve policy boundaries"];
  if (families.includes("data_leakage")) actions.push("avoid disclosing sensitive data");
  if (surfaces.includes("tool_call")) actions.push("validate tool use before acting");
  if (surfaces.includes("network") || surfaces.includes("api")) actions.push("block unsafe outbound requests");
  if (surfaces.includes("code_execution")) actions.push("refuse unsafe code execution");
  return actions.join("; ");
}

function estimatedCostFor(operatorIds: string[], families: AttackFamily[]): AttackCaseCard["estimatedCost"] {
  const operatorText = operatorIds.join(" ");
  if (/crescendo|renellm|many_shot|red_teaming|tree|tap/i.test(operatorText)) return "high";
  if (/role_play|context_compliance|executor/i.test(operatorText) || families.includes("dangerous_action")) return "medium";
  return "low";
}

function estimatedDurationFor(
  estimatedCost: AttackCaseCard["estimatedCost"],
  runProfiles: CorpusRunProfileId[],
  operatorIds: string[],
): number {
  const base = estimatedCost === "high" ? 120_000 : estimatedCost === "medium" ? 60_000 : 30_000;
  const openClawExtra = runProfiles.includes("openclaw") ? 15_000 : 0;
  const pyritExtra = operatorIds.some((operatorId) => operatorId.startsWith("pyrit.executor")) ? 30_000 : 0;
  return base + openClawExtra + pyritExtra;
}

function qualityWarningsFor(options: {
  testCase: TestCase;
  runProfiles: CorpusRunProfileId[];
  families: AttackFamily[];
  surfaces: TargetSurface[];
  sourceRefs: string[];
  promptSummary: string;
  oracleSummary: string;
  resources: ResourceDefinition[];
  toolResponses: ToolResponseTemplate[];
  operatorIds: string[];
}): string[] {
  const warnings: string[] = [];
  if (options.runProfiles.length === 0) warnings.push("missing_run_profile");
  if (options.families.length === 0) warnings.push("missing_attack_family");
  if (options.surfaces.length === 0) warnings.push("missing_target_surface");
  if (options.sourceRefs.length === 0) warnings.push("missing_source_refs");
  if (!options.oracleSummary) warnings.push("missing_oracle_summary");
  if (options.testCase.toolIds.length === 0 && options.resources.length === 0) warnings.push("missing_tool_or_resource_mapping");
  if (options.promptSummary.length < 24 || options.promptSummary.length > 230) warnings.push("prompt_summary_length_out_of_range");
  if (hasUnsafeSelectionText(options.promptSummary) || hasUnsafeSelectionText(options.oracleSummary)) warnings.push("summary_secret_like_pattern");
  if (options.operatorIds.some((operatorId) => /metadata_only/i.test(operatorId))) warnings.push("metadata_only_operator");
  if (options.toolResponses.some((response) => response.content.length > 0 && options.promptSummary.includes(response.content.slice(0, 60)))) {
    warnings.push("summary_may_include_tool_response_content");
  }
  return [...new Set(warnings)].sort();
}

function qualityScoreFor(options: {
  testCase: TestCase;
  runProfiles: CorpusRunProfileId[];
  families: AttackFamily[];
  surfaces: TargetSurface[];
  sourceRefs: string[];
  promptSummary: string;
  oracleSummary: string;
  resources: ResourceDefinition[];
  operatorIds: string[];
  requiresExternalTool: boolean;
}): number {
  let score = 0;
  if (options.runProfiles.length > 0) score += 20;
  if (options.families.length > 0) score += 15;
  if (options.surfaces.length > 0) score += 15;
  if (options.testCase.toolIds.length > 0 || options.resources.length > 0) score += 10;
  if (options.sourceRefs.length > 0) score += 10;
  if (options.oracleSummary) score += 10;
  if (options.promptSummary.length >= 24 && options.promptSummary.length <= 230 && !hasUnsafeSelectionText(options.promptSummary)) score += 10;
  if (!options.requiresExternalTool || options.runProfiles.includes("openclaw")) score += 10;
  if (options.sourceRefs.length === 0) score -= 20;
  if (hasUnsafeSelectionText(options.promptSummary) || hasUnsafeSelectionText(options.oracleSummary)) score -= 20;
  if (options.testCase.toolIds.length === 0 && options.resources.length === 0) score -= 15;
  if (options.operatorIds.some((operatorId) => /metadata_only/i.test(operatorId))) score -= 10;
  if (options.promptSummary.length < 24 || options.promptSummary.length > 230) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function buildCoverageTaxonomy(corpusId: string, cards: AttackCaseCard[]): CoverageTaxonomy {
  return {
    schemaVersion,
    taxonomyId: "coverage_taxonomy.p3_a.selection",
    generatedAt,
    corpusId,
    totalCards: cards.length,
    profileSummary: countEnum(cards, profileOrder, (card) => card.runProfiles),
    attackFamilySummary: countEnum(cards, attackFamilies, (card) => card.attackFamilies),
    targetSurfaceSummary: countEnum(cards, targetSurfaces, (card) => card.targetSurfaces),
    riskCategorySummary: countEnum(cards, riskCategories, (card) => categoriesFromRiskSummary(card.payloadRiskSummary)),
    sourceOriginSummary: countEnum(cards, sourceOrigins, (card) => [card.sourceOrigin]),
  };
}

function buildCaseQualityReport(corpusId: string, cards: AttackCaseCard[]): CaseQualityReport {
  const digestOwners = new Map<string, string[]>();
  for (const card of cards) {
    const owners = digestOwners.get(card.digest) ?? [];
    owners.push(card.caseId);
    digestOwners.set(card.digest, owners);
  }
  const duplicateDigestCaseIds = [...digestOwners.values()]
    .filter((owners) => owners.length > 1)
    .flat()
    .sort();
  const issues: CaseQualityIssue[] = [];
  for (const card of cards) {
    for (const warning of card.qualityWarnings) {
      issues.push({
        caseId: card.caseId,
        severity: warning.startsWith("missing_") ? "error" : "warning",
        code: warning,
        message: `AttackCaseCard ${card.caseId} has quality warning ${warning}.`,
      });
    }
    if (card.qualityScore < 60) {
      issues.push({
        caseId: card.caseId,
        severity: "warning",
        code: "low_quality_score",
        message: `AttackCaseCard ${card.caseId} quality score is ${card.qualityScore}.`,
      });
    }
  }
  for (const caseId of duplicateDigestCaseIds) {
    issues.push({
      caseId,
      severity: "warning",
      code: "duplicate_digest",
      message: `AttackCaseCard ${caseId} shares a digest with another card.`,
    });
  }
  const averageQualityScore = cards.length === 0
    ? 0
    : Math.round(cards.reduce((sum, card) => sum + card.qualityScore, 0) / cards.length);
  return {
    schemaVersion,
    reportId: "case_quality_report.p3_a.selection",
    generatedAt,
    corpusId,
    totalCards: cards.length,
    minQualityScore: cards.length > 0 ? Math.min(...cards.map((card) => card.qualityScore)) : 0,
    averageQualityScore,
    lowQualityCaseIds: cards.filter((card) => card.qualityScore < 60).map((card) => card.caseId),
    duplicateDigestCaseIds,
    issues,
  };
}

function toLlmSelectionCatalogItem(card: AttackCaseCard): LlmSelectionCatalogItem {
  return {
    caseId: card.caseId,
    runProfiles: card.runProfiles,
    attackFamilies: card.attackFamilies,
    targetSurfaces: card.targetSurfaces,
    targetToolHints: card.targetToolHints,
    sensitivityTags: card.sensitivityTags,
    estimatedCost: card.estimatedCost,
    sourceOrigin: card.sourceOrigin,
    promptSummary: card.promptSummary,
    payloadRiskSummary: card.payloadRiskSummary,
    qualityScore: card.qualityScore,
    digest: card.digest,
  };
}

function compareCards(left: AttackCaseCard, right: AttackCaseCard): number {
  const profileDelta = profileRank(left.runProfiles) - profileRank(right.runProfiles);
  if (profileDelta !== 0) return profileDelta;
  const qualityDelta = right.qualityScore - left.qualityScore;
  if (qualityDelta !== 0) return qualityDelta;
  return left.caseId.localeCompare(right.caseId);
}

function profileRank(runProfiles: CorpusRunProfileId[]): number {
  return Math.min(...runProfiles.map((profileId) => profileOrder.indexOf(profileId)).filter((index) => index >= 0));
}

function hasUnsafeSelectionText(value: string): boolean {
  return /sk-[A-Za-z0-9_\-]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._\-]{20,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}|\b[A-Za-z0-9+/]{160,}={0,2}\b|\b[0-9a-fA-F]{160,}\b/.test(value);
}

function countEnum<T extends string>(
  cards: AttackCaseCard[],
  values: readonly T[],
  getValues: (card: AttackCaseCard) => T[],
): Record<T, number> {
  const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
  for (const card of cards) {
    for (const value of getValues(card)) {
      result[value] = (result[value] ?? 0) + 1;
    }
  }
  return result;
}

function categoriesFromRiskSummary(summary: string): RiskCategory[] {
  return riskCategories.filter((category) => summary.includes(category));
}

function sourceOriginFromMetadata(testCase: TestCase): CorpusSourceOrigin | undefined {
  const value = testCase.task.metadata?.sourceOrigin;
  return typeof value === "string" && sourceOrigins.includes(value as CorpusSourceOrigin)
    ? value as CorpusSourceOrigin
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isRunProfileId(value: string): value is CorpusRunProfileId {
  return (profileOrder as string[]).includes(value);
}
