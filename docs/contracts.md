# Agent-MCP 交互安全测评系统接口契约

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是运行时共享数据契约的初始基线。文档版本不等于运行时对象版本；当前运行时对象继续使用 `schemaVersion: "mvp-1"` 作为 P0 阶段契约版本。系统最终目标是完整的竞赛级 Agent-MCP 交互安全测评系统，后续阶段可以在版本演进规则下扩展契约。

## 1. 契约总则

系统唯一被测对象是 `Agent`。MCP Server、Tool、Resource、Prompt、Tool Response 注入内容、风险规则和测试用例均由系统内部提供，是测试夹具，不是被测对象。

所有跨模块共享对象必须包含:

- `schemaVersion`
- 可追踪的业务 ID
- 明确的时间字段
- 可序列化为 JSON 的数据结构

P0 统一版本:

```txt
schemaVersion: "mvp-1"
configVersion: "mvp-1"
ruleVersion: "mvp-1"
```

共享字段变更必须同步更新本文档。禁止口头通知字段变更，禁止私下修改 JSON 字段名。

## 2. 通用类型

```ts
type SchemaVersion = "mvp-1" | "p3-a-1"

type RiskLevel = "low" | "medium" | "high" | "critical"

type RiskCategory =
  | "tool_misuse"
  | "unauthorized_access"
  | "data_leakage"
  | "dangerous_action"
  | "instruction_injection_following"

type AttackEntryType =
  | "malicious_user_prompt"
  | "malicious_resource"
  | "tool_response_injection"
  | "multi_turn_induction"

type ReportFormat = "json" | "html" | "markdown" | "pdf"

type RunStatus = "running" | "completed" | "failed"

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray

type JsonObject = {
  [key: string]: JsonValue
}

type JsonArray = JsonValue[]
```

时间字段使用 ISO 8601 字符串。系统内部建议统一使用 UTC。

跨模块共享对象不得使用 `any`、`unknown`、函数、类实例、Date 对象、Map、Set、Buffer 或不可 JSON 序列化的对象。

## 3. 被测 Agent 输入类型

`AgentUnderTest` 是系统唯一被测对象的描述。

```ts
type AgentUnderTest = {
  schemaVersion: "mvp-1"
  agentId: string
  name: string
  description?: string
  adapterType: "api" | "local_script" | "sdk" | "mock"
}
```

`AgentAdapterConfig` 描述如何调用被测 Agent。任何阶段都不得在该对象中保存明文密钥；密钥通过本地环境变量或运行时安全配置注入。

```ts
type AgentAdapterConfig = {
  schemaVersion: "mvp-1"
  adapterId: string
  agentId: string
  adapterType: "api" | "local_script" | "sdk" | "mock"
  endpoint?: string
  scriptPath?: string
  sdkName?: string
  timeoutMs: number
  envKeys?: string[]
}
```

`AgentTask` 是系统发送给 Agent 的测试任务。

```ts
type AgentTask = {
  taskId: string
  caseId: string
  instruction: string
  promptIds: string[]
  resourceIds: string[]
  metadata?: JsonObject
}
```

`AgentRunResult` 是 Agent Adapter 调用完成后的直接结果。真实工具调用过程必须进入 `InteractionTrace`，不能只保存在该结果里。

```ts
type AgentRunResult = {
  schemaVersion: "mvp-1"
  runId: string
  agentId: string
  caseId: string
  status: RunStatus
  finalMessage?: string
  error?: string
  startedAt: string
  endedAt?: string
}
```

## 4. 系统内置 MCP Sandbox 类型

`McpSandboxProfile` 是系统内部 MCP 测试环境画像。

```ts
type McpSandboxProfile = {
  schemaVersion: "mvp-1"
  sandboxId: string
  name: string
  description?: string
  tools: ToolDefinition[]
  resources: ResourceDefinition[]
  prompts: PromptDefinition[]
  toolResponseTemplates: ToolResponseTemplate[]
}
```

```ts
type ToolDefinition = {
  toolId: string
  name: string
  description: string
  schema: JsonObject
  parameters: ToolParameter[]
  riskTags: RiskTag[]
  riskLevel: RiskLevel
  sideEffect: "none" | "read" | "write" | "network" | "command"
}
```

```ts
type ToolParameter = {
  name: string
  type: "string" | "number" | "boolean" | "object" | "array"
  required: boolean
  description?: string
}
```

```ts
type ResourceDefinition = {
  resourceId: string
  name: string
  type: "document" | "file" | "secret" | "database" | "web"
  path?: string
  description?: string
  sensitivity: "public" | "internal" | "sensitive" | "secret"
  containsInjection: boolean
  riskTags: RiskTag[]
  accessPolicy: AccessPolicy
}
```

```ts
type PromptDefinition = {
  promptId: string
  name: string
  description?: string
  attackEntryType?: AttackEntryType
  content: string
  riskTags: RiskTag[]
}
```

```ts
type ToolResponseTemplate = {
  responseTemplateId: string
  toolId: string
  name: string
  content: string
  containsInjection: boolean
  riskTags: RiskTag[]
}
```

```ts
type RiskTag = {
  tagId: string
  category: RiskCategory
  level: RiskLevel
  description: string
}
```

```ts
type AccessPolicy = {
  allowedAgentIds: string[]
  allowedUseCases: string[]
}
```

## 5. 测试用例类型

`TestCase` 描述一次要运行的安全测试。

```ts
type TestCase = {
  schemaVersion: "mvp-1"
  caseId: string
  caseName: string
  description: string
  attackEntryType: AttackEntryType
  task: AgentTask
  toolIds: string[]
  resourceIds: string[]
  promptIds: string[]
  toolResponsePlan: ToolResponsePlan[]
  enabled: boolean
}
```

```ts
type ToolResponsePlan = {
  planId: string
  toolId: string
  responseTemplateId: string
  trigger: "first_call" | "every_call" | "matching_parameters"
  parameterMatchers?: FieldMatcher[]
}
```

`toolResponsePlan` 用于告诉 Test Runner 在某个测试用例中如何返回恶意或普通 Tool Response。没有该字段时，B 模块无法确定 Tool Response 注入样例是否应参与本次测试。

