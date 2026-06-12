# P2 前后端 API 冻结草案

文档版本: p2-api-freeze-1
基线日期: 2026-06-07
状态: 并行开发前冻结草案

说明: 本文档只冻结 P2 并行开发必须先统一的前后端 API。P2 主方案以 OpenClaw 作为核心演示 Agent，Fastify 作为后端 API，Vite + React 作为正式前端。API 层只负责请求解析、响应组装和 service 调用；业务对象仍以 `packages/contracts/src/types/**` 和 `docs/contracts.md` 为准。

## 1. 冻结目标

P2 并行开发前必须让 B/C 对齐以下问题:

- C 前端如何发起一次针对 OpenClaw 的 E2E 安全测评。
- B/C 后端如何把运行、trace、风险、检测、策略、监督和防御报告串成可查询对象。
- 前端如何通过 API 查询 Dashboard、运行详情、trace、检测策略和防御报告。
- OpenClaw 的私有协议如何被 adapter 隔离，不反向污染共享 contracts。

P2 API 最小链路:

```txt
Frontend
  -> POST /api/v1/test-runs/e2e
  -> GET /api/v1/test-runs/:runGroupId
  -> GET /api/v1/traces/:traceId
  -> GET /api/v1/reports/detection/:reportId
  -> GET /api/v1/policies/:policyPackId
  -> GET /api/v1/supervision/sessions/:runtimeSessionId
  -> GET /api/v1/reports/defense/:reportId
```

## 2. 全局 API 约定

### 2.1 Base URL

```txt
Fastify: http://localhost:3100
API base: /api/v1
```

### 2.2 Response Envelope

所有 API 统一返回:

```ts
type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: ApiError;
  requestId: string;
};

type ApiError = {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};
```

约束:

- 成功时 `ok: true` 且必须有 `data`。
- 失败时 `ok: false` 且必须有 `error`。
- `requestId` 用于前端报错、后端日志和答辩现场排障。
- API 不返回后端私有 class 实例，只返回 JSON 可序列化对象。
- 例外: `POST /api/v1/openclaw/realtime/mcp` 是给 OpenClaw MCP 客户端消费的 raw JSON-RPC 端点，不使用 `ApiResponse<T>` envelope。

### 2.3 ID 与时间

```txt
ID: string
time: ISO 8601 string
schemaVersion: "mvp-1"
```

P2 前端不得自己生成业务 ID。所有 `runGroupId`、`traceId`、`reportId`、`policyPackId`、`runtimeSessionId` 都由后端生成或从后端产物读取。

### 2.4 Adapter Kind

P2 API 使用 `adapterKind` 表达演示入口，不直接要求前端构造底层 `AgentAdapterConfig` 的全部细节。

```ts
type P2AdapterKind = "openclaw" | "http_sample" | "mock";
```

映射原则:

- `openclaw`: 核心演示 Agent，经 OpenClaw adapter shim 接入。
- `http_sample`: 本地 HTTP sample agent，作为半真实兜底。
- `mock`: 稳定回归和最终兜底。

后端内部可以把 `adapterKind` 映射为现有 `AgentUnderTest` / `AgentAdapterConfig`。如果后续需要修改 contracts 中的 `adapterType` 枚举，必须另行走 `docs/contracts.md` 冻结流程。

## 3. 前端必需 View

P2 前端首批只做 5 个页面，因此 API 也先服务这 5 个页面:

```txt
Dashboard
Test Runs
Trace Detail
Detection & Policy
Defense Report
```

页面到 API 的关系:

```txt
Dashboard
  -> GET /api/v1/dashboard/summary

Test Runs
  -> GET /api/v1/test-runs
  -> POST /api/v1/test-runs/e2e
  -> GET /api/v1/test-runs/:runGroupId

Trace Detail
  -> GET /api/v1/traces/:traceId

Detection & Policy
  -> GET /api/v1/reports/detection/:reportId
  -> GET /api/v1/policies/:policyPackId

Defense Report
  -> GET /api/v1/supervision/sessions/:runtimeSessionId
  -> GET /api/v1/reports/defense/:reportId
```

## 4. Shared View Types

以下类型是 API view，不直接放入 `packages/contracts`，除非后续确认多端复用。字段必须可由 contracts 对象或 report index 推导。

