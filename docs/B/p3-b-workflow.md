# P3-B 工作流程：OpenClaw 外部工具实时监督网关

文档版本: p3-b-workflow-1  
生成日期: 2026-06-18  
适用范围: P3-B 分支下的 Gateway、外部工具接入、运行时监督、实时事件和监督证据链开发

## 1. 目标

P3-B 的目标不是重写 OpenClaw，也不是扩大前端展示范围，而是把 B 线职责做实:

```txt
OpenClaw
  -> Agent Guard MCP Gateway
  -> External Tool Registry
  -> ToolCapabilityProfile
  -> SupervisionPolicyPack 执行
  -> RuntimeSupervisionRecord[]
  -> realtime events
```

完成后必须能证明:

1. OpenClaw 只连接 Agent Guard 一个 MCP URL。
2. Agent Guard 能聚合外部 MCP provider 的工具。
3. 所有接入工具的 `tools/call` 都先经过 Agent Guard。
4. 已知高风险工具能 `deny / ask / redact`。
5. 未知工具不能静默放行。
6. 每次监督决策都能落到真实 `RuntimeSupervisionRecord[]`。

## 2. 开发原则

- B 线只执行 `SupervisionPolicyPack`，不生成策略包。
- B 线只产出运行时证据，不生成报告结论。
- Gateway 可以有 platform guardrail，但必须标记为平台安全边界，不能伪装成 C 生成的策略命中。
- 外部工具能力画像可以用 LLM 辅助，但最终执行必须由确定性策略和 guardrail 决定。
- 未知工具必须进入 `unknown_external_tool` 路径；当前默认 `deny`，并写入 `platform.guardrail.unknown_external_tool` 运行时记录。
- 每个阶段结束后必须进入审核，不允许“实现完成即通过”。

LLM 接入的独立计划见 `docs/B/p3-b-llm-integration-plan.md`。B 线 LLM 只做工具语义画像增强、未知工具解释和批测解释辅助，不生成策略包，不接管监督动作。

## 3. 推荐多 Agent 协作方式

可以使用多 agent 开发，但必须保持职责隔离。建议角色如下:

```txt
Lead / Integrator:
  负责主分支实现、代码合并、最终验收和取舍。

Contract Reviewer:
  只审核 contracts、API shape、RuntimeSupervisionRecord 字段和跨线兼容性。

Runtime Reviewer:
  只审核 Gateway、tools/list、tools/call、provider proxy、session 和实时事件。

Security Reviewer:
  只审核 unknown tool 默认行为、path/schema/provider guardrail、是否存在静默放行。

Test Reviewer:
  只审核验证脚本、失败路径、回归命令和证据链断言。

Docs Reviewer:
  只审核 P3plan、B 工作文档、接口说明和答辩口径是否一致。
```

多 agent 协作规则:

- Lead 负责改代码，Reviewer 默认只提审核意见。
- Reviewer 不直接改无关文件。
- 同一阶段至少经过 Runtime Reviewer 和 Test Reviewer 审核。
- 涉及策略字段、runtime record 字段或 API shape 时，必须加 Contract Reviewer。
- 涉及未知工具、外部 provider、payload 转发时，必须加 Security Reviewer。
- 审核意见必须按阻断、次要、建议分类。

## 4. 阶段拆分

### P3-B0: 契约和边界冻结

目标: 开工前冻结 B 线执行边界。

交付:

```txt
ExternalToolRegistration 草案
ToolCapabilityProfile 草案
Gateway provider 配置草案
RuntimeSupervisionRecord 扩展草案
unknown_external_tool 默认动作草案
```

验收:

- 不破坏 P2 API 和 OpenClaw realtime MCP 现有路径。
- `SupervisionPolicyPack` 仍由 C 生成，B 只执行。
- 新字段若进入共享对象，先更新 `docs/contracts.md` 和 `packages/contracts/src/types/**`。

审核:

- Contract Reviewer 必审。
- Runtime Reviewer 必审。

### P3-B1: External Tool Registry + ToolCapabilityProfile

目标: 所有接入工具都有注册信息和能力画像。

交付:

```txt
backend/src/modules/gateway/toolRegistry.ts
backend/src/modules/gateway/toolCapabilityProfiler.ts
backend/src/modules/gateway/toolTypes.ts
```

最低能力:

- 记录 provider、原始工具名、canonicalToolId、description、inputSchema。
- 生成规则版 `ToolCapabilityProfile`。
- 未识别工具标记 `surface: unknown`、`riskTags: unknown_behavior`。
- 保留 profile snapshot，用于后续监督记录。

验收:

- 至少一个 mock/downstream provider 的工具能注册。
- 工具名冲突不会覆盖已有工具。
- 未知工具有明确画像，不会被当作低风险工具。

审核:

- Runtime Reviewer 必审。
- Security Reviewer 必审。

### P3-B2: Gateway tools/list 聚合

