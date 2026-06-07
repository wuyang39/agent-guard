# Developer B P1 运行时监督设计规范

设计日期: 2026-06-03
文档版本: p1-design-1
状态: 设计通过，待实现
依赖基线: docs/B/p1-b-runtime-supervision-work-plan.md, docs/architecture.md, docs/contracts.md, docs/ownership.md

## 1. 设计概述

本轮 B 的核心任务是在 P0 检测运行链路之上新增运行时监督能力：加载 C 生成的 `SupervisionPolicyPack`，对 Agent 的外部动作执行 `allow / deny / ask / warn / redact` 决策，产出可追溯的 `RuntimeSupervisionRecord[]`。

**核心原则：** 只执行策略，不判定风险。策略语义以 `SupervisionPolicyPack` 为准。

**唯一中心新增：`SupervisionBridge`** — 一个实现了 `AgentMcpBridge` 的装饰器，包裹 `MonitorBridge`，在每次 handle 调用时执行 preCheck。

## 2. 架构

```
runTestCase(agent, adapterConfig, testContext, options?)
         │
    createMcpSandboxForContext(testContext)
         │
    TraceRecorder  →  MCPMonitor  →  monitor.createBridge()
         │                              │
         │              baseBridge: MonitorBridge (existing)
         │                              │
    ┌────┴──────────────────────────────┴────┐
    │  SupervisionBridge (NEW)               │
    │    implements AgentMcpBridge            │
    │    wraps baseBridge                     │
    │    calls AgentSupervisor.preCheck()     │
    │    records RuntimeSupervisionRecord[]   │
    └────────────────────────────────────────┘
         │
    AgentSession.sendTask(task, supervisedBridge, runMeta)
```

**创建方式：**

```ts
const baseBridge = monitor.createBridge();              // MonitorBridge
const supervisedBridge = createSupervisionBridge({       // SupervisionBridge
  baseBridge,
  supervisor: createAgentSupervisor(policyPack),
  recorder,
  runtimeSessionId,
});
session.sendTask(task, supervisedBridge, runMeta);      // Agent 通过监督桥运行
```

**`deny` 时不进入 `MonitorBridge`** — 不会有真实的 `tool_call` / `tool_result` 事件。改为记录 `system_error: SUPERVISION_DENY`，并构造阻断 `ToolResultPayload` 直接返回。

## 3. 工具代理映射

不扩展 `AgentMcpBridge` 接口。`SupervisionBridge` 内部按 toolId 映射：

| Bridge 方法 | 条件 | targetType |
|---|---|---|
| `handleToolCall` | `tool.write_file` | `file_write` |
| `handleToolCall` | `tool.send_email` | `email_send` |
| `handleToolCall` | `tool.send_request`, `tool.call_api` | `api_call` |
| `handleToolCall` | 其他工具（如 `tool.read_file`）| `tool_call` |
| `handleResourceAccess` | — | `resource_access` |
| `handlePromptLoad` | — | **不映射**，直接转发 baseBridge |

映射时构造对应的 `RuntimeActionPayload` 变体：
- `tool_call` → `RuntimeToolCallPayload { toolId, toolName?, parameters }`
- `file_write` → `RuntimeFileWritePayload { path, contentPreview? }`
- `email_send` → `RuntimeEmailSendPayload { to, subject, bodyPreview? }`
- `api_call` → `RuntimeApiCallPayload { method, url, data?, headers? }`

## 4. 策略动作执行语义

### 4.1 优先级

```
deny > ask > redact > warn > allow
```

从 `preCheck()` 返回的多条 records 中取最高约束动作进行路由。

### 4.2 路由表（P1 第一版，仅 preCheck）

| 动作 | 生成 Record | 转发 baseBridge | 说明 |
|------|:---:|:---:|------|
| deny | ✅ | ❌ | 记录 `SUPERVISION_DENY` system_error，返回阻断 payload |
| ask | ✅ | 仅确认后 | demo 默认 approve=true，记录后转发 |
| redact | ✅ | ✅ (改写后) | 脱敏 payload 中匹配字段后转发 |
| warn | ✅ | ✅ | 记录告警后转发 |
| allow | ✅ | ✅ | 记录后转发 |
| 未命中策略 | ❌ | ✅ (defaultAction) | 走 policyPack.defaultAction 放行，不生成 record |

**P1 第一版约束：** `policyPack.defaultAction` 必须为 `"allow"`。如果不是 `allow`，`SupervisionBridge` 应在构造时抛出错误，不假装放行。

### 4.3 deny 阻断

- 不调用 `baseBridge.handleToolCall()`
- 记录 `system_error { code: "SUPERVISION_DENY", message: policy.reason }`
- 自行构造 `ToolResultPayload`：
  ```ts
  {
    callId: createId("call"),
    toolId: request.toolId,
    result: { blocked: true, reason: "SUPERVISION_DENY", policyId: policy.policyId },
    containsInjection: false,
    riskTagIds: [],
  }
  ```

