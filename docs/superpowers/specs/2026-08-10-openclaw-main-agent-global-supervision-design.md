# OpenClaw main Agent 全会话原生工具监督设计

日期：2026-08-10  
状态：已确认，待实施

## 1. 背景

当前系统存在两条彼此独立的监督路径：

- 检测编排为每个 OpenClaw RunGroup 创建隔离 Gateway，并为具体检测 session 激活 Native Guard lease；检测结束后撤销 lease 并清理 Gateway。
- 实时监督页面激活的是 realtime MCP 策略，并创建 `session.*` 运行时会话；“监听实时事件”只订阅 realtime MCP SSE，不会为常驻 OpenClaw Gateway 创建 Native Guard lease。

因此，用户在 `http://127.0.0.1:18789` 的 OpenClaw Control UI 中使用 `agent:main:*` 会话时，即使左侧实时监督页面正在监听，Gateway 仍可能保持 `coverage=off`、`activeLeaseCount=0`。此时原生 `read`、`write`、`exec` 按 Guard OFF 语义正常执行，左侧也不会显示对应 Hook 事件。

本设计补齐“检测生成策略包 -> 启动常驻监督 -> main 全部会话原生工具受控 -> 实时展示证据”的产品闭环。

## 2. 目标

1. 用户在 Agent Guard 前端点击“开始监督”后，一个 supervision lease 覆盖 `agentId=main` 的全部当前及未来会话。
2. 覆盖 `agent:main:dashboard:*`、`agent:main:cli:*`、`agent:main:<channel>:*` 和 `agent:main:subagent:*`。
3. 不覆盖其他 Agent，例如 `agent:worker:*`。
4. 原生工具统一经过 `before_tool_call` Hook 和 Agent Guard PDP 裁决。
5. main Agent 新建会话无需发现、轮询或再次绑定，第一次工具调用即受控。
6. Native Guard decision/outcome 以真实 OpenClaw sessionKey 出现在实时监督事件流。
7. 常驻 main supervision lease 与检测沙箱的临时 session lease 可以并存。
8. 点击“停止监督”后撤销 main Agent lease，Gateway 恢复 OFF，OpenClaw 正常执行不受影响。

## 3. 非目标

- 第一版不支持监督所有 Agent，也不接受用户输入任意 agentId；范围固定为 `main`。
- 第一版不支持同一 main Agent 同时激活多个策略包。
- 不用浏览器轮询 OpenClaw 会话列表，也不为每个会话分别创建 lease。
- 不改变检测沙箱的 Docker 强制隔离、session 级 attestation 和清理流程。
- 不在 Agent Guard 前端建立第二套原生 `ask` 状态机；原生 ask 继续由 OpenClaw `requireApproval` 处理，Agent Guard 只镜像状态。

## 4. 方案选择

### 4.1 采用：结构化 Agent 级 lease

为 lease 增加明确的 scope：

```ts
export type NativeGuardLeaseScope =
  | { kind: "session"; sessionKey: string }
  | { kind: "agent"; agentId: "main" };
```

main 全会话监督使用：

```ts
{
  mode: "supervision",
  scope: { kind: "agent", agentId: "main" },
  policyPackId: "policy_pack.*"
}
```

检测编排继续使用：

```ts
{
  mode: "detection",
  scope: { kind: "session", sessionKey: "agent:main:run.<run-id>" }
}
```

### 4.2 不采用：每会话动态 lease

轮询会话并逐一激活会产生新会话监督空窗，还要求解决多 lease 续租、策略冲突和清理竞争。Agent 级 lease 在 Hook 查询时直接按 agentId 匹配，不存在发现延迟。

### 4.3 不采用：`agent:main:*` 字符串通配符

通配字符串容易被非规范 sessionKey、转义和前缀混淆绕过。协议使用结构化 scope，插件只接受经过严格解析的 OpenClaw canonical sessionKey。

## 5. 协议与兼容性

### 5.1 Wire contract

`NativeGuardLeaseActivation` 增加 `scope`。为兼容现有调用：

- `scope` 缺失时，继续把现有 `rootSessionKey` 解释为 session scope。
- 新的 agent scope activation 同时携带 canonical anchor `rootSessionKey="agent:main:main"`，但授权范围以结构化 `scope` 为唯一依据。
- 如果 `scope.kind="session"`，`scope.sessionKey` 必须与 `rootSessionKey` 完全一致。
- 如果 `scope.kind="agent"`，第一版只接受 `agentId="main"`，并要求 anchor 为 `agent:main:main`。

marker、签名 canonical JSON、renew、recovery 和 status projection 都必须包含 scope，避免重启后把 agent scope 降级为单 session scope。

### 5.2 状态合约

后端可能同时持有常驻监督 lease 和检测沙箱 lease，因此状态增加 `activeLeases`：

