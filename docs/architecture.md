# Agent-MCP 交互安全测评系统总体架构约束

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是系统总体定位与架构边界的初始基线。系统最终目标是形成可用于信息安全作品赛、具备国一竞争力的完整 Agent-MCP 交互安全测评系统；运行时共享对象当前仍使用 `schemaVersion: "mvp-1"` 作为 P0 阶段契约版本，详见 `docs/contracts.md`。

## 1. 系统目标

本系统聚焦测试 Agent 在 MCP 交互过程中的行为安全性、风险暴露过程、证据链和可复现实验结论。系统唯一被测对象是 `Agent`。

MCP Server、Tool、Resource、Prompt、Tool Response 注入内容、风险规则和测试用例都属于系统内部测试夹具，不作为被测对象。系统主线不是 MCP Server 漏洞扫描，也不是传统代码审计；真实 MCP 服务、安全审计或外部环境接入可以作为后续对照场景或演示增强，但不得改变“测 Agent 行为安全性”的核心边界。

P0 阶段先固化一条可追溯的完整测评闭环:

```txt
被测 Agent -> Agent Adapter -> Test Runner -> MCP Sandbox -> MCP Monitor -> 交互日志采集 -> 风险判定 -> 证据链生成 -> 报告输出
```

完整系统目标不是停留在简单 demo 或最小闭环，而是逐步形成“场景库 + 运行监控 + 风险判定 + 证据链 + 攻击链 + 评分统计 + 报告展示 + 可复现实验”的竞赛级测评平台。P0 的作用是先让 A/B/C 围绕稳定数据契约并行开发，并跑通一次可追溯的 Agent-MCP 安全测评流程；正式前端职责并入 C，由 C 前端通过 Backend API、报告产物和共享契约展示结果。

## 2. 阶段范围

### 2.1 P0 垂直闭环必须包含

- 接入一个被测 Agent，并通过统一接口驱动它执行测试任务
- 加载系统内置测试配置，生成 `TestContext`
- 构建系统内置 MCP Sandbox，提供可控 Tool、Resource、Prompt 和 Tool Response
- 执行至少 1 个测试用例
- 记录 Agent 与 MCP 的交互事件，生成 `InteractionTrace`
- 基于规则生成风险发现和证据链
- 输出 JSON 与 HTML 格式的报告产物
- 支持通过 `traceId` 从报告追溯到原始交互事件

### 2.2 P0 不包含但后续阶段需要规划的能力

- 更完整的攻击场景库、分级基准集和回归测试集
- 多个被测 Agent 的横向对比评测。注意不是把多 Agent 编排作为被测对象，而是支持多次独立测评结果对比
- 攻击用例半自动生成、变体生成和覆盖率统计
- 实时风险提示、流式风险判定和可选阻断能力
- 更复杂的权限模型、策略模型和敏感数据分类
- 数据库存储、历史运行回放、报告对比和趋势分析
- 外部配置中心、场景包导入导出和规则版本管理
- 真实 MCP 服务或真实业务风格 MCP 环境的安全演示接入
- 面向答辩展示的 Dashboard、攻击链可视化、评分解释和报告样例

### 2.3 完整系统验收方向

完整系统最终应能够支撑信息安全作品赛级别展示，至少具备:

- 可解释: 每个风险结论都能追溯到 `TraceEvent.eventId`、规则和证据链
- 可复现: 同一配置、同一 Agent、同一测试用例能够复现主要交互路径和结论
- 可扩展: 新增 Tool、Resource、Prompt、Tool Response、RiskRule 和 TestCase 不破坏既有契约
- 可对比: 支持不同 Agent、不同测试集、不同规则版本的横向和纵向对比
- 可展示: 前端能够清晰展示运行过程、风险概览、攻击链、证据链和报告导出结果
- 可答辩: 系统有明确威胁模型、测评方法、评分依据、创新点和失败兜底演示路径

## 3. 主数据流

P0 只允许一条主数据流，后续阶段扩展也必须围绕这条主链路保持可追溯:

