# Developer B 模块运行时设计规范

设计日期: 2026-06-01
文档版本: design-1
状态: 设计通过，待实现
依赖基线: docs/architecture.md, docs/contracts.md, docs/interfaces.md, docs/ownership.md

## 1. 设计概述

本文档定义 Developer B 模块的内部运行时接口、文件清单、依赖方向和开发顺序。

B 的职责范围：
- 接入被测 Agent，提供统一调用接口
- 基于 `TestContext` 执行测试用例
- 驱动 Agent 与系统内置 MCP Sandbox 交互
- 捕获全部 Agent-MCP 交互事件
- 输出 `TestRun` + `InteractionTrace`

B 的硬性边界：
- 可以记录来自 `TestContext` / `McpSandboxProfile` 的事实标签（`isHighRiskTool`、`authorized`、`containsInjection`、`riskTagIds`）
- 不得生成 `Finding`、`EvidenceChain`、`AttackChain`、`RiskEvaluationResult`、`RiskReport` 或任何风险结论
- 不得修改 `TestCase`、`RiskRule` 或 MCP 配置文件
- 不得读取 `TestOracle` 参与运行时逻辑

## 2. 文件清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `backend/src/modules/agent/agentMcpBridge.ts` | 定义 `ToolCallRequest` 和 `AgentMcpBridge` 接口 |
| `backend/src/modules/agent/mockAgentSession.ts` | P0 Mock Agent，模拟被测 Agent 的工具调用和资源访问行为 |
| `backend/src/modules/monitor/monitorBridge.ts` | `AgentMcpBridge` 实现，拦截 Agent→Sandbox 交互并记录 TraceEvent |
| `backend/src/modules/sandbox/mockMcpSandboxRuntime.ts` | P0 Mock Sandbox Runtime，基于 `TestContext` 数据驱动 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `backend/src/modules/monitor/traceRecorder.ts` | 构造器接收 `TraceRecorderMeta`，`record()` 简化签名为 `(type, actor, payload)`，内部生成 eventId/timestamp/sequence |
| `backend/src/modules/monitor/mcpMonitor.ts` | 从 `NotImplementedError` 壳 → 完整 `MCPMonitor` 工厂 |
| `backend/src/modules/monitor/index.ts` | 新增导出 `monitorBridge` |
| `backend/src/modules/runner/testRunner.ts` | 从 `NotImplementedError` 壳 → 完整 `runTestCase()` 编排 |
| `backend/src/modules/agent/agentAdapter.ts` | `sendTask` 增加 `AgentRunMeta` 参数 |
| `backend/src/modules/agent/index.ts` | 新增导出 `agentMcpBridge`、`mockAgentSession` |

### 不改动

| 文件 | 原因 |
|------|------|
| `backend/src/modules/agent/agentTypes.ts` | 类型重导出，已正确 |
| `backend/src/modules/monitor/traceTypes.ts` | 类型重导出，已正确 |
| `backend/src/modules/runner/runTypes.ts` | 类型重导出，已正确 |
| `packages/contracts/src/**` | B 不改共享契约 |
| `configs/**` | B 只读不写 |

## 3. 依赖方向

```
agent → contracts (only)
monitor → agent (implements AgentMcpBridge) + sandbox (calls McpSandboxRuntime)
runner → agent + monitor + sandbox (orchestrates all three)
```

严格禁止：
- `agent → monitor`（类型定义在 agent，实现在 monitor，通过接口实现分离）
- `monitor → runner`
- `runner → risk` 或 `runner → report`

## 4. 核心接口定义

### 4.1 AgentMcpBridge（agent/agentMcpBridge.ts）

Agent 通过此桥与 Sandbox 交互，所有调用由 Monitor 拦截记录。