```ts
type NativeGuardStatus = {
  activeLeaseCount: number;
  activeLease?: NativeGuardLeaseSummary;
  activeLeases?: NativeGuardLeaseSummary[];
};
```

兼容规则：恰好一个 lease 时继续返回 `activeLease`；多个 lease 时以 `activeLeases` 为权威。前端按 gatewayInstanceId 和 scope 找到常驻 main supervision lease，不依赖数组第一项。

## 6. Lease 解析与并发

### 6.1 后端 LeaseService

`NativeGuardLeaseService` 为 StoredLease 保存 scope，并维护两类索引：

- `sessionKey -> leaseId`
- `agentId -> leaseId`

`resolveBySession(sessionKey)` 的顺序固定为：

1. 精确 session lease；
2. 解析 canonical sessionKey 的 agentId；
3. 匹配该 agentId 的 agent lease；
4. 无匹配时返回 OFF。

精确 session lease 优先，保证检测 session 的独立策略不会被常驻 main 策略覆盖。
decision、evidence 和 lifecycle 请求仍必须同时匹配请求携带的 leaseId、leaseEpoch 和解析出的 scope；`resolveBySession` 的 fallback 结果不能单独构成授权。这样检测 lease 撤销后，迟到请求不会错误落入 main Agent lease。

### 6.2 Coordinator

删除当前 `leases.size > 0` 的进程级单 lease 限制，改成冲突域检查：

```text
gatewayInstanceId + scope
```

允许：

- 常驻 Gateway 上一个 `main` agent-scope supervision lease；
- 每个隔离检测 Gateway 上一个 session-scope detection lease；
- 不同 Gateway 的 lease 并存。

拒绝：

- 同一常驻 Gateway 上第二个 `main` agent-scope lease；
- 同一 Gateway 上 scope 重叠且策略不同的 lease；
- 未完成 attestation 的 Gateway 创建 agent-scope lease。

ManagedLease 必须绑定 gatewayInstanceId、gatewayUrl、controlClient 和 scope，renew/revoke/status 不得回退到其他 Gateway 身份。

### 6.3 插件 LeaseRegistry

插件在 `before_tool_call` 中取得真实 sessionKey，严格解析 `agent:<agentId>:...`。查找顺序与后端一致：精确 session -> agent scope -> OFF。

agent-scope lease 的生命周期与任一具体会话无关：

- `session_end` 只结束该 session 的证据绑定，不结束 agent lease；
- 新会话无需 `bindChild` 即可命中 agent lease；
- `subagent_spawned` 仍可保留 lineage 证据，但授权不依赖事件及时到达；
- 只有显式 revoke、TTL 到期、策略过期或 recovery 处理才能结束 agent lease。

## 7. 常驻监督服务

后端新增 `MainAgentSupervisionService`，集中拥有常驻 Gateway 的 lease 生命周期，浏览器不直接接触 control token。

职责：

- 验证策略包来自已保存的 OpenClaw detection RunGroup；
- 验证常驻 Gateway capability 和 live attestation；
- 激活固定 `main` agent scope；
- 保存 leaseId、epoch、policyPackId、gatewayInstanceId、expiresAt；
- 在 TTL 剩余三分之一时自动 renew；
- 提供幂等 start/stop/status；
- stop 时先停止续租，再 revoke；
- 后端关闭时尽力 revoke，失败则保留 recovery marker 并报告 recovery。

同一策略且当前 lease 可用时重复 start 返回当前状态。其他 start 先验证请求策略；只要当前 main lease 仍被服务保留，就返回稳定的 `409 MAIN_AGENT_SUPERVISION_REPLACE_CONFLICT`，不撤销或替换当前 lease。操作员必须先显式 stop，再 start 所需策略；第一版不允许两个 main 策略并存。

## 8. API

新增面向本系统前端的编排 API，不暴露 `AGENT_GUARD_CONTROL_TOKEN`：

```text
GET    /api/v1/openclaw/native-supervision
POST   /api/v1/openclaw/native-supervision/start
POST   /api/v1/openclaw/native-supervision/stop
```

start 请求：

```json
{
  "policyPackId": "policy_pack.*"
}
```

agentId 不由客户端提供，服务端固定为 `main`。响应至少包含 coverage、scope、policyPackId、leaseId、leaseEpoch、expiresAt、gatewayInstanceId 和 reasonCode。

只有 Gateway 返回 active、scope 匹配且后端确认 lease 可用后，start 才返回成功。失败不得显示“正在监督”。

## 9. 实时事件桥接

共享 `NativeGuardEventStore` 在成功 append decision/outcome 后发布经过脱敏的内部通知。通知转换为现有 `native_tool_hook` SSE 事件：

