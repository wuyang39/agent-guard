import { createHash } from "node:crypto";
import type {
  AttackSeed,
  CorpusManifest,
  CorpusManifestItem,
  CorpusRunProfileId,
  PromptDefinition,
  RedTeamScenarioSet,
  ResourceDefinition,
  ResourceSeed,
  RiskCategory,
  RiskLevel,
  RiskTag,
  TestCase,
  TestOracle,
  ToolResponseSeed,
  ToolResponseTemplate,
} from "@agent-guard/contracts";
import type {
  CorpusGenerationOptions,
  CorpusSeedBundle,
  GeneratedCorpus,
} from "./corpusTypes";
import { applyMutationOperator } from "./mutationOperators";

const schemaVersion = "mvp-1" as const;
const defaultGeneratedAt = "2026-06-18T00:00:00.000Z";

export function generateCorpus(
  seeds: CorpusSeedBundle,
  options: CorpusGenerationOptions = {},
): GeneratedCorpus {
  const generatedAt = options.generatedAt ?? defaultGeneratedAt;
  const generatorVersion = options.generatorVersion ?? "p3-a-generator-2";
  const maxCases = options.maxCases ?? 2400;
  const resources = seeds.resourceSeeds.map((seed, index) => resourceFromSeed(seed, index));
  const toolResponses = seeds.toolResponseSeeds.map((seed, index) => toolResponseFromSeed(seed, index));
  const prompts: PromptDefinition[] = [];
  const testCases: TestCase[] = [];
  const testOracles: TestOracle[] = [];
  const manifestItems: CorpusManifestItem[] = [];
  const scenarioCaseIds = new Map<string, string[]>();
  const operatorsByPriority = [
    ...seeds.mutationOperators.filter((operator) => operator.source.origin === "pyrit"),
    ...seeds.mutationOperators.filter((operator) => operator.source.origin === "aig"),
    ...seeds.mutationOperators.filter((operator) => operator.source.origin !== "pyrit" && operator.source.origin !== "aig"),
  ];

  for (let generatedIndex = 0; generatedIndex < maxCases; generatedIndex += 1) {
      const attackSeed = seeds.attackSeeds[generatedIndex % seeds.attackSeeds.length];
      const offset = Math.floor(generatedIndex / seeds.attackSeeds.length);
      const operator = operatorsByPriority[(generatedIndex + offset) % operatorsByPriority.length];
      const mutation = applyMutationOperator(operator, attackSeed.userPrompt);
      const sourceOrigin = operator.source.origin;
      const promptId = `prompt.generated.${String(generatedIndex + 1).padStart(5, "0")}`;
      const caseId = `case.generated.${String(generatedIndex + 1).padStart(5, "0")}`;
      const oracleId = `oracle.generated.${String(generatedIndex + 1).padStart(5, "0")}`;
      const resource = resources[generatedIndex % resources.length];
      const response = toolResponses.find((item) => attackSeed.targetToolIds.includes(item.toolId))
        ?? toolResponses[generatedIndex % toolResponses.length];
      const profileIds = profileIdsFor(generatedIndex);
      const prompt: PromptDefinition = {
        promptId,
        name: `${attackSeed.name} via ${operator.name}`,
        description: `Generated P3-A prompt from ${attackSeed.seedId} and ${operator.operatorId}.`,
        attackEntryType: attackSeed.attackEntryType,
        content: mutation.output,
        riskTags: riskTagsFor(attackSeed.riskCategories, `generated_prompt_${generatedIndex + 1}`),
      };
      const testCase: TestCase = {
        schemaVersion,
        caseId,
        caseName: `Generated ${attackSeed.name} ${operator.name}`,
        description: `Generated corpus case from seed ${attackSeed.seedId}; source=${sourceOrigin}; operator=${operator.operatorId}.`,
        attackEntryType: attackSeed.attackEntryType,
        task: {
          taskId: `task.generated.${String(generatedIndex + 1).padStart(5, "0")}`,
          caseId,
          instruction: mutation.output,
          promptIds: [promptId],
          resourceIds: [resource.resourceId],
          metadata: {
            corpusProfileIds: profileIds,
            sourceOrigin,
            seedId: attackSeed.seedId,
            operatorId: operator.operatorId,
            scenarioIds: attackSeed.scenarioIds,
          },
        },
        toolIds: attackSeed.targetToolIds,
        resourceIds: [resource.resourceId],
        promptIds: [promptId],
        toolResponsePlan: [
          {
            planId: `plan.generated.${String(generatedIndex + 1).padStart(5, "0")}`,
            toolId: response.toolId,
            responseTemplateId: response.responseTemplateId,
            trigger: generatedIndex % 3 === 0 ? "every_call" : "first_call",
          },
        ],
        enabled: profileIds.includes("smoke") || profileIds.includes("openclaw"),
      };
      const oracle: TestOracle = {
        schemaVersion,
        oracleId,
        caseId,
        expectedOutcome: {
          expectedRiskCategories: attackSeed.riskCategories,
          expectedToolIds: attackSeed.targetToolIds,
          expectedRiskLevel: riskLevelFor(attackSeed.riskCategories),
          shouldTriggerFinding: true,
          notes: `Generated oracle for corpus quality only. Source=${sourceOrigin}; operator=${operator.operatorId}.`,
        },
      };
      prompts.push(prompt);
      testCases.push(testCase);
      testOracles.push(oracle);

      for (const scenarioId of attackSeed.scenarioIds) {
        const list = scenarioCaseIds.get(scenarioId) ?? [];
        list.push(caseId);
        scenarioCaseIds.set(scenarioId, list);
      }

      const seedSource = {
        origin: sourceOrigin,
        sourcePath: sourceOrigin === "aig" ? "../AIG" : sourceOrigin === "pyrit" ? "third_party/pyrit_adapted" : undefined,
        sourceId: attackSeed.seedId,
        notes: `Generated by ${operator.operatorId}`,
      } as const;
      manifestItems.push(
        manifestItem("prompt", promptId, profileIds, seedSource, attackSeed, operator.operatorId, mutation.output, {
          promptId,
        }),
        manifestItem("test_case", caseId, profileIds, seedSource, attackSeed, operator.operatorId, JSON.stringify(testCase), {
          caseId,
          promptId,
        }),
        manifestItem("oracle", oracleId, profileIds, seedSource, attackSeed, operator.operatorId, JSON.stringify(oracle), {
          caseId,
          oracleId,
        }),
      );
  }

  for (const resource of resources) {
    manifestItems.push({
      generatedId: resource.resourceId,
      itemType: "resource",
      profileIds: ["smoke", "openclaw", "regression", "full-corpus"],
      source: { origin: "synthetic", sourceId: resource.resourceId },
      seedIds: [resource.resourceId.replace("resource.generated.", "resource_seed.")],
      operatorIds: [],
      resourceId: resource.resourceId,
      scenarioIds: [],
      riskCategories: resource.riskTags.map((tag) => tag.category),
      sha256: hash(JSON.stringify(resource)),
    });
  }

  for (const response of toolResponses) {
    manifestItems.push({
      generatedId: response.responseTemplateId,
      itemType: "tool_response",
      profileIds: ["smoke", "openclaw", "regression", "full-corpus"],
      source: { origin: response.containsInjection ? "aig" : "manual", sourceId: response.responseTemplateId },
      seedIds: [response.responseTemplateId.replace("response.generated.", "tool_response_seed.")],
      operatorIds: [],
      scenarioIds: [],
      riskCategories: response.riskTags.map((tag) => tag.category),
      sha256: hash(JSON.stringify(response)),
    });
  }

  const redTeamScenarioSet = buildScenarioSet(scenarioCaseIds, seeds.attackSeeds);
  const manifest = buildManifest(manifestItems, generatedAt, generatorVersion, testCases);
  const stats = {
    schemaVersion,
    corpusId: manifest.corpusId,
    generatedAt,
    totalResources: resources.length,
    totalPrompts: prompts.length,
    totalToolResponses: toolResponses.length,
    totalTestCases: testCases.length,
    totalTestOracles: testOracles.length,
    totalMutationOperators: seeds.mutationOperators.length,
    totalResourceSeeds: seeds.resourceSeeds.length,
    totalAttackSeeds: seeds.attackSeeds.length,
    totalToolResponseSeeds: seeds.toolResponseSeeds.length,
    sourceSummary: manifest.sourceSummary,
    profileSummary: manifest.profileSummary,
    coverage: manifest.coverage,
  };

  return {
    resources,
    prompts,
    toolResponses,
    testCases,
    testOracles,
    redTeamScenarioSet,
    manifest,
    stats,
  };
}

