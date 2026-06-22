# P2 B 线工作计划：真实 Agent 接入与运行时监督 API

文档版本: p2-b-plan-1
基线日期: 2026-06-08
状态: B-1 至 B-6 已完成，进入审核

## 1. 目标一句话

**先用 Fastify + HTTP adapter 把真实 API 运行链路打通，再接 OpenClaw adapter，补 ask 通道和验证脚本，最后通过 OpenClaw MCP 配置实现实时监督入口。**

## 2. 当前基线

B 线已完成 P1：

- `AgentAdapter` 注册表 (`agentAdapter.ts`) — 可扩展的 adapter 接口
- `MockAgentSession` (`mockAgentSession.ts`) — 脚本驱动的模拟 Agent
- `runTestCase()` (`testRunner.ts`) — 编排 Agent + Sandbox + Monitor + SupervisionBridge
- `SupervisionBridge` (`supervisionBridge.ts`) — 装饰器模式包装 AgentMcpBridge
- `AgentSupervisor` (`agentSupervisor.ts`) — preCheck() 拦截点
- `policyEngine` (`policyEngine.ts`) — 纯规则引擎匹配
- `verify-e2e-three-stage.ts` — 三阶段全链路验证（mock 数据源）

未完成：

- 无正式 API 入口（`backend/src/api/v1/**` 只有目录）
- 无真实/半真实 Agent adapter
- 无运行历史持久化（只在内存 + outputs 文件）
- 无 HITL 人工确认通道

## 3. P2 B 线范围

### 3.1 必做

| 序号 | 阶段 | 产出 | 验收标准 |
|------|------|------|---------|
| B-1 | Fastify API 骨架 + e2eRunService | `app.ts`, `server.ts`, `e2eRunService.ts`, `fileRunStore.ts`, 4 个 route handler | `POST /api/v1/test-runs/e2e` 用 `mock` adapter 跑通全链路 |
| B-2 | HTTP Sample Agent Adapter | `httpAgentAdapter.ts`, `httpAgentBridge.ts`, `httpAgentTypes.ts` | HTTP agent 经 API 触发 → runner → trace → defense report |
| B-3 | OpenClaw CLI Adapter + JSONL Shadow Supervision | `openclawAdapter.ts`, `openclawSession.ts`, `openclawTypes.ts` | OpenClaw CLI → JSONL 解析 → 影子 sandbox + supervision → DefenseReport (post-hoc, 非实时阻断) |
| B-4 | 半真实 HITL (ask) | `askChannel.ts`, SSE handler, PendingAskDecision 类型 | 高危动作触发 ask → 前端 Approve/Reject → 超时兜底 |
| B-5 | 验证脚本 | `verify-p2-api-e2e.ts` | mock / http / openclaw 三条 adapter 链路全绿 |
| B-6 | OpenClaw Realtime MCP Supervision | `realtimeMcpServer.ts`, `realtime-mcp-handlers.ts`, `verify-openclaw-realtime-mcp.ts` | OpenClaw 可通过 MCP server/proxy 把工具调用实时送入 Agent Guard，产生 deny/ask/redact 监督记录 |

### 3.2 不做

- 不实现 `spawn_local` 启动模式（留 P3）
- 不做完整权限系统（留 P3）
- 不修改 OpenClaw 核心源码
- 不把 OpenClaw 私有协议写入 `packages/contracts`
- C 线的 report query API 和前端页面不在 B 线范围
- Markdown/PDF 导出不在 P2 范围

## 4. 阶段 B-1: Fastify API 骨架 + e2eRunService

### 4.1 目标

把 `verify:e2e` 的逻辑抽成 service，通过 Fastify API 触发，用 mock adapter 跑通完整链路。

### 4.2 架构

```txt
Fastify (3100)
  ├── GET  /api/v1/system/status
  ├── POST /api/v1/test-runs/e2e     → e2eRunService.run()
  ├── GET  /api/v1/test-runs          → fileRunStore.list()
  ├── GET  /api/v1/test-runs/:id      → fileRunStore.get()
  └── GET  /api/v1/supervision/sessions/:id → fileRunStore.getSession()

e2eRunService:
  loadTestContexts()
  → for each context: runTestCase() [detection pass]
  → buildRiskReport()
  → buildDetectionReport()
  → buildAgentRiskProfile()
  → buildSupervisionPolicyPack()
  → for each context: runTestCase() [supervised pass, with policyPack]
  → buildDefenseReport()
  → export artifacts (JSON + HTML)
  → save RunIndex / ReportIndex
  → return P2RunGroup
```

