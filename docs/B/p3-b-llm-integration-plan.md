# P3-B LLM 接入计划：Gateway 工具语义增强

文档版本: p3-b-llm-plan-1  
生成日期: 2026-06-19  
适用范围: B 线 Gateway、外部工具画像、未知工具解释、监督批测解释

## 1. 定位

B 线接入 LLM 的目标不是让模型接管监督，而是增强 B 线对开放外部工具的语义理解。

```txt
OpenClaw
  -> Agent Guard MCP Gateway
  -> External Tool Registry
  -> Rule ToolCapabilityProfile
  -> LLM semantic profile enhancement
  -> SupervisionPolicyPack / platform guardrail
  -> RuntimeSupervisionRecord[]
```

LLM 在 B 线只能作为辅助信号:

- 辅助识别外部工具能力。
- 辅助解释未知工具风险。
- 辅助解释监督批测结果。

LLM 不允许:

- 生成 `SupervisionPolicyPack`。
- 修改 C 线生成的策略包。
- 直接决定 allow / deny / ask / redact。
- 生成正式防御报告结论。

最终运行时动作仍由:

```txt
SupervisionPolicyPack + PolicyEngine + platform guardrail
```

决定。

## 2. 接入边界

### 2.1 B 线可做

```txt
ToolCapabilityProfile 语义增强
unknown tool 风险解释
SupervisionBatchResult 批测解释草案
LLM 调用审计 metadata
LLM 失败 fallback
```

### 2.2 B 线不可做

```txt
策略包生成
风险画像生成
防御报告结论生成
前端展示文案生成
把 LLM 输出直接当作阻断动作
```

## 3. 第一版实现范围

第一版只实现工具画像增强。

```txt
tools/list
  -> rule profiler
  -> optional LLM profiler
  -> merge profile
  -> ExternalToolRegistration.capabilityProfile
```

默认行为:

```txt
AGENT_GUARD_LLM_ENABLED unset / 0:
  只使用规则画像

AGENT_GUARD_LLM_ENABLED=1
AGENT_GUARD_LLM_MODE=mock:
  使用本地 mock LLM profiler，适合验证

AGENT_GUARD_LLM_ENABLED=1
AGENT_GUARD_LLM_MODE=openai_compatible:
  使用 OpenAI-compatible chat completions endpoint
```

第一版不在每次 `tools/call` 时调用 LLM，避免实时监督延迟和不确定性。

## 4. 配置

建议环境变量:

```txt
AGENT_GUARD_LLM_ENABLED=1
AGENT_GUARD_LLM_MODE=mock | openai_compatible
AGENT_GUARD_LLM_ENDPOINT=https://example.com/v1/chat/completions
AGENT_GUARD_LLM_API_KEY=...
AGENT_GUARD_LLM_MODEL=...
AGENT_GUARD_LLM_TIMEOUT_MS=5000
```

默认 mock 不需要 key，不访问网络。

## 5. LLM 输出契约

LLM 只能输出 `ToolCapabilityProfile` 的 patch，不输出完整运行时决策。

```ts
type LlmToolProfilePatch = {
  surfaces?: ToolSurface[]
  operations?: ToolOperation[]
  capabilityTags?: string[]
  riskTags?: string[]
  sideEffect?: ToolSideEffect
  dataClasses?: string[]
  networkReachability?: NetworkReachability
  sensitiveFields?: string[]
  confidence?: "low" | "medium" | "high"
  rationale?: string
}
```

约束:

- 输出必须通过 JSON schema 风格校验。
- 不认识的枚举值丢弃。
- 数组字段去重、限长。
- LLM 失败时使用规则画像。
- 画像来源标记为 `profileSource: "mixed"`，`llmAssisted: true`。

## 6. 安全约束

- 不把完整敏感 payload 发给 LLM。
- 第一版只发送工具名、描述、schema 摘要，不发送运行时用户数据。
- LLM 调用超时必须 fallback。
- LLM 输出不能覆盖 platform guardrail。
- LLM 输出不能让 unknown 工具降级为 allow。
- LLM 输出只改变画像，不直接改变监督动作。

## 7. 代码落点

```txt
backend/src/modules/llm/llmClient.ts
backend/src/modules/gateway/llmToolProfiler.ts
backend/src/modules/gateway/toolRegistry.ts
packages/contracts/src/types/gateway.ts
scripts/verify-p3-b-llm-profiler.ts
```

## 8. 阶段拆分

### B-LLM-1: LLM Client 抽象

交付:

```txt
LlmClient interface
MockLlmClient
OpenAI-compatible client
createConfiguredLlmClient()
```

验收:

- 默认不启用 LLM。
- mock 模式可稳定输出。
- openai-compatible 模式缺 endpoint/key 时不阻断主链路。

### B-LLM-2: LLM Tool Profiler

交付:

```txt
enhanceToolCapabilityProfileWithLlm()
mergeToolCapabilityProfiles()
profile cache key
```

验收:

- mock LLM 能把 `gmail_create_draft` 识别为 email / external。
- mock LLM 能把 `db_admin_export` 识别为 database / sensitive data。
- LLM 失败时回退规则画像。

### B-LLM-3: Gateway 注册流程接入

交付:

```txt
ExternalToolRegistry.registerAsync()
realtime external provider refresh 调用 async profile
static provider 可保持规则画像
```

验收:

- LLM 开启时，下游 MCP tools/list 画像带 `llmAssisted: true`。
- LLM 关闭时，现有 P3-B 验证脚本不退化。

### B-LLM-4: 批测解释草案

交付:

```txt
SupervisionBatchResult explanation draft
不进入 DefenseReport
交给 C 线后续展示
```

第一版可暂不实现。

## 9. 验证

新增:

```txt
npm run verify:p3:b-llm-profiler
```

最低覆盖:

```txt
1. LLM 默认关闭不影响规则画像
2. mock LLM 工具画像增强
3. LLM 输出非法枚举会被过滤
4. LLM 失败 fallback 到规则画像
5. P3-B Gateway 回归仍通过
```

## 10. 答辩口径

```txt
B 线使用 LLM 辅助理解开放外部工具的语义和风险面，
但实时监督动作仍由策略包和平台 guardrail 执行，
因此系统保持可解释、可复现、可审计。
```