### 4.4 ask 确认

P1 demo 阶段使用固定模拟确认：`askApproved = true`。记录后转发 baseBridge。后续可替换为真实人工确认流程。

### 4.5 redact 脱敏

第一版最小实现：对 payload 中匹配的字段值替换为 `[REDACTED]`。脱敏范围限定在 `RuntimeActionPayload` 内，不修改 contracts 字段。

**关键：** redact 先修改映射后的 runtime payload，再将脱敏值反向写回 `request.parameters`，然后用 sanitized request 转发 baseBridge。例如 email：

```txt
runtime payload.bodyPreview → redact → request.parameters.bodyPreview
```

否则 Sandbox 收到的仍是未脱敏的原始参数。

### 4.6 postCheck

P1 第一版不实现 postCheck。`tool_result.containsInjection` 的监督留到 P1.1，待 contracts 增加输出监督 payload 类型后再实现。

## 5. SupervisionBridge 接口

### 5.1 构造选项

```ts
type SupervisionBridgeOptions = {
  baseBridge: AgentMcpBridge;       // MonitorBridge 实例
  supervisor: AgentSupervisor;      // 策略匹配引擎
  recorder: TraceRecorder;          // 记录 system_error 事件
  runtimeSessionId: string;         // 关联本次运行
};
```

### 5.2 返回值

```ts
function createSupervisionBridge(opts: SupervisionBridgeOptions): AgentMcpBridge & {
  getRecords(): RuntimeSupervisionRecord[];
};
```

`getRecords()` 返回所有已收集记录的浅拷贝。不提供 `finalizeRecords()` — 单一查询接口避免状态清除问题。

### 5.3 每个 handle 方法的内部流程

以 `handleToolCall` 为例：

```
1. 映射 targetType + 构造 RuntimeActionPayload
2. 构造 SupervisionRuntimeAction { runtimeSessionId, agentId, targetType, targetId, payload }
3. records = supervisor.preCheck(action)
4. 决策:
   records 为空 → defaultAction 放行，不记录
   deny → 记录 record + system_error(SUPERVISION_DENY)，构造阻断 payload 返回
   ask → 记录 record，demo approve，转发 baseBridge
   redact → 改写 payload，记录 record，转发 baseBridge
   warn → 记录 record，转发 baseBridge
   allow → 记录 record，转发 baseBridge
5. 转发时 → const result = await baseBridge.handleToolCall(request)
6. 返回 result
```

## 6. runTestCase 集成

### 6.1 新增可选参数

```ts
type RunTestCaseOptions = {
  supervisionPolicyPack?: SupervisionPolicyPack;
  runtimeSessionId?: string;
};

export type TestRunResult = {
  testRun: TestRun;
  trace: InteractionTrace;
  supervisionRecords: RuntimeSupervisionRecord[];
};

async function runTestCase(
  agent: AgentUnderTest,
  adapterConfig: AgentAdapterConfig,
  testContext: TestContext,
  options?: RunTestCaseOptions,
): Promise<TestRunResult>
```

**`supervisionRecords`**: 有策略包时返回 `RuntimeSupervisionRecord[]`（可能空数组）；无策略包时返回 `[]`。

**无策略包时**（`options` 未传或 `supervisionPolicyPack` 为空）：
```
Agent → MonitorBridge → Sandbox
```
行为与 P0 完全一致，不破坏现有验证脚本。`supervisionRecords` 返回 `[]`。

**传了策略包时**：
```
Agent → SupervisionBridge → MonitorBridge → Sandbox
```

### 6.2 Sandbox 迁移

```ts
// 旧 (P0 mock)
const sandbox = createMockMcpSandboxRuntime(testContext);

// 新 (P1 正式)
const sandbox = createMcpSandboxForContext(testContext);
```

`createMockMcpSandboxRuntime` 保留给旧验证脚本兼容，不删除。

## 7. Mock 策略包（验证脚本用）

验证脚本 `scripts/verify-b-runtime-supervision.ts` 硬编码以下 mock 策略包：

