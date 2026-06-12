# P2 真实 Agent 接入、正式 API 与前端演示系统设计计划

文档版本: p2-plan-1
基线日期: 2026-06-07
状态: 设计计划稿

说明: 当前 P0/P1 后端数据产物链路已经跑通，`verify:all` 和 `verify:e2e` 可以证明 `TestContext -> TestRun -> InteractionTrace -> RiskReport -> DetectionReport -> AgentRiskProfile -> SupervisionPolicyPack -> RuntimeSupervisionRecord[] -> DefenseReport` 已形成闭环。P2 的重点不是继续新增后端概念，而是把已打通的链路产品化成可接真实或半真实 Agent、可通过正式 API 调用、可在正式前端展示和答辩演示的系统。

## 1. P2 总目标

P2 目标:

```txt
已验证后端链路
  -> 正式 Backend API
  -> 真实或半真实 Agent Adapter
  -> 文件级运行历史与报告索引
  -> 正式 Frontend Web Console
  -> 一键演示与回归验证
```

P2 完成后，系统应能回答:

- 如何接入一个真实或半真实 Agent。
- 如何从前端发起检测运行。
- 如何查看运行状态、trace、风险报告、检测报告、策略包、监督记录和防御报告。
- 如何证明报告不是手写 mock，而是由真实链路生成。
- 如何在答辩现场稳定复现一条完整攻击到防御闭环。

## 2. 当前基线

已经完成:

- A 线配置、场景、策略模板和 Sandbox 可被加载、校验和确定性执行。
- B 线 Runner、Monitor、Mock Agent、SupervisionBridge 已能产出 `TestRun`、`InteractionTrace` 和 `RuntimeSupervisionRecord[]`。
- C 线风险判定、检测报告、风险画像、策略包、防御报告和 JSON/HTML 导出已能串联。
- `npm run verify:all` 通过。
- `npm run verify:e2e` 通过，并生成 `outputs/reports/e2e/defense-report.html`。

尚未完成:

- `backend/src/api/v1/**` 只有目录，没有正式 API handler。
- `frontend/src/**` 只有目录，没有正式页面、API client、hook 或 view model。
- OpenClaw 作为核心演示 Agent 的 adapter 还没有纳入正式验证链路。
- 运行历史和报告索引还只是文件产物，没有统一查询服务。
- 前端仍不能从正式 API 消费报告和 trace。

## 3. P2 范围

P2 包含:

- 基于 Fastify 的正式后端 API 边界。
- 文件级运行仓库和报告仓库。
- OpenClaw 核心演示 adapter。
- 本地 HTTP sample agent adapter 作为兼容和兜底演示路径。
- 基于 Vite + React 的前端 API Client、ViewModel 和核心页面。
- 一键端到端脚本，覆盖 API 和前端消费所需产物。
- 答辩演示路径和失败兜底方案。

P2 不包含:

- 生产级数据库、用户系统和权限系统。
- 多租户、远程配置中心和分布式任务队列。
- 真正执行危险文件写入、网络请求或代码执行。
- 让前端直接读取 `configs/*.json` 或 `outputs/**` 原始文件。
- 把 MCP Server 作为被测对象做漏洞扫描。
- 直接修改 OpenClaw 核心源码或把 OpenClaw 私有协议写入共享 contracts。OpenClaw 接入必须通过 adapter shim。
- 在 P2 引入 Markdown / PDF 导出。P2 继续使用 JSON + HTML，Markdown / PDF 留到 P3 或答辩材料阶段。

### 3.1 比赛导向技术选择

根据比赛要求，P2 技术路线固定如下:

```txt
Backend API: Fastify
Frontend: Vite + React
Primary demo agent: OpenClaw
Fallback demo agent: local HTTP sample agent
Last-resort demo agent: mock adapter
OpenClaw support: first-class adapter shim + realtime MCP supervision endpoint
Persistence: file-based key object store
Report export: JSON + HTML in P2, Markdown / PDF in later phase
```

选择理由:

- Fastify 比 Node 原生 HTTP 更适合正式 API、schema 校验、错误处理和后续实时告警扩展。
- Vite + React 更适合比赛要求中的 Dashboard、Trace 时间线、监督台和防御报告交互展示。
- OpenClaw 与比赛要求中的“开源智能体应用”表达最贴合，适合作为核心演示 Agent。
- 本地 HTTP sample agent 用于在 OpenClaw 环境不可用时保持半真实演示路径。
- mock adapter 必须保留为最后兜底，保证断网或外部 Agent 不可用时仍可复现完整链路。
- P2 只持久化关键对象，优先保障可追溯，不提前引入数据库复杂度。

## 4. P2 主链路

```txt
Frontend Web Console
  -> Backend API
  -> Agent Registry / Adapter
  -> loadTestContexts()
  -> runTestCase()
  -> evaluateRisk()
  -> buildRiskReport()
  -> buildDetectionReport()
  -> buildAgentRiskProfile()
  -> buildSupervisionPolicyPack()
  -> runTestCase(...policyPack)
  -> buildDefenseReport()
  -> export reports
  -> RunHistory / ReportIndex
  -> Frontend Web Console
```

P2 必须保留 P1 已证明的追溯链:

```txt
DefenseReport
  -> RuntimeSupervisionRecord[]
  -> SupervisionPolicyPack
  -> AgentRiskProfile
  -> DetectionReport
  -> RiskReport[]
  -> InteractionTrace[]
  -> TestContext[]
```

## 5. 后端 API 设计

详细前后端 API 以 `docs/p2-api-contract-plan.md` 为 P2 并行开发前冻结草案。本节只保留规划级摘要；如果本节与 API 冻结文档冲突，以 `docs/p2-api-contract-plan.md` 为准。

### 5.1 API 原则

- P2 API 使用 Fastify 实现。
- API 层只做请求解析、响应组装和服务调用。
- API 层不得直接实现风险判定、策略生成或报告生成业务逻辑。
- API 返回共享契约对象或明确的 API response view，不返回后端私有类。
- API 可以读取文件级产物，但必须通过 service / storage 层，不让前端直接读 `outputs/**`。
- P2 先使用本地文件作为持久化来源，后续再替换数据库。

### 5.2 Fastify API 分组

P2 首轮必做 API:

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
GET  /api/v1/openclaw/realtime/mcp     # metadata + OpenClaw 配置示例
POST /api/v1/openclaw/realtime/mcp     # raw JSON-RPC MCP endpoint
```

P2 可选 API:

```txt
GET /api/v1/configs/summary
GET /api/v1/configs/scenarios
GET /api/v1/configs/policy-templates
GET /api/v1/reports/risk/:reportId
GET /api/v1/supervision/records
```

### 5.3 关键 API Response

`POST /api/v1/test-runs/e2e`:

```txt
input:
  agent: { agentId?, name, description? }
  connection?: { endpointUrl?, workspacePath?, launchMode?, authRef?, timeoutMs? }
  adapterKind: "openclaw" | "http_sample" | "mock"
  caseIds?: string[]
  generateDefenseReport: boolean

output:
  runGroupId
  agentId
  riskReportIds[]
  detectionReportId
  riskProfileId
  policyPackId
  runtimeSessionIds[]
  defenseReportId
  artifactIds[]
  status
```

`GET /api/v1/reports/defense/:reportId`:

```txt
output:
  defenseReport: DefenseReport
  artifacts: ReportArtifact[]
  traceLinks[]
  sourceReports[]
```

`GET /api/v1/traces/:traceId`:

```txt
output:
  trace: InteractionTrace
  relatedReports[]
  relatedFindings[]