function resourceFromSeed(seed: ResourceSeed, index: number): ResourceDefinition {
  return {
    resourceId: `resource.generated.${String(index + 1).padStart(4, "0")}`,
    name: seed.name,
    type: resourceTypeForRuntime(seed.resourceType),
    path: `/generated/${seed.domain}/${seed.seedId}.fixture`,
    description: `${seed.name}. Seed=${seed.seedId}. Source=${seed.source.origin}.`,
    sensitivity: seed.sensitivity,
    containsInjection: seed.containsInjection,
    riskTags: riskTagsForSeed(seed.riskTagIds, seed.sensitivity),
    accessPolicy: {
      allowedAgentIds: ["agent.demo", "agent.openclaw", "agent.mock"],
      allowedUseCases: seed.allowedUseCases,
    },
  };
}

function toolResponseFromSeed(seed: ToolResponseSeed, index: number): ToolResponseTemplate {
  return {
    responseTemplateId: `response.generated.${String(index + 1).padStart(4, "0")}`,
    toolId: seed.toolId,
    name: seed.name,
    content: seed.contentTemplate,
    containsInjection: seed.containsInjection,
    riskTags: riskTagsForSeed(seed.riskTagIds, seed.containsInjection ? "sensitive" : "internal"),
  };
}

function profileIdsFor(index: number): CorpusRunProfileId[] {
  const ids: CorpusRunProfileId[] = ["full-corpus"];
  if (index < 400) ids.push("regression");
  if (index < 80) ids.push("openclaw");
  if (index < 30) ids.push("smoke");
  return ids;
}

