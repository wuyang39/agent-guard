# P3 OpenClaw 外部工具实时监督网关最终设计

文档版本: p3-external-tool-gateway-1  
生成日期: 2026-06-17  
状态: 最后一轮设计稿  
适用范围: P2 之后的最后一轮重点改造，用最小可控范围补齐 OpenClaw 工具监督面，支撑信息安全作品赛答辩

## 1. 最终判断

旧 P3 的“全链路实时监督”方向正确，但范围过大。最后一轮不适合继续扩展到完整记忆中毒、完整上下文隔离、模型调用链路和 OpenClaw 内核级拦截。

最后一轮的主目标应收缩为:

```txt
实现 OpenClaw 外部工具统一接入 Agent Guard Gateway，
让所有接入 Gateway 的外部工具调用都经过实时监督。
```

这里的“所有工具”必须明确边界:

```txt
覆盖:
  所有通过 Agent Guard Gateway 接入的 MCP 工具和外部工具。

不承诺覆盖:
  OpenClaw 内部不可见动作、未接入 Gateway 的本地原生能力、模型 provider 内部调用。

补充能力:
  对未经过 Gateway 但出现在 OpenClaw CLI JSONL / session 中的行为做事后分析和盲区报告。
```

这个设计比“大而全 P3”更合理，因为它能解决当前系统最大短板: 现在监督面像是在监督系统自带的几个 `agent_guard_*` 工具，而不是监督 OpenClaw 使用的外部工具生态。

## 2. 最终系统定位

P3 最终定位:

```txt
Agent Guard 是 OpenClaw 的外部工具安全网关。
OpenClaw 只连接 Agent Guard 一个 MCP URL。
Agent Guard 负责接入、画像、监督、代理、记录和报告所有外部工具调用。
```

最终主链路:

```txt
内置红队测试
  -> OpenClaw CLI 检测
  -> Trace / RiskReport / DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack

OpenClaw
  -> Agent Guard MCP Gateway
  -> 外部工具注册表 / 工具能力画像
  -> PolicyEngine / Guardrail
  -> allow / deny / ask / warn / redact
  -> Downstream MCP Tool / Sandbox
  -> RuntimeSupervisionRecord[]

外部未知样本监督批测
  -> OpenClaw
  -> 同一个 Agent Guard MCP Gateway
  -> 同一个 SupervisionPolicyPack
  -> Supervision Batch Test Metrics
  -> DefenseReport
```

未知测试包不再作为单独检测系统存在。它本质上是监督环节的批量验证测试:

```txt
外部未知样本监督批测
```

它和实时监督共用同一个 Gateway、策略包、PolicyEngine 和监督记录，只是输入样本来自未参与策略生成的外部测试包，评价口径从单次监督变成批量监督效果统计。

## 3. 三个视角的最后一轮取舍

### 3.1 用户视角

用户最需要看到的是:

```txt
我接入一个外部工具
OpenClaw 能看到这个工具
OpenClaw 调用它时系统能实时看到
系统能判断、阻断、询问、告警或脱敏
报告能证明这次监督确实发生过
```

因此 P3 不应继续堆抽象概念，而应让用户在页面或终端看到:

- 已接入工具数量。
- 每个工具的能力画像和风险标签。
- 每次工具调用的实时监督事件。
- 未知工具是否被默认监督。
- 防御报告中的工具覆盖面、命中数、阻断数和残余风险。

### 3.2 产品经理视角

比赛要求的是行为监督原型系统，不是完整商业安全网关。最后一轮产品叙事应聚焦:

```txt
画像驱动的 OpenClaw 外部工具实时监督系统
```

产品亮点:

1. 用内置红队测试生成风险画像和策略包。
2. 用 Agent Guard Gateway 统一接入 OpenClaw 外部工具。
3. 对所有接入工具进行实时监督。
4. 用外部未知样本批量测试监督策略在未见样本上的命中效果。
5. 输出包含证据链的防御报告。

暂缓内容:

- 完整记忆中毒实时防御。
- 完整上下文隔离。
- 模型调用链路监控。
- 修改 OpenClaw 核心源码。
- 数据库、多用户、权限系统。

### 3.3 资深工程师视角

最后一轮工程落点应是 MCP Gateway / Proxy，不改 OpenClaw 核心。

目标结构:

```txt
OpenClaw
  -> Agent Guard MCP Gateway
       -> tools/list 聚合外部工具
       -> tools/call 拦截工具调用
       -> ToolCapabilityProfiler 生成工具能力画像
       -> PolicyEngine 执行策略包
       -> PlatformGuardrail 执行最低安全边界
       -> SupervisionRecorder 记录监督结果
       -> DownstreamToolClient 转发到外部 MCP 工具
  -> OpenClaw
```

工程原则:

