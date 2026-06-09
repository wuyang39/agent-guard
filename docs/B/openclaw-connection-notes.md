# OpenClaw 接入协议调研与连接方案

文档版本: b3-connection-1
基线日期: 2026-06-09
状态: 待确认 → 确认后进入 B-3 实现

## 1. OpenClaw 关键事实

### 1.1 项目概况

- 仓库: [openclaw/openclaw](https://github.com/openclaw/openclaw) (300k+ stars)
- 语言: TypeScript/Node.js
- 核心进程: **Gateway** (默认端口 `18789`)
- 协议: REST API + WebSocket + MCP (双向)

### 1.2 与 Agent Guard 相关的 Gateway API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/status` | GET | 健康检查 |
| `/api/sessions` | POST | 创建隔离 session |
| `/api/sessions/:key/messages` | POST | 向 session 发送消息（任务） |
| `/api/sessions/:key/history` | GET | 读取 session 完整历史（含 tool_call 事件） |
| `/tools/invoke` | POST | 直接调用工具（经过完整 policy 管线） |

### 1.3 Interceptor Pipeline（PR #6569，已合入）

```txt
message.before → params.before → tool.before → [tool execute] → tool.after
```

- `tool.before`: 接收 tool call，可返回 `block: true`（deny）、`allow`、`requireApproval`（ask）、或修改参数
- 优先级: deny > allow；高优先级先执行
- 内置 security-audit：阻止读 `.ssh`/`.env`/API key
- 第三方插件可注册自定义 interceptor

### 1.4 MCP 集成

OpenClaw 双向支持 MCP：
- **作为 MCP Client**: 连接外部 MCP Server，通过 `mcp-bridge` 插件将 MCP tool 注册为 agent tool
- **作为 MCP Server**: `openclaw mcp serve` 将 Gateway 会话暴露为 MCP tool

---

## 2. B-3 接入方案：两步走

### 2.1 推荐主方案 —— Gateway REST API + Session Polling（P2 实现）

**不写 OpenClaw 插件，不改 OpenClaw 源码，不要求 OpenClaw 安装任何东西。**

Agent Guard 通过 OpenClaw Gateway REST API 控制一个 session 的生命周期：

```txt
Agent Guard (adapter)
  │
  ├─ 1. POST /api/sessions          → 创建隔离 session，获得 sessionKey
  ├─ 2. POST /api/sessions/:key/messages
  │      body: { message: <AgentTaskEnvelope 转换的任务文本> }
  │      → OpenClaw 开始 ReAct loop，可能产生 tool_call
  │
  ├─ 3. GET /api/sessions/:key/history  (轮询或长轮询)
  │      → 解析 events[] 中的 tool_call 事件
  │
  ├─ 4. 对每个 tool_call:
  │      → 构造 ToolCallRequest → Agent Guard sandbox (模拟执行)
  │      → SupervisionBridge.preCheck() → allow/deny/ask/redact
  │      → 返回 tool_result
  │
  ├─ 5. POST /api/sessions/:key/messages
  │      body: { toolResults: [...] }  ← 将监督后的结果回传 OpenClaw
  │      → OpenClaw 继续 ReAct loop
  │
  └─ 6. 重复 3-5 直到 OpenClaw 返回 final answer
       → 采集所有 tool_call / resource_access → InteractionTrace
```

### 2.2 备选方案 —— Interceptor Plugin（P3 增强）

如果后续需要真正的**实时**拦截（不等轮询），可以写一个最小 OpenClaw 插件：

```typescript
// openclaw-guard-plugin (安装到 OpenClaw)
registerInterceptor({
  name: "agent-guard-supervision",
  priority: 100, // 高于内置 security-audit
  toolMatcher: /.*/, // 拦截所有工具
  "tool.before": async (ctx) => {
    const decision = await fetch("http://localhost:3100/api/v1/supervision/check", {
      method: "POST",
      body: JSON.stringify({ toolId: ctx.toolId, parameters: ctx.parameters }),
    });
    if (decision.action === "deny") return { block: true, reason: decision.reason };
    if (decision.action === "ask") return { requireApproval: true };
    return { allow: true };
  },
});
```

P2 不走这条路——需要 OpenClaw 安装插件 + 网络可达，增加答辩环境依赖。

---

## 3. 待你确认的 3 个前提

### 3.1 本地仓库路径

```
OpenClaw 本地路径: ____________________ (例如 E:\openclaw)
```

B 线只需要知道它的存在，用于参考其 API 格式和测试连接。不会直接改 OpenClaw 代码。

### 3.2 已运行实例连接方式

```
推荐: external_running + Gateway REST API
Gateway 地址: http://localhost:18789
```

Agent Guard 不负责 `openclaw gateway start`。答辩/开发环境提前启动 OpenClaw Gateway，B 线 adapter 通过 HTTP 连接。

如果答辩环境不能启动 OpenClaw，B-3 退化为 "API 已就绪但 openclaw adapter 标记为 unavailable"，由 `GET /system/status` 反映，前端走 http_sample → mock 降级链。

### 3.3 任务输入格式映射

Agent Guard `AgentTaskEnvelope` → OpenClaw message 的最小转换：

```typescript
// Agent Guard 内部结构（不入 contracts）
type AgentTaskEnvelope = {
  agentId: string;
  sessionId: string;
  systemPrompt?: string;
  userMessage: string;
  tools: { toolId: string; description: string }[];
  resources: { resourceId: string; description: string }[];
  metadata?: Record<string, unknown>;
};

// → OpenClaw message 文本
function toOpenClawMessage(env: AgentTaskEnvelope): string {
  return [
    env.systemPrompt,
    "",
    "## Task",
    env.userMessage,
    "",
    "## Available Tools",
    ...env.tools.map(t => `- ${t.toolId}: ${t.description}`),
    "",
    "## Available Resources",
    ...env.resources.map(r => `- ${r.resourceId}: ${r.description}`),
  ].join("\n");
}
```

更结构化的方式（如果 OpenClaw 支持 structured content）：

```json
POST /api/sessions/:key/messages
{
  "message": "<任务文本>",
  "context": {
    "availableTools": [...],
    "availableResources": [...]
  }
}
```

**你确认用哪种？纯文本拼接先跑通，还是需要结构化 context？**

---

## 4. 工具调用拦截方案

### 选型对比

| 方案 | 实时性 | 侵入性 | 复杂度 | P2 推荐 |
|------|--------|--------|--------|:---:|
| Gateway API session polling | 轮询延迟 (~2s) | 零侵入 | 低 | ✅ |
| Interceptor Plugin | 实时 (~0ms) | 需安装插件 | 中 | P3 |
| MCP Proxy | 实时 | 需配 OpenClaw MCP server | 高 | P3 |

### P2 选 Session Polling 的理由

1. **零侵入**: 不改 OpenClaw，不加插件。OpenClaw 不知道 Agent Guard 存在。
2. **协议稳定**: Gateway REST API 是 OpenClaw 的公开接口，不依赖未合入的 PR。
3. **兼容降级**: 如果 Gateway API 不可用，adapter 返回清晰错误 → 前端降级到 http_sample。
4. **满足 P2 验收**: 能证明 "OpenClaw 的工具调用进入了 Agent Guard 的 sandbox + supervision"。

轮询延迟在答辩演示场景可接受——Agent Guard 本身就是安全评测工具，不是生产流量网关。

### OpenClaw History 中的 tool_call 事件格式（待实测确认）

```typescript
// 预期格式（基于 OpenClaw session history JSONL）
type OpenClawHistoryEvent = {
  type: "message" | "tool_call" | "tool_result" | "status";
  timestamp: string;
  // tool_call:
  toolId?: string;
  toolName?: string;
  parameters?: Record<string, unknown>;
  callId?: string;
  // tool_result:
  result?: unknown;
  // message:
  content?: string;
  role?: "user" | "assistant" | "tool";
};
```

**需要你确认**: 在本地 OpenClaw 跑一次 `POST /api/sessions/test/messages` 然后 `GET /api/sessions/test/history`，把返回的 JSON 样例贴过来，B 线据此实现精确解析。

---

## 5. B-3 实现范围（确认后）

### 新增文件

```
backend/src/modules/agent/openclawAdapter.ts   ← OpenClaw Gateway REST 适配器
backend/src/modules/agent/openclawTypes.ts     ← OpenClaw 私有类型（History/Event）
backend/src/modules/agent/openclawSession.ts   ← Session polling + tool interception loop
```

### openclawAdapter 核心流程

```typescript
class OpenClawSession implements AgentSession {
  async sendTask(task, bridge, runMeta): Promise<AgentRunResult> {
    // 1. POST /api/sessions → sessionKey
    // 2. POST /api/sessions/:key/messages → 发送任务
    // 3. loop:
    //    a. GET /api/sessions/:key/history → events[]
    //    b. 对于每个新 tool_call:
    //       - bridge.handleToolCall() → sandbox + supervision
    //       - 收集 supervisionRecords
    //    c. 如果有 tool_results，回传给 OpenClaw
    //    d. 如果收到 final answer，退出 loop
    // 4. 返回 AgentRunResult
  }
}
```

### 验收标准

```bash
# OpenClaw Gateway 已启动在 localhost:18789

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
#   traceIds > 0 (trace 来自真实 OpenClaw session history)
#   runtimeSessionIds > 0
#   supervision records 包含 OpenClaw 工具调用的 deny/ask 判定
#   defenseReport 可追溯
```

---

## 6. 确认清单

请逐项回复：

- [ ] **3.1** OpenClaw 本地路径: `___________`
- [ ] **3.2** 连接方式: `external_running` @ `http://localhost:18789`（或其他地址）
- [ ] **3.3** 任务输入: 纯文本拼接先跑通 / 需要结构化 context（二选一）
- [ ] **4** 工具调用拦截: Session Polling（推荐）/ Interceptor Plugin / 其他
- [ ] **4.1** 贴一份 `GET /api/sessions/:key/history` 的真实 JSON 样例

确认后我开始写 B-3 代码。
