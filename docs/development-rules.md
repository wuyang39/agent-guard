# Agent-MCP 交互安全测评系统开发协作规则

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是开发协作纪律的初始基线。目录 ownership 以 `docs/ownership.md` 为准，数据契约以 `docs/contracts.md` 为准。

## 1. 协作原则

三人开发以共享契约为边界:

```txt
AgentUnderTest -> AgentAdapterConfig -> TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport -> ReportArtifact[]
```

任何模块不得依赖其他模块的内部实现。联调失败时，优先检查 schema、字段命名、版本号和事件顺序，不优先临时修改业务逻辑。

## 2. 模块责任

### 开发者 A

负责测试数据仓库、MCP Sandbox 建模与测试上下文:

- 维护 `configs/*.json`
- 实现配置加载和校验
- 建模系统内置 MCP Tool、Resource、Prompt 和 Tool Response
- 维护运行时 `TestCase`
- 维护验收专用 `TestOracle` 与 `ExpectedOutcome`
- 输出 `McpSandboxProfile`
- 输出 `TestContext`
- 提供 config 模块 demo

不得:

- 接入或驱动被测 Agent
- 直接生成风险报告
- 修改 trace 采集逻辑
- 在配置模块中读取运行时 trace

### 开发者 B

负责 Agent 接入、测试执行、MCP Sandbox 运行和事件记录:

- 接入 `AgentUnderTest`
- 读取 `AgentAdapterConfig`
- 实现统一调用接口 `sendTask()`
- 基于 `TestContext` 执行测试用例
- 驱动 Agent 与系统内置 MCP Sandbox 交互
- 捕获 Agent-MCP 交互
- 生成标准化 `TraceEvent`
- 输出 `TestRun`
- 输出 `InteractionTrace`
- 提供 monitor 模块 demo

不得:

- 修改 `TestCase`、`RiskRule` 或 MCP Sandbox 配置
- 内置风险判定规则
- 直接计算风险等级
- 修改配置文件结构

### 开发者 C

负责风险判定、证据链和报告:

- 输入 `TestContext` 与 `InteractionTrace`
- 输出 `RiskEvaluationResult`
- 输出 `RiskReport`
- 输出 `ReportArtifact[]`
- 维护风险判定逻辑
- 维护证据链生成逻辑
- 维护攻击链生成逻辑
- 提供 risk/report 模块 demo

不得:

- 绕过 `InteractionTrace` 读取临时日志
- 直接修改配置仓库
- 在报告展示中重新判定风险

## 3. 命名规范

共享数据类型使用名词:

```txt
AgentUnderTest
AgentAdapterConfig
AgentTask
AgentRunResult
JsonValue
JsonObject
McpSandboxProfile
TestContext
TestCase
ToolResponsePlan
TestOracle
ExpectedOutcome
TestRun
InteractionTrace
TraceEvent
TraceEventPayload
RiskRule
FieldMatcher
Finding
EvidenceChain
AttackChain
RiskEvaluationResult
RiskReport
ReportArtifact[]
```

模块入口函数使用动词:

```txt
loadTestContext()
createMcpSandbox()
sendTask()
runTestCase()
recordTraceEvent()
evaluateRisk()
buildEvidenceChain()
buildAttackChain()
buildRiskReport()
exportReport()
```

文件命名:

- TypeScript 文件使用 `camelCase.ts`
- JSON 配置文件使用 `snake_case.json`
- 文档文件使用小写短横线或既有约定

## 4. Import 约束

允许:

```txt
riskEvaluator.ts -> imports TestContext type
riskEvaluator.ts -> imports InteractionTrace type
riskEvaluator.ts -> imports RiskRule type
testRunner.ts -> imports AgentUnderTest type
testRunner.ts -> imports TestContext type
reportBuilder.ts -> imports RiskEvaluationResult type
```

不允许:

```txt
riskEvaluator.ts -> imports traceRecorder.ts
riskEvaluator.ts -> reads outputs/traces/raw.log directly
riskEvaluator.ts -> modifies configs/risk_rules.json at runtime
reportBuilder.ts -> reads configs/risk_rules.json directly
monitor.ts -> calculates RiskLevel
```

共享代码边界:

- `packages/contracts/` 只能存放前后端共享数据契约和稳定 API 类型，禁止放运行时业务逻辑。
- `backend/src/shared/` 只能存放后端内部通用小工具，例如 ID、时间、错误类型和 schema version。
- 禁止将 Agent 调用、Sandbox 运行、风险判定、报告导出或前端组件状态塞入共享目录。

## 5. MVP 风险规则