```

## 6. 后端 Service 与 Storage 设计

P2 使用文件级关键对象持久化，先不引入数据库。需要持久化的关键对象:

```txt
InteractionTrace
RiskReport
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord[]
DefenseReport
ReportArtifact[]
RunIndex
ReportIndex
```

P2 新增:

```txt
backend/src/services/e2eRunService.ts
backend/src/services/reportQueryService.ts
backend/src/services/configViewService.ts
backend/src/storage/fileRunStore.ts
backend/src/storage/fileReportStore.ts
backend/src/api/v1/**/handlers.ts
```

`e2eRunService` 负责串联现有模块:

```txt
load contexts
run detection
build risk reports
build detection report
build risk profile
build policy pack
run supervised pass
build defense report
export artifacts
save index
```

`fileReportStore` 负责:

- 写入报告 JSON / HTML artifact。
- 维护报告索引。
- 根据 `reportId`、`traceId`、`policyPackId` 查找关联对象。
- 隐藏 `outputs/**` 的真实文件路径，前端只看 API。

`fileRunStore` 负责:

- 维护 run group、test run、runtime session 的索引。
- 记录一次 E2E 运行关联的 case、trace、report、policy pack 和 defense report。
- 为前端运行列表提供稳定查询对象。

P2 暂不引入数据库。若后续要引入数据库，必须保持 API response 不破坏。

## 7. Agent Adapter 设计

P2 至少保留三个 adapter:

```txt
openclaw:
  核心演示 Agent。通过 adapter shim 接入 OpenClaw，不修改 OpenClaw 核心源码。

http_sample:
  本地或远程 HTTP sample agent。作为 OpenClaw 不可用时的半真实兜底。

mock:
  用于稳定回归和最终答辩兜底。
```

### 7.1 OpenClaw Adapter

OpenClaw 是 P2 默认演示 Agent，但实现上分成两条互补路径:

```txt
OpenClaw CLI adapter:
  用 openclaw agent --json 采集真实 OpenClaw 行为和 JSONL 证据链。
  适合生成 trace、风险画像和 DefenseReport 的 post-hoc shadow supervision。

OpenClaw Realtime MCP supervision:
  用 OpenClaw MCP server/proxy 配置指向 Agent Guard。
  工具调用实时进入 /api/v1/openclaw/realtime/mcp，在 sandbox 执行前完成 deny/ask/redact。
  OpenClaw 保持固定 MCP URL，监督策略由 Agent Guard active-policy API 热切换。
  适合作为答辩现场“外部测试用例 -> OpenClaw -> Agent Guard 监督台”的实时演示链路。
```

OpenClaw Adapter 的职责是把 Agent Guard 的 `AgentTask`、工具/资源/Prompt 可见性和监督桥接结果转换成 OpenClaw 可执行的任务输入，再把 OpenClaw 的消息、工具请求和最终输出归一化为 Agent Guard 的运行时事件。Realtime MCP 入口则负责把 OpenClaw 工具调用归一化为 Agent Guard canonical toolId，并复用 `SupervisionBridge`、`askChannel`、`McpSandbox` 和 trace/session storage。

初版配置:

```txt
OpenClawAdapterOptions:
  adapterKind: "openclaw"
  endpointUrl?: string
  workspacePath?: string
  launchMode: "external_running" | "spawn_local"
  timeoutMs
  authRef?: string
  mode?: "single_turn" | "multi_turn"
```

初版输入映射:

```txt
Agent Guard:
  task
  caseId
  contextId
  availableTools
  availableResources
  prompts
  policyPack?

OpenClaw adapter shim:
  creates OpenClaw task/session
  exposes sandbox tools through Agent Guard bridge
  intercepts tool/resource/API/file/email actions
  returns normalized messages and requested actions
```

初版输出映射:

```txt
OpenClaw output
  -> agent_message
  -> requestedToolCalls[]
  -> requestedResourceAccesses[]
  -> requestedApiCalls[]
  -> finalAnswer
  -> system_error on adapter/protocol failure
```

OpenClaw 接入原则:

- 不把 OpenClaw 私有协议写入 `packages/contracts`。
- 不让 OpenClaw 直接执行危险文件、网络或代码动作；动作必须经 sandbox / supervision bridge。
- Realtime MCP 端点返回 raw JSON-RPC，不使用普通 `ApiResponse<T>` envelope。
- `agent_guard_*` 工具名必须归一到 `tool.*`，确保 trace、风险识别和策略命中使用同一套语义。
- 策略切换通过 `POST /api/v1/openclaw/realtime/active-policy` 完成，不要求修改 OpenClaw MCP URL。
- 终端/前端可通过 `GET /api/v1/openclaw/realtime/events/stream` 订阅实时监督事件。
- `authRef` 只能是引用，不允许在配置中保存明文密钥。
- 如果 OpenClaw 协议变化，B 线只调整 adapter shim，不反向修改 A/C 数据契约。
- P2 实现前需要确认 OpenClaw 的启动方式、任务输入方式、工具调用表示和运行输出格式。

### 7.2 HTTP Sample Agent Adapter

HTTP Agent Adapter 是 P2 半真实兜底 adapter。初版契约:

```txt
AgentAdapterConfig:
  adapterType: "http"
  endpointUrl
  timeoutMs
  authRef?: string
  mode?: "single_turn" | "multi_turn"
```

HTTP Agent 请求:

```txt
POST {endpointUrl}
{
  task,
  caseId,
  contextId,
  availableTools,
  availableResources,
  prompts
}
```

HTTP Agent 响应:

```txt
{
  messages[],
  requestedToolCalls[],
  requestedResourceAccesses[],
  finalAnswer
}
```

注意:

- `authRef` 只能是引用，不允许在 `AgentAdapterConfig` 中保存明文密钥。
- HTTP Agent 不得直接访问真实危险资源，仍必须经 Agent Guard 的 sandbox / supervision bridge。
- 如果外部 Agent 协议不稳定，B 线先做 adapter shim，不反向修改共享契约。
- HTTP sample agent 不作为比赛核心演示 Agent，但必须保留，防止 OpenClaw 环境临时不可用。

## 8. 正式前端设计

P2 前端使用 Vite + React。目标不是复刻所有 demo，而是先做 5 个核心页面:

```txt
Dashboard
Test Runs
Trace Detail
Detection & Policy
Defense Report
```

### 8.1 Dashboard

展示:

- 最近运行状态。
- 最高风险等级。
- 风险类别分布。
- 阻断数量、脱敏数量、ask 数量。
- 最新 DefenseReport 入口。

### 8.2 Test Runs

展示:

- 运行列表。
- 每次运行的 agent、case 数、状态、生成时间。
- 进入 trace / report 的跳转。
- 发起一次 E2E 检测按钮。

### 8.3 Trace Detail

展示:

- `InteractionTrace.events` 时间线。
- `tool_call` / `tool_result` 关联。
- `resource_access`、`prompt_load`、`agent_message`。
- 与 finding / evidence chain 的反向关联。

### 8.4 Detection & Policy

展示:

- `DetectionReport` 场景失守摘要。
- `AgentRiskProfile` weakness 列表。
- `SupervisionPolicyPack` 策略列表。
- 每条策略的来源 weakness 和模板。

### 8.5 Defense Report

展示:

- `DefenseReport` 总览。
- blocked / redacted / ask / warning 分类。
- 防御有效性指标。
- 残余风险。
- JSON / HTML 导出入口。

前端约束:

- 页面只能调用 `frontend/src/lib/api/**`。
- API client 返回 contracts 类型或前端私有 view model。
- 前端不得直接读取 `outputs/**`。
- 前端不得重新计算风险等级、风险画像、策略包或防御效果。
- 前端开发服务器只消费 Fastify API，不把 demo server payload 当成正式契约。

## 9. A/B/C 分工

### 9.1 A 线 P2 目标

A 线负责让测试数据更像可演示产品数据:

- 补齐场景 metadata，保证前端能展示场景名称、攻击类型、推荐策略。
- 确认所有 case 都能通过 API view 安全展示。
- 补充适合真实/半真实 Agent 的 task 文案。
- 给每类工具补充展示字段: side effect、risk tags、allowed scopes。
- 保持 sandbox 行为确定性，不真实写文件、发网络请求或执行代码。

交付:

```txt
ConfigView data
Scenario catalog
Tool / Resource / Prompt display metadata
```

### 9.2 B 线 P2 目标

B 线负责把运行链路接到正式 API、OpenClaw 和兜底半真实 Agent:

- 实现 `openclaw` adapter，作为核心演示 Agent 接入路径。
- 实现 OpenClaw Realtime MCP 入口，作为核心实时监督演示路径。
- 实现 `http_sample` adapter，作为 OpenClaw 不可用时的半真实兜底。
- 实现 `e2eRunService` 中运行阶段的 B 线部分。
- 将 `runTestCase(...policyPack)` 纳入 API 触发链路。
- 保障监督记录和 trace 的 ID 可被 C 查询。
- 提供 `verify:p2:api-e2e` 和 `verify:openclaw:realtime` 的后端链路断言。

交付:

```txt
Agent adapter registry
OpenClaw adapter
OpenClaw realtime MCP supervision endpoint
HTTP Agent adapter
Run API service integration
RuntimeSupervisionRecord query support
```

### 9.3 C 线 P2 目标

C 线负责正式 API 的报告侧、正式前端和演示体验:

- 实现 report / detection / policy / defense API handler。
- 实现 file report store 和 report index。
- 搭建 Vite + React 正式前端。
- 实现前端 API client、view model 和 5 个核心页面。
- 实现前端空状态、加载状态、错误状态。
- 提供答辩演示路径和 HTML 报告兜底。

交付:

```txt
Backend report APIs
Frontend Web Console
Report index
Demo-ready route flow
```

## 10. P2 验收标准

P2 完成时必须满足:

- `npm run verify:all` 仍通过。
- `npm run verify:e2e` 仍通过。
- 新增 `npm run verify:p2:api-e2e`，通过 API 触发完整 E2E 链路。
- 新增 `npm run verify:openclaw:realtime`，验证 OpenClaw MCP 实时监督入口。
- Fastify API 能启动，并能通过 API 触发完整 E2E 链路。
- Vite + React 前端能启动，并通过 API 展示核心页面。
- OpenClaw 能作为核心演示 Agent 被接入，并产出 trace。
- OpenClaw MCP 工具调用能实时进入 Agent Guard，并产生可查询的 deny/ask/redact 监督记录。
- 本地 HTTP sample agent 能作为半真实兜底被接入并产出 trace；mock adapter 作为最终兜底仍可运行。
- API 能查询 `TestRun`、`InteractionTrace`、`DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack`、`DefenseReport`。
- 前端能从 API 展示 Dashboard、运行列表、trace 详情、检测策略、防御报告。
- 前端不直接 import `backend/src/**`，不直接读取 `configs/*.json` 或 `outputs/**`。
- DefenseReport 页面展示的阻断、脱敏和残余风险均可追溯到真实 `RuntimeSupervisionRecord[]`。
- 断网或外部 Agent 不可用时，mock adapter 演示路径仍可稳定运行。
- P2 报告导出保持 JSON + HTML。

## 11. 推荐实施顺序

### P2-A: 后端 API 最小闭环

目标: 不做前端，先让 API 能触发和查询 E2E。

任务:

1. 新增 file run/report store。
2. 新增 `e2eRunService`。
3. 引入并配置 Fastify。
4. 新增 `POST /api/v1/test-runs/e2e`。
5. 新增 report / trace 查询 API。
6. 新增 `verify:p2:api-e2e`。

验收:

```txt
API request
  -> e2e run
  -> report artifacts
  -> API query
  -> traceability assertions
```

### P2-B: OpenClaw 核心演示 Agent 接入

目标: 让 OpenClaw 成为系统核心演示 Agent，同时保留 HTTP sample 和 mock 兜底。

任务:

1. 调研并冻结 OpenClaw 启动方式、任务输入方式、工具调用表示和输出格式。
2. 定义 `openclaw` adapter shim。
3. 通过 API 选择 `adapterKind: "openclaw"`。
4. 实现 OpenClaw Realtime MCP 入口，确保工具调用实时经过 sandbox 和 supervision bridge。
5. 增加 OpenClaw 失败、超时、协议错误的 trace 记录。
6. 实现 HTTP sample agent adapter 作为半真实兜底。
7. 保留 mock adapter 作为最终兜底。
8. 新增 `verify:openclaw:realtime` 覆盖 deny/ask/redact 三类监督动作。

验收:

```txt
openclaw
  -> CLI JSONL trace / Realtime MCP tools/call
  -> InteractionTrace
  -> RiskReport / PolicyPack
  -> SupervisionBridge
  -> RuntimeSupervisionRecord[]
```

### P2-C: 正式前端最小可用

目标: C 前端能消费 API 完成演示。

任务:

1. 搭建 Vite + React 正式前端。
2. 新增 `frontend/src/lib/api/**`。
3. 新增前端 view model。
4. 新增 Dashboard。
5. 新增 Test Runs。
6. 新增 Trace Detail。
7. 新增 Detection & Policy。
8. 新增 Defense Report。

验收:

```txt
Frontend
  -> API
  -> Run E2E
  -> View reports
  -> Open trace detail
  -> Export HTML/JSON
```

### P2-D: 答辩演示固化

目标: 演示路径稳定、有兜底、有说法。

任务:

1. 固化一条默认 demo case set。
2. 固化 OpenClaw 作为默认演示路径。
3. 固化本地 HTTP sample agent 作为半真实兜底。
4. 固化 mock adapter 作为最终兜底。
5. 准备一键启动脚本。
6. 准备演示数据清理和重跑脚本。
7. 准备系统边界说明。

验收:

```txt
npm run demo:p2
npm run verify:p2:api-e2e
```

## 12. 风险与控制

风险: API 层直接写业务逻辑。

控制: API 只调用 service，service 只编排 modules。

风险: 前端为了展示直接读取文件。

控制: 所有数据必须经 API client；`frontend/src` 禁止读取 `outputs/**`。

风险: OpenClaw 或 HTTP Agent 协议反向污染 contracts。

控制: 通过 adapter shim 转换，不把某个 Agent 的私有协议写入共享契约。

风险: OpenClaw 环境不稳定影响答辩。

控制: OpenClaw 是默认演示路径；HTTP sample agent 是半真实兜底；mock adapter 是最终兜底。

风险: 运行历史索引和报告文件不一致。

控制: 每次导出同时写 index，并在验证脚本中检查 reportId / traceId / policyPackId 引用。

风险: P2 过早引入数据库或复杂框架。

控制: P2 使用 Fastify + Vite/React 作为必要产品化框架，但持久化先使用文件存储；等前端链路稳定后再做数据库替换。

## 13. 已确认技术选择

以下选择已按比赛要求确认，后续实现直接遵守:

1. P2 正式 API 选 Fastify。
2. 正式前端选 Vite + React。
3. 核心演示 Agent 选 OpenClaw。
4. 本地 HTTP sample agent 作为半真实兜底。
5. P2 只持久化关键对象: trace、risk report、detection report、risk profile、policy pack、runtime supervision records、defense report、artifact index。
6. 答辩演示默认展示 OpenClaw adapter，HTTP sample agent 和 mock adapter 作为兜底。
7. P2 报告导出继续 JSON + HTML，Markdown / PDF 留到 P3 或答辩材料阶段。

实现默认值:

- Fastify 默认端口: `3100`。
- Vite 默认端口: `5173`。
- 前端 P2 先使用轻量 CSS / 自有组件，不引入大型组件库。
- OpenClaw adapter 在 P2-B 作为第一优先级实现；具体协议由 B 线在实现前根据 OpenClaw 本地仓库或运行接口冻结。
- 如果 OpenClaw 无法在答辩环境稳定启动，则降级到本地 HTTP sample agent；如果 HTTP sample 也不可用，则降级到 mock adapter。

## 14. P2 对外表达口径

推荐表达:

```txt
P1 已证明 Agent Guard 的检测到防御数据链路可运行。P2 将把这条链路产品化为可交互系统: 后端使用 Fastify 提供正式 API 触发检测、查询 trace 和报告；B 线以 OpenClaw 作为核心演示 Agent，通过 adapter shim 让其工具调用进入 Agent Guard 的 sandbox 和 supervision bridge；C 线使用 Vite + React 建设正式 Web Console 展示检测画像、策略包、监督记录和防御报告。P2 的目标是让评委可以从页面发起一次针对 OpenClaw 的 Agent 安全测评，并沿着 trace、风险、策略和阻断证据一路追溯到最终防御结论。
```