```ts
type TestOracle = {
  schemaVersion: "mvp-1"
  oracleId: string
  caseId: string
  expectedOutcome: ExpectedOutcome
}
```

```ts
type ExpectedOutcome = {
  expectedRiskCategories: RiskCategory[]
  expectedToolIds: string[]
  expectedRiskLevel: RiskLevel
  shouldTriggerFinding: boolean
  notes?: string
}
```

`TestOracle` 只允许用于验收测试、回归测试和评测统计，不得进入 `TestContext`，也不得作为风险判定模块的运行时输入。风险判定模块只能基于 `TestContext`、`InteractionTrace` 和 `riskRules` 生成结论。

P0 至少覆盖:

- 恶意 Prompt 诱导工具误用
- 恶意 Resource 导致敏感资源访问
- Tool Response 注入影响后续行为

## 6. TestContext

`TestContext` 是开发者 A 交给开发者 B 和 C 的主要对象。它把被测 Agent、系统内置 MCP Sandbox、测试用例和风险规则合成一次测试所需上下文。

```ts
type TestContext = {
  schemaVersion: "mvp-1"
  configVersion: "mvp-1"
  contextId: string
  caseId: string
  caseName: string
  agent: AgentUnderTest
  sandbox: McpSandboxProfile
  testCase: TestCase
  riskRules: RiskRule[]
}
```

## 7. 测试执行与交互监控类型

`TestRun` 是一次测试执行的运行态元数据。

```ts
type TestRun = {
  schemaVersion: "mvp-1"
  runId: string
  contextId: string
  caseId: string
  agentId: string
  sandboxId: string
  status: RunStatus
  startedAt: string
  endedAt?: string
  error?: string
}
```

`InteractionTrace` 是开发者 B 交给开发者 C 的唯一交互事实对象。

```ts
type InteractionTrace = {
  schemaVersion: "mvp-1"
  traceId: string
  runId: string
  contextId: string
  caseId: string
  agentId: string
  sandboxId: string
  events: TraceEvent[]
  startedAt: string
  endedAt?: string
  status: RunStatus
}
```

```ts
type TraceEventType =
  | "test_started"
  | "task_sent"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "resource_access"
  | "prompt_load"
  | "system_error"
```

```ts
type TraceActor =
  | "agent"
  | "mcp_server"
  | "monitor"
  | "system"
```

```ts
type TraceEvent = {
  eventId: string
  traceId: string
  runId: string
  caseId: string
  timestamp: string
  sequence: number
  type: TraceEventType
  actor: TraceActor
  payload: TraceEventPayload
}
```

```ts
type TraceEventPayload =
  | TestStartedPayload
  | TaskSentPayload
  | AgentMessagePayload
  | ToolCallPayload
  | ToolResultPayload
  | ResourceAccessPayload
  | PromptLoadPayload
  | SystemErrorPayload
```

```ts
type TestStartedPayload = {
  contextId: string
  sandboxId: string
}

type TaskSentPayload = {
  taskId: string
  instruction: string
}

type AgentMessagePayload = {
  message: string
}

type ToolCallPayload = {
  callId: string
  toolId: string
  toolName: string
  parameters: JsonObject
  isHighRiskTool: boolean
}

type ToolResultPayload = {
  callId: string
  toolId: string
  result: JsonValue
  containsInjection: boolean
  riskTagIds: string[]
}

type ResourceAccessPayload = {
  resourceId: string
  path?: string
  sensitivity: "public" | "internal" | "sensitive" | "secret"
  authorized: boolean
  containsInjection: boolean
  riskTagIds: string[]
}

type PromptLoadPayload = {
  promptId: string
  attackEntryType?: AttackEntryType
  riskTagIds: string[]
}

type SystemErrorPayload = {
  code: string
  message: string
  detail?: JsonObject
}
```

事件约束:

- `sequence` 必须单调递增
- `timestamp` 使用 ISO 8601
- 同一 `traceId` 下的 `eventId` 必须唯一
- `tool_call` 与 `tool_result` 通过 `callId` 关联
- 风险判定只能基于 `TraceEvent`、`TestContext` 和 `riskRules`

## 8. 风险判定类型

`RiskRule` 来源于 `risk_rules.json`，由配置模块加载后进入 `TestContext`。

```ts
type RiskRule = {
  ruleId: string
  ruleVersion: "mvp-1"
  name: string
  category: RiskCategory
  riskLevel: RiskLevel
  description: string
  match: RuleMatchCondition
  evidenceRequired: boolean
}
```

```ts
type RuleMatchCondition = {
  relation: "all" | "any"
  eventTypes?: TraceEventType[]
  attackEntryTypes?: AttackEntryType[]
  riskTagIds?: string[]
  matchers?: FieldMatcher[]
}
```

```ts
type MatchOperator =
  | "exists"
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "regex"

type FieldMatcher = {
  fieldPath: string
  operator: MatchOperator
  value?: JsonValue
  caseSensitive?: boolean
  normalize?: "none" | "lowercase" | "trim" | "url_decode"
}
```

规则匹配约束:

- `relation` 决定 `matchers` 之间是全部满足还是任一满足。
- `fieldPath` 使用点路径访问事件字段，例如 `type`、`payload.toolId`、`payload.parameters.path`。
- P0 不支持数组通配符；数组字段只能整体参与 `contains`、`in` 或 `regex` 匹配。后续如扩展数组路径、表达式语言或更复杂规则，需要升级版本并补充兼容策略。
- `caseSensitive` 默认 `false`。
- `normalize` 默认 `"none"`，多个 normalize 不叠加。
- `regex` 使用宿主语言默认正则实现，但规则中必须写明完整 pattern，不允许运行时代码。
- P0 不引入复杂表达式语言、动态脚本规则和机器学习判定。后续如引入高级规则引擎或统计/模型辅助判定，必须保持可解释证据链，并明确哪些结论来自规则、哪些结论来自辅助模型。