第一版只覆盖 4 类核心风险:

1. 工具误用风险: Agent 调用了测试用例不允许的 MCP Tool，或使用明显异常参数
2. 越权访问风险: Agent 访问未授权 Resource，或访问行为不符合资源标签约束
3. 敏感数据泄露风险: Tool 参数、Tool 返回、Agent 消息或 Resource 内容中出现敏感字段泄露迹象
4. 危险动作风险: Agent 触发删除、外传、写入敏感资源、执行未经授权命令等高危操作

同时记录 1 类注入跟随行为:

```txt
instruction_injection_following:
  Agent 是否跟随恶意 Prompt、恶意 Resource 或 Tool Response 中的注入指令。
```

风险等级固定为:

```txt
low / medium / high / critical
```

## 6. 禁止事项

MVP 阶段明确禁止:

- 风险模块直接读取原始临时日志文件
- 报告模块重新判定风险等级
- 监控模块内置风险规则
- 配置模块依赖运行时 trace 数据
- 模块间互相 import 对方内部实现文件
- 没有 `schemaVersion` 的共享数据对象进入模块边界
- Frontend Web Console 或报告展示入口直接解析 `risk_rules.json`
- 为了演示效果手写假报告绕过 `RiskReport`
- 私下修改共享字段名或枚举值
- 使用口头约定替代文档契约
- 把 MCP Server 当成被测对象做漏洞扫描
- 将系统内置 Tool、Resource、Prompt 的配置散落到代码里
- 在 `AgentAdapterConfig` 中保存明文密钥
- 将 `ExpectedOutcome`、`TestOracle` 传入风险判定运行时
- 在共享对象中使用 `any`、`unknown` 或不可 JSON 序列化的字段

## 7. 开发顺序

推荐推进顺序:

1. 先定共享类型: `AgentUnderTest`、`McpSandboxProfile`、`TestCase`、`TestContext`、`InteractionTrace`、`RiskReport`
2. 再做 mock 数据闭环: 用 mock Agent 和 mock trace 跑通风险判定与报告生成
3. 再接入 Agent Adapter: 通过 `sendTask()` 驱动被测 Agent
4. 再接入真实监控: 监控模块替换 mock trace，但保持 `InteractionTrace` 格式不变
5. 最后实现前端展示: Frontend Web Console 只通过 Report API 或报告产物消费 `RiskReport` 和 `ReportArtifact[]`

`frontend/demo/` 只用于展示理想功能流程，不参与正式前端开发顺序。正式前端实现仍以 `frontend/src/**` 为准。

## 8. 模块级 Demo

每个开发者都要提供自己的模块级 demo:

```txt
开发者 A:
  input: configs/*.json
  output: McpSandboxProfile + TestCase[] + TestOracle[] + TestContext

开发者 B:
  input: AgentUnderTest + AgentAdapterConfig + TestContext
  output: TestRun + InteractionTrace

开发者 C:
  input: TestContext + InteractionTrace
  output: RiskEvaluationResult + RiskReport + ReportArtifact[]
```

总联调只接受:

```txt
AgentUnderTest + AgentAdapterConfig + TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport + ReportArtifact[]
```

## 9. MVP 验收标准

MVP 完成时必须满足:

- 能加载一组内置 JSON 测试配置并生成 `TestContext`
- `ExpectedOutcome` 只能存在于 `TestOracle`，不得进入运行时 `TestContext`
- 能接入一个被测 Agent，生成 `AgentUnderTest` 与 `AgentAdapterConfig`
- 能构建系统内置 MCP Sandbox
- 能通过 `toolResponsePlan` 绑定 Tool Response 注入样例
- 能运行至少 1 个测试用例
- 能记录完整 `InteractionTrace`
- 每条 trace event 都有 `eventId`、`caseId`、`traceId`、`sequence`、`timestamp`
- 能基于 `risk_rules.json` 生成 `RiskReport`
- 每个 `Finding` 至少引用 1 个 `evidenceEventIds`
- 能输出 JSON 和 HTML 报告文件
- 报告中能看到总体风险等级、风险列表、证据链、原始 trace 引用
- 三个模块可以分别用 mock 数据单独测试
- 不依赖真实线上 MCP 服务也能跑通 MVP demo

## 10. 变更流程

共享契约变更流程:

1. 提出变更原因
2. 修改 `docs/contracts.md`
3. 更新 `packages/contracts/src/types/**` 中的相关类型或 JSON Schema
4. 更新至少一个 mock 样例
5. 通知其他开发者按文档更新

未经文档更新的共享字段变更不得进入联调分支。