```json
{
  "type": "native_tool_hook",
  "runtimeSessionId": "agent:main:dashboard:...",
  "toolId": "call.*",
  "toolName": "exec",
  "action": "deny",
  "detail": {
    "leaseId": "...",
    "leaseEpoch": 1,
    "phase": "decision"
  }
}
```

要求：

- 只在 event store 成功持久化后发布；
- 不发送 credential、token、原始敏感参数或未脱敏 stderr；
- decision 和 outcome 使用相同 sessionKey/callId；
- SSE 断开不影响 Hook 裁决和持久化；
- realtime MCP 事件与 native event 共用展示协议，但保留来源字段。

## 10. 前端交互

实时监督页面把控制和观察分开：

- “开始监督”：激活 main 全会话 lease，然后启动事件监听。
- “停止监督”：停止自动续租并撤销 lease；事件监听可选择继续用于查看历史。
- “监听实时事件”：仅控制 SSE，不再暗示 Guard 已激活。

页面固定显示：

```text
原生工具监护：active / ready / recovery / off
监督范围：main 的所有会话
策略包：policy_pack.*
main 常驻租约：1
系统总租约：N
Gateway：gatewayInstanceId
到期时间：expiresAt
```

事件视图提供“main 全部会话”和具体 sessionKey 筛选。原有自动生成的 `session.*` 只用于 realtime MCP，不用于过滤 Native Guard 事件。

## 11. 错误处理

- start 超时、插件未确认或 capability 改变：回滚后端 lease，页面保持 ready/off。
- renew 失败：状态进入 recovery/conditional，页面明确告警，禁止继续显示“完整监督”。
- revoke 失败：停止续租但保留 recovery marker，持久化 revokeError。
- 策略包不存在或不是 OpenClaw stored detection：拒绝 start。
- main sessionKey 解析失败：该调用 fail closed 并记录 identity mismatch，不允许退回 OFF。
- 其他 Agent 的 sessionKey：不匹配 main scope，按 Guard OFF 正常执行。
- 检测与常驻监督并发：按 gatewayInstanceId 隔离，不得返回全局 `NATIVE_GUARD_ALREADY_ACTIVE`。

## 12. 测试策略

### 12.1 单元测试

- scope canonical JSON、签名、marker 和兼容解析；
- canonical sessionKey 的 main 匹配和其他 Agent 排除；
- 精确 session lease 优先于 agent lease；
- session_end 不撤销 agent lease；
- agent lease renew/revoke/recovery；
- 同 Gateway scope 冲突与不同 Gateway 并存；
- Native Guard event -> SSE 脱敏投影。

### 12.2 集成测试

- 前端 start 调用后，后端和常驻 Gateway 都显示 active；
- 已存在的 dashboard 会话执行工具时命中 agent lease；
- start 后新建 dashboard 会话，无额外绑定即可命中；
- 两个 main 会话同时调用工具，事件按各自 sessionKey 展示；
- main 常驻监督开启时，Docker 检测 RunGroup 仍能完成；
- stop 后 Gateway 返回 off，main 原生工具恢复正常执行；
- realtime MCP 事件和 Native Guard 事件不会串 session。

### 12.3 黑盒验收

1. Guard OFF：main 会话原生 read 正常，系统显示 0 lease。
2. 点击开始监督：系统显示 active、main 全会话、1 个 main 常驻 lease。
3. 已有 main 会话请求原生 exec 写入探针文件，策略 deny，文件不存在。
4. 新建另一个 main 会话，重复 exec，无需重新开始监督，仍被 deny。
5. 两个会话的 decision/outcome 都出现在左侧，并保留不同 sessionKey。
6. 监督期间运行一个 OpenClaw 检测用例，检测完成且常驻 lease 仍 active；检测期间系统总 lease 可以大于 1。
7. 点击停止监督：系统恢复 off/ready、0 个常驻 lease；新请求正常执行且不产生监督 decision。
8. 连续执行三轮，不能出现 conditional、identity mismatch、coverage breach 或残留 lease。

## 13. 实施边界

预计涉及：

- `packages/contracts` 与 `packages/native-guard-protocol`：scope/status 合约与 canonical 签名；
- `backend/src/modules/openclaw/nativeGuardLeaseService.ts`：Agent 索引和解析；
- `backend/src/modules/openclaw/nativeGuardCoordinator.ts`：按 Gateway/scope 的并发管理；
- `plugins/agent-guard-supervision/src/leaseRegistry.ts` 及 Hook 路径：agent-scope 查询和生命周期；
- `backend/src/api/v1/openclaw`：常驻监督 API；
- `backend/src/storage/nativeGuardEventStore.ts` 与 realtime 模块：持久化后事件桥接；
- `frontend/src/pages/Supervision` 和 API client：统一启停、状态和 session 过滤；
- 检测 E2E：证明常驻监督与沙箱检测并存。

不修改 unrelated 检测语料、报告生成和前端其他页面。