```ts
type RiskEvaluationResult = {
  schemaVersion: "mvp-1"
  evaluationId: string
  contextId: string
  caseId: string
  traceId: string
  riskLevel: RiskLevel
  findings: Finding[]
  evidenceChains: EvidenceChain[]
  attackChains: AttackChain[]
  evaluatedAt: string
}
```

```ts
type Finding = {
  findingId: string
  ruleId: string
  title: string
  category: RiskCategory
  riskLevel: RiskLevel
  description: string
  evidenceEventIds: string[]
}
```

```ts
type EvidenceChain = {
  chainId: string
  findingId: string
  eventIds: string[]
  summary: string
}
```

```ts
type AttackChain = {
  chainId: string
  findingId: string
  entryType: AttackEntryType
  steps: AttackChainStep[]
  summary: string
}

type AttackChainStep = {
  stepId: string
  sequence: number
  eventId: string
  title: string
  description: string
}
```

风险约束:

- 每个 `Finding` 必须至少引用 1 个 `evidenceEventIds`
- `evidenceEventIds` 必须能在对应 `InteractionTrace.events` 中找到
- `RiskEvaluationResult.riskLevel` 由全部 findings 的最高风险等级计算得到
- 当 `findings` 为空时，`RiskEvaluationResult.riskLevel` 固定为 `low`

## 9. 报告输出类型

`RiskReport` 是结构化报告数据，`ReportArtifact` 是导出的文件产物。

```ts
type RiskReport = {
  schemaVersion: "mvp-1"
  reportId: string
  evaluationId: string
  contextId: string
  caseId: string
  traceId: string
  riskLevel: RiskLevel
  summary: ReportSummary
  caseReport: CaseReport
  findings: Finding[]
  evidenceChains: EvidenceChain[]
  attackChains: AttackChain[]
  highRiskIssues: HighRiskIssue[]
  toolCallTrace: ToolCallTraceView
  attackChainViews: AttackChainView[]
  generatedAt: string
}
```

```ts
type ReportSummary = {
  totalFindings: number
  countsByRiskLevel: Record<RiskLevel, number>
  countsByCategory: Record<RiskCategory, number>
}
```

```ts
type CaseReport = {
  caseId: string
  caseName: string
  attackEntryType: AttackEntryType
  riskLevel: RiskLevel
  findingIds: string[]
}
```

```ts
type HighRiskIssue = {
  issueId: string
  findingId: string
  title: string
  category: RiskCategory
  riskLevel: RiskLevel
  triggeredToolId?: string
  triggeredResourceId?: string
  triggeredRuleId: string
}
```

```ts
type ToolCallTraceView = {
  traceId: string
  steps: ToolCallTraceStep[]
}

type ToolCallTraceStep = {
  sequence: number
  eventId: string
  type: TraceEventType
  title: string
  detail: string
}
```

```ts
type AttackChainView = {
  chainId: string
  findingId: string
  entryType: AttackEntryType
  summary: string
  eventIds: string[]
}
```

```ts
type ReportArtifact = {
  schemaVersion: "mvp-1"
  artifactId: string
  reportId: string
  format: ReportFormat
  path: string
  generatedAt: string
}
```

报告约束:

- P0 必须导出 JSON 与 HTML
- Markdown 与 PDF 可以后续实现
- `RiskReport.findings`、`RiskReport.evidenceChains`、`RiskReport.attackChains` 必须与对应 `RiskEvaluationResult` 保持一致
- JSON 报告必须是自包含报告，不能要求读取额外 evaluation 文件才能看到完整风险、证据链和攻击链
- 报告模块不得重新判定风险等级
- 报告模块不得绕过 `Finding` 直接解析原始日志生成结论

### 9.1 P3 C ReportBundle、证据包和报告质量契约

P3-C 在 P1/P2 报告对象之上新增提交级报告聚合对象。该对象只聚合和引用已有事实对象，不重新执行风险判定、策略生成或运行时监督。

新增共享类型位于:

```txt
packages/contracts/src/types/report.ts
```

核心对象:

```txt
TestContextView
ReportSection
DefenseClaim
EvidenceBundle
EvidenceCoverageMatrix
EvidenceCoverageRow
EvidenceItem
MissingEvidenceItem
TraceabilityGraph
TraceabilityNode
TraceabilityEdge
ReportQualitySummary
ReportQualityCheck
ReportBundle
```

`TestContextView` 是后端基于真实 `TestContext` 或 trace 元数据构建的展示对象。前端不得读取 `configs/*.json` 或 `outputs/**` 原始文件补齐上下文。

```ts
type TestContextView = {
  schemaVersion: SchemaVersion
  contextViewId: string
  contextId: string
  caseId: string
  caseName: string
  agentId: string
  scenarioIds: string[]
  attackEntryType?: AttackEntryType
  task: {
    taskId?: string
    instructionPreview?: string
  }
  tools: TestContextToolView[]
  resources: TestContextResourceView[]
  prompts: TestContextPromptView[]
  riskRuleIds: string[]
  source: "config" | "trace_only" | "missing"
  warnings: string[]
}
```

`DefenseClaim` 把报告结论结构化，便于前端复核证据。

```ts
type DefenseClaim = {
  claimId: string
  title: string
  statement: string
  claimType:
    | "risk"
    | "detection"
    | "policy"
    | "runtime_effect"
    | "residual_risk"
    | "limitation"
  confidence: "low" | "medium" | "high"
  sourceIds: {
    contextIds?: string[]
    traceEventIds?: string[]
    findingIds?: string[]
    policyIds?: string[]
    runtimeRecordIds?: string[]
  }
  reviewStatus: "auto_checked" | "needs_review" | "blocked_by_missing_evidence"
}
```

`ReportBundle` 是 C 线报告工作台和导出器的统一输入。

```ts
type ReportBundle = {
  schemaVersion: SchemaVersion
  bundleId: string
  runGroupId: string
  agentId: string
  generatedAt: string
  source: {
    testContextViewIds: string[]
    testRunIds: string[]
    traceIds: string[]
    riskReportIds: string[]
    detectionReportId?: string
    riskProfileId?: string
    policyPackId?: string
    runtimeSessionIds: string[]
    defenseReportId?: string
  }
  testContextViews: TestContextView[]
  executiveSummary: ReportSection
  claims: DefenseClaim[]
  evidenceBundle: EvidenceBundle
  traceabilityGraph: TraceabilityGraph
  quality: ReportQualitySummary
  exports: ReportArtifact[]
}
```

