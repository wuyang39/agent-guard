# Agent Guard 完整文件目录规范

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是完整文件目录的初始基线。具体开发者 ownership 以 `docs/ownership.md` 为准。

## 1. 目录设计目标

本目录规范参考 `E:\FAROS` 的工程组织方式，将 Agent Guard 从单层 `src/` 框架升级为完整系统目录。目录设计面向竞赛级完整系统，P0 阶段可以只实现其中的垂直闭环子集。

目标:

- 为前端控制台预留独立工作区
- 为后端测评运行时预留清晰模块边界
- 为前后端共享接口预留稳定契约包
- 为三名开发者保留严格工作区
- 为 API、存储、测试、报告导出、历史回放、评分统计和可视化迭代预留位置

本次目录设计不改变系统定位: 唯一被测对象仍然是 `Agent`。MCP Server、Tool、Resource、Prompt、Tool Response、风险规则和测试用例仍然全部由系统内部提供。后续接入真实 MCP 风格环境或数据库时，也必须先进入标准模块边界和共享契约。

## 2. 顶层目录

```txt
agent-guard/
  backend/
  frontend/
  packages/
  configs/
  outputs/
  docs/
  scripts/
  tests/
  package.json
  tsconfig.json
  README.md
```

顶层职责:

- `backend/`: 后端服务、Agent 接入、MCP Sandbox、动态监控、风险判定、报告生成
- `frontend/`: Web 控制台、风险总览、Trace 查看、攻击链视图、报告展示
- `packages/`: 前后端共享接口契约，禁止放运行时业务逻辑
- `configs/`: 系统内置测试数据仓库
- `outputs/`: 测试运行产物，包括 run、trace、report 和导出文件
- `docs/`: 架构、接口、目录、开发规则和 ownership 文档
- `scripts/`: 工程脚本，包含配置校验、构建和本地启动脚本
- `tests/`: 跨前后端端到端测试

## 3. 完整目录基线

```txt
agent-guard/
  backend/
    src/
      index.ts

      api/
        v1/
          agents/
          configs/
          test-runs/
          traces/
          risks/
          reports/
          system/

      core/
        errors/
        logger/
        result/
        ids/
        time/

      modules/
        agent/
        config/
        sandbox/
        mcp-server/
          tools/
          resources/
          prompts/
          tool-responses/
        runner/
        monitor/
        risk/
        report/

      services/
      shared/
      storage/

    tests/
      unit/
      integration/

  frontend/
    demo/
    public/
    src/
      pages/
        Dashboard/
        AgentConnect/
        TestCases/
        TestRuns/
        TraceDetail/
        RiskReports/
        Configs/
        System/
      components/
        layout/
        ui/
        agent/
        config/
        trace/
        risk/
        attack-chain/
        report/
      lib/
        api/
        hooks/
        models/
        types/
        formatters/
      styles/
    tests/

  packages/
    contracts/
      src/
        index.ts
        types/
          agent.ts
          common.ts
          report.ts
          risk.ts
          sandbox.ts
          test.ts
          trace.ts

  configs/
    tools.json
    resources.json
    prompts.json
    tool_responses.json
    risk_rules.json
    test_cases.json
    test_oracles.json

  outputs/
    runs/
    traces/
    reports/
    exports/

  docs/
    README.md
    architecture.md
    contracts.md
    development-rules.md
    directory-structure.md
    framework-risk-audit.md
    interfaces.md
    ownership.md

  scripts/

  tests/
    e2e/
```

## 4. 后端目录职责

`backend/src/api/v1/`:

- 对前端暴露 HTTP API 边界
- 只做请求解析、响应组装和服务调用
- 不直接读取 `configs/` 或 `outputs/`

`backend/src/core/`:

- 放后端通用基础设施
- 仅包含错误、日志、ID、时间、结果对象等无业务状态的小工具

`backend/src/modules/agent/`:

- 被测 Agent 接入边界
- 提供统一调用接口和 Agent Adapter 类型
- 不读取风险规则，不生成风险结论

`backend/src/modules/config/`:

- 读取和校验 `configs/*.json`
- 构造 `TestContext`
- 管理测试数据仓库到运行时上下文的转换

`backend/src/modules/sandbox/`:

- 定义系统内置 MCP Sandbox 画像
- 管理 Tool、Resource、Prompt、Tool Response 的运行时可见性
- 不把 MCP Server 当成被测对象

`backend/src/modules/mcp-server/`:

- 预留真实 MCP Server / Tool Runtime 实现位置
- `tools/`、`resources/`、`prompts/`、`tool-responses/` 分别承载系统内部测试夹具的运行时适配
- P0 可以先为空目录或薄适配层，后续完整系统在这里扩展真实运行时、场景包适配和演示环境接入

`backend/src/modules/runner/`:

- 根据 `TestContext` 驱动测试用例执行
- 调用 Agent Adapter 和 MCP Sandbox
- 输出 `TestRun`

`backend/src/modules/monitor/`:

- 采集 Agent-MCP 交互事件
- 输出 `InteractionTrace`
- 不做风险等级判断

`backend/src/modules/risk/`:

