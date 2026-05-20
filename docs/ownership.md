# Agent Guard 开发工作区 Ownership

版本: mvp-1
日期: 2026-05-20
状态: 三人并行开发基线

## 1. 总则

三名开发者按模块边界并行开发，默认只修改自己的主责目录。跨工作区修改必须先同步接口影响，并在提交前完成验证。

核心交接链路:

```txt
A: TestContext
B: TestRun + InteractionTrace
C: RiskEvaluationResult + RiskReport + ReportArtifact[]
```

运行时禁止把 `TestOracle` 或 `ExpectedOutcome` 传给风险判定模块。

## 2. 开发者 A: 测试数据仓库与 MCP Sandbox 建模

主责目录与文件:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/tool_responses.json
configs/test_cases.json
configs/test_oracles.json
src/config/**
src/sandbox/sandboxTypes.ts
src/shared/types/sandbox.ts
src/shared/types/test.ts
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
configs/risk_rules.json        与 C 协作，C 对规则语义负责
src/sandbox/mcpSandbox.ts      与 B 协作，B 对运行时行为负责
docs/contracts.md              涉及共享字段时协作修改
docs/interfaces.md             涉及交接对象时协作修改
```

禁止直接修改:

```txt
src/agent/**
src/runner/**
src/monitor/**
src/risk/**
src/report/**
src/shared/types/agent.ts
src/shared/types/trace.ts
src/shared/types/risk.ts
src/shared/types/report.ts
```

## 3. 开发者 B: Agent 接入、测试执行与交互监控

主责目录与文件:

```txt
src/agent/**
src/runner/**
src/monitor/**
src/sandbox/mcpSandbox.ts
src/shared/types/agent.ts
src/shared/types/trace.ts
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
src/sandbox/sandboxTypes.ts    与 A 协作，保持 Sandbox 画像一致
configs/test_cases.json        与 A 协作，确认测试执行所需字段
configs/tool_responses.json    与 A 协作，确认 Tool Response 注入计划
docs/interfaces.md             涉及 B -> C 输出时协作修改
```

禁止直接修改:

```txt
configs/risk_rules.json
configs/test_oracles.json
src/risk/**
src/report/**
src/shared/types/risk.ts
src/shared/types/report.ts
```

B 不得计算风险等级，不得生成 `Finding`，不得读取 `TestOracle` 参与运行时逻辑。

## 4. 开发者 C: 风险判定、证据链、攻击链与报告

主责目录与文件:

```txt
configs/risk_rules.json
src/risk/**
src/report/**
src/shared/types/risk.ts
src/shared/types/report.ts
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
configs/test_oracles.json      与 A 协作，仅用于验收和回归测试
docs/contracts.md              涉及风险或报告字段时协作修改
docs/interfaces.md             涉及 C 输出对象时协作修改
```

禁止直接修改:

```txt
src/agent/**
src/runner/**
src/monitor/**
src/sandbox/mcpSandbox.ts
src/shared/types/agent.ts
src/shared/types/trace.ts
```

C 不得直接读取 `configs/*.json` 参与运行时判定，不得绕过 `InteractionTrace` 读取临时日志。

## 5. 共享受控区域

以下文件属于共享受控区域，任何人修改前都必须说明影响范围:

```txt
src/shared/contracts.ts
src/shared/types/common.ts
docs/architecture.md
docs/contracts.md
docs/interfaces.md
docs/ownership.md
package.json
package-lock.json
tsconfig.json
README.md
```

修改共享受控区域时必须同时检查:

```txt
npm run typecheck
configs/*.json 能被解析
docs/contracts.md 与 src/shared/types/** 是否一致
docs/interfaces.md 与 docs/ownership.md 是否一致
```

## 6. 跨工作区修改规则

允许跨工作区修改的情况:

- 修复编译错误
- 更新共享接口字段
- 修改联调断裂的 ID 引用
- 小范围调整类型导出路径

跨工作区修改必须满足:

- 只改必要文件
- 在提交信息中说明影响模块
- 如果改变共享对象字段，必须同步 `docs/contracts.md`
- 如果改变 A/B/C 交接对象，必须同步 `docs/interfaces.md`
- 如果改变目录归属，必须同步本文档

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

C 交给展示层:

```txt
RiskReport
ReportArtifact[]
```

验收测试额外读取:

```txt
TestOracle[]
```

`TestOracle[]` 只能由验收测试读取，不属于运行时主链路。