约束:

- `ReportBundle.source` 中的 ID 必须来自当前 run group、report index、trace store 或 runtime session store。
- `claimType: "runtime_effect"` 必须引用真实 `RuntimeSupervisionRecord.recordId`。
- 没有 runtime record 时，报告只能表达缺少运行时证据，不得表达已阻断、已缓解或已生效。
- `EvidenceBundle.items` 只能引用真实对象；缺失对象必须进入 `missingEvidence`。
- `TraceabilityGraph` 必须覆盖 TestContextView、trace、risk report、detection report、policy pack、runtime record、defense report 和 artifact 的主链路。
- `ReportQualitySummary.level` 可为 `draft`、`reviewable` 或 `submission_ready`；存在 blocking issue 时必须降级为 `draft`。
- Markdown、HTML、PDF 等导出格式必须消费同一个 `ReportBundle`，不得各自重新拼接结论。

## 10. P1 检测画像、策略包、运行时监督和防御报告类型

P1 新增对象用于支撑“监督前检测 -> 风险画像 -> 策略包 -> 真实运行监督 -> 防御报告”的扩展链路。P1 对象仍必须保持 JSON 可序列化，并使用 `schemaVersion: "mvp-1"`，除非协调人明确启动版本升级。

P1 类型草案已落到 `packages/contracts/src/types/detection.ts`、`policy.ts`、`supervision.ts` 和 `defense.ts`。后续字段变更必须同步本文档和对应类型文件。

P1 主链路:

```txt
RiskReport
  -> DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack
  -> RuntimeSupervisionRecord[]
  -> DefenseReport
```

### 10.1 DetectionReport

`DetectionReport` 是监督前检测报告，用于总结红队场景检测结果。它是人读报告和风险画像生成的输入，不直接作为运行时监督逻辑。

```ts
type DetectionReport = {
  schemaVersion: "mvp-1"
  reportId: string
  agentId: string
  sourceRiskReportIds: string[]
  scenarioSummary: DetectionScenarioSummary[]
  riskSummary: DetectionRiskSummary
  failedScenarios: FailedScenario[]
  findingIds: string[]
  evidenceChainIds: string[]
  recommendedPolicyTemplateIds: string[]
  generatedAt: string
}
```

```ts
type DetectionScenarioSummary = {
  scenarioId: string
  caseIds: string[]
  status: "passed" | "failed" | "partially_failed"
  triggeredFindingIds: string[]
}
```

```ts
type DetectionRiskSummary = {
  totalScenarios: number
  failedScenarioCount: number
  totalFindings: number
  highestRiskLevel: RiskLevel
  countsByCategory: Record<RiskCategory, number>
}
```

```ts
type FailedScenario = {
  scenarioId: string
  caseId: string
  findingIds: string[]
  weaknessCategory: RiskCategory
  evidenceEventIds: string[]
}
```

### 10.2 AgentRiskProfile

`AgentRiskProfile` 是检测报告的结构化风险画像，用于生成策略包。它描述某个 Agent 在检测阶段暴露的失守模式。

```ts
type AgentRiskProfile = {
  schemaVersion: "mvp-1"
  profileId: string
  agentId: string
  sourceDetectionReportId: string
  weaknesses: AgentWeakness[]
  highRiskTools: string[]
  sensitiveResourcePatterns: string[]
  exfiltrationPatterns: string[]
  recommendedControls: string[]
  confidence: "low" | "medium" | "high"
  generatedAt: string
}
```

```ts
type AgentWeakness = {
  weaknessId: string
  category: RiskCategory
  title: string
  description: string
  sourceFindingIds: string[]
  recommendedPolicyTemplateIds: string[]
}
```

### 10.3 SupervisionPolicyPack

`SupervisionPolicyPack` 是从检测结论生成的机器可执行策略包。C 负责生成，B 负责加载和执行。运行时监督不得绕过策略包私自增加阻断逻辑。

```ts
type SupervisionAction =
  | "allow"
  | "deny"
  | "ask"
  | "warn"
  | "redact"
  | "isolate"
```

```ts
type SupervisionPolicyPack = {
  schemaVersion: "mvp-1"
  policyPackId: string
  agentId: string
  sourceDetectionReportId: string
  sourceRiskProfileId: string
  policies: SupervisionPolicy[]
  defaultAction: SupervisionAction
  createdAt: string
  expiresAt?: string
}
```

```ts
type SupervisionPolicy = {
  policyId: string
  sourcePolicyTemplateId?: string
  sourceWeaknessIds: string[]
  name: string
  description: string
  targetType: "tool_call" | "resource_access" | "api_call" | "file_write" | "email_send" | "code_execution" | "agent_message"
  action: SupervisionAction
  riskLevel: RiskLevel
  match: RuleMatchCondition
  reason: string
}
```

`SupervisionPolicy.match` 可以复用 `RuleMatchCondition` 与 `FieldMatcher`，但语义不同: `RiskRule` 用于检测归因，`SupervisionPolicy` 用于运行时动作判定。二者不得混用。

#### P3 Gateway 工具画像扩展

P3-B 引入外部工具 Gateway 后，所有接入工具必须先注册并生成工具能力画像。工具画像用于运行时监督、实时事件和报告解释，不替代 `SupervisionPolicyPack`。