- 输入 `TestContext`、`TestRun`、`InteractionTrace`
- 输出 `RiskEvaluationResult`
- 生成 Finding、EvidenceChain、AttackChain

`backend/src/modules/report/`:

- 输入风险判定结果
- 输出 `RiskReport` 和 `ReportArtifact[]`
- 不重新解释原始日志，不重新计算风险等级

`backend/src/services/`:

- 预留后端应用服务层
- 负责串联多个模块，例如 run service、report service、config service

`backend/src/shared/`:

- 仅放后端内部共享小工具
- 不再放前后端共享契约类型

`backend/src/storage/`:

- 预留持久化适配层
- P0 可先指向 `outputs/`，后续完整系统在这里扩展数据库、历史运行回放、报告对比和数据迁移

## 5. 前端目录职责

`frontend/demo/`:

- 展示型 Demo / 原型页面
- 只用于演示理想工作流和答辩展示
- 不作为正式前端架构基线
- 其中的接口字段和页面结构不作为最终实现契约

`frontend/src/pages/`:

- `Dashboard/`: 总体风险概览
- `AgentConnect/`: 被测 Agent 接入配置页
- `TestCases/`: 测试用例与测试数据查看页
- `TestRuns/`: 测试运行列表和运行状态页
- `TraceDetail/`: Tool Call Trace 与原始事件详情页
- `RiskReports/`: 风险报告列表与详情页
- `Configs/`: 内置 Tool、Resource、Prompt、Rule 查看页
- `System/`: 系统状态、版本和诊断页

`frontend/src/components/`:

- `layout/`: 页面布局、导航、顶栏和侧栏
- `ui/`: 通用 UI 组件
- `agent/`: Agent 接入相关组件
- `config/`: 配置和测试数据展示组件
- `trace/`: Trace 时间线、事件详情、Tool Call 展示组件
- `risk/`: 风险等级、Finding、高危问题列表组件
- `attack-chain/`: 攻击链视图组件
- `report/`: 报告详情、导出入口、证据链展示组件

`frontend/src/lib/`:

- `api/`: 前端 API Client
- `hooks/`: 前端状态和数据请求 hook
- `models/`: 前端视图模型
- `types/`: 前端私有类型
- `formatters/`: 风险等级、时间、Trace、报告字段格式化函数

前端只能依赖 `packages/contracts` 中的共享契约，不允许直接引用 `backend/src/**`。

`frontend/demo/` 是例外的展示原型目录。它可以使用独立 demo API，但不得被正式前端代码引用，也不得作为 `packages/contracts` 的替代来源。

## 6. 共享契约目录职责

`packages/contracts/` 是前后端共享接口的唯一来源。

允许放入:

- `AgentUnderTest`
- `AgentAdapterConfig`
- `McpSandboxProfile`
- `TestCase`
- `TestContext`
- `TestRun`
- `InteractionTrace`
- `RiskEvaluationResult`
- `RiskReport`
- `ReportArtifact`
- API request / response 的稳定类型

禁止放入:

- 文件系统读取逻辑
- MCP Server 运行逻辑
- Agent 调用逻辑
- 风险规则执行逻辑
- 报告导出逻辑
- 前端组件状态逻辑

## 7. 三人工作区摘要

详细目录 ownership 只在 `docs/ownership.md` 中维护，避免同一份工作区清单在多个文档中重复漂移。

职责摘要:

- 开发者 A: 测试数据仓库、配置加载、MCP Sandbox 建模、系统内置 Tool / Resource / Prompt / Tool Response 运行时适配。
- 开发者 B: Agent 接入、测试执行、动态监控、Trace API 与运行详情前端区域。
- 开发者 C: 风险判定、证据链、攻击链、报告生成、风险报告 API 与报告展示前端区域。

共享受控区、可协作区和禁止修改区以 `docs/ownership.md` 为准。

## 8. 依赖方向

允许的依赖方向:

```txt
frontend -> packages/contracts
backend -> packages/contracts
backend/api -> backend/services -> backend/modules
backend/modules -> backend/shared
backend/modules -> packages/contracts
```

禁止的依赖方向:

```txt
packages/contracts -> backend
packages/contracts -> frontend
frontend -> backend/src
backend/modules/risk -> outputs/raw files
backend/modules/report -> configs/*.json
backend/modules/monitor -> backend/modules/risk
```

## 9. 阶段扩展预留

P0 只要求跑通主数据流。完整系统后续可以自然扩展:

- 增加数据库、历史回放或报告对比时，放入 `backend/src/storage/`
- 增加 HTTP API 时，放入 `backend/src/api/v1/`
- 增加可视化页面时，放入 `frontend/src/pages/` 和 `frontend/src/components/`
- 增加前后端共享 API 类型时，放入 `packages/contracts/src/`
- 增加端到端测试时，放入 `tests/e2e/`
- 增加运行脚本时，放入 `scripts/`
- 增加场景库、规则集或演示数据时，优先放入 `configs/`，并通过配置加载模块转换为标准契约对象

任何新增目录必须先明确 ownership，并同步 `docs/ownership.md`。
