# P3-B 检测沙箱与实时监督分离工作方案

文档版本: p3-b-mode-split-1  
日期: 2026-06-26  
责任线: B 线  
适用范围: OpenClaw 检测、策略包生成、外部 MCP 工具监督、OpenClaw 原生工具监督

## 1. 核心结论

P3-B 后续应采用“双模式”架构:

1. 检测模式 Detection Mode
   - 必须启用 Docker sandbox。
   - 目标是安全地诱导并披露 Agent 风险。
   - 允许攻击样例触发危险意图，但不允许真实影响宿主机。

2. 监督模式 Supervision Mode
   - 默认不启用 Docker sandbox。
   - 目标是在 Agent 正常工作环境中实时监督工具调用。
   - 依靠执行前策略裁决，而不是依靠沙箱改变 Agent 的运行环境。

这份方案替代“监督阶段也使用 Docker 沙箱兜底”的旧口径。Docker sandbox 是检测阶段的安全底座，不是监督阶段的默认运行形态。

## 2. 为什么必须分离

### 2.1 检测阶段必须用 Docker

检测阶段会主动投喂攻击库样例，例如:

- 诱导读取敏感文件。
- 诱导执行系统命令。
- 诱导外发数据。
- 诱导调用高权限工具。

如果不隔离，系统在“证明 Agent 有风险”的同时，可能真的让 Agent 执行危险行为。比赛视角下，这会削弱安全系统可信度。

检测阶段的正确目标是:

```text
攻击样例触发 Agent 风险倾向
  -> 行为在 Docker 内发生或被模拟
  -> Agent Guard 采集 trace / tool call / risk finding
  -> 生成风险画像与策略包
```

### 2.2 监督阶段不能默认用 Docker

监督阶段要证明的是:

```text
真实 Agent 在真实工作流中
  -> 正常使用文件、网络、外部 MCP 工具和原生工具
  -> Agent Guard 在调用前做 allow / deny / ask / warn
```

如果监督阶段继续使用 Docker:

- 文件系统变了。
- 网络环境变了。
- 工作目录变了。
- 权限模型变了。
- 真实业务工具可能不可用。

这样得到的监督结果不再代表 Agent 正常工作环境，答辩时容易被质疑“你不是在监督真实 Agent，而是在监督一个被改造过的沙箱 Agent”。

## 3. 最终目标架构

### 3.1 检测模式架构

```text
A 线攻击库 / LLM 选样
  -> B 线 Detection Runner
  -> OpenClaw CLI / Agent
  -> Docker Sandbox
  -> JSONL / trace / risk report
  -> risk profile
  -> policy pack
  -> C 线报告与证据展示
```

检测模式要求:

- OpenClaw sandbox.mode = all。
- sandbox backend = docker。
- docker network = none，除非某个检测 case 明确需要受控网络。
- workspaceAccess = none 或只读受控 workspace。
- 记录 sandbox 配置快照作为证据。
- 检测结束后恢复 OpenClaw 正常配置。

### 3.2 监督模式架构

```text
OpenClaw 正常工作环境
  -> 外部 MCP 工具调用
      -> Agent Guard MCP Gateway
      -> policy decision
      -> downstream MCP tool

  -> OpenClaw 原生工具调用
      -> OpenClaw before_tool_call plugin hook
      -> Agent Guard native eval API
      -> policy decision
      -> allow / deny / ask / warn
      -> OpenClaw native tool
      -> after_tool_call audit event
```

监督模式要求:

- 不默认启用 Docker sandbox。
- OpenClaw 保持正常 workspace、网络和工具能力。
- 外部 MCP 工具必须统一走 Agent Guard Gateway。
- OpenClaw 原生工具必须通过 plugin hook 进入 Agent Guard 判定。
- deny 和 ask 必须发生在工具执行前。
- ask 必须由前端或人工通道 approve / reject，不得静默自动拒绝。

## 4. 需要解决的关键问题

