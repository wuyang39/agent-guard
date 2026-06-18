import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CorpusManifest,
  CorpusRunProfile,
  CorpusRunProfileId,
  PromptDefinition,
  ResourceDefinition,
  TestCase,
  TestOracle,
  ToolResponseTemplate,
} from "@agent-guard/contracts";
import type { GeneratedCorpusSelection } from "./corpusTypes";

export async function loadGeneratedCorpusProfile(
  projectRoot: string,
  profileId: CorpusRunProfileId,
): Promise<GeneratedCorpusSelection> {
  const generatedDir = join(projectRoot, "generated", "a-line");
  const configDir = join(projectRoot, "configs");
  const [
    resources,
    prompts,
    toolResponses,
    testCases,
    testOracles,
    manifest,
    profiles,
  ] = await Promise.all([
    readJson<ResourceDefinition[]>(generatedDir, "resources.generated.json"),
    readJson<PromptDefinition[]>(generatedDir, "prompts.generated.json"),
    readJson<ToolResponseTemplate[]>(generatedDir, "tool_responses.generated.json"),
    readJson<TestCase[]>(generatedDir, "test_cases.generated.json"),
    readJson<TestOracle[]>(generatedDir, "test_oracles.generated.json"),
    readJson<CorpusManifest>(generatedDir, "corpus_manifest.json"),
    readJson<CorpusRunProfile[]>(configDir, "corpus_run_profiles.json"),
  ]);
  const profile = profiles.find((item) => item.profileId === profileId);
  if (!profile) {
    throw new Error(`Unknown corpus run profile: ${profileId}`);
  }
  const caseIds = new Set(
    manifest.items
      .filter((item) => item.itemType === "test_case" && item.profileIds.includes(profileId))
      .map((item) => item.caseId)
      .filter((value): value is string => typeof value === "string"),
  );
  const promptIds = new Set<string>();
  const resourceIds = new Set<string>();
  const responseIds = new Set<string>();
  const selectedCases = testCases.filter((testCase) => {
    if (!caseIds.has(testCase.caseId)) {
      return false;
    }
    for (const promptId of testCase.promptIds) promptIds.add(promptId);
    for (const resourceId of testCase.resourceIds) resourceIds.add(resourceId);
    for (const plan of testCase.toolResponsePlan) responseIds.add(plan.responseTemplateId);
    return true;
  });

  return {
    profileId,
    profile,
    resources: resources.filter((resource) => resourceIds.has(resource.resourceId)),
    prompts: prompts.filter((prompt) => promptIds.has(prompt.promptId)),
    toolResponses: toolResponses.filter((response) => responseIds.has(response.responseTemplateId)),
    testCases: selectedCases,
    testOracles: testOracles.filter((oracle) => caseIds.has(oracle.caseId)),
    manifest,
  };
}

async function readJson<T>(dir: string, fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(dir, fileName), "utf8")) as T;
}

