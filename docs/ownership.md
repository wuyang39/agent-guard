# Agent Guard 开发工作区 Ownership

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是三人工作区 ownership 的初始基线。目录结构以 `docs/directory-structure.md` 为准。

## 1. 总则

三名开发者按模块边界并行开发，默认只修改自己的主责目录。跨工作区修改必须先同步接口影响，并在提交前完成验证。

核心交接链路:

```txt
A: TestContext
B: TestRun + InteractionTrace
C: RiskEvaluationResult + RiskReport + ReportArtifact[]
```

运行时禁止把 `TestOracle` 或 `ExpectedOutcome` 传给风险判定模块。

前端、后端和共享契约的依赖方向必须保持:

```txt
frontend -> packages/contracts
backend -> packages/contracts
backend/api -> backend/services -> backend/modules
backend/modules -> backend/shared
```

禁止:

```txt
frontend -> backend/src
packages/contracts -> backend
packages/contracts -> frontend
backend/modules/monitor -> backend/modules/risk
backend/modules/report -> configs/*.json
```

## 2. 开发者 A: 测试数据仓库与 MCP Sandbox 建模

主责目录与文件:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/tool_responses.json
configs/test_cases.json
configs/test_oracles.json
backend/src/modules/config/**
backend/src/modules/sandbox/**
backend/src/modules/mcp-server/tools/**
backend/src/modules/mcp-server/resources/**
backend/src/modules/mcp-server/prompts/**
backend/src/modules/mcp-server/tool-responses/**
packages/contracts/src/types/sandbox.ts
packages/contracts/src/types/test.ts
frontend/src/pages/Configs/**
frontend/src/components/config/**
```

主要交付物:

```txt
McpSandboxProfile
TestCase[]
TestOracle[]
TestContext
```

可协作区域:

```txt
configs/risk_rules.json                    与 C 协作，C 对规则语义负责
backend/src/modules/mcp-server/**          与 B 协作，B 对运行时调用链负责
backend/src/modules/sandbox/**             与 B 协作，保持 Sandbox 运行画像一致
packages/contracts/src/types/common.ts     涉及通用枚举时协作修改
docs/contracts.md                          涉及共享字段时协作修改
docs/interfaces.md                         涉及交接对象时协作修改
docs/directory-structure.md                涉及目录归属时协作修改
```

禁止直接修改:

```txt
backend/src/modules/agent/**
backend/src/modules/runner/**
backend/src/modules/monitor/**
backend/src/modules/risk/**
backend/src/modules/report/**
packages/contracts/src/types/agent.ts
packages/contracts/src/types/trace.ts
packages/contracts/src/types/risk.ts
packages/contracts/src/types/report.ts
frontend/src/pages/AgentConnect/**
frontend/src/pages/TestRuns/**
frontend/src/pages/TraceDetail/**
frontend/src/pages/RiskReports/**
frontend/src/pages/Dashboard/**
```

## 3. 开发者 B: Agent 接入、测试执行与交互监控

主责目录与文件:

```txt
backend/src/modules/agent/**
backend/src/modules/runner/**
backend/src/modules/monitor/**
backend/src/api/v1/agents/**
backend/src/api/v1/test-runs/**
backend/src/api/v1/traces/**
packages/contracts/src/types/agent.ts
packages/contracts/src/types/trace.ts
frontend/src/pages/AgentConnect/**
frontend/src/pages/TestRuns/**
frontend/src/pages/TraceDetail/**
frontend/src/components/agent/**
frontend/src/components/trace/**
```

主要交付物:

```txt
AgentAdapter
AgentSession
AgentToolBridge
TestRun
InteractionTrace
```

可协作区域:

```txt
backend/src/modules/sandbox/**             与 A 协作，保持 Sandbox 画像一致
backend/src/modules/mcp-server/**          与 A 协作，确认 Tool Runtime 暴露方式
configs/test_cases.json                    与 A 协作，确认测试执行所需字段
configs/tool_responses.json                与 A 协作，确认 Tool Response 注入计划
backend/src/services/**                    与 C 协作，串联 run 与 report 工作流
docs/interfaces.md                         涉及 B -> C 输出时协作修改
```

禁止直接修改:

```txt
configs/risk_rules.json
configs/test_oracles.json
backend/src/modules/risk/**
backend/src/modules/report/**
packages/contracts/src/types/risk.ts
packages/contracts/src/types/report.ts
frontend/src/pages/RiskReports/**
frontend/src/pages/Dashboard/**
frontend/src/components/risk/**
frontend/src/components/report/**
frontend/src/components/attack-chain/**
```

B 不得计算风险等级，不得生成 `Finding`，不得读取 `TestOracle` 参与运行时逻辑。

## 4. 开发者 C: 风险判定、证据链、攻击链与报告

主责目录与文件:

```txt
configs/risk_rules.json
backend/src/modules/risk/**
backend/src/modules/report/**
backend/src/api/v1/risks/**
backend/src/api/v1/reports/**
packages/contracts/src/types/risk.ts
packages/contracts/src/types/report.ts
frontend/src/pages/Dashboard/**
frontend/src/pages/RiskReports/**
frontend/src/components/risk/**
frontend/src/components/attack-chain/**
frontend/src/components/report/**
```

主要交付物:

```txt
RiskEvaluationResult
Finding
EvidenceChain
AttackChain
RiskReport
ReportArtifact[]
```

可协作区域:

```txt
configs/test_oracles.json                  与 A 协作，仅用于验收和回归测试
backend/src/services/**                    与 B 协作，串联 run 与 report 工作流
frontend/src/components/trace/**           与 B 协作，报告中复用 Trace 展示组件
packages/contracts/src/types/common.ts     涉及风险等级或报告格式枚举时协作修改
docs/contracts.md                          涉及风险或报告字段时协作修改
docs/interfaces.md                         涉及 C 输出对象时协作修改
```

禁止直接修改:

```txt
backend/src/modules/agent/**
backend/src/modules/runner/**
backend/src/modules/monitor/**
packages/contracts/src/types/agent.ts
packages/contracts/src/types/trace.ts
frontend/src/pages/AgentConnect/**
frontend/src/pages/TestRuns/**
frontend/src/pages/TraceDetail/**
```

C 不得直接读取 `configs/*.json` 参与运行时判定，不得绕过 `InteractionTrace` 读取临时日志。

## 5. 共享受控区域

以下文件属于共享受控区域，任何人修改前都必须说明影响范围:

```txt
packages/contracts/src/index.ts
packages/contracts/src/types/common.ts
backend/src/index.ts
backend/src/api/v1/system/**
backend/src/core/**
backend/src/services/**
backend/src/shared/**
frontend/demo/**
docs/architecture.md
docs/contracts.md
docs/development-rules.md
docs/directory-structure.md
docs/framework-risk-audit.md
docs/interfaces.md
docs/ownership.md
package.json
package-lock.json
tsconfig.json
README.md
```

`frontend/demo/**` 是展示型原型目录，不归 A/B/C 任一正式模块单独所有。修改它只影响演示体验，不得反向改变正式接口契约。

修改共享受控区域时必须同时检查:

```txt
npm run typecheck
configs/*.json 能被解析
docs/contracts.md 与 packages/contracts/src/types/** 是否一致
docs/interfaces.md 与 docs/ownership.md 是否一致
docs/directory-structure.md 与实际目录是否一致
```

## 6. 跨工作区修改规则

允许跨工作区修改的情况:

- 修复编译错误
- 更新共享接口字段
- 修改联调断裂的 ID 引用
- 小范围调整类型导出路径
- 因目录迁移同步 ownership 和 README

跨工作区修改必须满足:

- 只改必要文件
- 在提交信息中说明影响模块
- 如果改变共享对象字段，必须同步 `docs/contracts.md`
- 如果改变 A/B/C 交接对象，必须同步 `docs/interfaces.md`
- 如果改变目录归属，必须同步 `docs/ownership.md` 和 `docs/directory-structure.md`

## 7. 联调交付物

A 交给 B 和 C:

```txt
TestContext
```

B 交给 C:

```txt
TestRun
InteractionTrace
```

C 交给 Backend Report API / Frontend Web Console:

```txt
RiskReport
ReportArtifact[]
```

验收测试额外读取:

```txt
TestOracle[]
```

`TestOracle[]` 只能由验收测试读取，不属于运行时主链路。