```ts
type ToolCallRequest = {
  toolId: string
  toolName?: string
  parameters: JsonObject
}

interface AgentMcpBridge {
  handleToolCall(call: ToolCallRequest): Promise<ToolResultPayload>
  handleResourceAccess(resourceId: string): Promise<ResourceAccessPayload>
  handlePromptLoad(promptId: string): Promise<PromptLoadPayload>
}
```

设计约束：
- `ToolCallRequest` 只包含 Agent 能提供的信息（toolId / toolName / parameters），`callId` 由 Bridge 内部生成，`isHighRiskTool` 由 Bridge 根据 Sandbox 元数据补全
- 三个 handle 方法内部逻辑一致：记录 trace event → 转发 Sandbox → (tool_call 时) 记录 result → 返回
- 任何 Sandbox 调用失败时，Bridge 捕获异常、记录 `system_error` 事件，然后 rethrow

### 4.2 TraceRecorder（monitor/traceRecorder.ts）

```ts
type TraceRecorderMeta = {
  traceId: string
  runId: string
  contextId: string
  caseId: string
}

class TraceRecorder {
  constructor(meta: TraceRecorderMeta)

  record(
    type: TraceEventType,
    actor: TraceActor,
    payload: TraceEventPayload,
  ): TraceEvent

  toTrace(overrides: Omit<InteractionTrace, "events">): InteractionTrace
}
```

- `eventId`、`timestamp`、`sequence` 由 recorder 内部自动生成
- `traceId`、`runId`、`caseId` 从构造参数继承到每个 event 的对应字段
- `contextId` 用于 `finalizeTrace()` 和 `test_started` payload，不写入 `TraceEvent` 顶层（`TraceEvent` 协议中无此字段）
- `sequence` 从 1 开始单调递增
- `toTrace()` 将收集的 events（按 sequence 排序）与 overrides 合并为完整 `InteractionTrace`

### 4.3 MCPMonitor（monitor/mcpMonitor.ts）

```ts
type InteractionTraceMeta = Omit<InteractionTrace, "events">

interface MCPMonitor {
  sandbox: McpSandboxRuntime
  recorder: TraceRecorder

  createBridge(): AgentMcpBridge       // 给 Agent 用的拦截桥
  recordEvent(type: TraceEventType, actor: TraceActor, payload: TraceEventPayload): TraceEvent
  finalizeTrace(meta: InteractionTraceMeta): InteractionTrace
}
```

- `createBridge()` 返回的 `AgentMcpBridge` 实例在每次 handle 调用时自动记录事件
- `recordEvent()` 供 Runner 在编排级别记录 `test_started`、`task_sent`、`agent_message`、`system_error` 等桥覆盖不到的事件
- `finalizeTrace()` 调用 recorder.toTrace() 并补全 trace 元数据

### 4.4 AgentSession 扩展（agent/agentAdapter.ts）

```ts
type AgentRunMeta = {
  runId: string
  caseId: string
  agentId: string
}

interface AgentSession {
  agent: AgentUnderTest
  config: AgentAdapterConfig
  sendTask(task: AgentTask, bridge?: AgentMcpBridge, runMeta?: AgentRunMeta): Promise<AgentRunResult>
  close?(): Promise<void>
}
```

- `runMeta` 由 Runner 传入，AgentSession 不自生成 ID
- `AgentRunResult` 返回完整字段：`schemaVersion` / `runId` / `agentId` / `caseId` 来自 `runMeta` 和 `session.agent`；`status` / `startedAt` / `endedAt` 由 Session 记录；`finalMessage` / `error` 按实际执行结果填充

### 4.5 MockAgentSession（agent/mockAgentSession.ts）

```ts
class MockAgentSession implements AgentSession {
  constructor(agent: AgentUnderTest, config: AgentAdapterConfig)
  async sendTask(task: AgentTask, bridge?: AgentMcpBridge, runMeta?: AgentRunMeta): Promise<AgentRunResult>
  async close(): Promise<void>
}
```