```ts
type ToolProviderType =
  | "agent_guard"
  | "mcp"
  | "openclaw"
  | "custom"
  | "unknown"

type ToolSurface =
  | "tool"
  | "resource"
  | "code"
  | "network"
  | "communication"
  | "memory"
  | "browser"
  | "database"
  | "model"
  | "unknown"

type ToolOperation =
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
  | "unknown"

type ToolCapabilityProfile = {
  schemaVersion: "mvp-1"
  originalToolName: string
  canonicalToolId: string
  providerType: ToolProviderType
  surfaces: ToolSurface[]
  operations: ToolOperation[]
  capabilityTags: string[]
  riskTags: string[]
  sideEffect: "none" | "read" | "write" | "external" | "destructive" | "unknown"
  dataClasses: string[]
  authScopes: string[]
  networkReachability: "none" | "internal" | "external" | "unknown"
  sensitiveFields: string[]
  confidence: "low" | "medium" | "high"
  profileSource: "rule" | "llm" | "manual" | "mixed"
  llmAssisted: boolean
  llmMetadata?: LlmProfileMetadata
}

type LlmProfileMetadata = {
  provider: string
  model?: string
  promptVersion: string
  rationale?: string
  generatedAt: string
}
```

```ts
type ExternalToolRegistration = {
  schemaVersion: "mvp-1"
  registrationId: string
  providerId: string
  providerName: string
  providerType: ToolProviderType
  originalToolName: string
  exposedToolName: string
  canonicalToolId: string
  description: string
  inputSchema: JsonObject
  outputSchema?: JsonObject
  capabilityProfile: ToolCapabilityProfile
  enabled: boolean
  createdAt: string
  updatedAt: string
}

type GatewayRuntimeContext = {
  providerId: string
  providerName: string
  providerType: ToolProviderType
  originalToolName: string
  exposedToolName: string
  canonicalToolId: string
  capabilityProfileSnapshot: ToolCapabilityProfile
  decisionSource?: "policy" | "platform_guardrail" | "default"
  batch?: GatewayBatchContext
}

type GatewayBatchContext = {
  batchId: string
  externalCaseId?: string
  source?: "external_unknown_test_pack" | "manual" | "script" | "unknown"
}
```

约束:

- `ToolCapabilityProfile` 可以由规则、人工或 LLM 辅助生成，但最终监督动作仍由 `SupervisionPolicyPack` 和 platform guardrail 决定。
- `llmMetadata` 只用于审计 LLM 辅助画像的来源，不得作为运行时阻断动作依据。
- `ExternalToolRegistration.exposedToolName` 是暴露给 OpenClaw 的工具名，`originalToolName` 保留 provider 原始工具名，`canonicalToolId` 用于策略和证据链。
- `GatewayRuntimeContext.capabilityProfileSnapshot` 必须保存调用当时的画像快照，避免后续画像变化导致证据链不可复核。
- `GatewayRuntimeContext.batch` 用于把监督批测中的每个外部 case 关联到真实运行时记录。
- 未知工具不得静默放行，当前 Gateway 默认使用 `platform.guardrail.unknown_external_tool` 阻断并写入运行时记录。

P3-B 监督批测对象用于表达“外部未知测试包对监督环节的批量验证结果”。它不得参与风险画像或策略包生成，只能复用当前 `SupervisionPolicyPack` 和 Gateway 监督链路。

```ts
type SupervisionBatchCase = {
  externalCaseId: string
  toolName: string
  arguments: JsonObject
  notes?: string
}

type SupervisionBatchCaseResult = {
  externalCaseId: string
  toolName: string
  status: "completed" | "blocked" | "failed"
  blocked: boolean
  recordIds: string[]
  actionCounts: Record<string, number>
  gateway?: GatewayRuntimeContext
  result?: JsonValue
  error?: string
}

type SupervisionBatchCaseExplanation = {
  externalCaseId: string
  toolName: string
  outcome:
    | "policy_blocked"
    | "policy_supervised"
    | "platform_guardrail_blocked"
    | "executed"
    | "downstream_failed"
  explanation: string
  recordIds: string[]
}

type SupervisionBatchExplanationDraft = {
  schemaVersion: "mvp-1"
  explanationId: string
  batchId: string
  runtimeSessionId: string
  policyPackId: string
  source: GatewayBatchContext["source"]
  summary: string
  keyFindings: string[]
  caseExplanations: SupervisionBatchCaseExplanation[]
  limitations: string[]
  llmAssisted: boolean
  llmMetadata?: LlmProfileMetadata
  generatedAt: string
}

type SupervisionBatchResult = {
  schemaVersion: "mvp-1"
  batchId: string
  runtimeSessionId: string
  policyPackId: string
  source: GatewayBatchContext["source"]
  externalCaseCount: number
  supervisedToolCallCount: number
  policyHitCount: number
  guardrailHitCount: number
  blockedCount: number
  askCount: number
  warnedCount: number
  redactedCount: number
  allowedCount: number
  recordIds: string[]
  cases: SupervisionBatchCaseResult[]
  explanationDraft?: SupervisionBatchExplanationDraft
  startedAt: string
  endedAt: string
}
```

批测约束:

- `SupervisionBatchResult.recordIds` 必须能在对应 `RuntimeSupervisionRecord[]` 中找到。
- 每条批测产生的 `RuntimeSupervisionRecord.gateway.batch.batchId` 必须等于当前 `batchId`。
- 批测样本不得回流到 `DetectionReport`、`AgentRiskProfile` 或 `SupervisionPolicyPack`。
- 批测命中的 platform guardrail 必须通过 `guardrailHitCount` 与策略包命中区分。
- `SupervisionBatchExplanationDraft` 是 B 线对批测监督结果的解释草案，不是最终 `DefenseReport` 结论。
- `SupervisionBatchExplanationDraft.caseExplanations[].recordIds` 必须来自同一个 `SupervisionBatchResult.recordIds`，LLM 不得生成或改写证据 ID。
- LLM 只能辅助生成 `summary`、`keyFindings`、`limitations` 等解释文本，不得改变 case outcome、动作计数、策略命中或阻断结论。

### 10.4 RuntimeSupervisionRecord

`RuntimeSupervisionRecord` 是 B 交给 C 的运行时监督事实。防御报告只能基于该对象证明告警、阻断、询问、脱敏等防御效果。

```ts
type RuntimeSupervisionRecord = {
  schemaVersion: "mvp-1"
  recordId: string
  runtimeSessionId: string
  agentId: string
  policyPackId: string
  policyId: string
  action: SupervisionAction
  decisionReason: string
  targetType: SupervisionPolicy["targetType"]
  targetId?: string
  inputEventId?: string
  outputEventId?: string
  gateway?: GatewayRuntimeContext
  createdAt: string
}
```

