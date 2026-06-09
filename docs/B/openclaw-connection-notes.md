# OpenClaw 接入协议调研与连接方案

文档版本: b3-connection-2
基线日期: 2026-06-09
状态: 已实测 → B-3 方案修订

## 1. 实测环境

| 项目 | 实测值 |
|------|--------|
| OpenClaw 版本 | `2026.6.1 (2e08f0f)` |
| CLI 路径 | `/c/Users/Alienware/AppData/Roaming/npm/openclaw` |
| Workspace | `C:\Users\Alienware\.openclaw\workspace` |
| Gateway 端口 | `18789` (loopback, auth: token) |
| Gateway 协议 | **WebSocket** (端口 18789) + HTML 控制面板 |
| Agent 模型 | `deepseek/deepseek-v4-flash` |
| Agent harness | `openclaw` (native, sandbox.mode: off) |

## 2. 实测发现

### 2.1 OpenClaw 没有传统 REST API

之前文档上的 `POST /api/sessions` 等 REST 端点在实际版本中**不存在**。Gateway 端口 18789 提供的是：
- WebSocket (`/ws`) — 主要通信协议
- HTML 控制面板 (`/status`, `/v1/*`) — SPA 前端路由，不是 JSON API
- `/health` — 返回 200，仅存活检测

### 2.2 正确用法: `openclaw agent` CLI

```bash
openclaw agent \
  --session-key "agent:main:my-test" \
  --message "任务文本" \
  --json \
  --timeout 30
```

返回 JSON：

```json
{
  "runId": "8ef9f939-...",
  "status": "ok",
  "summary": "completed",
  "result": {
    "payloads": [{ "text": "agent response...", "mediaUrl": null }],
    "meta": {
      "durationMs": 30554,
      "agentMeta": {
        "sessionId": "1255e55f-...",
        "sessionFile": "C:\\Users\\...\\1255e55f-....jsonl",
        "provider": "deepseek",
        "model": "deepseek-v4-flash",
        "contextTokens": 1000000,
        "usage": { "input": 15197, "output": 816, "total": 17613 },
        "sandbox": { "mode": "off" }
      }
    }
  }
}
```

### 2.3 Session JSONL 格式（关键）✅ 4.1 已实测

每个 session 对应一个 `.jsonl` 文件，每行是一个事件。**工具调用事件格式**：

```jsonl
{"type":"message","id":"f0ebe75b","parentId":"...","timestamp":"...","message":{"role":"assistant","content":[
  {"type":"thinking","thinking":"Let me read the file...","thinkingSignature":"reasoning_content"},
  {"type":"toolCall",
   "id":"call_00_iNi664U83qcit8g5DPYA6385",
   "name":"read",
   "arguments":{"path":"/c/Users/.../TOOLS.md"}
  }
]}}

{"type":"message","id":"12460230","parentId":"f0ebe75b","timestamp":"...","message":{
  "role":"toolResult",
  "toolCallId":"call_00_iNi664U83qcit8g5DPYA6385",
  "toolName":"read",
  "content":[{"type":"text","text":"文件内容..."}],
  "details":{"status":"failed"},
  "isError":false
}}
```

**提取到的字段**：

| JSONL 字段 | Agent Guard 映射 | 实测值示例 |
|-----------|-----------------|-----------|
| `message.content[].type` = `"toolCall"` | 工具调用事件 | ✅ |
| `message.content[].id` | `callId` | `"call_00_iNi664..."` ✅ |
| `message.content[].name` | `toolId` / `toolName` | `"read"`, `"exec"`, `"write"` ✅ |
| `message.content[].arguments` | `parameters` | `{"path":"..."}` ✅ |
| `message.role` = `"toolResult"` | 工具返回 | ✅ |
| `message.toolCallId` | 关联 callId | ✅ |
| `message.isError` | 工具执行是否出错 | `true`/`false` ✅ |
| `message.content[].text` | 工具返回内容 | ✅ |

**OpenClaw 原生工具列表**（从 session JSONL 提取）：
`read`, `exec`, `write`, `process`, `browser`, `web_search`, `message`

### 2.4 MCP 支持