- 先代理工具，再谈全链路。
- 先覆盖所有接入工具，再逐步提高语义判断能力。
- 工具画像可用 LLM 辅助，但最终执行必须由确定性策略和 guardrail 决定。
- 未知工具不能绕过监督，必须进入 `unknown_external_tool` 路径。

## 4. 核心设计: 外部工具接入与监督

### 4.1 External Tool Registry

新增外部工具注册表，用于记录每个接入工具的来源、schema、画像和监督状态。

建议对象:

```txt
ExternalToolRegistration:
  registrationId
  providerId
  providerName
  providerType
  originalToolName
  canonicalToolId
  description
  inputSchema
  outputSchema?
  capabilityProfile
  enabled
  createdAt
  updatedAt
```

`canonicalToolId` 不应压成小枚举，而应采用稳定命名:

```txt
mcp.<providerId>.<toolName>
agent_guard.<toolName>
openclaw.<toolName>
custom.<providerId>.<toolName>
```

### 4.2 Tool Capability Profile

P3 不再使用狭窄的“工具类型归一”。正确方式是“工具能力画像与风险标签化”。

建议对象:

```txt
ToolCapabilityProfile:
  originalToolName
  canonicalToolId
  providerType
  surfaces[]
  operations[]
  capabilityTags[]
  riskTags[]
  sideEffect
  dataClasses[]
  authScopes[]
  networkReachability
  sensitiveFields[]
  confidence
  profileSource
  llmAssisted
```

字段解释:

```txt
surfaces:
  tool / resource / code / network / communication / memory / browser / database / model / unknown

operations:
  read / write / execute / send / query / search / delete / update / list / navigate / transform / unknown

capabilityTags:
  filesystem.read
  filesystem.write
  shell.execute
  network.http
  browser.navigate
  database.query
  memory.write
  email.send
  secret.access
  credential.submit

riskTags:
  external_side_effect
  sensitive_data
  destructive
  credential_access
  data_exfiltration
  privilege_escalation
  prompt_injection_surface
  unknown_behavior

sideEffect:
  none / read / write / external / destructive / unknown

profileSource:
  rule / llm / manual / mixed
```

这样设计的关键价值:

- 不限制外部工具种类。
- 未知工具也能被监督。
- 策略可以匹配能力标签、风险标签、operation、schema 和 payload。
- 后续接入 browser、database、memory、search 等工具时不需要重写核心枚举。

### 4.3 Unknown Tool 默认策略

未知工具不能默认放行。

建议默认规则:

```txt
已知低风险工具:
  allow + record

已知高风险工具:
  ask / deny / redact

未知外部工具:
  warn 或 ask

未知且存在外部副作用:
  ask

未知且疑似读取敏感信息、写文件、发网络请求:
  deny 或 ask

schema 缺失、参数异常、provider 不可信:
  deny
```

报告中必须展示:

```txt
unknownToolCount
unknownToolCallCount
unknownToolBlockedCount
unknownToolAskCount
```

## 5. MCP Gateway 设计

### 5.1 tools/list 聚合

Agent Guard Gateway 对 OpenClaw 暴露一个 MCP endpoint。

OpenClaw 请求:

```txt
tools/list
```

Agent Guard 行为:

```txt
1. 读取 downstream MCP provider 配置
2. 拉取每个 provider 的 tools/list
3. 为每个工具生成 ExternalToolRegistration
4. 生成或更新 ToolCapabilityProfile
5. 返回统一工具列表给 OpenClaw
```

返回给 OpenClaw 的工具名可以采用安全前缀，避免 provider 冲突:

```txt
agw__<providerId>__<toolName>
```

内部仍保留原始工具名和 provider 信息。

### 5.2 tools/call 拦截

OpenClaw 请求:

```txt
tools/call(name, arguments)
```

Agent Guard 行为:

```txt
1. 解析 gateway tool name
2. 找到 ExternalToolRegistration
3. 生成 SupervisionRuntimeAction
4. 执行 platform guardrail
5. 执行 SupervisionPolicyPack
6. 根据结果 allow / deny / ask / warn / redact
7. 如需执行，转发给 downstream MCP provider
8. 记录 RuntimeSupervisionRecord[]
9. 返回工具结果或阻断结果给 OpenClaw
```

### 5.3 监督记录最小字段

每次工具调用至少记录:

```txt
runtimeSessionId
recordId
policyPackId
policyId?
providerId
originalToolName
canonicalToolId
capabilityProfileSnapshot
action
decisionReason
payloadSummary
redactionSummary?
downstreamExecuted
downstreamResultSummary?
createdAt
```

注意: `capabilityProfileSnapshot` 很重要。它能证明当时系统是根据什么工具画像做的判断，避免后续工具画像变化后证据链断裂。

## 6. 策略包匹配方式