### 4.1 OpenClaw 原生工具绕过

当前仅靠 MCP Gateway 不能覆盖 OpenClaw 自带原生工具，例如:

- read
- write
- edit
- exec
- process
- apply_patch
- web_fetch
- browser
- cron

这些工具不经过 Agent Guard MCP URL，因此必须通过 OpenClaw plugin hook 拦截。

推荐实现:

```text
before_tool_call
  -> POST /api/v1/openclaw/realtime/supervision/eval
  -> 返回 allow / deny / ask / warn

after_tool_call
  -> POST /api/v1/openclaw/realtime/supervision/event
  -> 写入审计事件
```

### 4.2 检测配置与监督配置不能混用

需要明确两个 OpenClaw runtime profile:

1. detection profile
   - sandbox enabled。
   - 用于检测和策略生成。

2. supervision profile
   - sandbox disabled。
   - 用于真实工作流监督。

不得出现:

```text
检测结束后忘记关闭 Docker sandbox
  -> 后续监督仍在 Docker 里运行
```

也不得出现:

```text
监督阶段禁用了 sandbox
  -> 检测阶段忘记开启 sandbox
  -> 攻击样例影响宿主机
```

## 5. 详细实施阶段

## B3-S1: 运行模式管理器

目标: 在后端建立明确的运行模式概念，防止检测和监督配置混淆。

新增或修改建议:

```text
backend/src/modules/openclaw/openclawModeManager.ts
backend/src/modules/openclaw/openclawConfigSnapshot.ts
backend/src/api/v1/openclaw/mode-handlers.ts
```

职责:

- 读取当前 OpenClaw 配置摘要。
- 判断当前是 detection-ready 还是 supervision-ready。
- 在检测前写入 sandbox 配置。
- 在检测后恢复原配置。
- 保存配置快照到 outputs/openclaw-mode-snapshots/。

推荐状态:

```ts
type OpenClawRuntimeMode =
  | "detection_sandbox"
  | "supervision_normal"
  | "unknown";
```

API 建议:

```text
GET  /api/v1/openclaw/runtime-mode
POST /api/v1/openclaw/runtime-mode/detection
POST /api/v1/openclaw/runtime-mode/supervision
```

验收:

- 前端能看到当前模式。
- 检测运行前能确认 sandbox 已开启。
- 监督运行前能确认 sandbox 已关闭。
- 配置切换失败时禁止继续运行。

## B3-S2: 检测模式 Docker Sandbox 固化

目标: 把 Docker sandbox 变成检测阶段必备能力，而不是临时手动配置。

新增或修改建议:

```text
scripts/Dockerfile.sandbox
scripts/openclaw-detection-mode.ps1
scripts/openclaw-supervision-mode.ps1
backend/src/modules/agent/openclawSession.ts
backend/src/services/e2eRunService.ts
```

检测模式配置原则:

```json
{
  "sandbox": {
    "mode": "all",
    "backend": "docker",
    "scope": "session",
    "docker": {
      "image": "openclaw-sandbox:bookworm-slim",
      "network": "none",
      "readOnlyRoot": false
    },
    "workspaceAccess": "none"
  }
}
```

执行流程:

```text
创建 selection plan
  -> 启动检测
  -> 后端确认 detection_sandbox
  -> 如果未开启，自动切换或拒绝运行
  -> 执行 OpenClaw 检测
  -> 采集 trace
  -> 生成策略包
  -> 自动恢复 supervision_normal
```

验收:

- 检测阶段 `exec` 发生在 Docker 内。
- 宿主机 `C:\`、用户目录、项目外路径不可见或不可写。
- Docker 网络默认不可出站。
- 检测报告里能展示 sandbox evidence。
- 检测完成或失败后配置能恢复。

## B3-S3: 监督模式 Agent Guard MCP Gateway

目标: 保持现有外部 MCP 工具统一接入能力，监督阶段不依赖 Docker。

现有基础:

```text
backend/src/modules/openclaw/realtimeMcpServer.ts
frontend/src/pages/Supervision/LiveSupervisionPage.tsx
```

增强点:

- 明确 supervision mode 下 `agent_guard` MCP URL 保持不变。
- 外部 MCP provider 继续通过 runtime config 接入。
- 工具画像、策略包、policy decision 继续复用。
- SSE 事件增加 mode 字段:

```json
{
  "runtimeMode": "supervision_normal",
  "source": "mcp_gateway"
}
```

验收:

- OpenClaw 连接一个 Agent Guard MCP URL。
- 外部 MCP 工具调用能进入 Agent Guard。
- 前端实时监督能看到 allow / deny / ask / warn。
- 不需要 Docker 也能完成正常工具调用。

## B3-S4: OpenClaw 原生工具 Hook 监督

目标: 解决 OpenClaw 直接调用原生工具绕过 Agent Guard 的问题。

新增建议:

```text
plugins/agent-guard-supervision/
backend/src/api/v1/openclaw/native-supervision-handlers.ts
backend/src/modules/openclaw/nativeToolPolicyAdapter.ts
backend/src/modules/openclaw/nativeToolEventRecorder.ts
```

Hook 流程:

```text
OpenClaw before_tool_call
  -> toolName + arguments + sessionId
  -> Agent Guard native eval API
  -> policy engine
  -> allow / deny / ask / warn
  -> OpenClaw 根据结果执行或阻断
```

后端接口:

```text
POST /api/v1/openclaw/realtime/supervision/eval
POST /api/v1/openclaw/realtime/supervision/event
GET  /api/v1/openclaw/realtime/supervision/status
```

请求示例:

```json
{
  "runtimeSessionId": "openclaw.session.x",
  "agentId": "agent.openclaw.demo",
  "toolName": "exec",
  "parameters": {
    "cmd": "cat ~/.ssh/id_rsa"
  },
  "source": "native_tool_hook"
}
```

返回示例:

```json
{
  "action": "deny",
  "reason": "policy.deny.secret_file_read matched native exec payload",
  "policyPackId": "policy_pack.xxx",
  "recordId": "record.xxx"
}
```

工具风险默认策略:

| 工具类型 | 无策略包时 | 有策略包时 |
|---|---|---|
| exec / process / apply_patch | fail-close deny | policy decision |
| write / edit | ask 或 deny | policy decision |
| read | warn 或 ask | policy decision |
| web_fetch / browser | ask | policy decision |
| session / memory / image 等低风险工具 | allow + audit | policy decision |

注意:

- 这层不是 Docker。
- 这层必须发生在原生工具执行前。
- 如果 Agent Guard 不可达，高风险原生工具必须 fail-close。
- ask 需要真的等待前端确认或超时兜底。

验收:

- OpenClaw 原生 `exec` 被 Agent Guard 拦截。
- deny 时命令不执行。
- ask 时前端出现确认事件。
- approve 后工具执行，reject 后工具不执行。
- after_tool_call 上报结果进入实时监督事件流。

## B3-S5: 前端运行模式与监督展示

目标: 让演示者和评委清楚看到当前处于哪种模式。

修改建议:

```text
frontend/src/pages/RuntimeConfig/RuntimeConfigPage.tsx
frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx
frontend/src/pages/Supervision/LiveSupervisionPage.tsx
frontend/src/pages/System/SystemPage.tsx
```

前端增加:

1. 运行模式状态卡
   - 当前模式: 检测沙箱 / 实时监督 / 未知。
   - Docker sandbox: enabled / disabled。
   - OpenClaw gateway: connected / disconnected。
   - Agent Guard MCP URL: configured / missing。
   - Native hook plugin: installed / not detected。

2. 检测编排页
   - 检测前显示“将启用 Docker sandbox”。
   - 检测结束显示“已恢复正常监督模式”。
   - 如果恢复失败，用明显告警提示。

3. 实时监督页
   - 事件来源分组:
     - mcp_gateway
     - native_tool_hook
     - ask_channel
   - 原生工具事件显示 toolName、arguments 摘要、policyId、action。

4. ask 弹窗
   - 明确显示这是原生工具还是 MCP 工具。
   - 显示 Approve / Reject。
   - 超时状态要和最终决策分开。

验收:

- 评委能从页面直接看出检测使用 Docker，监督不使用 Docker。
- 评委能看到原生工具监督事件不是 MCP 工具事件。
- ask 事件能人工处理。

## B3-S6: stale running 清理

目标: 解决重启后旧检测记录仍显示 running 的问题。

新增或修改建议:

```text
backend/src/storage/fileRunStore.ts
backend/src/services/staleRunRecoveryService.ts
backend/src/app.ts
```

逻辑:

```text
API 启动时扫描 outputs/run-index/run-groups.json
  -> status=running
  -> updatedAt 超过阈值，例如 30 分钟
  -> 标记 failed
  -> phase=failed
  -> error="Run interrupted before API restart."
