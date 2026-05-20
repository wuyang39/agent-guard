# Agent-MCP 交互安全测评系统总体架构约束

版本: mvp-1
日期: 2026-05-20
状态: MVP 约束基线

## 1. 系统目标

本系统聚焦测试 Agent 在与 MCP Server / Tool / Resource / Prompt 交互过程中的安全性。MVP 阶段只验证一条完整测评闭环:

```txt
被测 Agent -> MCP 交互监控 -> 交互日志采集 -> 风险判定 -> 证据链生成 -> 报告输出
```

MVP 的目标不是构建完整线上平台，而是先让三名开发者能够围绕稳定的数据契约并行开发，并跑通一次可追溯的 Agent-MCP 安全测评流程。

## 2. MVP 范围

MVP 必须包含:

- 加载系统内置测试配置，生成 `TestContext`
- 执行至少 1 个测试用例
- 记录 Agent 与 MCP 的交互事件，生成 `InteractionTrace`
- 基于规则生成风险发现和证据链
- 输出 JSON 格式的 `RiskReport`
- 支持通过 `traceId` 从报告追溯到原始交互事件

MVP 暂不包含:

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
ConfigRepository -> TestContext -> InteractionTrace -> RiskReport -> ResultView
```

后一个模块只能消费前一个模块公开输出的数据对象。禁止跨层直接读取其他模块的内部文件、私有类、缓存对象或临时日志。

## 4. 三人开发边界

### 开发者 A: 测试环境与配置数据模块

负责:

- `tools.json`
- `resources.json`
- `prompts.json`
- `risk_rules.json`
- `test_cases.json`
- 配置加载、校验与转换
- MCP Tool / Resource / Prompt 风险标签建模
- 测试用例编排
- 输出统一的 `TestContext`

不负责:

- 不采集 Agent-MCP 实时交互日志
- 不执行风险判定
- 不生成最终报告

核心交付物:

```txt
configs/*.json -> TestContext
```

### 开发者 B: 动态交互监控与日志模块

负责:

- 捕获 Agent 调用 MCP Tool 的过程
- 记录 tool call、tool result、resource access、prompt load、agent message、system error
- 记录事件时间顺序
- 输出统一的 `InteractionTrace`

不负责:

- 不决定风险等级
- 不维护测试配置结构
- 不生成报告展示

核心交付物:

```txt
Agent-MCP interaction -> InteractionTrace
```

### 开发者 C: 风险判定、证据链与报告模块

负责:

- 输入 `TestContext` 与 `InteractionTrace`
- 根据 `riskRules` 生成风险发现
- 生成证据链
- 计算总体风险等级
- 组装并导出 JSON 报告
- 后续实现报告可视化与 PDF 导出

不负责:

- 不采集底层 MCP 调用
- 不维护配置仓库
- 不绕过标准事件流读取临时日志

核心交付物:

```txt
TestContext + InteractionTrace -> RiskReport
```

## 5. 模块边界

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
    config/
      loadTestContext.ts
      schemas.ts

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
```

目录职责:

- `configs/`: 系统内置测试数据和规则数据。MVP 不接数据库，不接远程配置中心。
- `src/config/`: 加载、校验并转换配置，输出 `TestContext`。
- `src/monitor/`: 采集 Agent-MCP 交互，只输出 `InteractionTrace`。
- `src/risk/`: 风险判定和证据链生成，只输入 `TestContext` 与 `InteractionTrace`。
- `src/report/`: 组装、展示和导出 `RiskReport`，不重新判定风险。
- `src/shared/`: 只放跨模块通用的小工具，禁止承载业务逻辑。

## 6. 执行模式

MVP 采用离线判定:

1. 加载测试配置，生成 `TestContext`
2. 执行一次 Agent-MCP 测试，生成 `InteractionTrace`
3. 测试结束后批量运行风险规则，生成 `RiskReport`
4. 展示层读取 `RiskReport`
5. 需要追溯详情时，根据 `traceId` 读取对应 `InteractionTrace`

MVP 不做实时阻断、不做流式风险判定、不要求数据库事务。

## 7. 输出文件约束

每次测试运行至少生成:

```txt
outputs/traces/{caseId}-{traceId}.json
outputs/reports/{caseId}-{reportId}.json
```

报告展示默认只读取 `outputs/reports/`。当用户查看证据链或 Tool Call Trace 时，再通过 `traceId` 读取对应 trace 文件。

## 8. 架构原则

- 共享对象优先，内部实现其次
- 风险判定只相信 `TestContext`、`InteractionTrace` 和 `riskRules`
- 报告只呈现风险模块产出的结果，不重新解释原始日志
- 所有可追溯结论都必须引用 `eventId`
- 三人协作以契约对齐，不以口头约定对齐