P3 策略不应只匹配小枚举 `targetType`，而应支持多维匹配。

建议策略匹配输入:

```txt
SupervisionRuntimeAction:
  targetType
  canonicalToolId
  originalToolName
  providerId
  providerType
  surfaces[]
  operations[]
  capabilityTags[]
  riskTags[]
  sideEffect
  payload
  payloadSummary
  dataClasses[]
```

策略示例:

```txt
match:
  riskTags contains data_exfiltration
  payload contains token
action:
  deny
```

```txt
match:
  capabilityTags contains filesystem.read
  payload.path starts_with /secret/
action:
  deny
```

```txt
match:
  sideEffect equals external
  confidence less_than medium
action:
  ask
```

平台最低安全边界可以先于策略执行:

```txt
schema_invalid -> deny
path_escape -> deny
provider_untrusted -> ask/deny
credential_in_outbound_payload -> redact/deny
```

这些记录应标记为:

```txt
decisionSource: platform_guardrail
```

而不是伪装成 C 生成的策略命中。

## 7. LLM 的合理使用方式

P3 可以接 LLM，但定位必须正确:

```txt
LLM = 语义分析和辅助画像层
PolicyEngine / Guardrail = 最终执行层
```

适合接 LLM 的功能:

1. **工具能力画像**
   根据工具名、description、inputSchema 推断 surfaces、operations、capabilityTags、riskTags、sideEffect、sensitiveFields。

2. **输入语义检测**
   对监督批测样本、用户输入、工具返回文本做 prompt injection / jailbreak / policy override 检测。

3. **输出语义检测**
   对 OpenClaw 最终回复做系统提示词泄露、敏感信息泄露、危险操作指导检测。

4. **策略包草拟**
   根据 AgentRiskProfile 和 ToolCapabilityProfile 生成策略建议，再由 C 模块校验、规范化和编译。

5. **报告解释**
   生成自然语言说明，但统计数字和证据链必须来自系统真实记录。

不允许 LLM 直接决定:

```txt
是否执行危险工具
是否读取敏感文件
是否发送外部 API 请求
DefenseReport 统计数字
证据链 ID
策略命中结果
```

LLM 输出必须:

```txt
结构化 JSON
通过 schema 校验
带 confidence
可被规则覆盖
可被人工审查
```

## 8. 外部未知样本监督批测

外部未知测试包本质上是对监督环节的批量测试。P3 不再单独建设另一套风险发现机制，也不把未知测试包用于生成风险画像或策略包。

统一流程:

```txt
1. 内置样本生成 AgentRiskProfile 和 SupervisionPolicyPack
2. 启动 Agent Guard MCP Gateway
3. 外部未知测试包批量输入 OpenClaw
4. OpenClaw 调用接入 Gateway 的外部工具
5. Gateway 使用同一个 SupervisionPolicyPack 做实时监督
6. 记录 RuntimeSupervisionRecord[]
7. 按批次汇总 Supervision Batch Test Metrics
8. DefenseReport 合并监督批测结果
```

关键指标:

```txt
batchId
externalCaseCount
executedCaseCount
supervisedToolCallCount
policyHitCount
blockedCount
warnedCount
redactedCount
askCount
unknownToolCallCount
supervisionHitRate
residualRiskCount
evidenceChainCompleteness
```

关键约束:

- 外部未知测试包不能参与风险画像和策略包生成。
- 外部未知测试包只用于批量测试监督环节。
- 批测运行时必须走同一个 Gateway、同一个 PolicyEngine 和同一个 SupervisionPolicyPack。
- 批测结果应按 batch 归档，并能追溯到每条 `RuntimeSupervisionRecord`。
- 报告必须区分 `built_in_profile_sample` 和 `external_supervision_batch_sample`。

## 9. 最后一轮实施范围

### 必做

```txt
P3-M1 External Tool Registry
P3-M2 ToolCapabilityProfile
P3-M3 MCP Gateway tools/list 聚合
P3-M4 MCP Gateway tools/call 拦截与转发
P3-M5 所有接入工具生成 RuntimeSupervisionRecord[]
P3-M6 unknown_external_tool 默认监督路径
P3-M7 实时事件流展示工具调用和监督决策
P3-M8 DefenseReport 增加工具覆盖与监督批测指标
```

### 应做

```txt
P3-S1 LLM Tool Profiler
P3-S2 InputGuard-lite
P3-S3 OutputGuard-lite
P3-S4 外部未知样本监督批测 runner
P3-S5 前端展示工具能力画像和 coverage matrix
```

### 暂缓

```txt
完整记忆中毒实时防御
完整上下文隔离
模型调用链路监控
修改 OpenClaw 核心源码
生产级数据库
多用户权限
复杂策略编辑器
```

## 10. A/B/C 分工