目标: OpenClaw 从 Agent Guard Gateway 获取统一工具列表。

实现策略:

```txt
第一步:
  使用 static sandbox downstream provider 验证聚合、命名映射、画像和监督链路。

第二步:
  接入真实 downstream MCP provider client，替换或并存 static provider。
```

交付:

```txt
Gateway tools/list handler
downstream provider 静态配置
provider tools/list 拉取与聚合
agw__<providerId>__<toolName> 命名映射
```

验收:

- OpenClaw 只连接 Agent Guard MCP URL。
- `tools/list` 能返回聚合后的工具。
- 每个返回工具都能反查到 `ExternalToolRegistration`。
- provider 不可用时返回明确错误或降级状态，不影响其他 provider。

当前落地方式:

```txt
内置 provider:
  agent_guard_realtime
    -> 保留 P2/P3 已有 agent_guard_* 工具名

静态下游 provider:
  sandbox_downstream
    -> 暴露 agw__sandbox_downstream__<toolName>
    -> 用于稳定验证聚合、画像、监督和回归

真实下游 MCP provider:
  通过环境变量接入一个 streamable HTTP / JSON-RPC MCP endpoint
    AGENT_GUARD_DOWNSTREAM_MCP_URL
    AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID
    AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME
    AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS
  OpenClaw 仍只连接 Agent Guard 的 MCP URL，
  Agent Guard 在内部拉取下游 provider 的 tools/list 并映射为 agw__<providerId>__<toolName>。
```

当前验证:

```txt
npm run verify:p3:b-gateway
  -> 启动临时下游 MCP JSON-RPC server
  -> Gateway tools/list 聚合远端 run_shell
  -> tools/call 先进入 SupervisionBridge
  -> ask/demo_approve 后转发到远端 provider
  -> RuntimeSupervisionRecord 写入 gateway snapshot
```

审核:

- Runtime Reviewer 必审。
- Test Reviewer 必审。

### P3-B3: Gateway tools/call 拦截、监督、转发

目标: 所有接入工具调用先经过 Agent Guard 再转发。

交付:

```txt
Gateway tools/call handler
SupervisionRuntimeAction 构造
platform guardrail
PolicyEngine 调用
downstream tool call 转发
RuntimeSupervisionRecord[] 落盘
realtime events
```

验收:

- 已知高风险工具能触发 `deny / ask / redact`。
- 未知工具至少 `warn` 或 `ask`。
- 当前未知工具默认走平台 guardrail `deny`，不进入下游 provider。
- schema 异常、provider 不可信、payload 高危时不能静默放行。
- downstream 未执行和已执行状态必须可区分。
- 每次调用都能查询到对应 runtime record。

审核:

- Runtime Reviewer 必审。
- Security Reviewer 必审。
- Test Reviewer 必审。

### P3-B4: 监督批测入口

目标: 外部未知测试包复用同一监督链路进行批量测试。

交付:

```txt
supervision batch runner
batchId / externalCaseCount / supervisedToolCallCount
policyHitCount / blockedCount / askCount / warnedCount / redactedCount
batch -> RuntimeSupervisionRecord[] 关联
```

当前落地方式:

```txt
POST /api/v1/openclaw/realtime/supervision-batches
  -> 输入 runtimeSessionId / policyPackId / external cases
  -> 每个 case 复用 Gateway tools/call 路径
  -> 每条 RuntimeSupervisionRecord 写入 gateway.batch
  -> 返回 SupervisionBatchResult

GET /api/v1/openclaw/realtime/supervision-batches
  -> 按 runtimeSessionId 查询批测历史

GET /api/v1/openclaw/realtime/supervision-batches/:batchId
  -> 查询单个批测结果和 recordIds
```

当前计数口径:

```txt
policyHitCount:
  SupervisionPolicyPack 命中的运行时记录数

guardrailHitCount:
  platform guardrail 命中的运行时记录数

blockedCount / askCount / warnedCount / redactedCount:
  RuntimeSupervisionRecord.action 计数
```

验收:

- 批测不参与风险画像和策略包生成。
- 批测运行复用当前 Gateway、PolicyEngine 和 SupervisionPolicyPack。
- 批测结果能追溯到每条 runtime record。
- 监督界面可以把它作为当前 runtime session 下的验证动作展示。

审核:

- Contract Reviewer 必审。
- Test Reviewer 必审。
- Docs Reviewer 必审。

### P3-B5: 验证脚本和回归

目标: 用脚本证明 B 线链路真实可运行。

建议新增:

```txt
npm run verify:p3:b-gateway
```

最低覆盖:

```txt
1. Gateway initialize / ping
2. tools/list 聚合
3. ExternalToolRegistration 生成
4. ToolCapabilityProfile 生成
5. 已知工具 tools/call 监督
6. 未知工具 tools/call 不静默放行
7. deny / ask / redact 至少各有一条覆盖
8. RuntimeSupervisionRecord[] 可查询
9. realtime events 可订阅
10. batch test 复用同一监督链路
```

