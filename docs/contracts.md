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
type SchemaVersion = "mvp-1"

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
configs/pyrit_attack_library.json
```

`configs/red_team_scenarios.json` 用于维护红队场景索引、用例归属和样本引用。`configs/supervision_policy_templates.json` 用于维护可复用策略模板。根据某个 Agent 检测结果生成的 `SupervisionPolicyPack` 不得写回策略模板配置文件。

P2 新增的 `configs/pyrit_attack_library.json` 用于维护迁入 PyRIT 攻击库的来源、converter catalog、attack family 和 sample 到 case 的映射。它是攻击库目录对象，不是风险判定结果。

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
  schemaVersion: "mvp-1"
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