### 4.1 EntityLink

```ts
type EntityLink = {
  kind:
    | "test_context"
    | "test_run"
    | "trace"
    | "risk_report"
    | "detection_report"
    | "risk_profile"
    | "policy_pack"
    | "runtime_session"
    | "defense_report"
    | "artifact";
  id: string;
  label: string;
};
```

### 4.2 P2RunGroup

```ts
type P2RunGroup = {
  runGroupId: string;
  agentId: string;
  agentName: string;
  adapterKind: P2AdapterKind;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  caseCount: number;
  highestRiskLevel?: "low" | "medium" | "high" | "critical";
  testRunIds: string[];
  traceIds: string[];
  riskReportIds: string[];
  detectionReportId?: string;
  riskProfileId?: string;
  policyPackId?: string;
  runtimeSessionIds: string[];
  defenseReportId?: string;
  artifactIds: string[];
  error?: string;
};
```

### 4.3 P2ArtifactView

```ts
type P2ArtifactView = {
  artifactId: string;
  reportId: string;
  format: "json" | "html";
  label: string;
  url: string;
  generatedAt: string;
};
```

P2 只展示 JSON / HTML。Markdown / PDF 不进入 P2 API 必做范围。

## 5. 必做接口

### 5.1 System Status

```txt
GET /api/v1/system/status
```

用途:

- 前端启动后确认 API 可用。
- 展示版本、运行模式和 P2 能力开关。

Response:

```ts
type SystemStatusResponse = {
  service: "agent-guard-api";
  schemaVersion: "mvp-1";
  apiVersion: "p2-api-freeze-1";
  status: "ok";
  defaultAdapterKind: "openclaw";
  fallbackAdapterKinds: ("http_sample" | "mock")[];
  features: {
    openclawAdapter: boolean;
    httpSampleAdapter: boolean;
    mockAdapter: boolean;
    e2eRun: boolean;
    reportIndex: boolean;
    frontendReady: boolean;
    openclawRealtimeMcp: boolean;
    askChannel: boolean;
  };
};
```

### 5.2 Dashboard Summary

```txt
GET /api/v1/dashboard/summary
```

用途:

- Dashboard 首屏。
- 展示最近运行、风险分布和防御效果摘要。

Response:

```ts
type DashboardSummaryResponse = {
  latestRun?: P2RunGroup;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  latestDefenseReportId?: string;
  highestRiskLevel?: "low" | "medium" | "high" | "critical";
  totalFindings: number;
  blockedActionCount: number;
  redactedActionCount: number;
  askDecisionCount: number;
  residualRiskCount: number;
  recentRuns: P2RunGroup[];
};
```

数据来源:

- `RunIndex`
- `RiskReport.summary`
- `DefenseReport.defenseEffectiveness`
- `DefenseReport.residualRisk`

### 5.3 Agent Check

```txt
POST /api/v1/agents/check
```

用途:

- 前端在发起 E2E 前检查 OpenClaw / HTTP sample / mock adapter 是否可用。
- 展示 OpenClaw 连接状态和兜底可用状态。

Request:

```ts
type AgentCheckRequest = {
  adapterKind: P2AdapterKind;
  endpointUrl?: string;
  workspacePath?: string;
  launchMode?: "external_running" | "spawn_local";
  timeoutMs?: number;
};
```

Response:

```ts
type AgentCheckResponse = {
  adapterKind: P2AdapterKind;
  available: boolean;
  displayName: string;
  detail: string;
  normalizedAgent?: {
    agentId: string;
    name: string;
    adapterKind: P2AdapterKind;
  };
};
```

约束:

- OpenClaw 不可用时不得阻塞整个前端，前端应提示可切到 `http_sample` 或 `mock`。
- 后端不得返回明文密钥或环境变量值。

### 5.4 Run E2E

```txt
POST /api/v1/test-runs/e2e
```

用途:

- 前端发起一次完整 P2 演示运行。
- 默认针对 OpenClaw。

Request:

```ts
type RunE2ERequest = {
  adapterKind: P2AdapterKind;
  agent: {
    agentId?: string;
    name: string;
    description?: string;
  };
  connection?: {
    endpointUrl?: string;
    workspacePath?: string;
    launchMode?: "external_running" | "spawn_local";
    authRef?: string;
    timeoutMs?: number;
  };
  caseIds?: string[];
  generateDefenseReport: boolean;
};
```

