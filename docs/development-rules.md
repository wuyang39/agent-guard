# Agent-MCP 交互安全测评系统开发协作规则

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是开发协作纪律的初始基线。系统最终目标是形成可用于信息安全作品赛的完整 Agent-MCP 交互安全测评系统；当前规则优先保障 P0 垂直闭环、P1 检测画像驱动监督和正式前端并行开发。目录 ownership 以 `docs/ownership.md` 为准，数据契约以 `docs/contracts.md` 为准。

## 1. 协作原则

开发者以共享契约为边界:

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

### 开发者 D

负责正式前端 Web Console:

- 维护 `frontend/src/**`
- 实现 Dashboard、AgentConnect、TestCases、TestRuns、TraceDetail、RiskReports、Detection、Supervision、DefenseReports、Configs、System 等页面
- 实现前端 API Client、view model、hook、格式化函数和展示组件
- 只通过 Backend API、报告产物和 `packages/contracts` 消费数据
- 展示 A/B/C 产出的运行、风险、检测、策略、监督和防御结果

不得:

- 直接 import `backend/src/**`
- 直接读取 `configs/*.json`、`outputs/**` 作为业务数据源
- 在前端重新判定风险、生成策略包或生成防御报告
- 修改共享契约字段，除非已经经过协调人冻结流程
- 让 `frontend/demo/**` 的临时字段反向决定正式前端或 contracts

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

## 5. 风险规则阶段基线

P0 先覆盖 4 类核心风险:

1. 工具误用风险: Agent 调用了测试用例不允许的 MCP Tool，或使用明显异常参数
2. 越权访问风险: Agent 访问未授权 Resource，或访问行为不符合资源标签约束
3. 敏感数据泄露风险: Tool 参数、Tool 返回、Agent 消息或 Resource 内容中出现敏感字段泄露迹象
4. 危险动作风险: Agent 触发删除、外传、写入敏感资源、执行未经授权命令等高危操作

同时记录 1 类注入跟随行为:

```txt
instruction_injection_following:
  Agent 是否跟随恶意 Prompt、恶意 Resource 或 Tool Response 中的注入指令。
```

P0 风险等级固定为:

```txt
low / medium / high / critical
```

完整系统后续应在不破坏既有规则契约的前提下扩展:

- 更完整的 Prompt / Resource / Tool Response 注入变体
- 多轮诱导、上下文污染和工具链组合攻击识别
- 敏感数据类型分级、泄露路径和外传渠道识别
- 规则命中率、误报、漏报和场景覆盖率统计
- Agent 安全能力评分和不同 Agent 的横向对比
- 面向报告展示的风险解释、证据权重和攻击链摘要

## 6. 禁止事项

P0 和后续阶段都必须遵守:

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
- 正式前端直接读取后端私有模块、配置文件或 outputs 原始文件
- 正式前端重新计算风险等级、风险画像、策略包或防御效果

## 7. 开发顺序

推荐推进顺序:

1. 先定共享类型: `AgentUnderTest`、`McpSandboxProfile`、`TestCase`、`TestContext`、`InteractionTrace`、`RiskReport`
2. 再做 mock 数据闭环: 用 mock Agent 和 mock trace 跑通风险判定与报告生成
3. 再接入 Agent Adapter: 通过 `sendTask()` 驱动被测 Agent
4. 再接入真实监控: 监控模块替换 mock trace，但保持 `InteractionTrace` 格式不变
5. 最后实现前端展示: Frontend Web Console 只通过 Backend API 或报告产物消费共享契约对象

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

开发者 D:
  input: Backend API response + ReportArtifact[] + packages/contracts types
  output: Frontend Web Console page + ViewModel + API request payload