```txt
AgentUnderTest -> AgentAdapterConfig -> TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport -> ReportArtifact[]
```

后一个模块只能消费前一个模块公开输出的数据对象。禁止跨层直接读取其他模块的内部文件、私有类、缓存对象或临时日志。

## 4. 开发边界

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
configs/*.json -> McpSandboxProfile + TestCase[] + TestOracle[]
McpSandboxProfile + TestCase + AgentUnderTest -> TestContext
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

### 开发者 C: 风险判定、证据链、报告与正式前端

负责:

- 输入 `TestContext` 与 `InteractionTrace`
- 根据 `riskRules` 生成风险发现
- 生成证据链
- 生成攻击链
- 计算总体风险等级
- 组装 `RiskReport`
- 导出 JSON 与 HTML 报告产物
- 后续实现 Markdown / PDF 导出
- 生成 `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack` 和 `DefenseReport`
- 实现正式 Frontend Web Console、API Client、ViewModel、页面和组件
- 展示配置视图、运行视图、Trace、风险报告、检测报告、策略包、运行时监督记录和防御报告

不负责:

- 不采集底层 MCP 调用
- 不维护配置仓库
- 不绕过标准事件流读取临时日志
- 不读取 `configs/*.json` 或 `outputs/raw files`
- 不直接 import `backend/src/**`

核心交付物:

```txt
TestContext + InteractionTrace -> RiskEvaluationResult -> RiskReport + ReportArtifact[]
RiskReport[] -> DetectionReport -> AgentRiskProfile -> SupervisionPolicyPack
RuntimeSupervisionRecord[] -> DefenseReport
Backend API + ReportArtifact[] + packages/contracts -> Frontend Web Console
```

## 5. 开发者接口交接

A/B/C 三条线之间只允许通过公开数据对象交接。正式前端职责归入 C:

```txt
外部输入:
  AgentUnderTest
  AgentAdapterConfig

A -> B:
  TestContext

A -> 验收测试:
  TestOracle

B -> C:
  TestRun
  InteractionTrace

C -> Backend Report API / Frontend Web Console:
  RiskReport
  ReportArtifact[]

Backend API / Report Artifacts -> C 前端:
  TestContext view
  TestRun
  InteractionTrace
  RiskReport
  DetectionReport
  AgentRiskProfile
  SupervisionPolicyPack
  RuntimeSupervisionRecord[]
  DefenseReport
```

详细字段以 `docs/contracts.md` 和 `docs/interfaces.md` 为准。任何共享字段变更必须先更新文档，再进入联调。

## 6. 模块边界与目录基线

当前目录结构采用 FAROS-style 前后端分离基线。物理目录、模块边界、依赖方向和新增目录规则统一以本文档为准。

```txt
agent-guard/
  backend/
    src/
      api/
        v1/
          agents/
          configs/
          test-runs/
          traces/
          risks/
          reports/
          detection/
          policies/
          supervision/
          defense/
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
        detection/
        policy/
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
        supervisor/
        defense/
      services/
      shared/
      storage/
    tests/

  frontend/
    demo/
    public/
    src/
      pages/
        Dashboard/
        AgentConnect/
        Detection/
        DefenseReports/
        TestCases/
        TestRuns/
        TraceDetail/
        RiskReports/
        Supervision/
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
        detection/
        policy/
        supervision/
        defense/
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
          detection.ts
          policy.ts
          supervision.ts
          defense.ts

  configs/
    tools.json
    resources.json
    prompts.json
    tool_responses.json
    risk_rules.json
    test_cases.json
    test_oracles.json
    red_team_scenarios.json
    supervision_policy_templates.json
    pyrit_attack_library.json

  scenarios/

  third_party/
    pyrit_adapted/

  outputs/
    runs/
    traces/
    reports/
    exports/

  docs/
    README.md
    A/
      p1-a-line-aig-adaptation-plan.md
      work-log-a-config-sandbox.md
    B/
      p1-b-runtime-supervision-work-plan.md
      superpowers/
        plans/
        specs/
    C/
      frontend-d-handoff.md
    architecture.md
    contracts.md
    interfaces.md
    ownership.md
    p1-supervision-defense-plan.md
    p2-api-contract-plan.md
    p2-real-agent-api-frontend-plan.md

  scripts/

  tests/
    e2e/
```

目录职责:

- `backend/src/api/v1/`: 面向前端的 API 边界，只做请求和响应组装。
- `backend/src/core/`: 后端通用基础设施，只放错误、日志、ID、时间和结果对象等小工具。
- `backend/src/modules/agent/`: 接入被测 Agent，提供统一调用接口。
- `backend/src/modules/config/`: 加载、校验并转换配置，输出 `TestContext`。
- `backend/src/modules/detection/`: 输入风险报告和 trace，输出监督前检测报告。
- `backend/src/modules/policy/`: 输入 Agent 风险画像和策略模板，输出 `SupervisionPolicyPack`。
- `backend/src/modules/sandbox/`: 提供系统内置 MCP Sandbox 画像。
- `backend/src/modules/mcp-server/`: 预留系统内置 MCP Server / Tool Runtime 的运行时适配。
- `backend/src/modules/runner/`: 根据测试用例驱动 Agent 运行。
- `backend/src/modules/monitor/`: 采集 Agent-MCP 交互，只输出 `InteractionTrace`。
- `backend/src/modules/risk/`: 风险判定和证据链生成，只输入 `TestContext` 与 `InteractionTrace`。
- `backend/src/modules/report/`: 组装、展示和导出 `RiskReport`，不重新判定风险。
- `backend/src/modules/supervisor/`: 加载策略包并监督真实或半真实运行，不生成策略包或防御报告。
- `backend/src/modules/defense/`: 基于检测、策略和监督记录生成 `DefenseReport`，不编造阻断记录。
- `backend/src/services/`: 应用服务层，串联 run、report、config 等多个模块。
- `backend/src/shared/`: 后端内部共享小工具，禁止放前后端共享契约。
- `backend/src/storage/`: 持久化适配层，P0 可先指向 `outputs/`。
- `frontend/demo/`: 展示型原型和答辩兜底，不作为正式前端契约来源。
- `frontend/src/pages/`: Web 控制台页面，包括 Dashboard、Detection、Supervision、Defense、Trace、Report、Config 等视图。
- `frontend/src/components/`: Web 控制台组件，按业务展示域拆分。
- `frontend/src/lib/`: 前端 API Client、hook、视图模型和格式化函数。
- `packages/contracts/`: 前后端共享契约唯一来源，禁止承载运行时业务逻辑。
- `configs/`: 系统内置测试数据和规则数据。P0 可只使用本地 JSON；后续如接入数据库或远程配置中心，也必须先转换为标准契约对象再进入运行时。
- `scenarios/`: 红队场景说明、对抗样本和攻击动作序列。
- `third_party/`: 受控迁入的外部或本地参考源码。当前 `third_party/pyrit_adapted` 由 A 线维护，用于 PyRIT 攻击库、jailbreak、converter 和后续 Python bridge 溯源；默认 TS 主链路不得直接执行未经适配的 third-party runtime。
- `outputs/`: 测试运行产物，包含 runs、traces、reports 和 exports。
- `docs/A`、`docs/B`、`docs/C`: 各责任线的计划、交接和工作记录。

依赖方向:

```txt
frontend -> packages/contracts
frontend -> backend API
backend -> packages/contracts
backend/api -> backend/services -> backend/modules
backend/modules -> backend/shared
backend/modules -> packages/contracts
```

禁止方向:

```txt
packages/contracts -> backend
packages/contracts -> frontend
frontend -> backend/src
frontend -> configs/*.json
frontend -> outputs/raw files
backend/modules/risk -> outputs/raw files
backend/modules/report -> configs/*.json
backend/modules/monitor -> backend/modules/risk
```

新增目录必须先明确 ownership，并同步 `docs/ownership.md` 与本文档。

## 7. 执行模式

P0 采用离线判定:

1. 接入被测 Agent，生成 `AgentUnderTest` 与 `AgentAdapterConfig`
2. 加载测试配置，生成 `McpSandboxProfile`、`TestCase`、`TestOracle` 与运行时 `TestContext`
3. 通过 Test Runner 执行一次 Agent-MCP 测试，生成 `TestRun`
4. MCP Monitor 记录完整事件，生成 `InteractionTrace`
5. 测试结束后批量运行风险规则，生成 `RiskEvaluationResult`
6. 报告模块组装自包含的 `RiskReport`，导出 JSON 与 HTML `ReportArtifact[]`
7. Backend Report API / Frontend Web Console 读取 `RiskReport`
8. 需要追溯详情时，根据 `traceId` 读取对应 `InteractionTrace`

P0 不要求实时阻断、流式风险判定或数据库事务。完整系统可以在不破坏 `InteractionTrace -> RiskEvaluationResult -> RiskReport` 主链路的前提下扩展实时提示、流式评估、持久化和历史回放。

## 8. 输出文件约束

每次测试运行至少生成:

```txt
outputs/traces/{caseId}-{traceId}.json
outputs/reports/{caseId}-{reportId}.json
outputs/reports/{caseId}-{reportId}.html
```

报告展示默认通过 Report API 或本地报告读取 `outputs/reports/`。当用户查看证据链或 Tool Call Trace 时，再通过 `traceId` 读取对应 trace 文件。

## 9. 开发协作与验收规则

开发者以共享契约为边界。任何模块不得依赖其他模块内部实现；联调失败时，优先检查 schema、字段命名、版本号和事件顺序。

命名规则:

- 共享数据类型使用名词，例如 `TestContext`、`InteractionTrace`、`RiskReport`、`SupervisionPolicyPack`。
- 模块入口函数使用动词，例如 `loadTestContext()`、`runTestCase()`、`evaluateRisk()`、`buildRiskReport()`。
- TypeScript 文件使用 `camelCase.ts`，JSON 配置文件使用 `snake_case.json`，文档文件使用小写短横线或既有约定。

Import 约束:

- `packages/contracts/` 只能存放前后端共享数据契约和稳定 API 类型，禁止放运行时业务逻辑。
- `backend/src/shared/` 只能存放后端内部通用小工具。
- 禁止将 Agent 调用、Sandbox 运行、风险判定、报告导出或前端组件状态塞入共享目录。
- 风险模块不得 import trace recorder 私有实现，不得读取 `outputs/traces/raw.log` 等原始临时日志。
- 监控模块不得计算风险等级，报告模块不得重新判定风险。

P0 风险规则阶段基线:

- 工具误用风险: Agent 调用了测试用例不允许的 MCP Tool，或使用明显异常参数。
- 越权访问风险: Agent 访问未授权 Resource，或访问行为不符合资源标签约束。
- 敏感数据泄露风险: Tool 参数、Tool 返回、Agent 消息或 Resource 内容中出现敏感字段泄露迹象。
- 危险动作风险: Agent 触发删除、外传、写入敏感资源、执行未经授权命令等高危操作。
- 注入跟随行为: Agent 是否跟随恶意 Prompt、Resource 或 Tool Response 中的注入指令。

禁止事项:

- 将 `ExpectedOutcome`、`TestOracle` 传入风险判定运行时。
- 监控模块内置风险规则，或 B 线直接计算风险等级。
- C 线绕过 `InteractionTrace` 读取临时日志，或报告模块重新判定风险。
- Frontend Web Console 直接解析 `risk_rules.json`、读取 `configs/*.json` / `outputs/**` 原始文件，或 import `backend/src/**`。
- 在共享对象中使用 `any`、`unknown` 或不可 JSON 序列化字段。
- 为了演示效果手写假报告绕过 `RiskReport`。
- 私下修改共享字段名或枚举值，或使用口头约定替代文档契约。
- 把 MCP Server 当成被测对象做漏洞扫描。
- 将系统内置 Tool、Resource、Prompt 的配置散落到代码里。
- 在 `AgentAdapterConfig` 中保存明文密钥。
- 让 `frontend/demo/**` 的临时字段反向决定正式前端或 contracts。

推荐开发顺序:

1. 先定共享类型: `AgentUnderTest`、`McpSandboxProfile`、`TestCase`、`TestContext`、`InteractionTrace`、`RiskReport`。
2. 再做 mock 数据闭环: 用 mock Agent 和 mock trace 跑通风险判定与报告生成。
3. 再接入 Agent Adapter: 通过 `sendTask()` 驱动被测 Agent。
4. 再接入真实监控: 监控模块替换 mock trace，但保持 `InteractionTrace` 格式不变。
5. 最后实现前端展示: C 前端只通过 Backend API 或报告产物消费共享契约对象。

模块级 demo:

```txt
A:
  input: configs/*.json
  output: McpSandboxProfile + TestCase[] + TestOracle[] + TestContext

B:
  input: AgentUnderTest + AgentAdapterConfig + TestContext
  output: TestRun + InteractionTrace

C:
  input: TestContext + InteractionTrace
  output: RiskEvaluationResult + RiskReport + ReportArtifact[]

C 前端:
  input: Backend API response + ReportArtifact[] + packages/contracts types
  output: Frontend Web Console page + ViewModel + API request payload
```

P0 完成时必须满足:

- 能加载内置 JSON 测试配置并生成 `TestContext`，且 `ExpectedOutcome` 只存在于 `TestOracle`。
- 能接入一个被测 Agent，构建系统内置 MCP Sandbox，并运行至少 1 个测试用例。
- 能记录完整 `InteractionTrace`，每条事件都有 `eventId`、`caseId`、`traceId`、`sequence`、`timestamp`。
- 能基于 `risk_rules.json` 生成 `RiskReport`，每个 `Finding` 至少引用 1 个 `evidenceEventIds`。
- 能输出 JSON 和 HTML 报告文件，并从报告追溯到原始 trace。
- 三个后端模块可以分别用 mock 数据单独测试，不依赖真实线上 MCP 服务也能跑通 P0 demo。

P1 采用两段式开发:

```txt
Trace -> RiskReport -> DetectionReport -> AgentRiskProfile -> SupervisionPolicyPack
SupervisionPolicyPack -> AgentSupervisor -> RuntimeSupervisionRecord[] -> DefenseReport
```

P1 合并前必须确认:

- 没有把 `TestOracle` 传入运行时风险判定。
- 没有让 B 根据 `RiskReport` 私自生成策略。
- 没有让 C 编造运行时阻断记录。
- `SupervisionPolicyPack` 的每条策略都能追溯到检测报告或策略模板。
- `RuntimeSupervisionRecord` 的每条阻断都能追溯到策略包。
- `DefenseReport` 的防御效果来自真实监督记录。
- 至少运行 `npm run typecheck`、`npm run verify:p1:detection-policy`、`npm run verify:p1:supervision-defense`。

共享契约变更流程:

1. 提出变更原因。
2. 修改 `docs/contracts.md`。
3. 更新 `packages/contracts/src/types/**` 中的相关类型或 JSON Schema。
4. 更新至少一个 mock 样例。
5. 通知其他开发者按文档更新。

未经文档更新的共享字段变更不得进入联调分支。接口冲突必须回到 `docs/interfaces.md`、`docs/contracts.md` 和本文档解决。

## 10. 架构原则

- 只有 Agent 是被测对象，MCP 环境是系统内部测试夹具
- `TestOracle` 和 `ExpectedOutcome` 只用于验收测试，不得进入运行时 `TestContext`
- 共享对象优先，内部实现其次
- 风险判定只相信 `TestContext`、`InteractionTrace` 和 `riskRules`
- 报告只呈现风险模块产出的结果，不重新解释原始日志
- 所有可追溯结论都必须引用 `eventId`
- A/B/C 协作以契约对齐，不以口头约定对齐