默认:

```txt
adapterKind: "openclaw"
generateDefenseReport: true
timeoutMs: 30000
caseIds: omitted means all enabled P2 demo cases
```

Response:

```ts
type RunE2EResponse = {
  runGroup: P2RunGroup;
  links: EntityLink[];
};
```

后端行为:

```txt
loadTestContexts()
run detection pass
build RiskReport[]
build DetectionReport
build AgentRiskProfile
build SupervisionPolicyPack
run supervised pass
collect RuntimeSupervisionRecord[]
build DefenseReport
export JSON / HTML artifacts
save RunIndex / ReportIndex
```

验收断言:

- `runGroup.traceIds.length > 0`
- `runGroup.riskReportIds.length > 0`
- `runGroup.detectionReportId` 存在
- `runGroup.policyPackId` 存在
- `runGroup.defenseReportId` 存在

### 5.5 Run List

```txt
GET /api/v1/test-runs
```

Query:

```txt
limit?: number
status?: running | completed | failed
adapterKind?: openclaw | http_sample | mock
```

Response:

```ts
type RunListResponse = {
  runs: P2RunGroup[];
  total: number;
};
```

### 5.6 Run Detail

```txt
GET /api/v1/test-runs/:runGroupId
```

Response:

```ts
type RunDetailResponse = {
  runGroup: P2RunGroup;
  testRuns: TestRun[];
  links: EntityLink[];
  artifacts: P2ArtifactView[];
};
```

消费页面:

- Test Runs
- Dashboard drill-down

### 5.7 Trace Detail

```txt
GET /api/v1/traces/:traceId
```

Response:

```ts
type TraceDetailResponse = {
  trace: InteractionTrace;
  relatedRunGroupId: string;
  relatedRiskReportIds: string[];
  relatedFindingIds: string[];
  eventToFindingIds: Record<string, string[]>;
  links: EntityLink[];
};
```

约束:

- 前端可以展示 timeline，但不得在前端重新计算风险。
- `eventToFindingIds` 由后端从 `RiskReport.findings[].evidenceEventIds` 推导。

### 5.8 Detection Detail

```txt
GET /api/v1/reports/detection/:reportId
```

Response:

```ts
type DetectionDetailResponse = {
  detectionReport: DetectionReport;
  riskProfile: AgentRiskProfile;
  sourceRiskReports: RiskReport[];
  links: EntityLink[];
};
```

约束:

- `riskProfile.sourceDetectionReportId` 必须等于 `detectionReport.reportId`。
- `sourceRiskReports[].reportId` 必须覆盖 `detectionReport.sourceRiskReportIds`。

### 5.9 Policy Pack Detail

```txt
GET /api/v1/policies/:policyPackId
```

Response:

```ts
type PolicyPackDetailResponse = {
  policyPack: SupervisionPolicyPack;
  sourceDetectionReportId: string;
  sourceRiskProfileId: string;
  sourceWeaknessTitles: Record<string, string>;
  links: EntityLink[];
};
```

约束:

- 前端只能展示策略，不得修改策略语义。
- 策略命中解释来自 `SupervisionPolicy.reason` 和 source weakness，不从配置文件读取模板。

### 5.10 Supervision Session Detail

```txt
GET /api/v1/supervision/sessions/:runtimeSessionId
```

Response:

```ts
type SupervisionSessionDetailResponse = {
  runtimeSessionId: string;
  agentId: string;
  policyPackId: string;
  records: RuntimeSupervisionRecord[];
  blockedActions: BlockedAction[];
  alerts: RuntimeAlert[];
  actionCounts: Record<"allow" | "deny" | "ask" | "warn" | "redact" | "isolate", number>;
  links: EntityLink[];
};
```

约束:

- `records[].policyPackId` 必须等于本 session 加载的策略包。
- `blockedActions[].recordId` 必须能在 `records` 中找到。

### 5.11 Defense Report Detail

```txt
GET /api/v1/reports/defense/:reportId
```

Response:

