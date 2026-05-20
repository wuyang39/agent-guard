# Agent-MCP 交互安全测评系统接口契约

版本: mvp-1
日期: 2026-05-20
状态: MVP 契约基线

## 1. 契约总则

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
```

时间字段使用 ISO 8601 字符串。系统内部建议统一使用 UTC。

## 3. TestContext

`TestContext` 是配置模块对外输出的唯一测试上下文对象。

```ts
type TestContext = {
  schemaVersion: "mvp-1"
  configVersion: "mvp-1"
  caseId: string
  caseName: string
  agentProfile: AgentProfile
  tools: ToolDefinition[]
  resources: ResourceDefinition[]
  prompts: PromptDefinition[]
  riskRules: RiskRule[]
}
```

```ts
type AgentProfile = {
  agentId: string
  name: string
  description?: string
  allowedToolIds: string[]
  allowedResourceIds: string[]
}
```

```ts
type ToolDefinition = {
  toolId: string
  name: string
  description: string
  schema: Record<string, unknown>
  riskTags: RiskTag[]
}
```

```ts
type ResourceDefinition = {
  resourceId: string
  name: string
  type: string
  description?: string
  riskTags: RiskTag[]
  accessPolicy: AccessPolicy
}
```

```ts
type PromptDefinition = {
  promptId: string
  name: string
  description?: string
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

## 4. InteractionTrace

`InteractionTrace` 是监控模块对外输出的唯一交互事实对象。

```ts
type InteractionTrace = {
  schemaVersion: "mvp-1"
  traceId: string
  caseId: string
  events: TraceEvent[]
  startedAt: string
  endedAt?: string
  status: "running" | "completed" | "failed"
}
```

### TraceEvent

```ts
type TraceEventType =
  | "tool_call"
  | "tool_result"
  | "resource_access"
  | "prompt_load"
  | "agent_message"
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
  caseId: string
  timestamp: string
  sequence: number
  type: TraceEventType
  actor: TraceActor
  payload: Record<string, unknown>
}
```

事件约束:

- `sequence` 必须单调递增
- `timestamp` 使用 ISO 8601
- `payload` 可以扩展，但不能替代顶层标准字段
- 同一 `traceId` 下的 `eventId` 必须唯一
- 风险判定只能基于 `TraceEvent`、`TestContext` 和 `riskRules`

## 5. RiskRule

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
  toolIds?: string[]
  resourceIds?: string[]
  riskTagIds?: string[]
  payloadContains?: string[]
  parameterKeys?: string[]
}
```

MVP 的规则匹配能力保持简单，只做确定性匹配。复杂表达式语言、动态脚本规则和机器学习判定不进入 MVP。

## 6. RiskReport

`RiskReport` 是风险与报告模块对外输出的最终结果对象。

```ts
type RiskReport = {
  schemaVersion: "mvp-1"
  reportId: string
  caseId: string
  traceId: string
  riskLevel: RiskLevel
  findings: Finding[]
  evidenceChains: EvidenceChain[]
  generatedAt: string
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

报告约束:

- 每个 `Finding` 必须至少引用 1 个 `evidenceEventIds`
- `evidenceEventIds` 必须能在对应 `InteractionTrace.events` 中找到
- `RiskReport.riskLevel` 由全部 findings 的最高风险等级计算得到
- 当 `findings` 为空时，`RiskReport.riskLevel` 固定为 `low`
- 报告模块不得重新判定风险等级
- 报告模块不得绕过 `Finding` 直接解析原始日志生成结论

## 7. 配置文件契约

MVP 内置配置文件:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/risk_rules.json
configs/test_cases.json
```

配置加载后的唯一公开出口是 `TestContext`。其他模块不得直接读取 `configs/*.json` 参与运行时逻辑。

## 8. 契约演进规则

允许:

- 新增可选字段
- 在 `payload` 中增加事件类型相关细节
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
