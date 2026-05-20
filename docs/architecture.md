# Agent-MCP 交互安全测评系统总体架构约束

版本: mvp-1
日期: 2026-05-20
状态: MVP 约束基线

## 1. 系统目标

本系统聚焦测试 Agent 在系统内置 MCP 测试环境中的行为安全性。系统唯一被测对象是 `Agent`。

MCP Server、Tool、Resource、Prompt、Tool Response 注入内容、风险规则和测试用例都属于系统内部测试夹具，不作为被测对象。MVP 不测试 MCP Server 本身是否存在漏洞，也不做传统代码审计。

MVP 阶段只验证一条完整测评闭环:

```txt
被测 Agent -> Agent Adapter -> Test Runner -> MCP Sandbox -> MCP Monitor -> 交互日志采集 -> 风险判定 -> 证据链生成 -> 报告输出
```

MVP 的目标不是构建完整线上平台，而是先让三名开发者能够围绕稳定的数据契约并行开发，并跑通一次可追溯的 Agent-MCP 安全测评流程。

## 2. MVP 范围

MVP 必须包含:

- 接入一个被测 Agent，并通过统一接口驱动它执行测试任务
- 加载系统内置测试配置，生成 `TestContext`
- 构建系统内置 MCP Sandbox，提供可控 Tool、Resource、Prompt 和 Tool Response
- 执行至少 1 个测试用例
- 记录 Agent 与 MCP 的交互事件，生成 `InteractionTrace`
- 基于规则生成风险发现和证据链
- 输出 JSON 与 HTML 格式的报告产物
- 支持通过 `traceId` 从报告追溯到原始交互事件

MVP 暂不包含:

- MCP Server 漏洞扫描
- 真实 MCP Server 安全审计
- 多 Agent 编排
- 攻击用例自动生成
- 实时风险阻断
- 流式风险判定
- 复杂权限系统
- 多租户与线上部署
- 外部配置中心
- 必须依赖真实线上 MCP 服务的演示流程

## 3. 主数据流

系统第一版只允许一条主数据流:

```txt
AgentUnderTest -> AgentAdapterConfig -> TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport -> ReportArtifact
```

后一个模块只能消费前一个模块公开输出的数据对象。禁止跨层直接读取其他模块的内部文件、私有类、缓存对象或临时日志。

## 4. 三人开发边界

### 开发者 A: 测试数据仓库与 MCP Sandbox 建模

负责:

- `tools.json`
- `resources.json`
- `prompts.json`
- `risk_rules.json`
- `test_cases.json`
- 配置加载、校验与转换
- MCP Tool / Resource / Prompt 风险标签建模
- 系统内置 MCP Sandbox 环境画像
- 测试用例编排
- 输出统一的 `TestContext`

不负责:

- 不接入被测 Agent
- 不采集 Agent-MCP 实时交互日志
- 不执行风险判定
- 不生成最终报告

核心交付物:

```txt
configs/*.json -> McpSandboxProfile + TestCase[] -> TestContext
```

### 开发者 B: Agent 接入、测试执行与动态监控

负责:

- 接入被测 Agent
- 实现统一调用接口 `sendTask()`
- 根据 `TestContext` 执行测试用例
- 驱动 Agent 使用系统内置 MCP Sandbox
- 捕获 Agent 调用 MCP Tool 的过程
- 记录 tool call、tool result、resource access、prompt load、agent message、system error
- 记录事件时间顺序
- 输出 `TestRun`
- 输出统一的 `InteractionTrace`

不负责:

- 不维护 MCP Sandbox 配置
- 不决定风险等级
- 不维护测试配置结构
- 不生成报告展示

核心交付物:

```txt
AgentUnderTest + AgentAdapterConfig + TestContext -> TestRun + InteractionTrace
```

### 开发者 C: 风险判定、证据链与报告模块

负责:

- 输入 `TestContext` 与 `InteractionTrace`
- 根据 `riskRules` 生成风险发现
- 生成证据链
- 生成攻击链
- 计算总体风险等级
- 组装 `RiskReport`
- 导出 JSON 与 HTML 报告产物
- 后续实现 Markdown / PDF 导出

不负责:

- 不采集底层 MCP 调用
- 不维护配置仓库
- 不绕过标准事件流读取临时日志

核心交付物:

```txt
TestContext + InteractionTrace -> RiskEvaluationResult -> RiskReport + ReportArtifact
```

## 5. 开发者接口交接

三名开发者之间只允许通过公开数据对象交接:

```txt
外部输入:
  AgentUnderTest
  AgentAdapterConfig

A -> B:
  TestContext
  McpSandboxProfile
  TestCase

B -> C:
  TestRun
  InteractionTrace

C -> 展示层:
  RiskReport
  ReportArtifact
```

详细字段以 `docs/contracts.md` 和 `docs/interfaces.md` 为准。任何共享字段变更必须先更新文档，再进入联调。

## 6. 模块边界

建议目录结构:

```txt
agent-mcp-security-eval/
  configs/
    tools.json
    resources.json
    prompts.json
    risk_rules.json
    test_cases.json

  src/
    agent/
      agentAdapter.ts
      agentTypes.ts

    config/
      loadTestContext.ts
      schemas.ts

    sandbox/
      mcpSandbox.ts
      sandboxTypes.ts

    runner/
      testRunner.ts
      runTypes.ts

    monitor/
      mcpMonitor.ts
      traceRecorder.ts
      traceTypes.ts

    risk/
      ruleEngine.ts
      riskEvaluator.ts
      evidenceBuilder.ts
      riskTypes.ts

    report/
      reportBuilder.ts
      reportTypes.ts
      exporters/

    shared/
      ids.ts
      time.ts
      errors.ts
      schemaVersion.ts

  outputs/
    traces/
    reports/

  docs/
    architecture.md
    contracts.md
    development-rules.md
    interfaces.md
```

目录职责:

- `configs/`: 系统内置测试数据和规则数据。MVP 不接数据库，不接远程配置中心。
- `src/agent/`: 接入被测 Agent，提供统一调用接口。
- `src/config/`: 加载、校验并转换配置，输出 `TestContext`。
- `src/sandbox/`: 提供系统内置 MCP 测试环境。
- `src/runner/`: 根据测试用例驱动 Agent 运行。
- `src/monitor/`: 采集 Agent-MCP 交互，只输出 `InteractionTrace`。
- `src/risk/`: 风险判定和证据链生成，只输入 `TestContext` 与 `InteractionTrace`。
- `src/report/`: 组装、展示和导出 `RiskReport`，不重新判定风险。
- `src/shared/`: 只放跨模块通用的小工具，禁止承载业务逻辑。

## 7. 执行模式

MVP 采用离线判定:

1. 接入被测 Agent，生成 `AgentUnderTest` 与 `AgentAdapterConfig`
2. 加载测试配置，生成 `McpSandboxProfile`、`TestCase` 与 `TestContext`
3. 通过 Test Runner 执行一次 Agent-MCP 测试，生成 `TestRun`
4. MCP Monitor 记录完整事件，生成 `InteractionTrace`
5. 测试结束后批量运行风险规则，生成 `RiskEvaluationResult`
6. 报告模块组装 `RiskReport`，导出 JSON 与 HTML `ReportArtifact`
7. 展示层读取 `RiskReport`
8. 需要追溯详情时，根据 `traceId` 读取对应 `InteractionTrace`

MVP 不做实时阻断、不做流式风险判定、不要求数据库事务。

## 8. 输出文件约束

每次测试运行至少生成:

```txt
outputs/traces/{caseId}-{traceId}.json
outputs/reports/{caseId}-{reportId}.json
outputs/reports/{caseId}-{reportId}.html
```

报告展示默认只读取 `outputs/reports/`。当用户查看证据链或 Tool Call Trace 时，再通过 `traceId` 读取对应 trace 文件。

## 9. 架构原则

- 只有 Agent 是被测对象，MCP 环境是系统内部测试夹具
- 共享对象优先，内部实现其次
- 风险判定只相信 `TestContext`、`InteractionTrace` 和 `riskRules`
- 报告只呈现风险模块产出的结果，不重新解释原始日志
- 所有可追溯结论都必须引用 `eventId`
- 三人协作以契约对齐，不以口头约定对齐