```ts
type DefenseReportDetailResponse = {
  defenseReport: DefenseReport;
  detectionReport?: DetectionReport;
  riskProfile?: AgentRiskProfile;
  policyPack?: SupervisionPolicyPack;
  runtimeSessionSummaries: {
    runtimeSessionId: string;
    recordCount: number;
    blockedCount: number;
    redactedCount: number;
    askCount: number;
  }[];
  artifacts: P2ArtifactView[];
  links: EntityLink[];
};
```

约束:

- `defenseReport.blockedActions` 必须来自真实 `RuntimeSupervisionRecord[]`。
- `artifacts` 只包含 P2 支持的 JSON / HTML。

### 5.12 Artifact Access

```txt
GET /api/v1/artifacts/:artifactId
```

用途:

- 前端打开 HTML 报告或下载 JSON 报告。

Response:

```txt
HTML artifact: text/html
JSON artifact: application/json
```

约束:

- 后端必须通过 artifact index 查找文件，不允许前端传任意文件路径。

### 5.13 OpenClaw Realtime MCP Endpoint

```txt
GET  /api/v1/openclaw/realtime/mcp
POST /api/v1/openclaw/realtime/mcp
POST /mcp/openclaw/realtime
GET  /api/v1/openclaw/realtime/active-policy
POST /api/v1/openclaw/realtime/active-policy
POST /api/v1/openclaw/realtime/sessions/reset
GET  /api/v1/openclaw/realtime/events/stream
```

用途:

- 让 OpenClaw 通过 MCP server/proxy 配置把工具调用实时送入 Agent Guard。
- 在 sandbox 执行前复用 `SupervisionBridge` 完成 `deny` / `ask` / `redact` / `allow` 判定。
- 为监督台提供可查询的 `RuntimeSupervisionRecord[]` 和 `InteractionTrace`。

`GET /api/v1/openclaw/realtime/mcp` 使用普通 `ApiResponse<T>` envelope:

```ts
type OpenClawRealtimeMcpInfo = {
  endpoint: "/api/v1/openclaw/realtime/mcp";
  transport: "streamable-http";
  mode: "realtime_mcp_supervision";
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  openclawConfigExample: Record<string, unknown>;
};
```

`POST /api/v1/openclaw/realtime/mcp` 是 MCP JSON-RPC 端点，**不使用** `ApiResponse<T>` envelope。请求和响应保持 MCP 客户端期望的 raw JSON-RPC:

```ts
type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: "initialize" | "ping" | "tools/list" | "tools/call" | string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
```

约束:

- `tools/call` 的 `name` 支持 `agent_guard_*` 工具名，后端统一归一到 `tool.*` canonical toolId。
- `arguments._agentGuardSessionId` 可指定 runtime session；未传时使用默认 realtime session。
- Query `policyPackId=fallback` 可强制使用内置实时兜底策略；未传时优先使用最近一次 completed run 的策略包。
- `ask` 动作通过已有 SSE/API ask 通道解决，超时策略由 `AGENT_GUARD_ASK_TIMEOUT` 控制。
- 该端点可由 OpenClaw MCP 配置消费，前端一般只需要展示 metadata 和实时监督记录。

策略热切换:

```ts
POST /api/v1/openclaw/realtime/active-policy
{
  policyPackId: "policy_pack.xxx" | "fallback";
  resetSessions?: boolean;
  runtimeSessionId?: string;
}
```

OpenClaw MCP 配置保持固定 URL；Agent Guard 后端通过 active policy 决定当前监督策略。`resetSessions` 默认为 `true`，用于避免旧 runtime session 继续持有旧策略。

实时事件流:

```txt
GET /api/v1/openclaw/realtime/events/stream?replay=1
```

SSE 事件包括:

```txt
active_policy_updated
session_reset
session_created
tool_call_started
supervision_decision
tool_call_result
```

终端可以用 `curl.exe -N` 订阅，用于答辩时展示实时 `deny` / `ask` / `redact` 过程。

## 6. P2 可选接口

以下接口不阻塞首轮并行开发:

```txt
GET /api/v1/configs/summary
GET /api/v1/configs/scenarios
GET /api/v1/configs/policy-templates
GET /api/v1/reports/risk/:reportId
GET /api/v1/supervision/records
```

