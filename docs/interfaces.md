# Agent-MCP 交互安全测评系统开发者接口清单

版本: mvp-1
日期: 2026-05-20
状态: MVP 联调接口基线

## 1. 接口边界总览

本系统唯一被测对象是 `AgentUnderTest`。MCP Server、Tool、Resource、Prompt、Tool Response、风险规则和测试用例都由系统内部提供。

三名开发者之间只通过下列对象交接:

```txt
外部输入 -> A/B:
  AgentUnderTest
  AgentAdapterConfig

A -> B:
  TestContext

B -> C:
  TestRun
  InteractionTrace

C -> 展示层:
  RiskReport
  ReportArtifact[]
```

任何模块不得要求其他开发者提供私有类、临时日志、缓存对象或未写入契约文档的字段。

## 2. 开发者 A 对外接口

职责: 测试数据仓库、MCP Sandbox 建模、测试用例建模。

输入:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/tool_responses.json
configs/risk_rules.json
configs/test_cases.json
configs/test_oracles.json
AgentUnderTest
```

输出给 B:

```txt
TestContext
```

输出给 C:

```txt
TestContext
```

`TestContext` 必须包含:

```txt
schemaVersion
configVersion
contextId
caseId
caseName
agent
sandbox
testCase
riskRules
```

`TestContext` 禁止包含:

```txt
expectedOutcome
TestOracle
```

其中 `sandbox` 必须包含:

```txt
McpSandboxProfile
ToolDefinition[]
ResourceDefinition[]
PromptDefinition[]
ToolResponseTemplate[]
```

其中 `testCase` 必须包含 `toolResponsePlan`，用于声明本用例中 Tool Response 模板如何绑定到工具调用。

验收方式:

```txt
configs/*.json -> loadTestContext() -> TestContext + TestOracle[]
```

开发者 A 不需要知道 Agent 如何运行，也不需要读取运行时 trace。

## 3. 开发者 B 对外接口

职责: Agent 接入、测试执行、MCP Sandbox 运行、交互监控。

输入:

```txt
AgentUnderTest
AgentAdapterConfig
TestContext
```

输出给 C:

```txt
TestRun
InteractionTrace
```

`TestRun` 必须包含:

```txt
schemaVersion
runId
contextId
caseId
agentId
sandboxId
status
startedAt
endedAt
error
```

`InteractionTrace` 必须包含:

```txt
schemaVersion
traceId
runId
contextId
caseId
agentId
sandboxId
events
startedAt
endedAt
status
```

`TraceEvent` 必须包含:

```txt
eventId
traceId
runId
caseId
timestamp
sequence
type
actor
payload
```

验收方式:

```txt
AgentUnderTest + AgentAdapterConfig + TestContext
  -> runTestCase()
  -> TestRun + InteractionTrace
```

开发者 B 可以根据 `TestContext.sandbox` 运行系统内置 MCP 环境，但不得修改 `riskRules` 或计算风险等级。

## 4. 开发者 C 对外接口

职责: 风险判定、证据链、攻击链、报告生成。

输入:

```txt
TestContext
TestRun
InteractionTrace
```

输出给展示层:

```txt
RiskEvaluationResult
RiskReport
ReportArtifact[]
```

`RiskEvaluationResult` 必须包含:

```txt
schemaVersion
evaluationId
contextId
caseId
traceId
riskLevel
findings
evidenceChains
attackChains
evaluatedAt
```

`RiskReport` 必须包含:

```txt
schemaVersion
reportId
evaluationId
contextId
caseId
traceId
riskLevel
summary
caseReport
highRiskIssues
findings
evidenceChains
attackChains
toolCallTrace
attackChainViews
generatedAt
```

`ReportArtifact` 必须包含:

```txt
schemaVersion
artifactId
reportId
format
path
generatedAt
```

验收方式:

```txt
TestContext + InteractionTrace
  -> evaluateRisk()
  -> RiskEvaluationResult
  -> buildRiskReport()
  -> RiskReport + ReportArtifact[]
```

开发者 C 不得重新采集 Agent-MCP 交互，不得直接读取 `configs/*.json` 参与运行时判定，不得绕过 `Finding` 生成报告结论。

## 5. 联调检查表

每次联调前检查:

- 所有共享对象都有 `schemaVersion: "mvp-1"`
- `TestContext.caseId` 与 `InteractionTrace.caseId` 一致
- `TestContext.contextId` 与 `InteractionTrace.contextId` 一致
- `InteractionTrace.events` 按 `sequence` 单调递增
- `tool_call` 与 `tool_result` 能通过 `callId` 关联
- `Finding.evidenceEventIds` 都能在 `InteractionTrace.events` 中找到
- `RiskReport.traceId` 指向本次 `InteractionTrace.traceId`
- `RiskReport.findings` 与 `RiskEvaluationResult.findings` 一致
- `RiskReport.evidenceChains` 与 `RiskEvaluationResult.evidenceChains` 一致
- `ReportArtifact[]` 至少包含 `json` 和 `html`
- 每个 `ReportArtifact.reportId` 都指向本次 `RiskReport.reportId`

联调失败时，先修接口契约和 mock 数据，再讨论业务逻辑。
