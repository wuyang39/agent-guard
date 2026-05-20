export type SchemaVersion = "mvp-1";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskCategory =
  | "tool_misuse"
  | "unauthorized_access"
  | "data_leakage"
  | "dangerous_action"
  | "instruction_injection_following";

export type AttackEntryType =
  | "malicious_user_prompt"
  | "malicious_resource"
  | "tool_response_injection"
  | "multi_turn_induction";

export type ReportFormat = "json" | "html" | "markdown" | "pdf";

export type RunStatus = "running" | "completed" | "failed";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonArray = JsonValue[];

export type AgentUnderTest = {
  schemaVersion: SchemaVersion;
  agentId: string;
  name: string;
  description?: string;
  adapterType: "api" | "local_script" | "sdk" | "mock";
};

export type AgentAdapterConfig = {
  schemaVersion: SchemaVersion;
  adapterId: string;
  agentId: string;
  adapterType: "api" | "local_script" | "sdk" | "mock";
  endpoint?: string;
  scriptPath?: string;
  sdkName?: string;
  timeoutMs: number;
  envKeys?: string[];
};

export type AgentTask = {
  taskId: string;
  caseId: string;
  instruction: string;
  promptIds: string[];
  resourceIds: string[];
  metadata?: JsonObject;
};

export type AgentRunResult = {
  schemaVersion: SchemaVersion;
  runId: string;
  agentId: string;
  caseId: string;
  status: RunStatus;
  finalMessage?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
};

export type McpSandboxProfile = {
  schemaVersion: SchemaVersion;
  sandboxId: string;
  name: string;
  description?: string;
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponseTemplates: ToolResponseTemplate[];
};

export type ToolDefinition = {
  toolId: string;
  name: string;
  description: string;
  schema: JsonObject;
  parameters: ToolParameter[];
  riskTags: RiskTag[];
  riskLevel: RiskLevel;
  sideEffect: "none" | "read" | "write" | "network" | "command";
};

export type ToolParameter = {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
};

export type ResourceDefinition = {
  resourceId: string;
  name: string;
  type: "document" | "file" | "secret" | "database" | "web";
  path?: string;
  description?: string;
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  containsInjection: boolean;
  riskTags: RiskTag[];
  accessPolicy: AccessPolicy;
};

export type PromptDefinition = {
  promptId: string;
  name: string;
  description?: string;
  attackEntryType?: AttackEntryType;
  content: string;
  riskTags: RiskTag[];
};

export type ToolResponseTemplate = {
  responseTemplateId: string;
  toolId: string;
  name: string;
  content: string;
  containsInjection: boolean;
  riskTags: RiskTag[];
};

export type RiskTag = {
  tagId: string;
  category: RiskCategory;
  level: RiskLevel;
  description: string;
};

export type AccessPolicy = {
  allowedAgentIds: string[];
  allowedUseCases: string[];
};

export type TestCase = {
  schemaVersion: SchemaVersion;
  caseId: string;
  caseName: string;
  description: string;
  attackEntryType: AttackEntryType;
  task: AgentTask;
  toolIds: string[];
  resourceIds: string[];
  promptIds: string[];
  toolResponsePlan: ToolResponsePlan[];
  enabled: boolean;
};

export type ToolResponsePlan = {
  planId: string;
  toolId: string;
  responseTemplateId: string;
  trigger: "first_call" | "every_call" | "matching_parameters";
  parameterMatchers?: FieldMatcher[];
};

export type TestOracle = {
  schemaVersion: SchemaVersion;
  oracleId: string;
  caseId: string;
  expectedOutcome: ExpectedOutcome;
};

export type ExpectedOutcome = {
  expectedRiskCategories: RiskCategory[];
  expectedToolIds: string[];
  expectedRiskLevel: RiskLevel;
  shouldTriggerFinding: boolean;
  notes?: string;
};

export type TestContext = {
  schemaVersion: SchemaVersion;
  configVersion: SchemaVersion;
  contextId: string;
  caseId: string;
  caseName: string;
  agent: AgentUnderTest;
  sandbox: McpSandboxProfile;
  testCase: TestCase;
  riskRules: RiskRule[];
};

export type TestRun = {
  schemaVersion: SchemaVersion;
  runId: string;
  contextId: string;
  caseId: string;
  agentId: string;
  sandboxId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
};

export type InteractionTrace = {
  schemaVersion: SchemaVersion;
  traceId: string;
  runId: string;
  contextId: string;
  caseId: string;
  agentId: string;
  sandboxId: string;
  events: TraceEvent[];
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
};

export type TraceEventType =
  | "test_started"
  | "task_sent"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "resource_access"
  | "prompt_load"
  | "system_error";

export type TraceActor = "agent" | "mcp_server" | "monitor" | "system";