```ts
type RuntimeAlert = {
  alertId: string
  recordId: string
  riskLevel: RiskLevel
  title: string
  message: string
  createdAt: string
}
```

```ts
type BlockedAction = {
  blockedActionId: string
  recordId: string
  policyId: string
  targetType: SupervisionPolicy["targetType"]
  targetId?: string
  reason: string
  createdAt: string
}
```

### 10.5 DefenseReport

`DefenseReport` 是最终防御报告，用于证明检测阶段发现的问题在真实运行中被监督、告警、阻断或缓解。

```ts
type DefenseReport = {
  schemaVersion: "mvp-1"
  defenseReportId: string
  agentId: string
  detectionReportId: string
  riskProfileId: string
  policyPackId: string
  runtimeSessionIds: string[]
  detectedWeaknesses: AgentWeakness[]
  generatedPolicies: SupervisionPolicy[]
  runtimeAlerts: RuntimeAlert[]
  blockedActions: BlockedAction[]
  defenseEffectiveness: DefenseEffectiveness
  residualRisk: ResidualRisk[]
  generatedAt: string
}
```

```ts
type DefenseEffectiveness = {
  blockedHighRiskActionCount: number
  alertedActionCount: number
  redactedActionCount: number
  askDecisionCount: number
  mitigatedWeaknessIds: string[]
}
```

```ts
type ResidualRisk = {
  residualRiskId: string
  category: RiskCategory
  riskLevel: RiskLevel
  description: string
  relatedWeaknessIds: string[]
}
```

P1 报告约束:

- `DetectionReport` 必须能追溯到一个或多个 `RiskReport`
- `AgentRiskProfile` 必须能追溯到一个 `DetectionReport`
- `SupervisionPolicyPack` 必须能追溯到一个 `AgentRiskProfile`
- `RuntimeSupervisionRecord.policyId` 必须存在于对应 `SupervisionPolicyPack.policies`
- 例外: 当 `RuntimeSupervisionRecord.gateway.decisionSource === "platform_guardrail"` 时，`policyId` 可以使用 `platform.guardrail.*`，但防御报告不得把它统计为 C 线策略包命中。
- `DefenseReport` 中的告警和阻断必须来自真实 `RuntimeSupervisionRecord[]`
- 防御报告模块不得编造运行时阻断记录
- 前端不得直接读取策略模板配置来解释策略命中

## 11. 配置文件契约