如果前端首轮页面需要这些数据，优先通过必做详情接口里的嵌套字段满足，不直接开放配置文件读取。

## 7. 前后端分工

### 7.1 B 线

B 线负责:

- `adapterKind: "openclaw"` 的执行路径。
- OpenClaw adapter shim。
- `RuntimeSupervisionRecord[]` 的真实采集。
- `POST /api/v1/agents/check` 中 OpenClaw 可用性检查。
- `POST /api/v1/test-runs/e2e` 中运行阶段。

B 线不负责:

- 生成 `AgentRiskProfile`。
- 生成 `SupervisionPolicyPack`。
- 生成 `DefenseReport`。
- 为前端定制展示字段。

### 7.2 C 线后端

C 线后端负责:

- Fastify API 注册和 response envelope。
- `e2eRunService` 编排。
- `fileRunStore` / `fileReportStore`。
- risk / detection / policy / defense 查询接口。
- Dashboard summary 聚合。
- Artifact 安全访问。

C 线后端不负责:

- 执行 OpenClaw 私有协议。
- 编造运行时监督记录。
- 让 API 返回不可追溯的展示字段。

### 7.3 C 前端

C 前端负责:

- `frontend/src/lib/api/**` API client。
- Dashboard / Test Runs / Trace Detail / Detection & Policy / Defense Report 页面。
- 加载、空状态、错误状态。
- 只展示后端返回数据，不重新计算风险、策略或防御效果。

C 前端不得:

- import `backend/src/**`。
- 直接读取 `configs/*.json`。
- 直接读取 `outputs/**`。
- 使用 demo payload 反向决定 API shape。

## 8. 并行开发冻结点

进入 P2 并行开发前冻结:

```txt
Freeze-P2-API-1:
  ApiResponse<T>
  P2AdapterKind
  P2RunGroup
  P2ArtifactView
  POST /api/v1/test-runs/e2e
  GET /api/v1/test-runs
  GET /api/v1/test-runs/:runGroupId
  GET /api/v1/traces/:traceId
  GET /api/v1/reports/detection/:reportId
  GET /api/v1/policies/:policyPackId
  GET /api/v1/supervision/sessions/:runtimeSessionId
  GET /api/v1/reports/defense/:reportId
```

冻结后允许:

- 新增可选字段。
- 新增非阻塞 endpoint。
- 扩展 `links`。

冻结后禁止:

- 删除必填字段。
- 修改字段语义。
- 改变 `adapterKind` 枚举含义。
- 让前端依赖未进入本文档的临时字段。

## 9. 验证脚本要求

P2 必须新增:

```txt
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
```

脚本至少验证:

- Fastify API 可以启动。
- `GET /api/v1/system/status` 返回 `ok: true`。
- `POST /api/v1/test-runs/e2e` 可用 `adapterKind: "mock"` 跑通兜底链路。
- 如果 OpenClaw 测试环境可用，再验证 `adapterKind: "openclaw"`。
- `verify:openclaw:realtime` 必须验证 MCP `initialize`、`tools/list`、`tools/call`、实时 deny/ask/redact 记录、trace/session 可反查。
- `GET /api/v1/test-runs/:runGroupId` 能查到本次运行。
- `GET /api/v1/traces/:traceId` 能查到 trace。
- `GET /api/v1/reports/defense/:reportId` 能查到 defense report 和 artifact。
- 所有关键 ID 引用不断裂。

## 10. 首轮实现顺序

建议顺序:

1. 定义 API view 类型和 envelope。
2. 实现 file run/report index。
3. 实现 Fastify server 和 system status。
4. 把现有 `verify:e2e` 逻辑抽成 `e2eRunService`。
5. 实现 `POST /api/v1/test-runs/e2e`，先支持 `mock`。
6. 实现查询接口。
7. 接入 OpenClaw adapter shim。
8. 实现前端 API client。
9. 实现 5 个核心页面。
10. 补 `verify:p2:api-e2e`。

## 11. 待实现前确认

以下只影响实现细节，不改变 API 冻结草案:

- OpenClaw 本地仓库路径。
- OpenClaw 启动命令或已运行服务地址。
- OpenClaw 任务输入格式。
- OpenClaw 工具调用输出格式。
- 答辩环境是否允许启动 OpenClaw 子进程。