当前 `verify:p3:b-gateway` 已覆盖:

```txt
1. 真实下游 MCP provider tools/list 聚合
2. 真实下游 MCP provider tools/call 转发
3. 已知工具 deny / ask / redact
4. 未知工具 platform guardrail deny
5. batch API 复用同一 runtime session
6. batch -> RuntimeSupervisionRecord.recordId 反查
7. P2 / OpenClaw realtime 回归可独立运行
```

审核:

- Test Reviewer 必审。
- Lead 最终确认。

### P3-B6: LLM 工具语义画像增强

目标: 对开放外部 MCP 工具做可回退的语义理解增强。

交付:

```txt
LLM client abstraction
mock LLM profiler
OpenAI-compatible client
LLM ToolCapabilityProfile patch
profileSource: mixed
llmAssisted: true
```

验收:

- 默认关闭 LLM 时，P3-B Gateway 回归不退化。
- mock LLM 开启时，真实下游 MCP 工具画像能写入 `llmAssisted: true`。
- LLM 输出非法枚举会被过滤。
- LLM 失败时 fallback 到规则画像。
- LLM 不参与 allow / deny / ask / redact 最终决策。

当前验证:

```txt
npm run verify:p3:b-llm-profiler
npm run verify:p3:b-gateway
```

审核:

- Contract Reviewer 必审。
- Runtime Reviewer 必审。
- Security Reviewer 必审。

### P3-B7: 多 MCP Server Gateway 配置

目标: OpenClaw 仍只连接 Agent Guard 一个 MCP URL，但 Agent Guard 可以同时聚合多个外部 MCP server。

配置兼容:

```txt
旧单 provider:
  AGENT_GUARD_DOWNSTREAM_MCP_URL
  AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID
  AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME

新增多 provider:
  AGENT_GUARD_DOWNSTREAM_MCP_SERVERS=<JSON array or object>

运行时 API:
  POST /api/v1/runtime-config/downstream-mcp
  body.servers[]
```

`servers[]` 单项字段:

```txt
enabled
providerId
providerName
endpointUrl
timeoutMs
```

Gateway 行为:

```txt
servers[]
  -> 为每个 enabled server 创建 DownstreamMcpProvider
  -> 分别调用 tools/list
  -> 聚合成 agw__<providerId>__<toolName>
  -> tools/call 继续统一经过 SupervisionBridge
```

验收:

- 同时配置两个 MCP server 后，Gateway 返回两个 provider 的工具。
- `gatewayReload.externalProviderCount` 与启用 provider 数一致。
- providerId 重复时自动生成唯一 ID，避免覆盖。
- 单 provider 旧配置继续可用。
- 任一 provider 失败不应让其他 provider 的工具消失。

当前验证:

```txt
npm run verify:p3:b-gateway
  -> 通过 runtime-config API 写入两个 MCP server
  -> Gateway reload 后 externalProviderCount = 2
  -> tools/list 同时包含 stub_mcp 和 audit_mcp 工具
```

审核:

- Runtime Reviewer 必审。
- Security Reviewer 必审。
- Test Reviewer 必审。

## 5. 每个任务的完成定义

每个 P3-B 任务完成前必须满足:

```txt
1. 代码实现完成。
2. 单元或验证脚本覆盖核心成功路径。
3. 至少覆盖一个失败路径。
4. typecheck 通过。
5. 相关文档同步。
6. 自查没有破坏 P2 OpenClaw realtime MCP 路径。
7. Reviewer 审核通过或阻断项已关闭。
```

推荐命令:

```txt
npm run typecheck
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
npm run verify:p3:b-gateway
```

`verify:p3:b-gateway` 未实现前，必须在提交说明中明确“计划项未落地”，不能作为已完成验收。

## 6. 审核模板

审核必须优先列问题，不先写总结。

```txt
阻断:
- [文件:行号] 问题、影响、建议修复。

次要:
- [文件:行号] 问题、影响、建议修复。

建议:
- 可改进项，不阻断合并。

验证:
- 已运行命令
- 未运行命令及原因

结论:
- 通过 / 有条件通过 / 不通过
```

阻断项示例:

- 未知工具静默 allow。
- `tools/call` 未经过 PolicyEngine。
- runtime record 缺 `policyPackId`、`canonicalToolId` 或 action。
- platform guardrail 命中却伪装成策略命中。
- 批测样本参与了策略包生成。
- DefenseReport 无法回指 runtime record。

## 7. 合并前检查

合并 `p3-B` 前必须确认:

```txt
git status --short
npm run typecheck
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
npm run verify:p3:b-gateway
```

并确认:

- P2 主链路未退化。
- OpenClaw 仍只需要一个 Agent Guard MCP URL。
- Gateway 工具覆盖和未知工具处理有真实记录。
- 审核阻断项全部关闭。
- 文档和实际行为一致。