### 4.3 新增文件

```
backend/src/app.ts                              Fastify app factory
backend/src/server.ts                           启动入口 (listen)
backend/src/api/v1/system/handlers.ts           GET /system/status
backend/src/api/v1/test-runs/handlers.ts        POST /e2e, GET /, GET /:id
backend/src/api/v1/supervision/handlers.ts      GET /sessions/:id
backend/src/services/e2eRunService.ts           编排 service
backend/src/storage/fileRunStore.ts             RunGroup + Session 索引
backend/src/storage/fileReportStore.ts          报告 artifact 索引
backend/src/api/response.ts                     ApiResponse<T> envelope
```

### 4.4 关键接口

```typescript
// e2eRunService.ts
type RunE2EInput = {
  adapterKind: "openclaw" | "http_sample" | "mock";
  agent: { agentId?: string; name: string };
  connection?: { endpointUrl?: string; timeoutMs?: number };
  caseIds?: string[];
  generateDefenseReport: boolean;
};

type RunE2EOutput = {
  runGroup: P2RunGroup;
  links: EntityLink[];
};

// fileRunStore.ts
interface RunStore {
  save(runGroup: P2RunGroup): Promise<void>;
  get(runGroupId: string): Promise<P2RunGroup | undefined>;
  list(opts?: { limit?: number; status?: string; adapterKind?: string }): Promise<P2RunGroup[]>;
  saveSession(session: SupervisionSession): Promise<void>;
  getSession(sessionId: string): Promise<SupervisionSession | undefined>;
}
```

### 4.5 Fastify 项目结构