### A 线

A 负责测试样本和策略模板:

1. 标记内置画像样本和外部监督批测样本。
2. 扩展工具劫持、数据泄露、越权访问、代码执行、API 外泄样本。
3. 提供工具能力画像的人工校验样本。
4. 维护策略模板与 capabilityTags/riskTags 的映射建议。

### B 线

B 负责 Gateway 和运行时监督:

1. 实现 External Tool Registry。
2. 实现 MCP Gateway tools/list 聚合。
3. 实现 tools/call 拦截、监督、转发。
4. 实现 ToolCapabilityProfile 的规则版生成。
5. 接入可选 LLM Tool Profiler。
6. 记录 RuntimeSupervisionRecord[] 和实时事件。
7. 保证未知工具不会绕过监督。

### C 线

C 负责策略包、报告和前端:

1. 扩展 SupervisionPolicyPack 对 capabilityTags/riskTags 的匹配支持。
2. 扩展 DefenseReport 的工具覆盖和监督批测指标。
3. 前端展示接入工具、工具画像、实时监督事件、策略命中和报告。
4. 确保 LLM 生成内容只作为解释或建议，不覆盖真实统计。

## 11. 前端最终展示

最后一轮前端不需要做复杂新产品，只需要把核心能力讲清楚。

建议增加或强化:

```txt
Gateway Status:
  active policy pack
  connected providers
  registered tools
  unknown tools

Tool Coverage:
  tool name
  provider
  capability tags
  risk tags
  default action
  call count
  blocked / warned / asked / redacted

Live Supervision:
  tool_call_started
  supervision_decision
  tool_call_result
  policy hit
  platform guardrail hit

Supervision Batch Test:
  external batch
  policy hit rate
  blocked / warned / asked / redacted
  residual risk

Defense Report:
  registered tool count
  supervised call count
  policy hit count
  unknown tool handled count
  blocked / warn / ask / redact
  evidence links
```

## 12. 验收标准

P3 最后一轮完成标准:

1. OpenClaw 只连接 Agent Guard 一个 MCP URL。
2. Agent Guard 能聚合至少一个外部 MCP provider 的工具。
3. 聚合工具会生成 ExternalToolRegistration。
4. 每个工具都有 ToolCapabilityProfile。
5. 所有接入工具的 `tools/call` 都先经过 Agent Guard。
6. 已知高风险工具能被 deny / ask / redact。
7. 未知工具不会静默放行，至少 warn 或 ask。
8. 每次工具调用都生成 RuntimeSupervisionRecord。
9. 实时事件流能看到工具调用和监督决策。
10. 外部未知测试包能复用同一条监督链路进行批量测试。
11. DefenseReport 能展示工具覆盖、策略命中、监督批测结果、未知工具处理和残余风险。
12. 文档和前端都不宣称覆盖未接入 Gateway 的 OpenClaw 内部行为。

## 13. 答辩口径

推荐表达:

```txt
本系统以 OpenClaw 为核心演示 Agent。P2 已经完成 OpenClaw 检测、风险画像、策略包和实时 MCP 监督闭环。P3 最后一轮将系统升级为 OpenClaw 外部工具实时监督网关: OpenClaw 只连接 Agent Guard 一个 MCP URL，所有接入 Gateway 的外部工具都会被注册、画像、打风险标签并接受策略包监督。系统不依赖固定工具类型枚举，而是基于工具能力画像和风险标签判断未知工具风险。外部未知测试包不参与画像和策略生成，而是在监督开启后复用同一 Gateway、同一策略包和同一 PolicyEngine 批量测试监督效果，最终输出包含工具覆盖面、阻断记录、告警记录、监督批测命中率、残余风险和证据链的防御报告。
```

边界表达:

```txt
当前实时阻断覆盖所有接入 Agent Guard Gateway 的外部工具。
未接入 Gateway 的 OpenClaw 内部行为不宣称实时阻断，但可以通过 OpenClaw CLI / JSONL 做事后分析和盲区报告。
LLM 只用于工具画像、语义风险提示和报告解释，不直接作为最终安全执行器。
```

## 14. 最小下一步

建议下一步只开以下任务，不再扩散:

```txt
1. 设计 ExternalToolRegistration 和 ToolCapabilityProfile 类型。
2. 实现一个静态 downstream MCP provider 配置。
3. 让 Agent Guard Gateway 聚合 provider 的 tools/list。
4. 让 tools/call 经过 PolicyEngine 后再转发。
5. 为 unknown_external_tool 增加默认 ask/warn/deny 策略。
6. 把监督结果写入现有 RuntimeSupervisionRecord[]。
7. 前端和报告展示工具覆盖与未知工具处理。
```

这一版 P3 足够贴合比赛要求，也不会把最后一轮拖进不可控的大工程。
