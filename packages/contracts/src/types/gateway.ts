import type { JsonObject, JsonValue, SchemaVersion } from "./common";

export type ToolProviderType =
  | "agent_guard"
  | "mcp"
  | "openclaw"
  | "custom"
  | "unknown";

export type ToolSurface =
  | "tool"
  | "resource"
  | "code"
  | "network"
  | "communication"
  | "memory"
  | "browser"
  | "database"
  | "model"
  | "unknown";

export type ToolOperation =
  | "read"
  | "write"
  | "execute"
  | "send"
  | "query"
  | "search"
  | "delete"
  | "update"
  | "list"
  | "navigate"
  | "transform"
  | "unknown";

export type ToolSideEffect =
  | "none"
  | "read"
  | "write"
  | "external"
  | "destructive"
  | "unknown";

export type ToolProfileSource = "rule" | "llm" | "manual" | "mixed";

export type ToolProfileConfidence = "low" | "medium" | "high";

export type NetworkReachability = "none" | "internal" | "external" | "unknown";

export type LlmProfileMetadata = {
  provider: string;
  model?: string;
  promptVersion: string;
  rationale?: string;
  generatedAt: string;
};

export type ToolCapabilityProfile = {
  schemaVersion: SchemaVersion;
  originalToolName: string;
  canonicalToolId: string;
  providerType: ToolProviderType;
  surfaces: ToolSurface[];
  operations: ToolOperation[];
  capabilityTags: string[];
  riskTags: string[];
  sideEffect: ToolSideEffect;
  dataClasses: string[];
  authScopes: string[];
  networkReachability: NetworkReachability;
  sensitiveFields: string[];
  confidence: ToolProfileConfidence;
  profileSource: ToolProfileSource;
  llmAssisted: boolean;
  llmMetadata?: LlmProfileMetadata;
};

export type ExternalToolRegistration = {
  schemaVersion: SchemaVersion;
  registrationId: string;
  providerId: string;
  providerName: string;
  providerType: ToolProviderType;
  originalToolName: string;
  exposedToolName: string;
  canonicalToolId: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  capabilityProfile: ToolCapabilityProfile;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GatewayBatchContext = {
  batchId: string;
  externalCaseId?: string;
  source?: "external_unknown_test_pack" | "manual" | "script" | "unknown";
};

export type GatewayRuntimeContext = {
  providerId: string;
  providerName: string;
  providerType: ToolProviderType;
  originalToolName: string;
  exposedToolName: string;
  canonicalToolId: string;
  capabilityProfileSnapshot: ToolCapabilityProfile;
  decisionSource?: "policy" | "platform_guardrail" | "default";
  batch?: GatewayBatchContext;
};

export type SupervisionBatchCase = {
  externalCaseId: string;
  toolName: string;
  arguments: JsonObject;
  notes?: string;
};

export type SupervisionBatchCaseResult = {
  externalCaseId: string;
  toolName: string;
  status: "completed" | "blocked" | "failed";
  blocked: boolean;
  recordIds: string[];
  actionCounts: Record<string, number>;
  gateway?: GatewayRuntimeContext;
  result?: JsonValue;
  error?: string;
};

export type SupervisionBatchCaseExplanation = {
  externalCaseId: string;
  toolName: string;
  outcome:
    | "policy_blocked"
    | "policy_supervised"
    | "platform_guardrail_blocked"
    | "executed"
    | "downstream_failed";
  explanation: string;
  recordIds: string[];
};

export type SupervisionBatchExplanationDraft = {
  schemaVersion: SchemaVersion;
  explanationId: string;
  batchId: string;
  runtimeSessionId: string;
  policyPackId: string;
  source: GatewayBatchContext["source"];
  summary: string;
  keyFindings: string[];
  caseExplanations: SupervisionBatchCaseExplanation[];
  limitations: string[];
  llmAssisted: boolean;
  llmMetadata?: LlmProfileMetadata;
  generatedAt: string;
};

export type SupervisionBatchResult = {
  schemaVersion: SchemaVersion;
  batchId: string;
  runtimeSessionId: string;
  policyPackId: string;
  source: GatewayBatchContext["source"];
  externalCaseCount: number;
  supervisedToolCallCount: number;
  policyHitCount: number;
  guardrailHitCount: number;
  blockedCount: number;
  askCount: number;
  warnedCount: number;
  redactedCount: number;
  allowedCount: number;
  recordIds: string[];
  cases: SupervisionBatchCaseResult[];
  explanationDraft?: SupervisionBatchExplanationDraft;
  startedAt: string;
  endedAt: string;
};