参考 [mcollina/skills/fastify](https://github.com/mcollina/skills) 最佳实践：

```txt
App Factory 模式:
  app.ts  ← buildApp() 创建 Fastify 实例、注册插件和路由
  server.ts ← 调用 buildApp()，listen，处理 graceful shutdown

插件:
  @fastify/cors
  @fastify/rate-limit (可选)

响应:
  统一 ApiResponse<T> envelope
  错误统一通过 error handler 捕获
```

### 4.6 验收

```bash
# 启动 API
node --import tsx backend/src/server.ts

# 触发 E2E (mock adapter)
curl -X POST http://localhost:3100/api/v1/test-runs/e2e \
  -H "Content-Type: application/json" \
  -d '{"adapterKind":"mock","agent":{"name":"Demo"},"generateDefenseReport":true}'

# 预期响应包含
#   runGroup.runGroupId
#   runGroup.traceIds.length > 0
#   runGroup.detectionReportId 存在
#   runGroup.policyPackId 存在
#   runGroup.defenseReportId 存在

# 查询运行列表
curl http://localhost:3100/api/v1/test-runs

# 查询监督会话
curl http://localhost:3100/api/v1/supervision/sessions/:id
```

## 5. 阶段 B-2: HTTP Sample Agent Adapter

### 5.1 目标

实现 `adapterKind: "http_sample"` 的 adapter，连接到本地 HTTP sample agent server，通过 API 触发完整检测+监督链路。

### 5.2 Adapter 设计

```typescript
// httpAgentAdapter.ts
class HttpAgentAdapter implements AgentAdapter {
  adapterType = "http_sample";

  async createSession(agent: AgentUnderTest, config: AgentAdapterConfig): Promise<AgentSession> {
    return new HttpAgentSession(agent, config);
  }
}

// HttpAgentSession.sendTask():
//   1. 构造请求体: { task, availableTools, availableResources, prompts }
//   2. POST → HTTP Agent endpoint
//   3. 解析响应中的 actions[]
//   4. 对每个 action:
//      - tool_call → bridge.handleToolCall()
//      - resource_access → bridge.handleResourceAccess()
//      - prompt_load → bridge.handlePromptLoad()
//      - agent_message → 收集到 finalMessages
//   5. 返回 AgentRunResult { finalMessage, ... }
```

### 5.3 与现有 sample-agent-server 对齐

当前 `scripts/sample-agent-server.mjs` 的契约：

```typescript
// 请求
POST /agent/run?mode=vulnerable|guarded
{
  task: { instruction: string },
  sandbox: { tools: [...], resources: [...] }
}

// 响应
{
  actions: [
    { type: "agent_message", message: "..." },
    { type: "resource_access", resourceId: "..." },
    { type: "tool_call", toolId: "...", parameters: {...} },
  ],
  finalMessage: "..."
}
```

P2 HTTP adapter 需要将此契约对齐到更规范的格式：

```typescript
// 请求 (HttpAgentAdapter → Agent Server)
POST {endpointUrl}
{
  task: { taskId, instruction },
  caseId: string,
  availableTools: ToolProfile[],
  availableResources: ResourceProfile[],
  prompts: PromptProfile[]
}

// 响应
{
  actions: AgentAction[],   // 同上
  finalMessage: string
}
```

sample-agent-server 需要同步更新以支持新契约，同时保留旧格式兼容。

### 5.4 新增文件

```
backend/src/modules/agent/httpAgentAdapter.ts
backend/src/modules/agent/httpAgentBridge.ts      HTTP 响应 → AgentMcpBridge 事件转换
backend/src/modules/agent/httpAgentTypes.ts       HTTP agent 私有类型
```

### 5.5 验收

```bash
# 1. 启动 sample agent server
npm run demo:sample-agent

# 2. 触发 E2E (http_sample adapter)
curl -X POST http://localhost:3100/api/v1/test-runs/e2e \
  -H "Content-Type: application/json" \
  -d '{"adapterKind":"http_sample","agent":{"name":"HTTP Demo"},"connection":{"endpointUrl":"http://localhost:7001/agent/run"},"generateDefenseReport":true}'

# 3. 验证 trace 中包含来自 HTTP agent 的真实 tool_call 事件
# 4. 验证 supervision records 中有 deny/ask/redact 动作
# 5. 验证 defense report 可追溯
```

## 6. 阶段 B-3: OpenClaw Adapter Shim

### 6.1 目标

接入 OpenClaw (github.com/openclaw/openclaw, 343k stars) 作为核心演示 Agent。

**B-3 定位修订 (2026-06-09 实测后):** B-3 是**真实 OpenClaw 行为采集 + 事后影子监督**，不是实时阻断型 Adapter。使用 `openclaw agent --json` CLI 执行任务，解析 session JSONL 提取 tool_call 事件，通过影子 sandbox + supervision 做 post-hoc 判定。监督结果标注 `shadow`/`post_hoc`，deny/ask 语义为 `would_deny`/`would_ask`。

**B-6 补充 (2026-06-12):** OpenClaw 实测支持将 MCP 配置指向自定义 server/proxy，因此新增 Agent Guard Realtime MCP 入口。OpenClaw 工具调用可以经 `streamable-http` MCP 进入 Agent Guard，在调用 sandbox 前完成策略匹配、deny/ask/redact 处理和监督记录落盘。P3 可继续做更强的 Gateway/Interceptor 集成，但 P2 已具备不改 OpenClaw 源码的实时监督路径。

详见 [openclaw-connection-notes.md](openclaw-connection-notes.md)。

### 6.2 接入模式: external_running + CLI

```txt
Agent Guard (3100)
  │
  ├── OpenClawAdapter
  │     → spawn("openclaw", ["agent", "--session-key", key, "--message", task, "--json"])
  │     → 等待 CLI 返回 → 获取 sessionFile 路径
  │     → 解析 session JSONL → 提取 tool_call/toolResult 事件
  │
  ├── Shadow Supervision (事后影子监督)
  │     → 对每个 tool_call: bridge.handleToolCall() → sandbox 影子执行
  │     → SupervisionBridge.preCheck() → would_deny/would_ask/would_redact
  │     → 记录 shadow RuntimeSupervisionRecord (标注 post_hoc)
  │
  ├── InteractionTrace
  │     → tool_call/toolResult/agent_message → trace events
  │
  └── Artifacts
        → 原始 JSONL 落盘 outputs/openclaw-sessions/
        → shadow supervision records → DefenseReport
```

### 6.3 任务输入映射

```typescript
// openclawSession.ts — 结构化 context → OpenClaw message 文本
AgentTaskEnvelope {               openclaw agent --message:
  agentId,            ──→         (session key: agent:main:agent-guard-{runId})
  systemPrompt?,      ──→         system instruction block
  userMessage,        ──→         task text block
  tools,              ──→         "Available tools: ..." block
  resources,          ──→         "Available resources: ..." block
  metadata            ──→         (not sent to OpenClaw)
}
```

转换逻辑在 `openclawSession.ts` 内，不入 contracts。

### 6.4 参考

| 来源 | 参考要点 |
|------|---------|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | `openclaw agent --json` CLI、session JSONL 格式、toolCall/toolResult 事件结构 |
| [openclaw-connection-notes.md](openclaw-connection-notes.md) | 实测环境 (2026.6.1)、JSONL 样例、字段映射 |

### 6.5 关键设计决策

```txt
1. 使用真实 openclaw agent --json CLI，不伪造 REST API
2. 原始 JSONL 落盘作为证据链 artifact (outputs/openclaw-sessions/)
3. toolCall → trace event (type: "tool_call")
   toolResult → trace event (type: "tool_result")
4. 影子监督: sandbox 重放 + supervision 判定，标注 post_hoc
5. deny → "would_deny"，ask → "would_ask"，redact → "would_redact"
6. 不在报告/前端声称"已实时阻断 OpenClaw"
7. OpenClaw 私有类型在 openclawTypes.ts，不入 contracts
8. CLI 不可用时 adapter 标记 unavailable，前端降级 http_sample → mock
```

### 6.6 新增文件

```
backend/src/modules/agent/openclawAdapter.ts   ← AgentAdapter 实现
backend/src/modules/agent/openclawSession.ts   ← CLI spawn + JSONL 解析 + shadow supervision
backend/src/modules/agent/openclawTypes.ts     ← JSONL 事件类型（不入 contracts）
```

### 6.7 验收

```bash
curl -X POST http://localhost:3100/api/v1/test-runs/e2e \
  -H "Content-Type: application/json" \
  -d '{
    "adapterKind": "openclaw",
    "agent": {"name": "OpenClaw Demo"},
    "connection": {
      "endpointUrl": "http://localhost:18789",
      "launchMode": "external_running"
    },
    "generateDefenseReport": true
  }'

# 验收:
#   - trace 事件来自真实 OpenClaw JSONL (非 mock)
#   - supervision records 标签为 shadow/post_hoc
#   - 语义为 would_deny / would_ask（非实际阻断）
#   - 原始 JSONL 落盘 outputs/openclaw-sessions/
#   - DefenseReport 可追溯
```

## 7. 阶段 B-4: 半真实 HITL (ask 通道)

### 7.1 目标

当策略判定为 `ask` 时，不固定通过，而是推送到前端等待人工确认。

### 7.2 设计

```txt
SupervisionBridge 拦截到 ask 动作
  → PendingAskDecision 入队
  → SSE/WebSocket 推送给前端
  → 前端展示: toolId, parameters, reason, riskLevel
  → 用户 Approve → 继续执行
  → 用户 Reject → 阻断
  → 超时 (askTimeoutMs) → 默认 reject（可配置为 demoApproved）
```

### 7.3 接口

```typescript
// askChannel.ts
type PendingAskDecision = {
  askId: string;
  runtimeSessionId: string;
  policyId: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  createdAt: string;
  expiresAt: string;
};

// SSE endpoint (实时推送)
GET /api/v1/supervision/ask/stream?sessionId=xxx
→ event: ask_decision
→ data: PendingAskDecision

// 响应端点
POST /api/v1/supervision/ask/:askId/respond
{ decision: "approve" | "reject", reason?: string }
```

### 7.4 超时兜底

```typescript
const ASK_TIMEOUT_MS = 60_000; // 60 秒
const DEFAULT_TIMEOUT_ACTION: "reject" | "demo_approve" =
  process.env.AGENT_GUARD_ASK_TIMEOUT === "demo_approve" ? "demo_approve" : "reject";
```

答辩时如需无人值守，设置 `AGENT_GUARD_ASK_TIMEOUT=demo_approve`。

### 7.5 新增文件

```
backend/src/modules/supervisor/askChannel.ts     PendingAskDecision 队列 + SSE 推送
backend/src/api/v1/supervision/ask-handlers.ts   GET /stream, POST /:id/respond
```

## 8. 阶段 B-5: 验证脚本

### 8.1 verify-p2-api-e2e.ts

```txt
1. 启动 Fastify API
2. GET /api/v1/system/status → ok: true
3. POST /api/v1/test-runs/e2e (mock) → 200, runGroupId 不为空
4. GET /api/v1/test-runs → 包含本次运行
5. GET /api/v1/test-runs/:id → traceIds, riskReportIds 完整
6. GET /api/v1/supervision/sessions/:id → records 不为空
7. 检查 defenseReport.defenseReportId 存在
8. 检查所有 ID 引用链不断裂
9. (如有 OpenClaw) POST /api/v1/test-runs/e2e (openclaw) → 200
10. (如有 HTTP agent) POST /api/v1/test-runs/e2e (http_sample) → 200
```

## 8.5 阶段 B-6: OpenClaw Realtime MCP Supervision

### 8.5.1 目标

在不修改 OpenClaw 源码、不安装 OpenClaw 插件的前提下，利用 OpenClaw MCP 配置能力，把 OpenClaw 的工具调用实时路由到 Agent Guard。Agent Guard 在工具执行前完成监督策略判定，再进入 sandbox 模拟执行。

### 8.5.2 架构

```txt
OpenClaw MCP client
  → POST /api/v1/openclaw/realtime/mcp     (JSON-RPC / streamable-http)
  → tools/call(agent_guard_*)
  → normalize to canonical toolId
  → SupervisionBridge.preCheck()
      - deny   → 直接阻断并记录 RuntimeSupervisionRecord
      - ask    → 进入 askChannel，等待 SSE/API 确认或超时兜底
      - redact → 脱敏参数后继续执行
      - allow  → 继续执行
  → McpSandbox simulated execution
  → persist RuntimeSupervisionRecord[] + InteractionTrace
```

### 8.5.3 MCP 工具映射

```txt
OpenClaw tool name              Agent Guard canonical toolId
agent_guard_read_file       →   tool.read_file
agent_guard_write_file      →   tool.write_file
agent_guard_execute_code    →   tool.execute_code
agent_guard_send_email      →   tool.send_email
agent_guard_call_api        →   tool.call_api
agent_guard_send_request    →   tool.send_request
```

入口同时兼容 `tool.read_file`、`read_file`、`exec`、`bash`、`fetch` 等常见别名，内部统一归一到 `tool.*`，避免 trace 识别和策略命中错位。

### 8.5.4 API / MCP 端点

```txt
GET  /api/v1/openclaw/realtime/mcp
  → 返回工具列表、transport、OpenClaw 配置示例

POST /api/v1/openclaw/realtime/mcp
  → raw JSON-RPC MCP endpoint，不使用 ApiResponse envelope

POST /mcp/openclaw/realtime
  → root-level 兼容别名

POST /api/v1/openclaw/realtime/active-policy
  → 设置当前激活策略包，支持 resetSessions 热切换

POST /api/v1/openclaw/realtime/sessions/reset
  → 重置单个或全部 realtime session

GET /api/v1/openclaw/realtime/events/stream
  → SSE 事件流，终端/前端实时展示 deny/ask/redact
```

`POST` 端点支持 query:

```txt
sessionId?: string       # 指定 runtimeSessionId
policyPackId?: string   # 指定策略包；fallback 表示使用内置实时兜底策略
```

如果不传 `policyPackId`，默认选择最近一次 completed run 的 `SupervisionPolicyPack`；若不存在，则使用 `policy_pack.openclaw.realtime.fallback`。

推荐产品形态:

```txt
OpenClaw MCP URL 固定为 /api/v1/openclaw/realtime/mcp
策略包通过 active-policy API 在 Agent Guard 后端切换
切换策略时 resetSessions=true，避免旧 session 继续持有旧策略
```

终端实时查看:

```powershell
curl.exe -N http://127.0.0.1:3100/api/v1/openclaw/realtime/events/stream
```

### 8.5.5 OpenClaw 配置示例

OpenClaw 配置中的 MCP server 可以指向 Agent Guard:

```json
{
  "mcp": {
    "servers": {
      "agent_guard": {
        "transport": "streamable-http",
        "url": "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp",
        "timeout": 20,
        "connectTimeout": 5
      }
    }
  }
}
```

如果使用 OpenClaw CLI 的 `/mcp set` 能力，按本机 OpenClaw 版本要求写入等价配置即可。

### 8.5.6 验收

```bash
npm run verify:openclaw:realtime
```

验证脚本覆盖:

- MCP endpoint metadata 可查询。
- `initialize` / `tools/list` 返回正确 JSON-RPC。
- `agent_guard_read_file` 读取 `/secret/.env` 被实时 deny。
- `agent_guard_execute_code` 触发 ask，`demo_approve` 超时兜底后放行。
- `agent_guard_call_api` 的敏感 body 被实时 redact。
- `GET /api/v1/supervision/sessions/:id` 可反查 deny/ask/redact 记录。
- `GET /api/v1/traces/:traceId` 可反查实时 MCP trace。

### 8.5.7 Realtime MCP 工具覆盖边界 (B-P2-4)

P2 实时监督白名单限定为 6 个 canonical toolId：

```txt
tool.read_file
tool.write_file
tool.execute_code
tool.send_email
tool.call_api
tool.send_request
```

映射规则：

```txt
OpenClaw MCP tool name (agent_guard_*) → canonical toolId
agent_guard_read_file    → tool.read_file
agent_guard_write_file   → tool.write_file
agent_guard_execute_code → tool.execute_code
agent_guard_send_email   → tool.send_email
agent_guard_call_api     → tool.call_api
agent_guard_send_request → tool.send_request
```

边界约束：

- 入口同时兼容 `read_file`、`exec`、`bash`、`fetch` 等常见别名，内部统一归一到 `tool.*`。
- 其他 OpenClaw tool name（如 `web_search`、`query_database`、`browser`、`glob` 等）可以 normalize 到 canonical ID 用于 trace 记录，但**不自动进入监督白名单**。
- 新增监督工具必须先更新 `REALTIME_TOOL_IDS` 常量、同步本白名单文档和 `TOOL_NAME_BY_ID` 映射。
- 文档、UI 和报告必须强调"已监督工具列表"，不宣称覆盖所有 OpenClaw 原生工具。

### 8.5.8 OpenClaw Required 验证模式 (B-P2-1)

`verify-p2-api-e2e.ts` 支持 required 模式，用于 OpenClaw 环境的 sign-off：

```bash
# 普通模式：OpenClaw 不可用时 skip（optional）
npm run verify:p2:api-e2e

# Required 模式：OpenClaw 不可用即阻断
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e
```

Required 模式的行为：

- OpenClaw CLI adapter 不可用时抛出错误而非 skip。
- OpenClaw CLI 检测阶段失败时抛出错误而非 skip。
- 当前基线（2026-06-13）：本地 OpenClaw 2026.6.1 (2e08f0f) 环境已通过 required 模式验证。
- 当前项目隔离基线（2026-06-16）：`E:\XinAnProject\openclaw-runtime` 使用 OpenClaw 2026.6.6，默认模型 `deepseek/deepseek-v4-flash`，通过进程内 provider key 映射后，required 模式已通过且 `0 optional skipped`；`DeepSeek_API_2` 只是当时本机示例变量名。

P2 sign-off 必须满足：

```bash
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e  # 全部 required 通过，0 optional skipped
npm run verify:openclaw:realtime                        # OpenClaw realtime MCP 覆盖 deny/ask/redact
```

## 9. 降级策略

```
优先: OpenClaw Realtime MCP supervision (核心实时监督演示)
  ↓ MCP 配置不可用
降级: OpenClaw CLI adapter (真实行为采集 + post-hoc shadow supervision)
  ↓ OpenClaw 不可用
降级: HTTP sample agent adapter (半真实兜底)
  ↓ HTTP agent 不可用
最终: Mock adapter (稳定回归)
```

实现方式：API 层根据 `adapterKind` 选择 adapter。前端 `POST /agents/check` 可查询各 adapter 可用性。

## 10. 文件变更汇总

```
新增 (B-1):
  backend/src/app.ts
  backend/src/server.ts
  backend/src/api/response.ts
  backend/src/api/v1/system/handlers.ts
  backend/src/api/v1/test-runs/handlers.ts
  backend/src/api/v1/supervision/handlers.ts
  backend/src/services/e2eRunService.ts
  backend/src/storage/fileRunStore.ts
  backend/src/storage/fileReportStore.ts

新增 (B-2):
  backend/src/modules/agent/httpAgentAdapter.ts
  backend/src/modules/agent/httpAgentBridge.ts
  backend/src/modules/agent/httpAgentTypes.ts

新增 (B-3):
  backend/src/modules/agent/openclawAdapter.ts
  backend/src/modules/agent/openclawSession.ts
  backend/src/modules/agent/openclawTypes.ts

新增 (B-4):
  backend/src/modules/supervisor/askChannel.ts
  backend/src/api/v1/supervision/ask-handlers.ts

新增 (B-5):
  scripts/verify-p2-api-e2e.ts

新增 (B-6):
  backend/src/modules/openclaw/realtimeMcpServer.ts
  backend/src/api/v1/openclaw/realtime-mcp-handlers.ts
  scripts/verify-openclaw-realtime-mcp.ts

修改:
  package.json                     ← fastify, @fastify/cors 依赖 + scripts
  scripts/sample-agent-server.mjs  ← 对齐新请求/响应契约
  backend/src/modules/agent/index.ts ← 导出新 adapter
```

## 11. 技术选型

| 选择 | 理由 |
|------|------|
| Fastify 5 | 比赛要求；70k+ req/s；TypeBox schema 校验；mcollina/skills 最佳实践 |
| App Factory 模式 | 测试友好；`app.inject()` 不需要真实 HTTP |
| TypeBox (可选) | 编译时类型 + 运行时校验，一个声明两用 |
| Pino (Fastify 内置) | 结构化日志，pino-pretty 仅 dev |
| SSE (Server-Sent Events) | ask 通道单向推送，比 WebSocket 简单，够用 |
| 文件存储 (JSON) | P2 不引入数据库；RunIndex/ReportIndex 用 JSON 文件维护 |

## 12. 风险控制

| 风险 | 控制 |
|------|------|
| OpenClaw 协议变更 | adapter shim 隔离，不污染 contracts |
| HTTP agent 不稳定 | mock adapter 始终作为最终兜底 |
| ask 通道未接入前端 | 超时兜底 + 环境变量可切换 demo_approve |
| API 层写业务逻辑 | API 只调 service，service 只编排 modules |
| 运行历史文件不一致 | verify-p2-api-e2e 检查所有 ID 引用链 |

## 13. 验收标准

P2 B 线完成时：

- [ ] `npm run verify:all` 仍通过
- [ ] `npm run verify:e2e` 仍通过
- [x] Fastify API 启动并返回 `GET /system/status` ok
- [x] `POST /test-runs/e2e` 用 mock adapter 跑通全链路
- [x] `POST /test-runs/e2e` 用 http_sample adapter 跑通，trace 来自真实 HTTP agent
- [x] `POST /test-runs/e2e` 用 openclaw adapter 跑通，trace 来自真实 OpenClaw
- [x] `GET /test-runs` 和 `GET /test-runs/:id` 返回正确数据
- [x] `GET /supervision/sessions/:id` 返回真实监督记录
- [x] ask 动作触发 SSE 推送，超时有兜底
- [x] `POST /api/v1/openclaw/realtime/mcp` 支持 OpenClaw MCP 实时监督
- [x] `npm run verify:openclaw:realtime` 通过，覆盖 deny/ask/redact 实时记录
- [x] defense report 可经 API 查询，blockedActions 可追溯
- [x] `npm run verify:p2:api-e2e` 全部通过
- [x] `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 在项目隔离 OpenClaw runtime 通过
- [ ] OpenClaw 不可用时自动降级到 http_sample，再降级到 mock
