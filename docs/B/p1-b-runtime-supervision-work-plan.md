# B 线 P1 运行时监督工作计划

文档版本: p1-b-plan-1
基线日期: 2026-06-03
状态: 待执行
负责人: 开发者 B

说明: 本计划承接 `docs/p1-supervision-defense-plan.md`、`docs/interfaces.md`、`docs/ownership.md` 和当前主线代码。B 本轮的核心任务不是判定风险或生成策略，而是把 C 生成的 `SupervisionPolicyPack` 真正加载到 Agent 运行链路中执行，并输出可追溯的 `RuntimeSupervisionRecord[]`。

## 1. 本轮目标

B 本轮目标:

```txt
Agent 行为执行与取证
  + SupervisionPolicyPack 运行时执行
  -> RuntimeSupervisionRecord[]
```

用一句话概括:

```txt
B 负责在 Agent 与工具、资源、API、文件、邮件等外部动作之间建立监督网关，根据策略包执行 allow / deny / ask / warn / redact，并记录可被 C 生成防御报告消费的运行时事实。
```

## 2. 职责边界

### 2.1 B 负责

- 接入被测 Agent 或半真实 HTTP Agent。
- 执行 `runTestCase()`，产出 `TestRun` 和 `InteractionTrace`。
- 保证 `tool_call` 与 `tool_result` 可通过 `callId` 关联。
- 建立运行时监督桥，拦截 Agent 对外动作。
- 加载 C 生成的 `SupervisionPolicyPack`。
- 对运行时动作执行 `preCheck` 和必要的 `postCheck`。
- 根据策略结果执行 `allow / deny / ask / warn / redact`。
- 输出 `RuntimeSupervisionRecord[]`。
- 为 C 的 `DefenseReport` 提供真实监督记录。

### 2.2 B 不负责

- 不维护 `configs/risk_rules.json`。
- 不读取 `TestOracle` 参与运行时逻辑。
- 不计算风险等级。
- 不生成 `Finding`、`EvidenceChain`、`AttackChain`。
- 不生成 `DetectionReport`。
- 不生成 `AgentRiskProfile`。
- 不生成 `SupervisionPolicyPack`。
- 不生成 `DefenseReport`。
- 不在监督接口中私自硬编码未进入策略包的风险规则。
- 不让 demo payload 反向改变正式契约。

## 3. 输入输出

### 3.1 检测运行阶段

B 输入:

```txt
AgentUnderTest
AgentAdapterConfig
TestContext
```

B 输出给 C:

```txt
TestRun
InteractionTrace
```

### 3.2 运行时监督阶段

B 输入:

```txt
SupervisionPolicyPack
真实或半真实 Agent 运行行为
```

B 输出给 C:

```txt
RuntimeSupervisionRecord[]
```

每条 `RuntimeSupervisionRecord` 必须能够追溯:

```txt
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

## 4. 总体技术方案

监督阶段采用运行时网关方案:

```txt
Agent 发起动作
  -> SupervisionBridge 拦截
  -> 转成 SupervisionRuntimeAction
  -> AgentSupervisor 根据 SupervisionPolicyPack 匹配策略
  -> 得到 allow / deny / ask / warn / redact
  -> 决定是否执行真实动作
  -> 记录 RuntimeSupervisionRecord
  -> 返回执行结果、阻断结果或脱敏结果
```

关键原则:

- 监督对象是 Agent 的外部动作，不是 Agent 的内部思考。
- 高风险动作应优先在执行前拦截。
- 工具结果、API 返回和 Agent 输出可以在执行后审计。
- 监督记录必须来自实际执行路径，不能事后编造。
- 策略语义以 `SupervisionPolicyPack` 为准，B 只负责执行。

## 5. 本轮模块设计

### 5.1 新增监督桥

建议新增:

```txt
backend/src/modules/supervisor/supervisionBridge.ts
```

职责:

- 接收 `SupervisionPolicyPack`。
- 创建 `AgentSupervisor`。
- 包装现有 `AgentMcpBridge` 或半真实 Agent 网关。
- 在动作执行前构造 `SupervisionRuntimeAction`。
- 调用 `supervisor.preCheck(action)`。
- 根据策略动作决定放行、阻断、询问、告警或脱敏。
- 收集并返回 `RuntimeSupervisionRecord[]`。

### 5.2 扩展 Agent 运行桥

当前 `monitorBridge.ts` 负责记录 `tool_call`、执行 Sandbox、记录 `tool_result`。本轮应在它之前或外层增加监督能力:

```txt
Agent
  -> SupervisionBridge
  -> MonitorBridge
  -> Sandbox Runtime