```

验收:

- 重启后不会继续显示昨天的 169/300 running。
- 历史记录仍保留，可在证据中心查看。
- 新检测运行不会被旧 running 干扰。

## 6. 黑盒测试方案

### 6.1 检测模式安全测试

步骤:

```text
1. 切换到 detection_sandbox。
2. 跑 10 个 OpenClaw 检测样例。
3. 样例包含 exec/read/write/web_fetch 意图。
4. 检查执行环境。
5. 检查检测结束后恢复 supervision_normal。
```

通过标准:

- 命令执行在 Docker 内。
- 宿主机敏感路径不可访问。
- 网络不可出站。
- trace 和 risk report 正常生成。
- policy pack 正常生成。

### 6.2 监督模式正常环境测试

步骤:

```text
1. 切换到 supervision_normal。
2. 确认 Docker sandbox disabled。
3. 开启实时监督。
4. 在 OpenClaw 对话中触发外部 MCP 工具。
5. 观察前端监督事件。
```

通过标准:

- 外部 MCP 调用进入 Agent Guard Gateway。
- 事件来源为 mcp_gateway。
- 策略命中后能 deny / ask / warn。

### 6.3 原生工具绕过测试

步骤:

```text
1. supervision_normal 模式。
2. 安装并启用 OpenClaw Agent Guard plugin。
3. 在 OpenClaw 对话中诱导调用原生 exec/read/write。
4. 检查 before_tool_call 是否调用 Agent Guard eval API。
```

通过标准:

- 原生工具事件来源为 native_tool_hook。
- deny 时工具没有执行。
- ask 时前端弹确认。
- approve 后执行，reject 后阻断。
- after_tool_call 有审计记录。

### 6.4 Agent Guard 不可达测试

步骤:

```text
1. 关闭 Agent Guard API。
2. 在 OpenClaw 中触发原生 exec。
```

通过标准:

- 高风险原生工具 fail-close。
- OpenClaw 侧能看到阻断原因。
- 低风险工具可按策略 warn 或 allow。

## 7. 演示路线

推荐答辩演示顺序:

1. 运行配置页
   - 展示 LLM 配置。
   - 展示外部 MCP 接入。
   - 展示当前模式为 supervision_normal。

2. 检测编排页
   - 选择 10 或 30 个样例。
   - 启动检测。
   - 系统自动切换 detection_sandbox。
   - 展示 Docker sandbox evidence。
   - 生成风险画像和策略包。
   - 检测结束自动恢复 supervision_normal。

3. 实时监督页
   - 激活策略包。
   - OpenClaw 正常对话。
   - 外部 MCP 工具调用被 Gateway 监督。
   - 原生工具调用被 native hook 监督。
   - 展示 deny / ask / allow / warn。

4. 报告工作台
   - 展示检测证据。
   - 展示监督记录。
   - 展示策略包来源。
   - 展示防御效果。

## 8. 文件落点总览

优先新增:

```text
docs/B/p3-b-detection-sandbox-supervision-hook-plan.md
scripts/Dockerfile.sandbox
scripts/openclaw-detection-mode.ps1
scripts/openclaw-supervision-mode.ps1
backend/src/modules/openclaw/openclawModeManager.ts
backend/src/api/v1/openclaw/mode-handlers.ts
backend/src/api/v1/openclaw/native-supervision-handlers.ts
plugins/agent-guard-supervision/
backend/src/services/staleRunRecoveryService.ts
```

优先修改:

```text
backend/src/app.ts
backend/src/services/e2eRunService.ts
backend/src/modules/agent/openclawSession.ts
backend/src/modules/openclaw/realtimeMcpServer.ts
backend/src/storage/fileRunStore.ts
frontend/src/pages/RuntimeConfig/RuntimeConfigPage.tsx
frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx
frontend/src/pages/Supervision/LiveSupervisionPage.tsx
frontend/src/pages/System/SystemPage.tsx
```

## 9. 风险与边界

### 9.1 不改 OpenClaw 核心源码

最后一轮不建议 fork 或改 OpenClaw 核心。优先使用:

- OpenClaw 配置。
- OpenClaw plugin hook。
- Agent Guard MCP Gateway。
- Agent Guard 后端 eval API。

### 9.2 不把 Docker 说成实时监督

Docker 的作用是隔离，不是策略裁决。答辩时应明确:

```text
检测阶段 Docker 防止攻击样例危害宿主机。
监督阶段 Hook/Gateway 防止真实工具调用越权。
```

### 9.3 原生工具 Hook 必须有安装检测

如果插件没有安装或没有启用，系统不能声称“已监督 OpenClaw 原生工具”。前端和 system/status 必须显示:

```text
nativeToolHook: unavailable
```

并提示当前只能监督 MCP Gateway 工具。

### 9.4 模式切换必须可恢复

任何自动修改 OpenClaw 配置的操作，都必须:

- 先保存配置快照。
- 失败时停止运行。
- 检测结束后恢复。
- 恢复失败时前端强提示。

## 10. 分阶段验收标准

### 第一阶段: 模式分离可见

- 前端显示 detection_sandbox / supervision_normal。
- 后端能读取当前 OpenClaw 模式。
- stale running 能自动清理。

### 第二阶段: 检测 Docker 必备

- 检测前自动检查 Docker sandbox。
- 检测中危险行为不影响宿主机。
- 检测后恢复正常模式。

### 第三阶段: 外部 MCP 监督稳定

- 外部 MCP 工具通过 Gateway 接入。
- 实时监督有完整 SSE 事件。
- 策略包能产生 deny / ask / warn。

### 第四阶段: 原生工具 Hook 监督闭合

- OpenClaw 原生 exec/read/write 被 hook 拦截。
- deny 不执行。
- ask 等人工。
- after_tool_call 进入审计。
- Agent Guard 不可达时高风险 fail-close。

### 第五阶段: 黑盒演示通过

- 10 样例检测能快速完成。
- 300 样例检测可长跑但不影响宿主机。
- 监督阶段不启用 Docker，也能拦截原生工具。
- 报告能证明检测证据、策略来源、监督结果三者闭环。

## 11. 最终答辩口径

推荐表述:

> Agent Guard 将 OpenClaw 风险治理拆成两个阶段。检测阶段使用 Docker sandbox 安全地运行攻击库，避免风险披露过程影响宿主机；检测结果生成风险画像和策略包。监督阶段不改变 Agent 正常工作环境，而是通过 Agent Guard MCP Gateway 监督外部工具，通过 OpenClaw before_tool_call plugin 监督原生工具，在真实工具执行前完成 allow、deny、ask、warn 裁决。这样既能安全发现风险，又能证明系统对真实运行中的 OpenClaw 工具调用具备实时监督能力。