OpenClaw 原生支持 `openclaw mcp add` 连接外部 MCP Server。当前配置：
- `mcp: none` — 未配置外部 MCP 服务器
- `plugins: { deepseek: { enabled: true } }` — 仅 deepseek provider 插件

### 2.5 关键约束

- OpenClaw 工具调用 (`read`, `exec`, `write` 等) 是**原生执行**的，不经 MCP/plugin
- Agent 运行在 `sandbox.mode: "off"` 模式下，有直接系统访问权限
- `openclaw agent` CLI 是**同步阻塞**的——返回时 Agent 已完成所有工具调用
- 没有在 CLI 层面提供实时 tool_call 事件流（`--raw-stream` 仅在 Gateway 进程级别）

---

## 3. B-3 方案修订

### 3.1 约束分析

| 需求 | 可行性 | 说明 |
|------|--------|------|
| 不改 OpenClaw 代码 | ✅ | 只用 CLI + JSONL |
| 不装 OpenClaw 插件 | ✅ | 同上 |
| 不改 OpenClaw 配置 | ✅ | 同上 |
| 工具调用实时拦截 | ❌ | CLI 是同步阻塞的；实时拦截需要 Gateway RPC 或 MCP proxy，两者均需配置变更 |
| 工具调用事后提取 | ✅ | 解析 session JSONL |
| 产生 trace events | ✅ | 从 JSONL tool_call 构造 |
| 监督策略影子分析 | ✅ | 对提取的 tool_call 跑 sandbox + supervision，记录"本应阻断" |

### 3.2 修订方案: Post-Hoc Shadow Supervision

```
Agent Guard adapter:
  1. spawn("openclaw", ["agent", "--session-key", key, "--message", task, "--json", "--timeout", "60"])
  2. 等待 CLI 返回 → 解析 JSON → 获取 sessionFile 路径
  3. 读取 session JSONL → 逐行解析
  4. 对每个 tool_call 事件:
     a. 记录为 trace event (type: "tool_call", payload: {toolId, parameters, callId})
     b. 通过 Agent Guard sandbox 影子执行 (相同的参数，相同的 sandbox)
     c. 通过 SupervisionBridge 判定 → allow/deny/ask/redact
     d. 记录 shadow supervision record
  5. 构建 InteractionTrace + RuntimeSupervisionRecord[]
  6. → RiskReport → DetectionReport → ... → DefenseReport
```

### 3.3 与原始目标的差异

| 原始目标 | B-3 实际能力 | 差距 |
|---------|-------------|------|
| "工具调用进入 SupervisionBridge" | 事后影子分析——用相同参数跑 sandbox+supervision | 不能实时阻断 |
| "allow/deny/ask/redact" | 记录"本应 deny/redact" | 不能实际改变 OpenClaw 行为 |

这个差距是**诚实的架构限制**，应在 DefenseReport 和答辩中明确表述：

> "P2 阶段 Agent Guard 通过 OpenClaw session JSONL 提取真实工具调用事件，在 Agent Guard sandbox 中影子重放并应用监督策略，证明检测到的高风险行为在监督策略下本应被阻断/脱敏。P3 阶段将通过 OpenClaw MCP Proxy 或 Interceptor Plugin 实现实时拦截。"

### 3.4 备选实时方案（P3 增强）

两个可行的实时拦截路径，均需 OpenClaw 配置变更：

**方案 A: MCP Proxy**
```bash
openclaw mcp add agent-guard --transport http --url http://localhost:3100/mcp
```
Agent Guard 注册为 MCP Server，OpenClaw 的 MCP 工具调用经 Agent Guard sandbox + supervision。

**方案 B: Gateway RPC**
```bash
openclaw gateway rpc sessions.send --session-key "..." --message "..."
```
直接使用 Gateway RPC 方法，实时接收 tool_call 事件并回传 tool_result。

两个方案均保留到 P3，不在 B-3 实现。

---

## 4. B-3 实现范围（修订后）

### 4.1 新增文件

```
backend/src/modules/agent/openclawAdapter.ts   ← OpenClaw CLI adapter (AgentAdapter 实现)
backend/src/modules/agent/openclawSession.ts   ← CLI spawn + JSONL 解析 + shadow supervision
backend/src/modules/agent/openclawTypes.ts     ← OpenClaw JSONL 事件类型（不入 contracts）
```