P0 行为：
- 读取 `task.instruction`，按固定剧本模拟 Agent 行为
- 如果 task 声明了 `toolIds` → 遍历调用 `bridge.handleToolCall()`
- 如果 task 声明了 `resourceIds` → 遍历调用 `bridge.handleResourceAccess()`
- 如果 task 声明了 `promptIds` → 遍历调用 `bridge.handlePromptLoad()`
- 返回完整 `AgentRunResult`，包含 `schemaVersion`、`runId`、`agentId`、`caseId`、`startedAt`、`endedAt`、`status`、`finalMessage`（或 `error`）
- 异常时 `status = "failed"` 并填充 `error`

### 4.6 MockMcpSandboxRuntime（sandbox/mockMcpSandboxRuntime.ts）

```ts
function createMockMcpSandboxRuntime(context: TestContext): McpSandboxRuntime
```

- 持有 `context.sandbox`（McpSandboxProfile）和 `context.testCase.toolResponsePlan`
- `executeTool(toolId, params)`：查找 ToolDefinition，返回包含对应 riskTagIds 和 containsInjection 的 ToolResultPayload
- `readResource(resourceId)`：查找 ResourceDefinition，返回 sensitivity/authorized/containsInjection 等信息
- `loadPrompt(promptId)`：查找 PromptDefinition，返回 attackEntryType 和 riskTagIds
- `resolveToolResponse(plan, params)`：根据 plan.trigger（first_call/every_call/matching_parameters）匹配 ToolResponseTemplate
- 内部维护 tool call 计数器，支持 `first_call` / `every_call` trigger 判断

## 5. runTestCase 时序

```
runTestCase(agent, adapterConfig, testContext):

1. validate(agent, adapterConfig, testContext)
   - 校验 schemaVersion，必要字段非空
   - 提取局部变量:
     caseId    = testContext.caseId
     contextId = testContext.contextId
     agentId   = agent.agentId
     sandboxId = testContext.sandbox.sandboxId

2. 创建初始对象:
   - runId = createId("run")
   - traceId = createId("trace")
   - testRun = { runId, contextId, caseId, agentId, sandboxId, status:"running", startedAt: now() }
   - sandbox = createMockMcpSandboxRuntime(testContext)

3. 创建 Monitor:
   - recorder = new TraceRecorder({ traceId, runId, contextId, caseId })
   - monitor = createMCPMonitor(sandbox, recorder)
   - bridge = monitor.createBridge()

4. 记录 test_started:
   - recorder.record("test_started", "system", { contextId, sandboxId })

5. 创建 AgentSession:
   - adapter = adapterRegistry.get(agent.adapterType)
   - session = await adapter.createSession(agent, adapterConfig)

6. 记录 task_sent:
   - recorder.record("task_sent", "system", { taskId, instruction })

7. try:
     result = await session.sendTask(testCase.task, bridge, { runId, caseId, agentId })
     recorder.record("agent_message", "agent", { message: result.finalMessage ?? "" })
     testRun.status = "completed"

   catch (error):
     recorder.record("system_error", "system", {
       code: "RUNNER_ERROR",
       message: String(error),
     })
     testRun.status = "failed"
     testRun.error = String(error)

   finally:
     await session.close?.()
     testRun.endedAt = now()
     trace = monitor.finalizeTrace({
       schemaVersion: "mvp-1",
       traceId, runId, contextId, caseId,
       agentId, sandboxId,
       status: testRun.status,
       startedAt: testRun.startedAt,
       endedAt: testRun.endedAt,
     })

8. 返回 { testRun, trace }
```

## 6. Bridge 内部事件记录逻辑

### handleToolCall

```
1. 根据 request.toolId 查找 ToolDefinition
2. 构造 ToolCallPayload { callId, toolId, toolName, parameters, isHighRiskTool }
3. recorder.record("tool_call", "agent", callPayload)
4. try:
     result = await sandbox.executeTool(request.toolId, request.parameters)
     recorder.record("tool_result", "mcp_server", result)
     return result
   catch (error):
     recorder.record("system_error", "system", { code:"TOOL_ERROR", message:String(error) })
     throw error
```