export type TraceEvent = {
  eventId: string;
  traceId: string;
  runId: string;
  caseId: string;
  timestamp: string;
  sequence: number;
  type: TraceEventType;
  actor: TraceActor;
  payload: TraceEventPayload;
};

export type TraceEventPayload =
  | TestStartedPayload
  | TaskSentPayload
  | AgentMessagePayload
  | ToolCallPayload
  | ToolResultPayload
  | ResourceAccessPayload
  | PromptLoadPayload
  | SystemErrorPayload;

export type TestStartedPayload = {
  contextId: string;
  sandboxId: string;
};

export type TaskSentPayload = {
  taskId: string;
  instruction: string;
};

export type AgentMessagePayload = {
  message: string;
};

export type ToolCallPayload = {
  callId: string;
  toolId: string;
  toolName: string;
  parameters: JsonObject;
  isHighRiskTool: boolean;
};

export type ToolResultPayload = {
  callId: string;
  toolId: string;
  result: JsonValue;
  containsInjection: boolean;
  riskTagIds: string[];
};

export type ResourceAccessPayload = {
  resourceId: string;
  path?: string;
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  authorized: boolean;
  containsInjection: boolean;
  riskTagIds: string[];
};

export type PromptLoadPayload = {
  promptId: string;
  attackEntryType?: AttackEntryType;
  riskTagIds: string[];
};

export type SystemErrorPayload = {
  code: string;
  message: string;
  detail?: JsonObject;
};

export type RiskRule = {
  ruleId: string;
  ruleVersion: SchemaVersion;
  name: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  description: string;
  match: RuleMatchCondition;
  evidenceRequired: boolean;
};

export type RuleMatchCondition = {
  relation: "all" | "any";
  eventTypes?: TraceEventType[];
  attackEntryTypes?: AttackEntryType[];
  riskTagIds?: string[];
  matchers?: FieldMatcher[];
};

export type MatchOperator =
  | "exists"
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "regex";

export type FieldMatcher = {
  fieldPath: string;
  operator: MatchOperator;
  value?: JsonValue;
  caseSensitive?: boolean;
  normalize?: "none" | "lowercase" | "trim" | "url_decode";
};

export type RiskEvaluationResult = {
  schemaVersion: SchemaVersion;
  evaluationId: string;
  contextId: string;
  caseId: string;
  traceId: string;
  riskLevel: RiskLevel;
  findings: Finding[];
  evidenceChains: EvidenceChain[];
  attackChains: AttackChain[];
  evaluatedAt: string;
};

export type Finding = {
  findingId: string;
  ruleId: string;
  title: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  description: string;
  evidenceEventIds: string[];
};

export type EvidenceChain = {
  chainId: string;
  findingId: string;
  eventIds: string[];
  summary: string;
};

export type AttackChain = {
  chainId: string;
  findingId: string;
  entryType: AttackEntryType;
  steps: AttackChainStep[];
  summary: string;
};

export type AttackChainStep = {
  stepId: string;
  sequence: number;
  eventId: string;
  title: string;
  description: string;
};

export type RiskReport = {
  schemaVersion: SchemaVersion;
  reportId: string;
  evaluationId: string;
  contextId: string;
  caseId: string;
  traceId: string;
  riskLevel: RiskLevel;
  summary: ReportSummary;
  caseReport: CaseReport;
  findings: Finding[];
  evidenceChains: EvidenceChain[];
  attackChains: AttackChain[];
  highRiskIssues: HighRiskIssue[];
  toolCallTrace: ToolCallTraceView;
  attackChainViews: AttackChainView[];
  generatedAt: string;
};

export type ReportSummary = {
  totalFindings: number;
  countsByRiskLevel: Record<RiskLevel, number>;
  countsByCategory: Record<RiskCategory, number>;
};

export type CaseReport = {
  caseId: string;
  caseName: string;
  attackEntryType: AttackEntryType;
  riskLevel: RiskLevel;
  findingIds: string[];
};

export type HighRiskIssue = {
  issueId: string;
  findingId: string;
  title: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  triggeredToolId?: string;
  triggeredResourceId?: string;
  triggeredRuleId: string;
};

export type ToolCallTraceView = {
  traceId: string;
  steps: ToolCallTraceStep[];
};

export type ToolCallTraceStep = {
  sequence: number;
  eventId: string;
  type: TraceEventType;
  title: string;
  detail: string;
};

export type AttackChainView = {
  chainId: string;
  findingId: string;
  entryType: AttackEntryType;
  summary: string;
  eventIds: string[];
};

export type ReportArtifact = {
  schemaVersion: SchemaVersion;
  artifactId: string;
  reportId: string;
  format: ReportFormat;
  path: string;
  generatedAt: string;
};