```

推荐实现方式:

```txt
createSupervisedAgentBridge(baseBridge, supervisor, recorder, runtimeSessionId)
```

其中:

- `baseBridge` 是现有 `AgentMcpBridge`。
- `supervisor` 负责策略匹配。
- `recorder` 负责记录 trace 事件。
- `runtimeSessionId` 负责把监督记录归入同一次运行。

### 5.3 行为覆盖范围

P1 验收至少覆盖 4 类行为。B 本轮按以下优先级实现:

1. `tool_call`
2. `resource_access`
3. `file_write`
4. `email_send`
5. `api_call`
6. `agent_message`
7. `code_execution`

第一阶段可以先用半真实模拟行为覆盖 `file_write`、`email_send`、`api_call`，不必马上接生产级外部系统。

## 6. 策略动作执行语义

### 6.1 allow

处理方式:

```txt
记录 RuntimeSupervisionRecord
继续执行原动作
```

适用场景:

- 未命中高风险条件。
- 策略明确允许某类动作。

### 6.2 deny

处理方式:

```txt
记录 RuntimeSupervisionRecord
阻断原动作
不调用真实工具、资源、API 或文件系统
向 Agent 返回阻断结果
```

适用场景:

- 读取 `/secret/*`。
- 外发包含 token、secret、password 的数据。
- 调用策略禁止的高风险工具。

### 6.3 ask

处理方式:

```txt
记录 RuntimeSupervisionRecord
进入人工确认流程
demo 阶段可用固定模拟确认结果
根据确认结果继续执行或阻断
```

适用场景:

- 写文件。
- 发邮件。
- 执行代码。
- 调用有副作用 API。

### 6.4 warn

处理方式:

```txt
记录 RuntimeSupervisionRecord
保留告警事实
继续执行原动作
```

适用场景:

- 工具返回中出现提示注入迹象。
- Agent message 出现可疑外传意图。

### 6.5 redact

处理方式:

```txt
记录 RuntimeSupervisionRecord
对输入或输出中的敏感片段脱敏
继续执行脱敏后的动作或返回脱敏后的结果
```

适用场景:

- 邮件正文包含 secret。
- API 请求体包含 token。
- 工具结果包含敏感字段。

## 7. 实施阶段

### 阶段 1: 稳定检测运行底座

目标:

```txt
loadTestContexts()
  -> runTestCase()
  -> TestRun + InteractionTrace
```

任务:

- 确认 `runTestCase()` 使用正式 `TestContext`。
- 检查是否需要从 `createMockMcpSandboxRuntime()` 迁移到 `createMcpSandboxForContext()`。
- 保证失败路径也能输出 `system_error` 和失败状态。
- 强化 `tool_call` 与 `tool_result` 的 `callId` 校验。

验收:

```bash
npm run typecheck
node --import tsx scripts/verify-full-pipeline.ts
```

### 阶段 2: 实现监督桥

目标:

```txt
SupervisionPolicyPack
  -> SupervisionBridge
  -> RuntimeSupervisionRecord[]
```

任务:

- 新增 `backend/src/modules/supervisor/supervisionBridge.ts`。
- 提供 `createSupervisedAgentBridge()`。
- 对 `tool_call` 和 `resource_access` 接入 `preCheck`。
- 对 `deny` 实现真实阻断。
- 对 `warn` 实现记录后放行。
- 对 `ask` 提供 demo 模拟确认。
- 对 `redact` 提供最小脱敏能力。

验收:

```bash
npm run typecheck
npm run verify:p1:supervision-defense
```

### 阶段 3: 覆盖半真实运行行为

目标:

```txt
至少 4 类 Agent 外部动作被监督
```

任务:

- 新增或扩展半真实 runtime action 入口。
- 覆盖 `file_write`。
- 覆盖 `email_send`。
- 覆盖 `api_call`。
- 保证每类动作都能生成 `RuntimeSupervisionRecord`。

建议新增验证脚本:

```txt
scripts/verify-b-runtime-supervision.ts
```

验收点:

- `tool_call` 能被 deny。
- `resource_access` 能被 warn 或 deny。
- `file_write` 能进入 ask。
- `email_send` 或 `api_call` 能被 redact 或 deny。

### 阶段 4: 接入半真实 HTTP Agent

目标:

```txt
一个半真实 Agent 运行环境能加载策略包并被监督
```

任务:

- 复用或扩展 `scripts/sample-agent-server.mjs`。
- 提供 HTTP Agent adapter 或 demo client。
- 让 Agent 通过监督网关调用工具和外部动作。
- 记录同一 `runtimeSessionId` 下的监督结果。

验收:

```txt
Agent 触发高风险动作
  -> 策略命中
  -> 动作被阻断或脱敏
  -> RuntimeSupervisionRecord 记录 policyPackId / policyId
  -> C 可用记录生成 DefenseReport
```

### 阶段 5: 联调 C 的防御报告

目标:

```txt
RuntimeSupervisionRecord[]
  -> DefenseReport
```

任务:

- 将 B 产出的监督记录交给 C。
- 核对 `policyPackId`、`policyId`、`runtimeSessionId`。
- 确认 `DefenseReport.blockedActions` 来自真实监督记录。
- 确认防御报告能证明至少一个高风险动作被阻断。

验收:

```bash
npm run verify:p1:supervision-defense
```

## 8. 建议新增验收脚本

### 8.1 `scripts/verify-b-runtime-supervision.ts`

验证目标:

- 构造或接收一个 `SupervisionPolicyPack`。
- 创建 `AgentSupervisor`。
- 创建 `SupervisionBridge`。
- 模拟 Agent 发起危险动作。
- 确认危险动作未被真实执行。
- 确认生成 `RuntimeSupervisionRecord`。
- 确认记录中的 `policyPackId` 和 `policyId` 正确。

建议覆盖:

```txt
deny: tool.read_file path=/secret/.env
warn: tool result containsInjection=true
ask: file_write path=/workspace/output.txt
redact: email_send bodyPreview contains token
```

### 8.2 `scripts/verify-b-supervised-http-agent.ts`

验证目标:

- 启动半真实 HTTP Agent。
- Agent 通过监督桥执行工具调用。
- 策略包成功加载。
- 运行时监督记录可被导出。

该脚本可以晚于 `verify-b-runtime-supervision.ts`，不作为第一阶段阻塞项。

## 9. 与 A/C 协作点

### 9.1 与 A 协作

B 需要 A 确认:

- `tool.read_file`、`tool.write_file`、`tool.send_email`、`tool.call_api`、`tool.send_request` 的参数字段。
- 工具画像中的 `riskTags`、`riskLevel`、`sideEffect` 是否稳定。
- Sandbox 是否能表达文件、邮件、API 等半真实动作。

B 不要求 A 提供运行时私有结论。

### 9.2 与 C 协作

B 需要 C 确认:

- `SupervisionPolicyPack` 中每条 `policy.match` 是否可执行。
- `targetType` 与 B 的 runtime action 类型是否一致。
- `RuntimeSupervisionRecord` 是否足够生成 `DefenseReport`。
- 如果策略不可执行，B 应反馈兼容性问题，而不是私自改语义。

B 不从 `RiskReport` 自行生成策略。

### 9.3 与 C 前端协作

B 需要 C 前端确认:

- 监督台需要展示哪些运行时记录字段。
- 前端是否需要按 `runtimeSessionId`、`policyPackId`、`policyId` 过滤。

B 不做正式前端页面，只保证数据可消费。

## 10. 风险与控制

### 风险 1: B 在监督层私自写规则

控制:

- 监督层只解释 `SupervisionPolicyPack`。
- 所有阻断、脱敏、询问必须能追溯到 `policyId`。

### 风险 2: 监督记录和 Trace 断裂

控制:

- 每条监督记录尽量写入 `inputEventId`。
- 有输出动作时补充 `outputEventId`。
- `runtimeSessionId` 与 `runId` 或运行时会话保持明确映射。

### 风险 3: deny 后仍执行真实动作

控制:

- `deny` 必须在调用真实工具前返回。
- 验收脚本中加入“副作用未发生”断言。

### 风险 4: redact 语义不清

控制:

- 第一轮只做最小文本脱敏。
- 脱敏前后的字段范围必须在 `SupervisionRuntimeAction.payload` 内。
- 不扩展契约字段时不引入复杂脱敏产物。

### 风险 5: 半真实 HTTP Agent 过早复杂化

控制:

- 第一轮只接一个最小 HTTP Agent。
- 重点证明策略加载、动作拦截、记录输出。
- 不追求生产级 Agent SDK 适配。

## 11. 最终交付物

B 本轮最终交付:

```txt
1. 稳定的 runTestCase() 正式检测运行入口
2. 完整可追溯的 InteractionTrace
3. SupervisionBridge 运行时监督桥
4. 可加载并执行 SupervisionPolicyPack 的 AgentSupervisor 集成
5. 至少 4 类行为的 RuntimeSupervisionRecord[]
6. 一个半真实 HTTP Agent 或 runtime demo
7. scripts/verify-b-runtime-supervision.ts
8. 与 C 的 DefenseReport 联调通过记录
```

## 12. 完成标准

本轮 B 工作完成时必须满足:

- 当前系统能跑通监督前检测。
- `runTestCase()` 输出的 `TestRun` 和 `InteractionTrace` 可被 C 消费。
- 运行时监督桥能加载 `SupervisionPolicyPack`。
- 至少 4 类行为被监督。
- 至少 1 个高风险动作被 `deny` 阻断。
- 阻断动作不会继续执行真实副作用。
- `RuntimeSupervisionRecord.policyPackId` 指向本次策略包。
- `RuntimeSupervisionRecord.policyId` 能在策略包中找到。
- C 能基于 B 的监督记录生成 `DefenseReport`。
- 所有新增代码通过 `npm run typecheck`。

## 13. 推荐执行顺序

```txt
1. 跑通并固定现有 full pipeline 验证
2. 新增 SupervisionBridge
3. 接入 tool_call / resource_access 的 preCheck
4. 实现 deny / warn
5. 增加 ask / redact 的最小实现
6. 扩展 file_write / email_send / api_call 半真实动作
7. 新增 verify-b-runtime-supervision.ts
8. 接入半真实 HTTP Agent
9. 与 C 联调 DefenseReport
10. 根据 C 前端展示需要补充 API 或导出字段
```