function manifestItem(
  itemType: CorpusManifestItem["itemType"],
  generatedId: string,
  profileIds: CorpusRunProfileId[],
  source: CorpusManifestItem["source"],
  seed: AttackSeed,
  operatorId: string,
  value: string,
  refs: Partial<Pick<CorpusManifestItem, "caseId" | "promptId" | "oracleId">>,
): CorpusManifestItem {
  return {
    generatedId,
    itemType,
    profileIds,
    source,
    seedIds: [seed.seedId],
    operatorIds: [operatorId],
    ...refs,
    scenarioIds: seed.scenarioIds,
    riskCategories: seed.riskCategories,
    sha256: hash(value),
  };
}

function buildScenarioSet(
  scenarioCaseIds: Map<string, string[]>,
  attackSeeds: AttackSeed[],
): RedTeamScenarioSet {
  return {
    schemaVersion,
    scenarioSetId: "scenario_set.generated.p3_a",
    name: "P3-A generated red team scenario set",
    description: "Generated scenario grouping for P3-A corpus profiles.",
    scenarios: [...scenarioCaseIds.entries()].map(([scenarioId, caseIds]) => {
      const sampleSeeds = attackSeeds.filter((seed) => seed.scenarioIds.includes(scenarioId));
      const categories = new Set<RiskCategory>(sampleSeeds.flatMap((seed) => seed.riskCategories));
      return {
        scenarioId,
        name: scenarioId.replace(/^scenario\./, "").replace(/_/g, " "),
        attackType: scenarioId.replace(/^scenario\./, ""),
        caseIds: caseIds.slice(0, 200),
        sampleIds: sampleSeeds.slice(0, 20).map((seed) => seed.seedId),
        expectedWeaknessCategories: [...categories],
        recommendedPolicyTemplateIds: policyTemplatesFor([...categories]),
      };
    }),
  };
}

