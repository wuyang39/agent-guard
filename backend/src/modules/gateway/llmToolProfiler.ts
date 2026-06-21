import type {
  JsonObject,
  JsonValue,
  LlmProfileMetadata,
  NetworkReachability,
  ToolCapabilityProfile,
  ToolOperation,
  ToolSideEffect,
  ToolSurface,
} from "@agent-guard/contracts";
import { nowIso } from "../../shared";
import type { LlmClient } from "../llm/llmClient";

export type LlmToolProfileInput = {
  providerId: string;
  providerName: string;
  originalToolName: string;
  canonicalToolId: string;
  description?: string;
  inputSchema?: JsonObject;
  baseProfile: ToolCapabilityProfile;
};

export type LlmToolProfilerOptions = {
  client?: LlmClient;
  timeoutMs?: number;
};

const PROMPT_VERSION = "p3-b-tool-profiler-v1";
const MAX_ARRAY_VALUES = 16;
const profileCache = new Map<string, ToolCapabilityProfile>();

export async function enhanceToolCapabilityProfileWithLlm(
  input: LlmToolProfileInput,
  opts: LlmToolProfilerOptions = {},
): Promise<ToolCapabilityProfile> {
  if (!opts.client) return input.baseProfile;

  const cacheKey = buildProfileCacheKey(input);
  const cached = profileCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await opts.client.completeJson({
      system: [
        "You classify MCP tools for a security gateway.",
        "Return only a JSON object with optional profile patch fields.",
        "Never decide allow, deny, ask, or redact.",
      ].join(" "),
      user: JSON.stringify({
        providerId: input.providerId,
        providerName: input.providerName,
        toolName: input.originalToolName,
        canonicalToolId: input.canonicalToolId,
        description: input.description ?? "",
        inputSchemaSummary: summarizeSchema(input.inputSchema ?? {}),
        baseProfile: input.baseProfile,
      }),
      responseSchemaName: "LlmToolProfilePatch",
      timeoutMs: opts.timeoutMs,
    });
    const patch = sanitizePatch(response.json);
    const enhanced = mergeToolCapabilityProfile(
      input.baseProfile,
      patch,
      {
        provider: response.provider,
        model: response.model,
        promptVersion: PROMPT_VERSION,
        rationale: patch.rationale,
        generatedAt: nowIso(),
      },
    );
    profileCache.set(cacheKey, enhanced);
    return enhanced;
  } catch {
    return input.baseProfile;
  }
}

export function clearLlmToolProfileCache(): void {
  profileCache.clear();
}

export type SanitizedLlmToolProfilePatch = {
  surfaces?: ToolSurface[];
  operations?: ToolOperation[];
  capabilityTags?: string[];
  riskTags?: string[];
  sideEffect?: ToolSideEffect;
  dataClasses?: string[];
  networkReachability?: NetworkReachability;
  sensitiveFields?: string[];
  confidence?: ToolCapabilityProfile["confidence"];
  rationale?: string;
};

export function mergeToolCapabilityProfile(
  base: ToolCapabilityProfile,
  patch: SanitizedLlmToolProfilePatch,
  metadata: LlmProfileMetadata,
): ToolCapabilityProfile {
  return {
    ...base,
    surfaces: unique([...base.surfaces, ...(patch.surfaces ?? [])]) as ToolSurface[],
    operations: unique([...base.operations, ...(patch.operations ?? [])]) as ToolOperation[],
    capabilityTags: unique([...base.capabilityTags, ...(patch.capabilityTags ?? [])]),
    riskTags: unique([...base.riskTags, ...(patch.riskTags ?? [])]),
    sideEffect: strongerSideEffect(base.sideEffect, patch.sideEffect),
    dataClasses: unique([...base.dataClasses, ...(patch.dataClasses ?? [])]),
    networkReachability: strongerNetworkReachability(
      base.networkReachability,
      patch.networkReachability,
    ),
    sensitiveFields: unique([...base.sensitiveFields, ...(patch.sensitiveFields ?? [])]),
    confidence: strongerConfidence(base.confidence, patch.confidence),
    profileSource: "mixed",
    llmAssisted: true,
    llmMetadata: metadata,
  };
}

