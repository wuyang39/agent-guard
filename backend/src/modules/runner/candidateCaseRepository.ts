import path from "node:path";
import type {
  AgentUnderTest,
  CandidateCaseCard,
  TestContext,
  TestSelectionProfile,
} from "@agent-guard/contracts";
import { loadTestContexts } from "../config/loadTestContext";

export type CandidateCaseLoadRequest = {
  targetProfile: TestSelectionProfile;
  manifestId?: string;
};

export type CandidateCaseLoadResult = {
  corpusManifestId: string;
  candidates: CandidateCaseCard[];
};

const DEFAULT_MANIFEST_ID = "corpus_manifest.derived.local_config";

export class CandidateCaseRepository {
  constructor(
    private readonly opts: {
      configDir?: string;
      agent: AgentUnderTest;
    },
  ) {}

  async loadCandidateCases(
    request: CandidateCaseLoadRequest,
  ): Promise<CandidateCaseLoadResult> {
    const configDir = this.opts.configDir ?? path.resolve(process.cwd(), "configs");
    const { contexts } = await loadTestContexts(configDir, this.opts.agent);
    const candidates = contexts
      .map((context) => deriveCandidateCase(context))
      .filter((candidate) => candidate.enabled)
      .filter(
        (candidate) =>
          request.targetProfile === "full-corpus" ||
          candidate.runProfiles.includes(request.targetProfile),
      );

    return {
      corpusManifestId: request.manifestId ?? DEFAULT_MANIFEST_ID,
      candidates,
    };
  }
}

export function deriveCandidateCase(context: TestContext): CandidateCaseCard {
  const text = [
    context.caseId,
    context.caseName,
    context.testCase.description,
    context.testCase.attackEntryType,
    context.testCase.toolIds.join(" "),
    context.testCase.resourceIds.join(" "),
    context.testCase.promptIds.join(" "),
    context.testCase.task.instruction,
  ]
    .join(" ")
    .toLowerCase();

  return {
    schemaVersion: "mvp-1",
    caseId: context.caseId,
    caseName: context.caseName,
    enabled: context.testCase.enabled,
    runProfiles: ["smoke", "openclaw", "regression", "full-corpus"],
    attackFamilies: deriveAttackFamilies(text, context.testCase.attackEntryType),
    targetSurfaces: deriveTargetSurfaces(text, context.testCase.toolIds),
    targetToolHints: [...context.testCase.toolIds].sort(),
    sensitivityTags: deriveSensitivityTags(text, context.testCase.resourceIds),
    estimatedDurationMs: 10_000,
    requiresExternalTool: context.testCase.toolIds.some(isExternalTool),
    requiresOpenClaw: true,
    sourceOrigin: "derived",
    promptSummary: summarize(context.testCase.task.instruction, 160),
    payloadRiskSummary: summarize(context.testCase.description, 160),
    expectedSafeBehaviorSummary:
      "Derived metadata only. Runtime risk conclusions must come from real traces.",
    qualityScore: deriveQualityScore(text, context.testCase.toolIds.length),
  };
}

function deriveAttackFamilies(
  text: string,
  attackEntryType: string,
): string[] {
  const families = new Set<string>();

  if (
    attackEntryType === "malicious_resource" ||
    attackEntryType === "tool_response_injection" ||
    includesAny(text, ["inject", "injection", "jailbreak", "rag", "resource"])
  ) {
    families.add("prompt_injection");
  }
  if (includesAny(text, ["leak", "secret", "token", "env", "exfil", "pii", "credential"])) {
    families.add("data_leakage");
  }
  if (
    attackEntryType === "tool_response_injection" ||
    includesAny(text, ["tool", "hijack", "api", "call", "abuse", "response", "ssrf"])
  ) {
    families.add("tool_hijack");
  }
  if (includesAny(text, ["auth", "tenant", "admin", "bypass", "unauthorized", "rbac"])) {
    families.add("auth_bypass");
  }
  if (includesAny(text, ["memory", "poison"])) {
    families.add("memory_poisoning");
  }
  if (includesAny(text, ["exec", "shell", "code", "command"])) {
    families.add("tool_hijack");
  }

  if (families.size === 0) families.add("tool_hijack");
  return [...families].sort();
}

function deriveTargetSurfaces(text: string, toolIds: string[]): string[] {
  const surfaces = new Set<string>(["tool_call"]);
  const joinedTools = toolIds.join(" ").toLowerCase();
  const haystack = `${text} ${joinedTools}`;

  if (includesAny(haystack, ["read", "file", "path", "secret_env"])) {
    surfaces.add("file_access");
  }
  if (includesAny(haystack, ["exec", "code", "shell", "command"])) {
    surfaces.add("code_execution");
  }
  if (includesAny(haystack, ["api", "http", "request", "ssrf", "network"])) {
    surfaces.add("api");
    surfaces.add("network");
  }
  if (includesAny(haystack, ["email", "mail"])) {
    surfaces.add("email");
  }
  if (includesAny(haystack, ["memory"])) {
    surfaces.add("memory");
  }
  if (includesAny(haystack, ["browser", "web", "dom"])) {
    surfaces.add("browser");
  }

  return [...surfaces].sort();
}

function deriveSensitivityTags(text: string, resourceIds: string[]): string[] {
  const tags = new Set<string>();
  const haystack = `${text} ${resourceIds.join(" ").toLowerCase()}`;

  if (includesAny(haystack, ["secret", "token", "credential", "env", "key"])) {
    tags.add("secret");
  }
  if (includesAny(haystack, ["pii", "personal", "email", "phone"])) {
    tags.add("pii");
  }
  if (includesAny(haystack, ["tenant", "admin", "internal", "config"])) {
    tags.add("internal");
  }

  return [...tags].sort();
}

function deriveQualityScore(text: string, toolCount: number): number {
  let score = 0.55;
  if (includesAny(text, ["secret", "token", "exfil", "admin", "ssrf"])) score += 0.2;
  if (includesAny(text, ["injection", "tool", "api", "exec"])) score += 0.15;
  if (toolCount > 1) score += 0.05;
  return Math.min(0.95, Number(score.toFixed(2)));
}

function isExternalTool(toolId: string): boolean {
  return includesAny(toolId.toLowerCase(), ["send", "api", "email", "request", "browser"]);
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function summarize(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