### handleResourceAccess

```
1. payload = await sandbox.readResource(resourceId)
2. recorder.record("resource_access", "agent", payload)
3. return payload
注意: 先从 Sandbox 获取事实值（sensitivity/authorized/containsInjection/riskTagIds）
      再记录事件，Sandbox 调用失败时记录 system_error 并 rethrow
```

### handlePromptLoad

```
1. payload = await sandbox.loadPrompt(promptId)
2. recorder.record("prompt_load", "agent", payload)
3. return payload
注意: 同 resource_access，先从 Sandbox 取数据，再记录事件，失败时记录 system_error
```

## 7. 开发迭代顺序

### 迭代 1: AgentMcpBridge 类型 + TraceRecorder 重设计
- 新建 `agent/agentMcpBridge.ts`：`ToolCallRequest` + `AgentMcpBridge` 接口
- 改 `monitor/traceRecorder.ts`：构造器元数据 + 简化 `record()` 签名
- 验证: 单测 — 连续 record 3 个事件，sequence 递增，eventId 不重复
- 更新 `agent/index.ts`、`monitor/index.ts` 导出

### 迭代 2: MockMcpSandboxRuntime
- 新建 `sandbox/mockMcpSandboxRuntime.ts`
- 基于 `TestContext` 实现 4 个方法（executeTool / readResource / loadPrompt / resolveToolResponse）
- 验证: 用 `configs/test_cases.json` 数据驱动，确认 executeTool 返回正确的 riskTagIds

### 迭代 3: MonitorBridge + MCPMonitor
- 改 `monitor/mcpMonitor.ts`：工厂创建 Bridge + Recorder，注入 sandbox
- 新建 `monitor/monitorBridge.ts`：实现 `AgentMcpBridge`（含失败路径 system_error）
- 验证: 单元测试 — 通过 Bridge 调 Sandbox，确认 trace events 正确记录

### 迭代 4: MockAgentSession + runTestCase
- 新建 `agent/mockAgentSession.ts`
- 改 `agent/agentAdapter.ts`：`sendTask` 增加 `AgentRunMeta` 参数
- 改 `runner/testRunner.ts`：完整 `runTestCase()` 编排
- 验证: 用 mock agent + mock sandbox + test_cases.json 跑一条 case，产出完整 TestRun + InteractionTrace

### 迭代 5: B 模块闭环验证
- 用 `configs/test_cases.json` 中 2 个 case 分别跑通完整流程
- 确认:
  - 所有共享对象有 `schemaVersion: "mvp-1"`
  - `InteractionTrace.events` 按 `sequence` 单调递增
  - `tool_call` 与 `tool_result` 通过 `callId` 关联
  - `TestRun` / `InteractionTrace` 的 caseId、contextId、runId、agentId、sandboxId 一致
  - 失败路径生成 `system_error` + `TestRun.status = "failed"`
  - B 支持全部 8 种 TraceEventType；闭环验证集整体至少覆盖 8 种事件类型（单条 trace 无需全部包含）
- B 产出可供 C 直接消费

## 8. B 模块禁止事项

- 不能生成 `Finding`、`EvidenceChain`、`AttackChain`、`RiskEvaluationResult`、`RiskReport`
- 不能计算 `RiskLevel`
- 不能在 runTestCase 中直接读取 `configs/*.json`（只能通过 `TestContext`）
- 不能修改 `riskRules`、`TestCase`、`TestOracle`
- `agent` 模块不能导入 `monitor` 模块
- `TraceRecorder` / `MCPMonitor` 不能调用 `risk` 或 `report` 模块
- 不能在 B 模块代码中硬编码风险判定逻辑