```

总联调只接受:

```txt
AgentUnderTest + AgentAdapterConfig + TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport + ReportArtifact[]
```

## 9. 阶段验收标准

### 9.1 P0 垂直闭环验收

P0 完成时必须满足:

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
- 不依赖真实线上 MCP 服务也能跑通 P0 demo

### 9.2 完整系统验收方向

后续阶段应逐步满足:

- 能维护成体系的测试场景库，并区分基础、进阶、组合攻击、展示和回归场景
- 能对同一 Agent 批量运行多条测试用例，并输出场景覆盖、风险分布和失败原因
- 能对不同 Agent 或不同规则版本进行横向对比
- 能回放历史 `InteractionTrace`，并复现报告中的证据链和攻击链
- 能输出适合答辩展示的 Dashboard、风险报告、攻击链视图和证据详情
- 能说明风险评分依据、规则命中逻辑、系统创新点和测评边界
- 新增场景、规则、报告格式或展示页面时，不破坏 P0 主数据流和共享契约

## 10. 变更流程

共享契约变更流程:

1. 提出变更原因
2. 修改 `docs/contracts.md`
3. 更新 `packages/contracts/src/types/**` 中的相关类型或 JSON Schema
4. 更新至少一个 mock 样例
5. 通知其他开发者按文档更新

未经文档更新的共享字段变更不得进入联调分支。

## 11. P1 协调人工作规则

P1 采用“检测发现弱点 -> 生成策略包 -> 真实运行监督 -> 防御报告证明有效”的两段式开发。协调人的首要任务是冻结跨模块对象，而不是让后端 A/B/C 三条线和前端 D 同时抢改接口。

P1 主链路:

```txt
TestContext
  -> TestRun + InteractionTrace
  -> RiskEvaluationResult + RiskReport
  -> DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack
  -> RuntimeSupervisionRecord[]
  -> DefenseReport
```

### 11.1 P1 里程碑

P1-A: 监督前检测与策略包生成

```txt
Trace -> RiskReport -> DetectionReport -> AgentRiskProfile -> SupervisionPolicyPack
```

验收:

- 至少 3 类红队场景可运行
- 全链路检测输出风险报告
- 能生成检测报告和风险画像
- 能基于风险画像生成策略包

P1-B: 运行时监督与防御报告

```txt
SupervisionPolicyPack -> AgentSupervisor -> RuntimeSupervisionRecord[] -> DefenseReport
```

验收:

- 一个真实或半真实 Agent 能加载策略包
- 至少 4 类工具行为被监督
- 至少 1 个高风险行为被阻断
- 能生成防御报告并追溯到检测报告和策略包

### 11.2 P1 冻结顺序

协调人按以下顺序冻结接口:

1. `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack`
2. `RuntimeSupervisionRecord`、`RuntimeAlert`、`BlockedAction`
3. `DefenseReport`
4. API request / response
5. 前端视图模型

冻结前可以讨论字段；冻结后只允许新增可选字段。删除字段、修改字段含义、修改枚举含义必须重新同步:

```txt
docs/contracts.md
docs/interfaces.md
docs/ownership.md
packages/contracts/src/types/**
至少一个 mock 样例
至少一个验证脚本
```

### 11.3 Contracts 修改纪律

P1 初期禁止 A/B/C/D 同时修改 `packages/contracts/src/types/**`。推荐做法:

1. 协调人先收集 A/B/C/D 字段需求
2. 由一人集中提交 P1 类型草案
3. A/B/C/D 分别确认是否可生产、可执行、可报告、可展示
4. 冻结后各自实现模块

新增类型建议:

```txt
detection.ts
policy.ts
supervision.ts
defense.ts
```

### 11.4 P1 合并前检查

任何 P1 分支合并前必须确认:

- 没有把 `TestOracle` 传入运行时风险判定
- 没有让 B 根据 `RiskReport` 私自生成策略
- 没有让 C 编造运行时阻断记录
- 没有让前端直接读取 `configs/*.json` 解释风险或策略
- 没有让前端直接 import `backend/src/**`
- `SupervisionPolicyPack` 的每条策略都能追溯到检测报告或策略模板
- `RuntimeSupervisionRecord` 的每条阻断都能追溯到策略包
- `DefenseReport` 的防御效果来自真实监督记录

合并前至少运行:

```txt
npm run typecheck
npm run verify:p1:detection-policy
npm run verify:p1:supervision-defense
```

### 11.5 冲突处理顺序

P1 并行开发出现冲突时，协调人按以下顺序处理:

1. 先确认对象归属: 谁生产、谁消费、谁展示
2. 再确认字段语义: 字段是否属于检测、策略、运行时监督或防御报告
3. 再确认数据来源: 是否来自配置、trace、risk report、策略包或运行时记录
4. 最后再改代码

不要用临时代码绕过接口冲突。接口冲突必须回到 `docs/interfaces.md` 和 `docs/contracts.md` 解决。
