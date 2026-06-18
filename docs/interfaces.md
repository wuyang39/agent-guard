# Agent-MCP 交互安全测评系统开发者接口清单

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档是开发者交接接口的初始基线。当前接口优先保障 P0 垂直闭环并行开发；后续完整系统扩展仍必须通过本文档约束交接对象。字段类型以 `docs/contracts.md` 和 `packages/contracts/src/types/**` 为准。

## 1. 接口边界总览

本系统唯一被测对象是 `AgentUnderTest`。MCP Server、Tool、Resource、Prompt、Tool Response、风险规则和测试用例都由系统内部提供。

P0 后端三条线之间只通过下列对象交接:

```txt
外部输入 -> A/B:
  AgentUnderTest
  AgentAdapterConfig

A -> B:
  TestContext

B -> C:
  TestRun
  InteractionTrace

C -> Backend Report API / Frontend Web Console:
  RiskReport
  ReportArtifact[]
```

任何模块不得要求其他开发者提供私有类、临时日志、缓存对象或未写入契约文档的字段。

独立开发者 D 模块已移交给 C。C 前端不参与 A/B 运行时数据生产，只消费 Backend API、报告产物和 `packages/contracts` 中的共享契约对象。

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
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
configs/a-line/sources/pyrit_attack_library.json
configs/a-line/sources/pyrit_jailbreak_template_index.json
configs/a-line/corpus/seeds/resource_seeds.json
configs/a-line/corpus/seeds/attack_seeds.json
configs/a-line/corpus/seeds/user_prompt_seeds.json
configs/a-line/corpus/seeds/tool_response_seeds.json
configs/a-line/corpus/operators/mutation_operators.json
configs/a-line/corpus/profiles/corpus_run_profiles.json
generated/a-line/**
AgentUnderTest
```

输出给 B:

```txt
TestContext
RedTeamScenarioSet
PolicyTemplate[]
PyritAttackLibrary
PyritJailbreakTemplateIndex
CorpusManifest
CorpusRunProfile[]
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

`PyritAttackLibrary` 是 A 线 P2 新增的攻击库目录对象，用于描述 vendored PyRIT 来源、converter catalog、attack family 和 sample 到 case 的映射。它不是运行时风险结论，不能替代 `InteractionTrace` 或 C 线报告。

`PyritJailbreakTemplateIndex` 是 A 线 P2 新增的 PyRIT jailbreak 模板元数据索引。它只保存路径、分组、参数、作者、哈希和大小，不保存模板全文；前端和报告只能把它作为来源说明或覆盖率统计。

`CorpusManifest` 是 A 线 P3 generated corpus 的来源和覆盖率索引。B 线可按 `CorpusRunProfile` 显式选择 generated case；C 线可用 `CorpusManifest` 展示来源、覆盖率和样本分层。`CorpusManifest` 不包含风险结论，不能替代 `InteractionTrace`、`RiskReport` 或 `DefenseReport`。

`generated/a-line/test_oracles.generated.json` 只用于离线验收和 corpus 质量检查，不进入运行时 `TestContext`，也不得作为 C 线风险判定证据。

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

输出给 Backend Report API / Frontend Web Console:

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

## 6. P1 检测画像驱动监督接口扩展

P1 在不破坏 P0 主链路的前提下，新增“监督前检测 -> 风险画像 -> 策略包 -> 真实运行监督 -> 防御报告”的扩展链路。

P1 主链路:

```txt
AgentUnderTest + AgentAdapterConfig
  -> TestContext
  -> TestRun + InteractionTrace
  -> RiskEvaluationResult + RiskReport
  -> DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack
  -> RuntimeSupervisionRecord[]
  -> DefenseReport + ReportArtifact[]
```

P1 新增对象只允许通过公开契约交接，不得通过私有类、临时日志、前端 demo payload 或未文档化字段交接。

### 6.1 P1 交接边界总览

```txt
A -> B/C:
  TestContext
  RedTeamScenarioSet
  PolicyTemplate[]

B -> C:
  TestRun
  InteractionTrace
  RuntimeSupervisionRecord[]

C -> B:
  SupervisionPolicyPack

C -> Backend API / Frontend:
  DetectionReport
  AgentRiskProfile
  DefenseReport
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
  ReportArtifact[]
```

协调人必须优先冻结 `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack`、`RuntimeSupervisionRecord`、`DefenseReport` 的字段草案，再允许 A/B/C 三条线并行实现；原 D 前端实现归入 C。

### 6.2 开发者 A 的 P1 输出

职责: 红队场景、业务工具画像、策略模板和测试数据扩展。

输入:

```txt
configs/tools.json
configs/resources.json
configs/prompts.json
configs/tool_responses.json
configs/risk_rules.json
configs/test_cases.json
configs/test_oracles.json
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
```

输出给 B 和 C:

```txt
TestContext
RedTeamScenarioSet
PolicyTemplate[]
```

`RedTeamScenarioSet` 必须说明:

```txt
scenarioId
name
attackType
caseIds
sampleIds
expectedWeaknessCategories
recommendedPolicyTemplateIds
```

`PolicyTemplate` 只描述可复用的策略模板，不绑定某个 Agent 的检测结果。根据检测结果生成的实例化策略包由 C 输出为 `SupervisionPolicyPack`。

A 不得:

- 根据运行时 trace 直接生成 `AgentRiskProfile`
- 直接生成 `SupervisionPolicyPack`
- 在配置中写入某次检测运行的私有结论

### 6.3 开发者 B 的 P1 输出

职责: 检测运行、真实或半真实 Agent 接入、运行时监督接口执行和监督记录输出。

输入:

```txt
AgentUnderTest
AgentAdapterConfig
TestContext
SupervisionPolicyPack
```

输出给 C:

```txt
TestRun
InteractionTrace
RuntimeSupervisionRecord[]
```

`RuntimeSupervisionRecord` 必须包含:

```txt
recordId
runtimeSessionId
agentId
policyPackId
policyId
action
decisionReason
targetType
targetId
inputEventId
outputEventId
createdAt
```

B 负责解释策略包如何在运行时执行，但不得修改策略包含义。发现策略包无法执行时，B 应输出兼容性问题给协调人和 C，而不是在运行时代码中私自改变策略语义。

B 不得:

- 根据 `RiskReport` 自行推导新策略
- 直接计算 `AgentRiskProfile`
- 在监督接口中内置未进入 `SupervisionPolicyPack` 的临时风险规则

### 6.4 开发者 C 的 P1 输出

职责: 检测报告、风险画像、策略包生成和防御报告。

输入:

```txt
TestContext
TestRun
InteractionTrace
RiskEvaluationResult
RiskReport
PolicyTemplate[]
RuntimeSupervisionRecord[]
```

输出给 B:

```txt
SupervisionPolicyPack
```

输出给 Backend API / Frontend:

```txt
DetectionReport
AgentRiskProfile
DefenseReport
ReportArtifact[]
```

`DetectionReport` 必须包含:

```txt
reportId
agentId
sourceRiskReportIds
scenarioSummary
riskSummary
failedScenarios
findingIds
evidenceChainIds
recommendedPolicyTemplateIds
generatedAt
```

`AgentRiskProfile` 必须包含:

```txt
profileId
agentId
sourceDetectionReportId
weaknesses
highRiskTools
sensitiveResourcePatterns
exfiltrationPatterns
recommendedControls
confidence
generatedAt
```

`SupervisionPolicyPack` 必须包含:

```txt
policyPackId
agentId
sourceDetectionReportId
sourceRiskProfileId
policies
defaultAction
createdAt
expiresAt
```

`DefenseReport` 必须包含:

```txt
defenseReportId
agentId
detectionReportId
riskProfileId
policyPackId
runtimeSessionIds
detectedWeaknesses
generatedPolicies
runtimeAlerts
blockedActions
defenseEffectiveness
residualRisk
generatedAt
```

C 不得:

- 绕过 `RuntimeSupervisionRecord` 编造防御效果
- 在报告模块中重新采集 Agent 运行时行为
- 让前端直接读取 `configs/supervision_policy_templates.json` 解释策略命中

### 6.5 P1 联调检查表

每次 P1 联调前检查:

- `DetectionReport.sourceRiskReportIds` 指向真实风险报告
- `AgentRiskProfile.sourceDetectionReportId` 指向真实检测报告
- `SupervisionPolicyPack.sourceRiskProfileId` 指向真实风险画像
- `RuntimeSupervisionRecord.policyPackId` 指向本次加载的策略包
- `RuntimeSupervisionRecord.policyId` 能在策略包中找到
- 每个 `deny`、`ask`、`redact` 记录都有可追溯的输入事件或运行时动作
- `DefenseReport.policyPackId` 与运行时监督记录一致
- 防御报告中的阻断和告警来自真实 `RuntimeSupervisionRecord[]`
- 前端只消费 API、报告产物或共享契约对象，不直接解释配置文件

P1 联调失败时，按以下顺序排查:

1. 共享契约字段是否一致
2. P1 对象 ID 引用是否断裂
3. A 的策略模板是否能被 C 实例化
4. C 的策略包是否能被 B 执行
5. B 的运行时记录是否足够让 C 生成防御报告

## 7. 开发者 C 前端展示接口

职责: 正式 Frontend Web Console。该职责归入 C 线。C 前端只消费后端 API、报告产物和共享契约，不直接读取后端模块、配置文件或 outputs 原始文件。

C 前端输入:

```txt
Backend API response
ReportArtifact[]
packages/contracts types
```

C 前端展示对象:

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
```

C 前端输出:

```txt
Frontend route / page
ViewModel
User action request
API request payload
```

C 前端不得:

- 直接 import `backend/src/**`
- 直接读取 `configs/*.json` 解释规则、场景或策略
- 直接读取 `outputs/**` 原始文件作为业务数据源
- 在前端重新计算风险等级、风险画像或防御效果
- 用 demo payload 反向修改正式 contracts

C 前端联调检查表:

- 前端页面只从 API client 或 report artifact 加载数据
- 前端类型只从 `@agent-guard/contracts` 或前端私有 view model 引入
- 前端 view model 不改变共享契约字段语义
- Dashboard、Detection、Supervision、DefenseReports 页面都能追溯到对应 reportId / traceId / policyPackId
- 如果 C 前端需要新增展示字段，必须先通过协调人更新 `docs/contracts.md` 和 `packages/contracts/src/types/**`

## 8. P2 前后端 API 冻结

P2 以 OpenClaw 作为核心演示 Agent，正式前端通过 Fastify API 消费后端产物。并行开发前必须以 `docs/p2-api-contract-plan.md` 冻结首批 API。

首批冻结对象:

```txt
ApiResponse<T>
P2AdapterKind
P2RunGroup
P2ArtifactView
```

首批冻结接口:

```txt
GET  /api/v1/system/status
GET  /api/v1/dashboard/summary
POST /api/v1/agents/check
POST /api/v1/test-runs/e2e
GET  /api/v1/test-runs
GET  /api/v1/test-runs/:runGroupId
GET  /api/v1/traces/:traceId
GET  /api/v1/reports/detection/:reportId
GET  /api/v1/policies/:policyPackId
GET  /api/v1/supervision/sessions/:runtimeSessionId
GET  /api/v1/reports/defense/:reportId
GET  /api/v1/artifacts/:artifactId
```

P2 前端不得依赖未进入 `docs/p2-api-contract-plan.md` 的临时字段。P2 后端如果需要新增字段，应优先新增可选字段，并同步该 API 冻结文档。