function sanitizePatch(input: JsonObject): SanitizedLlmToolProfilePatch {
  return {
    surfaces: filterEnumArray(input.surfaces, VALID_SURFACES),
    operations: filterEnumArray(input.operations, VALID_OPERATIONS),
    capabilityTags: filterStringArray(input.capabilityTags),
    riskTags: filterStringArray(input.riskTags),
    sideEffect: filterEnum(input.sideEffect, VALID_SIDE_EFFECTS),
    dataClasses: filterStringArray(input.dataClasses),
    networkReachability: filterEnum(input.networkReachability, VALID_NETWORK_REACHABILITY),
    sensitiveFields: filterStringArray(input.sensitiveFields),
    confidence: filterEnum(input.confidence, VALID_CONFIDENCE),
    rationale: typeof input.rationale === "string" ? input.rationale.slice(0, 500) : undefined,
  };
}

function summarizeSchema(schema: JsonObject): JsonObject {
  return {
    type: typeof schema.type === "string" ? schema.type : undefined,
    required: Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string").slice(0, 20)
      : undefined,
    properties: isJsonObject(schema.properties)
      ? Object.keys(schema.properties).slice(0, 50)
      : undefined,
  } as JsonObject;
}

function buildProfileCacheKey(input: LlmToolProfileInput): string {
  return [
    input.providerId,
    input.originalToolName,
    input.canonicalToolId,
    stableHash(JSON.stringify(input.inputSchema ?? {})),
  ].join("|");
}

function stableHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

function filterStringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .map((item) => item.slice(0, 80))
    .slice(0, MAX_ARRAY_VALUES);
  return result.length > 0 ? unique(result) : undefined;
}

function filterEnumArray<T extends string>(
  value: JsonValue | undefined,
  allowed: readonly T[],
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowedSet = new Set<string>(allowed);
  const result = value
    .filter((item): item is T => typeof item === "string" && allowedSet.has(item))
    .slice(0, MAX_ARRAY_VALUES);
  return result.length > 0 ? unique(result) as T[] : undefined;
}

function filterEnum<T extends string>(
  value: JsonValue | undefined,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined;
}

function strongerSideEffect(
  base: ToolSideEffect,
  patch: ToolSideEffect | undefined,
): ToolSideEffect {
  if (!patch) return base;
  const rank: Record<ToolSideEffect, number> = {
    none: 0,
    read: 1,
    write: 2,
    external: 3,
    destructive: 4,
    unknown: -1,
  };
  return rank[patch] > rank[base] ? patch : base;
}

function strongerNetworkReachability(
  base: NetworkReachability,
  patch: NetworkReachability | undefined,
): NetworkReachability {
  if (!patch) return base;
  const rank: Record<NetworkReachability, number> = {
    none: 0,
    internal: 1,
    external: 2,
    unknown: -1,
  };
  return rank[patch] > rank[base] ? patch : base;
}

function strongerConfidence(
  base: ToolCapabilityProfile["confidence"],
  patch: ToolCapabilityProfile["confidence"] | undefined,
): ToolCapabilityProfile["confidence"] {
  if (!patch) return base;
  const rank: Record<ToolCapabilityProfile["confidence"], number> = {
    low: 1,
    medium: 2,
    high: 3,
  };
  return rank[patch] > rank[base] ? patch : base;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_SURFACES = [
  "tool",
  "resource",
  "code",
  "network",
  "communication",
  "memory",
  "browser",
  "database",
  "model",
  "unknown",
] as const;

const VALID_OPERATIONS = [
  "read",
  "write",
  "execute",
  "send",
  "query",
  "search",
  "delete",
  "update",
  "list",
  "navigate",
  "transform",
  "unknown",
] as const;

const VALID_SIDE_EFFECTS = [
  "none",
  "read",
  "write",
  "external",
  "destructive",
  "unknown",
] as const;

const VALID_NETWORK_REACHABILITY = [
  "none",
  "internal",
  "external",
  "unknown",
] as const;

const VALID_CONFIDENCE = ["low", "medium", "high"] as const;
