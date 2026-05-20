# Agent-MCP 交互安全测评系统接口契约

版本: mvp-1
日期: 2026-05-20
状态: MVP 契约基线

## 1. 契约总则

系统唯一被测对象是 `Agent`。MCP Server、Tool、Resource、Prompt、Tool Response 注入内容、风险规则和测试用例均由系统内部提供，是测试夹具，不是被测对象。

所有跨模块共享对象必须包含:

- `schemaVersion`
- 可追踪的业务 ID
- 明确的时间字段
- 可序列化为 JSON 的数据结构

MVP 统一版本:

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
```

时间字段使用 ISO 8601 字符串。系统内部建议统一使用 UTC。

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

`AgentAdapterConfig` 描述如何调用被测 Agent。MVP 不在该对象中保存明文密钥；密钥通过本地环境变量或运行时安全配置注入。

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
  metadata?: Record<string, unknown>
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
  schema: Record<string, unknown>
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
  expectedOutcome: ExpectedOutcome
  enabled: boolean
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

MVP 至少覆盖:

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
  parameters: Record<string, unknown>
  isHighRiskTool: boolean
}

type ToolResultPayload = {
  callId: string
  toolId: string
  result: unknown
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
  detail?: Record<string, unknown>
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
  eventTypes?: TraceEventType[]
  attackEntryTypes?: AttackEntryType[]
  toolIds?: string[]
  resourceIds?: string[]
  promptIds?: string[]
  riskTagIds?: string[]
  payloadContains?: string[]
  parameterKeys?: string[]
  sensitiveKeywords?: string[]
}
```

MVP 的规则匹配能力保持简单，只做确定性匹配。复杂表达式语言、动态脚本规则和机器学习判定不进入 MVP。

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

- MVP 必须导出 JSON 与 HTML
- Markdown 与 PDF 可以后续实现
- 报告模块不得重新判定风险等级
- 报告模块不得绕过 `Finding` 直接解析原始日志生成结论

## 10. 配置文件契约

MVP 内置配置文件:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/risk_rules.json
configs/test_cases.json
```

配置加载后的唯一公开出口是 `TestContext`。其他模块不得直接读取 `configs/*.json` 参与运行时逻辑。

## 11. 契约演进规则

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
- 让展示层直接解析 `risk_rules.json`
- 使用无法序列化为 JSON 的共享对象