### 4.2 openclawSession 核心流程

```typescript
class OpenClawSession implements AgentSession {
  constructor(
    agent, config,
    private openclaw: {
      cliPath: string;        // 默认 "openclaw"，可 env/config 覆盖
      gatewayUrl?: string;    // http://localhost:18789，可配置
      timeoutMs: number;      // 默认 60_000
      workspacePath?: string; // C:\Users\Alienware\.openclaw\workspace
    }
  ) {}

  async sendTask(task, bridge, runMeta): Promise<AgentRunResult> {
    const sessionKey = `agent:main:agent-guard-${runMeta.runId}`;

    // 1. 执行 openclaw agent
    const { runId, sessionFile } = await this.spawnAgent(sessionKey, task);

    // 2. 解析 session JSONL
    const events = await this.parseSessionJsonl(sessionFile);

    // 3. 对每个 tool_call 做 shadow supervision
    for (const tc of events.toolCalls) {
      // 记录 trace event
      // 影子执行: bridge.handleToolCall({toolId: tc.name, parameters: tc.arguments})
      // → sandbox 模拟执行 → supervision 判定 → 记录 shadow record
    }

    // 4. 返回结果
    return { status: "completed", finalMessage: events.finalAnswer, ... };
  }
}
```

### 4.3 环境变量/配置覆盖

```typescript
const OPENCLAW_CLI = process.env.OPENCLAW_CLI ?? "openclaw";
const OPENCLAW_GATEWAY = process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";
const OPENCLAW_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 60_000);
```

### 4.4 验收标准

```bash
# 1. GET /system/status 报告 openclawAdapter: true (仅当 CLI 可用)
openclaw --version  # 返回 2026.6.1 → adapter available

# 2. POST /test-runs/e2e (openclaw)
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

# 预期:
#   traceIds > 0 (trace 来自 OpenClaw session JSONL 的真实 tool_call)
#   runtimeSessionIds > 0
#   supervision records 包含 shadow 监督判定
#   defenseReport 可追溯
#   defenseReport 中注明 "post-hoc shadow supervision" 模式

# 3. OpenClaw CLI 不可用时
#    GET /system/status → openclawAdapter: false
#    POST /test-runs/e2e (openclaw) → 400 NOT_YET_SUPPORTED 或 503
#    前端自动降级到 http_sample → mock
```

---

## 5. 确认清单（已回复）

- [x] **3.1** OpenClaw 本地路径: `C:\Users\Alienware\.openclaw\workspace`（B 线只读参考，不改）
- [x] **3.2** 连接方式: `external_running`，endpoint 默认 `http://localhost:18789`，代码支持 env/config 覆盖
- [x] **3.3** 任务输入: 结构化 context 转换，逻辑在 `openclawBridge.ts`，不入 contracts
- [x] **4** 拦截方案: B-3 先用 CLI + Session JSONL Post-Hoc Shadow Supervision；Interceptor Plugin / MCP Proxy 保留 P3
- [x] **4.1** 实测完成：session JSONL 格式已确认（见第 2.3 节），tool_call 字段完整可用

---

## 6. 修订确认

B-3 从原方案的 "Gateway REST API Session Polling（实时拦截）" 修订为 **"CLI + Session JSONL Post-Hoc Shadow Supervision（事后影子监督）"**。

修订原因：
1. 实测确认 OpenClaw 没有传统 REST API，主要协议是 WebSocket
2. `openclaw agent --json` CLI 是稳定、可脚本化的接口
3. Session JSONL 包含完整的 tool_call 事件（id/name/arguments/result 齐全）
4. 实时拦截需要 Gateway RPC 或 MCP proxy，均需配置变更，保留 P3

修订后的方案仍然满足 P2 核心目标：
- ✅ 产生来自真实 OpenClaw 的 trace events（不是 mock）
- ✅ 监督策略对真实 OpenClaw 行为做出判定（shadow supervision）
- ✅ 证明检测→策略→防御的闭环（DefenseReport 基于真实数据）
- ✅ 不改 OpenClaw、不装插件、不配 MCP