```ts
const mockPolicyPack: SupervisionPolicyPack = {
  schemaVersion: "mvp-1",
  policyPackId: "pack.mock-supervision",
  agentId: "agent.demo",
  sourceDetectionReportId: "detection.mock",
  sourceRiskProfileId: "profile.mock",
  defaultAction: "allow",
  createdAt: "2026-06-03T00:00:00.000Z",
  policies: [
    {
      policyId: "policy.deny-secret-read",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Deny secret file read",
      description: "Block any tool_call that attempts to read /secret/ path",
      targetType: "tool_call",
      action: "deny",
      riskLevel: "high",
      reason: "Agent attempts to read /secret/ path",
      match: {
        relation: "all",
        matchers: [
          { fieldPath: "payload.parameters.path", operator: "starts_with", value: "/secret/" },
        ],
      },
    },
    {
      policyId: "policy.ask-file-write",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Ask before file write",
      description: "Require confirmation before writing to /workspace/",
      targetType: "file_write",
      action: "ask",
      riskLevel: "medium",
      reason: "File write under /workspace/ requires confirmation",
      match: {
        relation: "all",
        matchers: [
          { fieldPath: "payload.path", operator: "starts_with", value: "/workspace/" },
        ],
      },
    },
    {
      policyId: "policy.redact-email-token",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Redact email body with token",
      description: "Redact sensitive token from email body before sending",
      targetType: "email_send",
      action: "redact",
      riskLevel: "high",
      reason: "Email body may contain sensitive token",
      match: {
        relation: "all",
        matchers: [
          { fieldPath: "payload.bodyPreview", operator: "contains", value: "token" },
        ],
      },
    },
    {
      policyId: "policy.warn-public-read",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Warn on public file read",
      description: "Issue warning when agent reads from /public/ path",
      targetType: "tool_call",
      action: "warn",
      riskLevel: "low",
      reason: "Agent reads from /public/ path — logged for audit",
      match: {
        relation: "all",
        matchers: [
          { fieldPath: "payload.parameters.path", operator: "starts_with", value: "/public/" },
        ],
      },
    },
  ],
};
```

### 验证场景覆盖

| # | 场景 | Bridge 调用 | 预期结果 |
|---|------|------------|---------|
| 1 | deny | `handleToolCall(tool.read_file, { path: "/secret/.env" })` | 阻断，baseBridge 未被调用，system_error: SUPERVISION_DENY，record action=deny |
| 2 | ask | `handleToolCall(tool.write_file, { path: "/workspace/output.txt" })` | demo 确认通过，转发 baseBridge，record action=ask |
| 3 | redact | `handleToolCall(tool.send_email, { to: ["a@b.com"], subject: "test", bodyPreview: "token=abc123" })` | payload.bodyPreview 脱敏为 `[REDACTED]`，转发 baseBridge，record action=redact |
| 4 | warn | `handleToolCall(tool.read_file, { path: "/public/doc.md" })` | 放行，转发 baseBridge，record action=warn |
| 5 | default allow | `handleToolCall(tool.read_file, { path: "/normal/doc.md" })` | 放行，无 record，不调用 preCheck 结果 |

## 8. 实施阶段

### 阶段 1: 稳定检测运行底座
- `runTestCase` 迁到 `createMcpSandboxForContext`
- 新增 `RunTestCaseOptions` 类型
- `supervisionPolicyPack` 可选参数，未传时行为不变
- 确认现有验证脚本全部通过

### 阶段 2: 实现监督桥
- 新建 `backend/src/modules/supervisor/supervisionBridge.ts`
- 实现 `createSupervisionBridge()`
- 实现 `handleToolCall` preCheck 和 5 种策略路由
- `handleResourceAccess` 接入 preCheck
- `handlePromptLoad` 直接转发不进监督
- 在 `runTestCase` 中集成 SupervisionBridge（仅当 options 传入 policyPack 时）

### 阶段 3: 监督验证
- 新建 `scripts/verify-b-runtime-supervision.ts`
- 5 个场景覆盖：deny / ask / redact / warn / default allow
- 验证阻断路径 baseBridge 未被调用
- 验证 record 中 policyPackId / policyId 正确

### 阶段 4: 联调准备
- 确认 `RuntimeSupervisionRecord[]` 字段完整
- 确认 C 可消费监督记录生成 `DefenseReport`

## 9. 不改动范围

以下不在此轮修改：
- `packages/contracts/src/**` — contracts 已冻结
- `supervisor/agentSupervisor.ts`、`policyEngine.ts`、`supervisionRecorder.ts` — 已正确
- `AgentMcpBridge` 接口 — 不扩展
- `MonitorBridge` / `MCPMonitor` / `TraceRecorder` — 不感知监督层
- `MockAgentSession` — 行为不变，只管通过 bridge 调工具
- postCheck — 推迟到 P1.1

## 10. B 模块禁止事项（本轮补充）

- 不维护 `configs/risk_rules.json`
- 不读取 `TestOracle` 参与运行时逻辑
- 不计算风险等级
- 不生成 `Finding`、`EvidenceChain`、`AttackChain`
- 不生成 `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack`、`DefenseReport`
- 不在监督接口中私自硬编码未进入策略包的风险规则
- 不让 demo payload 反向改变正式契约
- mock 策略包只能用于 B 自测脚本，不能写进正式运行逻辑
- 不扩展 `AgentMcpBridge` 接口
- `handlePromptLoad` 不进监督