P0 内置配置文件:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/tool_responses.json
configs/risk_rules.json
configs/test_cases.json
configs/test_oracles.json
```

配置加载后的运行时公开出口是 `TestContext`。其他模块不得直接读取 `configs/*.json` 参与运行时逻辑。

`configs/test_oracles.json` 只用于验收测试、回归测试和评测统计，不得进入运行时 `TestContext`。

P1/P2 新增配置文件:

```txt
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
configs/a-line/sources/pyrit_attack_library.json
configs/a-line/sources/pyrit_jailbreak_template_index.json
```

`configs/red_team_scenarios.json` 用于维护红队场景索引、用例归属和样本引用。`configs/supervision_policy_templates.json` 用于维护可复用策略模板。根据某个 Agent 检测结果生成的 `SupervisionPolicyPack` 不得写回策略模板配置文件。

P2 新增的 `configs/a-line/sources/pyrit_attack_library.json` 用于维护迁入 PyRIT 攻击库的来源、converter catalog、attack family 和 sample 到 case 的映射。它是攻击库目录对象，不是风险判定结果。

P2 新增的 `configs/a-line/sources/pyrit_jailbreak_template_index.json` 用于维护迁入 PyRIT jailbreak YAML 模板的元数据索引。它不得包含模板全文或 `value` 字段，只能包含路径、分组、参数、作者、哈希、大小和安全说明。

P3-A 新增配置与生成物:

```txt
configs/a-line/corpus/seeds/resource_seeds.json
configs/a-line/corpus/seeds/attack_seeds.json
configs/a-line/corpus/seeds/user_prompt_seeds.json
configs/a-line/corpus/seeds/tool_response_seeds.json
configs/a-line/corpus/operators/mutation_operators.json
configs/a-line/corpus/profiles/attack_generation_profiles.json
configs/a-line/corpus/profiles/corpus_run_profiles.json
configs/a-line/sources/pyrit_seed_dataset_index.json
configs/a-line/sources/pyrit_executor_template_index.json
configs/a-line/sources/pyrit_scorer_template_index.json
configs/a-line/sources/aig_strategy_index.json
generated/a-line/resources.generated.json
generated/a-line/prompts.generated.json
generated/a-line/tool_responses.generated.json
generated/a-line/test_cases.generated.json
generated/a-line/test_oracles.generated.json
generated/a-line/red_team_scenarios.generated.json
generated/a-line/corpus_manifest.json
generated/a-line/corpus_stats.json
generated/a-line/attack_case_cards.generated.json
generated/a-line/llm_selection_catalog.generated.json
generated/a-line/coverage_taxonomy.generated.json
generated/a-line/case_quality_report.generated.json
```

P3-A seed 文件是生成输入，不直接进入默认 `TestContext`。A 线 corpus/source/generated 对象使用 `schemaVersion: "p3-a-1"`；根目录运行时 fixture 和现有 B/C 线运行时对象仍可继续使用 `schemaVersion: "mvp-1"` 作为兼容域。`attack_seeds.json` 保存攻击目标、目标工具/资源和风险类别；`user_prompt_seeds.json` 保存进入 PyRIT/operator 变异前的用户 prompt 材料，包括歧义 user prompt、roleplay persona、多轮铺垫和委托授权。生成器先组合 `AttackSeed + UserPromptSeed`，再应用 PyRIT/AIG/operator 变异。`generated/a-line/**` 是可复现的测试输入和覆盖率材料，只能通过显式 run profile 被 B 线加载。默认 `loadConfigRepository()` 继续读取根目录共享运行时 fixture，不得默认加载 full corpus。

`CorpusManifest` 是 P3-A generated corpus 的来源索引和覆盖率对象，记录 PyRIT/AIG/manual/user_supplied/synthetic 来源、seed、operator、profile、case/prompt/oracle 映射和 coverage。它不是风险判定结果，不能替代 `InteractionTrace`、`RiskReport`、`RuntimeSupervisionRecord[]` 或 `DefenseReport`。

`AttackCaseCard` 是 P3-A 给 B 线选择攻击库时使用的脱敏元数据单元。它只包含 `caseId`、profile、攻击族、目标面、工具/资源 hint、来源、摘要、质量分和 digest，不包含完整 `task.instruction`、完整 prompt、tool response 内容、resource 内容、secret 或 `TestOracle.expectedOutcome` 细节。B 线可以把 card 或 `LlmSelectionCatalogItem` 交给规则选择器/LLM rerank 做候选排序，但真实运行仍必须通过 `caseId -> TestContext` 加载完整用例。

```ts
type AttackFamily =
  | "prompt_injection"
  | "data_leakage"
  | "tool_hijack"
  | "auth_bypass"
  | "memory_poisoning"
  | "environment_poisoning"
  | "model_evasion"
  | "dangerous_action"
  | "benign_control"

type TargetSurface =
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
  | "database"

type AttackCaseCard = {
  schemaVersion: "p3-a-1"
  cardId: string
  caseId: string
  caseName: string
  enabled: boolean
  runProfiles: CorpusRunProfileId[]
  attackFamilies: AttackFamily[]
  targetSurfaces: TargetSurface[]
  targetToolHints: string[]
  targetResourceHints: string[]
  sensitivityTags: string[]
  estimatedCost: "low" | "medium" | "high"
  estimatedDurationMs: number
  requiresExternalTool: boolean
  requiresNetwork: boolean
  requiresOpenClaw: boolean
  sourceOrigin: CorpusSourceOrigin
  sourceRefs: string[]
  promptSummary: string
  payloadRiskSummary: string
  expectedSafeBehaviorSummary: string
  oracleSummary: string
  qualityScore: number
  qualityWarnings: string[]
  digest: string
}
```

`LlmSelectionCatalogItem` 是 `AttackCaseCard` 的更小投影，只允许包含 `caseId`、profile、攻击族、目标面、工具 hint、敏感标签、成本、来源、脱敏摘要、质量分和 digest。它不得包含 `task.instruction`、prompt/resource/tool response 原文、`runtimeObjectivePayloadPreview` 或 oracle 原始对象。LLM 对 catalog 的选择理由只能用于测试编排解释，不能进入 `RiskReport.findings`、`DefenseClaim` 或任何风险结论。

`CoverageTaxonomy` 汇总 `AttackCaseCard[]` 的 profile、attack family、target surface、risk category 和 source origin 分布，用于 B 线覆盖 gate 和 C 线展示来源覆盖。`CaseQualityReport` 汇总低分、缺字段、摘要异常和重复 digest 等问题，用于 A/B 联调前过滤，不是风险报告。

`PyritBridgeRequest` / `PyritBridgeResult` 是 P3-A PyRIT Python runtime bridge 的输入输出对象。它用于显式调用 vendored PyRIT `run_attack_cli.py` 或 converter runtime，结果写入 `outputs/pyrit-runs/**`。模型环境未配置时必须返回 `modelConfigured: false` 与 `status: "skipped"`；只有 `runtimeUsed: "pyrit"` 且 `status: "ok"` 才代表真实 PyRIT runtime 完成。该对象不进入默认 `TestContext`，不得替代 B 线 `InteractionTrace` 或 C 线风险结论。

`configs/test_oracles.json` 和 `generated/a-line/test_oracles.generated.json` 都只用于验收测试、回归测试、corpus 质量检查和覆盖率统计，不得进入运行时 `TestContext`，也不得作为 C 线风险判定或防御效果证据。

P1 配置对象:

```ts
type RedTeamScenarioSet = {
  schemaVersion: "mvp-1"
  scenarioSetId: string
  name: string
  description?: string
  scenarios: RedTeamScenario[]
}

type RedTeamScenario = {
  scenarioId: string
  name: string
  attackType: string
  caseIds: string[]
  sampleIds: string[]
  expectedWeaknessCategories: RiskCategory[]
  recommendedPolicyTemplateIds: string[]
}

type PolicyTemplate = {
  schemaVersion: "mvp-1"
  policyTemplateId: string
  name: string
  description: string
  targetType: SupervisionPolicy["targetType"]
  action: SupervisionAction
  riskCategory: RiskCategory
  match: RuleMatchCondition
  reasonTemplate: string
}

type PyritAttackLibrary = {
  schemaVersion: "p3-a-1"
  libraryId: string
  name: string
  description: string
  source: PyritSourceMetadata
  converterCatalog: PyritPromptConverterSpec[]
  attackFamilies: PyritAttackFamily[]
  samples: PyritAttackSample[]
}

type PyritSourceMetadata = {
  upstreamName: string
  upstreamVersion?: string
  localSourcePath: string
  importedPath: string
  importedAt: string
  includedComponents: string[]
  excludedComponents: string[]
  notes?: string
}

type PyritPromptConverterSpec = {
  converterId: string
  name: string
  sourcePath: string
  executionMode: "native_ts_adapter" | "python_reference" | "metadata_only"
  supportedInputTypes: string[]
  tags: string[]
  description: string
  defaultOptions?: JsonObject
}

type PyritAttackFamily = {
  familyId: string
  name: string
  sourcePaths: string[]
  strategy: string
  maturity: "vendored_reference" | "config_integrated" | "runtime_integrated"
  recommendedCaseIds: string[]
  riskCategories: RiskCategory[]
  notes?: string
}

type PyritAttackSample = {
  sampleId: string
  familyId: string
  name: string
  sourcePath: string
  caseIds: string[]
  promptIds: string[]
  converterIds: string[]
  attackEntryType: AttackEntryType
  riskCategories: RiskCategory[]
  objective: string
  successMarkers: string[]
  safetyNotes: string
  metadata?: JsonObject
}

type PyritJailbreakTemplateIndex = {
  schemaVersion: "p3-a-1"
  indexId: string
  name: string
  description: string
  sourcePath: string
  generatedAt: string
  totalTemplates: number
  groups: PyritJailbreakTemplateGroup[]
  templates: PyritJailbreakTemplateRef[]
  safetyNotes: string
}

type PyritJailbreakTemplateGroup = {
  groupId: string
  name: string
  sourcePath: string
  templateCount: number
}

type PyritJailbreakTemplateRef = {
  templateId: string
  name: string
  groupId: string
  sourcePath: string
  sourceName?: string
  authors: string[]
  parameters: string[]
  dataType?: string
  harmCategories: string[]
  isGeneralTechnique?: boolean
  byteLength: number
  sha256: string
}

type PyritBridgeMode = "converter_batch" | "attack_cli"

type PyritBridgeRuntimeUsed = "pyrit" | "fallback" | "not_executed"

type PyritBridgeItemStatus = "ok" | "unsupported" | "error" | "skipped"

type PyritAttackMethod =
  | "prompt_sending"
  | "flip"
  | "red_teaming"
  | "crescendo"
  | "context_compliance"
  | "role_play"
  | "many_shot_jailbreak"
  | "renellm"

type PyritBridgeRequestItem = {
  itemId: string
  operatorId: string
  input: string
  inputType?: "text"
  method?: PyritAttackMethod
  objective?: string
  maxTurns?: number
  renellmMaxRounds?: number
  renellmRewriteStyle?: string
  evaluatorSync?: boolean
  metadata?: JsonObject
}

type PyritBridgeRequest = {
  schemaVersion: "p3-a-1"
  bridgeVersion: string
  requestId: string
  mode: PyritBridgeMode
  generatedAt: string
  items: PyritBridgeRequestItem[]
  options?: JsonObject
}

type PyritBridgeResultItem = {
  itemId: string
  operatorId: string
  status: PyritBridgeItemStatus
  input: string
  output?: string
  outputType?: string
  converterClass?: string
  method?: PyritAttackMethod
  objective?: string
  outputJsonPath?: string
  executedTurns?: number
  outcome?: string
  outcomeReason?: string
  lastScore?: JsonObject
  lastResponsePreview?: string
  runtimeUsed: PyritBridgeRuntimeUsed
  notes: string[]
  error?: string
  metadata?: JsonObject
}

type PyritBridgeResult = {
  schemaVersion: "p3-a-1"
  bridgeVersion: string
  requestId: string
  mode: PyritBridgeMode
  generatedAt: string
  startedAt: string
  endedAt: string
  pythonExecutable?: string
  pyritAvailable: boolean
  modelConfigured?: boolean
  fallbackAllowed: boolean
  items: PyritBridgeResultItem[]
  errors: string[]
  metadata?: JsonObject
}
```

P1 运行时监督动作 payload 固定使用 `SupervisionRuntimeAction.payload`，禁止 B 线自定义未进入契约的 payload 结构。标准 payload 包括:

```txt
RuntimeToolCallPayload
RuntimeResourceAccessPayload
RuntimeApiCallPayload
RuntimeFileWritePayload
RuntimeEmailSendPayload
RuntimeCodeExecutionPayload
RuntimeAgentMessagePayload
```

P1 检测报告和防御报告导出产物统一复用 `ReportArtifact`。暂不新增 `DetectionReportArtifact` 或 `DefenseReportArtifact` 专用类型；如后续确需区分，必须先修改本文档和 `packages/contracts/src/types/**`。

## 11. P3 测试选择契约

P3-B 新增测试选择对象，用于在监督前检测阶段把 A 线攻击库候选样本转换为一次可执行的测试计划。

新增共享类型位于:

```txt
packages/contracts/src/types/testSelection.ts
```

核心对象:

```txt
CandidateCaseCard
TestSelectionRequest
TestSelectionPlan
CoverageSnapshot
SelectionCoverageRequirements
SelectionProfileSummary
SelectionRunSummary
SelectionEvalStyleResult
SelectionReason
LlmSelectionAudit
```

边界约束:

- `CandidateCaseCard` 是攻击库元数据摘要，不包含完整攻击 prompt、secret、真实 payload 或 `TestOracle`。
- `TestSelectionPlan.selectedCaseIds` 只能引用候选池中存在且 enabled 的 case。
- `CoverageSnapshot.ready=false` 时，计划只能保存为 draft，不能直接驱动 e2e run。
- `LlmSelectionAudit` 只记录 LLM 辅助选择过程，不构成风险结论。
- `SelectionReason` 只能解释为什么选择 case，不得进入 `Finding`、`RiskReport` 或 `DefenseClaim`。
- `RunE2ERequest.selectionPlanId` 与 `caseIds` 不能同时传入。
- `P2RunGroup.selectionPlanId` 用于追溯本次运行来源。
- `SelectionProfileSummary` 描述 profile、模式、adapter 和预算，不改变攻击库内容。
- `SelectionRunSummary` 记录候选数、规则选择数、LLM 接受/拒绝数和 fallback 状态。
- `SelectionEvalStyleResult` 只表达测试选择计划的检查结果，不表达 Agent 风险结论。

第一版允许 B 线在 A 线正式 `CorpusManifest / AttackCaseCard[]` 上传前，从现有 `TestContext` 派生临时 `CandidateCaseCard`。该派生对象必须标记 `sourceOrigin: "derived"`，不得反向修改 A 线配置。

## 12. 契约演进规则

允许:

- 新增可选字段
- 在 payload 类型中增加事件类型相关细节
- 增加新的风险规则
- 增加新的报告导出格式

需要升级版本:

- 删除共享字段
- 修改共享字段语义
- 修改枚举值含义
- 改变风险等级计算方式
- 改变 `TraceEvent` 的排序规则

禁止:

- 无版本变更地修改字段含义
- 让模块依赖其他模块私有文件
- 让 Frontend Web Console 或报告展示入口直接解析 `risk_rules.json`
- 使用无法序列化为 JSON 的共享对象
