# Agent Guard 开发工作区 Ownership

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是工作区 ownership 的初始基线。当前 ownership 优先保障 P0 垂直闭环与 P1 检测画像驱动监督的并行开发，后续竞赛级完整系统扩展目录时也必须先明确归属。目录结构以 `docs/architecture.md` 为准。

## 1. 总则

开发者按模块边界并行开发，默认只修改自己的主责目录。跨工作区修改必须先同步接口影响，并在提交前完成验证。

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
frontend -> backend API
backend -> packages/contracts
backend/api -> backend/services -> backend/modules
backend/modules -> backend/shared
```

禁止:

```txt
frontend -> backend/src
frontend -> configs/*.json
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
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
configs/pyrit_attack_library.json
backend/src/modules/config/**
backend/src/modules/sandbox/**
backend/src/modules/mcp-server/tools/**
backend/src/modules/mcp-server/resources/**
backend/src/modules/mcp-server/prompts/**
backend/src/modules/mcp-server/tool-responses/**
packages/contracts/src/types/sandbox.ts
packages/contracts/src/types/test.ts
packages/contracts/src/types/scenario.ts
packages/contracts/src/types/attackLibrary.ts
docs/A/**
third_party/pyrit_adapted/**
```

主要交付物:

```txt
McpSandboxProfile
TestCase[]
TestOracle[]
TestContext
RedTeamScenarioSet
PolicyTemplate[]
PyritAttackLibrary
```

可协作区域:

```txt
configs/risk_rules.json                    与 C 协作，C 对规则语义负责
backend/src/modules/mcp-server/**          与 B 协作，B 对运行时调用链负责
backend/src/modules/sandbox/**             与 B 协作，保持 Sandbox 运行画像一致
packages/contracts/src/types/common.ts     涉及通用枚举时协作修改
docs/contracts.md                          涉及共享字段时协作修改
docs/interfaces.md                         涉及交接对象时协作修改
docs/architecture.md                       涉及目录归属时协作修改
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
frontend/src/**
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
docs/B/**
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
frontend/src/**
```

B 不得计算风险等级，不得生成 `Finding`，不得读取 `TestOracle` 参与运行时逻辑。

## 4. 开发者 C: 风险判定、证据链、攻击链、报告与正式前端

主责目录与文件:

```txt
configs/risk_rules.json
backend/src/modules/risk/**
backend/src/modules/report/**
backend/src/modules/detection/**
backend/src/modules/policy/**
backend/src/modules/defense/**
backend/src/api/v1/risks/**
backend/src/api/v1/reports/**
backend/src/api/v1/detection/**
backend/src/api/v1/policies/**
backend/src/api/v1/defense/**
frontend/src/**
frontend/public/**
frontend/tests/**
packages/contracts/src/types/risk.ts
packages/contracts/src/types/report.ts
packages/contracts/src/types/detection.ts
packages/contracts/src/types/policy.ts
packages/contracts/src/types/defense.ts
docs/C/**
```

主要交付物:

```txt
RiskEvaluationResult
Finding
EvidenceChain
AttackChain
RiskReport
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
DefenseReport
ReportArtifact[]
Frontend Web Console
API Client
ViewModel
```

可协作区域:

```txt
configs/test_oracles.json                  与 A 协作，仅用于验收和回归测试
backend/src/services/**                    与 B 协作，串联 run 与 report 工作流
backend/src/api/v1/**                      与 A/B 协作，确认 API response shape
packages/contracts/src/types/common.ts     涉及风险等级或报告格式枚举时协作修改
docs/contracts.md                          涉及风险或报告字段时协作修改
docs/interfaces.md                         涉及 C 输出对象时协作修改
docs/architecture.md                       涉及前端目录时协作修改
frontend/demo/**                           仅作为展示原型和答辩兜底参考
```

禁止直接修改:

```txt
backend/src/modules/agent/**
backend/src/modules/runner/**
backend/src/modules/monitor/**
packages/contracts/src/types/agent.ts
packages/contracts/src/types/trace.ts
```

C 不得直接读取 `configs/*.json` 参与运行时判定，不得绕过 `InteractionTrace` 读取临时日志。C 的前端部分不得直接 import `backend/src/**`，不得直接读取 `configs/*.json` 或 `outputs/**` 原始文件作为业务数据源，不得重新计算风险等级、风险画像、策略包或防御效果。

C 前端依赖方向必须保持:

```txt
frontend/src -> packages/contracts
frontend/src -> backend API
```

禁止:

```txt
frontend/src -> backend/src
frontend/src -> configs/*.json
frontend/src -> outputs/raw files
```

说明: 独立开发者 D 模块已移交给 C。历史文档中的 D 前端职责全部视为 C 前端职责。

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
frontend/src/lib/api/**
docs/architecture.md
docs/contracts.md
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
docs/architecture.md 与实际目录是否一致
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
- 如果改变 A/B/C 交接对象或 C 前端消费对象，必须同步 `docs/interfaces.md`
- 如果改变目录归属，必须同步 `docs/ownership.md` 和 `docs/architecture.md`

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

Backend API / Report Artifacts 交给 C 前端:

```txt
TestContext view
TestRun
InteractionTrace
RiskReport
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord[]
DefenseReport
ReportArtifact[]
```

验收测试额外读取:

```txt
TestOracle[]
```

`TestOracle[]` 只能由验收测试读取，不属于运行时主链路。

## 8. P1 检测画像驱动监督 Ownership 扩展

P1 新增能力围绕以下对象展开:

```txt
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord
DefenseReport
```

这些对象必须先进入 `docs/contracts.md` 和 `packages/contracts/src/types/**`，再进入模块实现。协调人负责冻结字段草案和确认 A/B/C 三条线可以并行开工；原 D 前端职责归入 C。

### 8.1 P1 新增主责归属

开发者 A 新增主责:

```txt
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
scenarios/**
backend/src/modules/config/**
backend/src/modules/sandbox/**
packages/contracts/src/types/test.ts
packages/contracts/src/types/sandbox.ts
```

A 负责红队场景、业务工具画像、策略模板和配置校验。A 不负责根据某个 Agent 的检测结果生成策略包实例。

开发者 B 新增主责:

```txt
backend/src/modules/supervisor/**
backend/src/api/v1/supervision/**
packages/contracts/src/types/supervision.ts
```

B 负责真实或半真实运行环境接入、监督接口执行、策略包加载和 `RuntimeSupervisionRecord[]` 输出。B 不负责生成策略包，不负责生成防御报告；`frontend/src/**` 的正式页面由 C 负责，B 只提供 API / contract 支撑。

开发者 C 新增主责:

```txt
backend/src/modules/detection/**
backend/src/modules/policy/**
backend/src/modules/defense/**
backend/src/api/v1/detection/**
backend/src/api/v1/policies/**
backend/src/api/v1/defense/**
frontend/src/**
frontend/public/**
frontend/tests/**
packages/contracts/src/types/detection.ts
packages/contracts/src/types/policy.ts
packages/contracts/src/types/defense.ts
```

C 负责 `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack` 生成、`DefenseReport`、报告产物、正式前端页面、API Client、ViewModel 和展示验收。C 不负责执行策略包，前端部分不得重新计算风险、画像、策略或防御效果。

### 8.2 P1 可协作区域

以下区域必须由协调人确认影响范围后再修改:

```txt
packages/contracts/src/index.ts
packages/contracts/src/types/common.ts
packages/contracts/src/types/detection.ts
packages/contracts/src/types/policy.ts
packages/contracts/src/types/supervision.ts
packages/contracts/src/types/defense.ts
docs/contracts.md
docs/interfaces.md
docs/ownership.md
docs/architecture.md
docs/p1-supervision-defense-plan.md
scripts/verify-full-pipeline.ts
scripts/verify-p1-detection-policy.ts
scripts/verify-p1-supervision-defense.ts
```

`SupervisionPolicyPack` 是 C -> B 的关键交接对象。任何字段变化必须同时由 B 确认可执行、由 C 确认可生成。

`RuntimeSupervisionRecord` 是 B -> C 的关键交接对象。任何字段变化必须同时由 B 确认可采集、由 C 确认可生成防御报告。

### 8.3 P1 禁止事项

P1 期间新增禁止事项:

- A 在策略模板中写入某次检测运行的私有结论
- B 在监督接口中绕过 `SupervisionPolicyPack` 私自内置阻断规则
- B 根据 `RiskReport` 直接生成运行时策略
- C 编造运行时阻断记录来生成防御报告
- C 在生成 `SupervisionPolicyPack` 时直接读取 B 的私有运行日志
- 前端直接读取 `configs/supervision_policy_templates.json` 来解释策略命中
- demo payload 反向决定正式契约字段
- A/B/C 同时修改同一个 contracts 类型文件而未提前同步

### 8.4 协调人冻结点

协调人必须在以下节点冻结接口:

```txt
P1-Freeze-1:
  DetectionReport
  AgentRiskProfile
  SupervisionPolicyPack

P1-Freeze-2:
  RuntimeSupervisionRecord
  RuntimeAlert
  BlockedAction

P1-Freeze-3:
  DefenseReport
  ReportArtifact for DefenseReport
```

冻结后只允许新增可选字段。删除字段、改字段语义、改枚举含义必须重新开协调评审，并同步 `docs/contracts.md`、`docs/interfaces.md` 和 `packages/contracts/src/types/**`。