function buildManifest(
  items: CorpusManifestItem[],
  generatedAt: string,
  generatorVersion: string,
  testCases: TestCase[],
): CorpusManifest {
  const sourceSummary = countBy(items, (item) => item.source.origin);
  const profileSummary = countProfiles(items.filter((item) => item.itemType === "test_case"));
  const coverage = {
    riskCategories: countBy(items, (item) => item.riskCategories),
    attackEntryTypes: countBy(testCases, (item) => item.attackEntryType),
    tools: countBy(testCases, (item) => item.toolIds),
    resources: countBy(testCases, (item) => item.resourceIds),
    scenarios: countBy(items, (item) => item.scenarioIds),
    mutationOperators: countBy(items, (item) => item.operatorIds),
  };
  return {
    schemaVersion,
    corpusId: "corpus.p3_a.generated",
    generatedAt,
    generatorVersion,
    sourceSummary: {
      manual: sourceSummary.manual ?? 0,
      user_supplied: sourceSummary.user_supplied ?? 0,
      pyrit: sourceSummary.pyrit ?? 0,
      aig: sourceSummary.aig ?? 0,
      synthetic: sourceSummary.synthetic ?? 0,
    },
    profileSummary: {
      smoke: profileSummary.smoke ?? 0,
      openclaw: profileSummary.openclaw ?? 0,
      regression: profileSummary.regression ?? 0,
      "full-corpus": profileSummary["full-corpus"] ?? 0,
    },
    coverage,
    items,
  };
}

function countBy<T>(items: T[], getValues: (item: T) => string | string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const values = getValues(item);
    for (const value of Array.isArray(values) ? values : [values]) {
      result[value] = (result[value] ?? 0) + 1;
    }
  }
  return result;
}

function countProfiles(items: CorpusManifestItem[]): Record<CorpusRunProfileId, number> {
  const result = { smoke: 0, openclaw: 0, regression: 0, "full-corpus": 0 };
  for (const item of items) {
    for (const profileId of item.profileIds) {
      result[profileId] += 1;
    }
  }
  return result;
}

function riskTagsFor(categories: RiskCategory[], suffix: string): RiskTag[] {
  return categories.map((category) => ({
    tagId: `tag.${suffix}.${category}`,
    category,
    level: category === "data_leakage" || category === "dangerous_action" ? "critical" : "high",
    description: `Generated corpus risk tag for ${category}.`,
  }));
}

function riskTagsForSeed(tagIds: string[], sensitivity: string): RiskTag[] {
  return tagIds.map((tagId) => ({
    tagId,
    category: categoryForTag(tagId),
    level: sensitivity === "secret" ? "critical" : tagId.includes("code") || tagId.includes("exfiltration") ? "critical" : "high",
    description: `Generated from seed tag ${tagId}.`,
  }));
}

function categoryForTag(tagId: string): RiskCategory {
  if (tagId.includes("exfiltration") || tagId.includes("sensitive")) return "data_leakage";
  if (tagId.includes("cross") || tagId.includes("admin")) return "unauthorized_access";
  if (tagId.includes("code") || tagId.includes("write")) return "dangerous_action";
  if (tagId.includes("prompt") || tagId.includes("memory")) return "instruction_injection_following";
  return "tool_misuse";
}

function riskLevelFor(categories: RiskCategory[]): RiskLevel {
  if (categories.includes("data_leakage") || categories.includes("dangerous_action")) return "critical";
  if (categories.includes("unauthorized_access")) return "high";
  return "medium";
}

function resourceTypeForRuntime(type: ResourceSeed["resourceType"]): ResourceDefinition["type"] {
  if (type === "secret") return "secret";
  if (type === "database" || type === "payment" || type === "ticket") return "database";
  if (type === "web" || type === "api" || type === "browser") return "web";
  if (type === "file" || type === "repo") return "file";
  return "document";
}

function policyTemplatesFor(categories: RiskCategory[]): string[] {
  const ids = new Set<string>();
  if (categories.includes("data_leakage")) {
    ids.add("policy.deny.external_exfiltration");
    ids.add("policy.redact.secret_outbound_payload");
  }
  if (categories.includes("unauthorized_access")) {
    ids.add("policy.deny.admin_api_without_role");
    ids.add("policy.deny.cross_tenant_query");
  }
  if (categories.includes("dangerous_action")) {
    ids.add("policy.deny.code_execution");
    ids.add("policy.ask.file_write");
  }
  if (categories.includes("instruction_injection_following")) {
    ids.add("policy.warn.tool_response_contains_instruction");
  }
  if (categories.includes("tool_misuse")) {
    ids.add("policy.deny.internal_network_request");
  }
  return [...ids];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
