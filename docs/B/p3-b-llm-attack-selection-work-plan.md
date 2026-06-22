# P3-B LLM 攻击库选择工作计划

文档版本: p3-b-llm-attack-selection-1
生成日期: 2026-06-21
适用范围: B 线检测前测试选择、OpenClaw/Gateway 运行编排、LLM 辅助攻击库样本排序
上游参考: `docs/p3-llm-attack-library-ab-plan.md`
实施蓝图: `docs/B/p3-b-test-selection-implementation-blueprint.md`

## 1. B 线定位

B 线在“LLM 选择攻击库”中的职责是把 A 线攻击库变成本次可执行的测试计划，并保证该计划真实运行、可追溯、可降级。

```txt
A 线:
  CorpusManifest / AttackCaseCard[] / TestContext loader

B 线:
  TestSelectionService
  -> RuleBasedCaseSelector
  -> optional LlmAssistedCaseReranker
  -> CoverageValidator
  -> TestSelectionPlan
  -> runTestCase / e2eRunService
  -> TestRun + InteractionTrace

C 线:
  RiskReport / DetectionReport / AgentRiskProfile / SupervisionPolicyPack / DefenseReport
```

B 线不生成攻击库，不生成风险画像，不生成策略包，不生成防御报告。LLM 在 B 线只能辅助选择和解释“为什么选这些 case”，不能直接输出风险结论或监督动作。

## 2. 最终目标

完成后，用户或前端可以在监督前检测阶段发起:

```txt
选择被测 Agent / OpenClaw
选择攻击库 profile: smoke / openclaw / regression
选择模式: rule_only / llm_assisted
设置 case 数量和时间预算
生成 TestSelectionPlan
锁定 TestSelectionPlan 并运行检测
```

B 线需要证明:

1. 选择计划中的每个 `caseId` 都来自 A 线攻击库。
2. 选择计划至少覆盖比赛要求的 3 类以上攻击场景。
3. LLM 不能创造不存在的 case。
4. LLM 输出失败或不合法时，系统自动降级到 rule-only。
5. 运行结果中的 `TestRun` / `InteractionTrace` 能回指 `selectionPlanId` 和 `caseId`。
6. 后续 C 线生成的风险画像和策略包仍来自真实 trace，不来自 LLM 选择理由。

## 3. 输入与输出

### 3.1 B 线输入

来自 A 线:

```txt
CorpusManifest
AttackCaseCard[]
caseId -> TestContext loader
CorpusRunProfile
```

来自系统当前状态:

```txt
AgentUnderTest
AgentAdapterConfig
OpenClaw / Gateway tool surface summary
ExternalToolRegistration[]
ToolCapabilityProfile[]
可选: 上一轮 AgentRiskProfile 摘要
```

来自用户或前端:

```txt
targetProfile
selectionMode
maxCaseCount
timeBudgetMs
requiredAttackFamilies
requiredTargetSurfaces
includeExternalTools
```

### 3.2 B 线输出

```txt
TestSelectionPlan
SelectionAuditLog
TestRun[]
InteractionTrace[]
```

`TestSelectionPlan` 建议字段:

```txt
selectionPlanId
agentId
corpusManifestId
mode: rule_only / llm_assisted / replay
targetProfile
requestedCaseCount
selectedCaseIds
selectedCasesSummary
coverageSnapshot
selectionReasons
llmAudit
fallbackReasons
createdAt
createdBy
```

## 4. 第一版实现边界

第一版不要一次做成“智能测试专家”。B 线先保证确定性闭环，然后再加 LLM。

第一版必须做:

```txt
rule_only selector
coverage gate
selection plan store
selectionPlanId -> test-runs/e2e
mock LLM rerank
LLM 输出校验和 fallback
验证脚本
```

第一版可以暂缓:

```txt
真实 LLM 大规模调优
复杂历史风险画像参与选择
前端高级交互
full-corpus 千级自动运行
基于 oracle 的智能评分
```

## 5. 推荐代码落点

B 线主责:

```txt
backend/src/modules/runner/testSelectionService.ts
backend/src/modules/runner/ruleBasedCaseSelector.ts
backend/src/modules/runner/coverageValidator.ts
backend/src/modules/runner/llmAssistedCaseReranker.ts
backend/src/modules/runner/selectionPlanStore.ts
backend/src/modules/runner/selectionAuditLogger.ts
backend/src/api/v1/test-selection/handlers.ts
scripts/verify-p3-b-test-selection.ts
docs/B/p3-b-llm-attack-selection-work-plan.md
```

共享受控:

```txt
packages/contracts/src/types/testSelection.ts
packages/contracts/src/index.ts
docs/contracts.md
docs/interfaces.md
backend/src/services/e2eRunService.ts
backend/src/api/v1/test-runs/handlers.ts
package.json
```

如果 A 线尚未提供正式 `AttackCaseCard[]`，B 线可以先做只读 adapter:

```txt
backend/src/modules/runner/corpusManifestAdapter.ts
```

该 adapter 只能把现有 `configs/test_cases.json` 或 generated corpus 摘要转换成候选 metadata，不得修改 A 线源数据。

## 6. 阶段计划

### B-SEL-0: 契约与边界冻结

目标: 冻结 B 线要消费和输出的最小对象。

交付:

```txt
TestSelectionRequest 草案
TestSelectionPlan 草案
CoverageSnapshot 草案
LlmSelectionAudit 草案
A -> B AttackCaseCard 最低字段确认
```

验收:

- `docs/contracts.md` 写清新增字段语义。
- `docs/interfaces.md` 写清 A -> B、B -> C 的影响。
- 明确 LLM 选择理由不进入 `Finding`、`RiskReport`、`DefenseClaim`。

审核重点:

- 是否把 C 线风险/策略职责误放到 B。
- 是否要求 A 线暴露完整攻击 prompt 或 TestOracle。

### B-SEL-1: Corpus 候选池读取

目标: B 线能够读取 A 线攻击库 metadata，形成可筛选候选池。

交付:

```txt
CandidateCaseRepository
loadCandidateCases(manifestId, profile)
caseId existence validation
case metadata normalization
```

验收:

- 能读取 `smoke` / `openclaw` profile 的候选 case。
- 每个候选 case 至少有 attack family、target surface、enabled、quality score。
- 候选池不包含 disabled case。
- 候选池不包含无法加载 `TestContext` 的 case。

失败处理:

- manifest 不存在 -> 400。
- profile 为空 -> 400。
- 候选池不足 -> 返回明确 `INSUFFICIENT_CASE_POOL`。

### B-SEL-2: Rule-only 选择器

目标: 无 LLM 情况下也能生成稳定测试计划。

交付:

```txt
RuleBasedCaseSelector
stable sorting
budget filter
required coverage fill
deterministic tie-break
```

规则建议:

```txt
优先保留 requiredAttackFamilies
优先覆盖不同 targetSurfaces
优先选择 requiresOpenClaw=true 且 openclaw profile 内 case
优先高 qualityScore
避免同一 attack family 占比过高
按 caseId 做稳定 tie-break
```

验收:

- 同样输入多次生成相同 `selectedCaseIds`。
- 至少覆盖 3 类攻击场景。
- 至少覆盖 tool_call / file_access / network 或 api 中的 2 类工具面。
- `maxCaseCount` 和 `timeBudgetMs` 生效。

### B-SEL-3: CoverageValidator

目标: 对 rule-only 和 LLM 输出统一做硬校验。

交付:

```txt
CoverageValidator
CoverageSnapshot
coverage warnings
coverage blocking issues
auto-fill missing coverage
```

最低 coverage gate:

```txt
minAttackFamilyCount >= 3
minCaseCount >= 用户 requested 下限或系统默认下限
requiredAttackFamilies 必须全部命中
selectedCaseIds 必须全部来自候选池
selectedCaseIds 不得重复
disabled case 不得进入计划
```

验收:

- LLM 返回不存在 caseId 会被拒绝。
- LLM 漏掉必测类别时，规则补齐或降级。
- coverage 不达标时不能标记计划为 ready。

### B-SEL-4: TestSelectionPlanStore

目标: 选择计划可以被锁定、复用、回放和审计。

交付:

```txt
createSelectionPlan()
getSelectionPlan()
listSelectionPlans()
selectionPlan status: draft / ready / running / completed / failed
```

存储建议:

```txt
outputs/test-selection/plans/<selectionPlanId>.json
```

验收:

- API 创建后能按 `selectionPlanId` 查询。
- plan 中保存 input digest、selectedCaseIds、coverageSnapshot。
- 后续 e2e run 可以引用 `selectionPlanId`。
- replay 模式不重新调用 LLM。

### B-SEL-5: LLM-assisted rerank

目标: 在规则候选和 coverage 底线之上加入 LLM 辅助排序与解释。

交付:

```txt
LlmAssistedCaseReranker
prompt template
LLM JSON output parser
output validator
fallback to rule_only
llmAudit
```

LLM 输入只允许:

```txt
Agent 工具面摘要
ToolCapabilityProfile 摘要
AttackCaseCard 脱敏摘要
目标 profile 和预算
coverage requirement 摘要
```

LLM 输出只允许:

```txt
rankedCaseIds
selectionReasons
coverageNotes
```

验收:

- mock LLM 可稳定通过。
- LLM 输出非法 JSON -> fallback。
- LLM 输出非法 caseId -> reject + fallback 或规则补齐。
- LLM 超时 -> fallback。
- `llmAudit` 记录 provider、model、duration、accepted/rejected caseIds。

安全要求:

- 不把完整攻击 prompt 发给 LLM。
- 不把 secret/token/key 发给 LLM。
- 不把 TestOracle 细节发给 LLM。
- LLM 选择理由不得进入风险结论。

### B-SEL-6: API 接入

目标: 前端和脚本可以创建、查询、运行选择计划。

建议接口:

```txt
POST /api/v1/test-selection/plans
GET  /api/v1/test-selection/plans
GET  /api/v1/test-selection/plans/:selectionPlanId
POST /api/v1/test-runs/e2e
```

`POST /api/v1/test-runs/e2e` 增加可选字段:

```txt
selectionPlanId
```

运行规则:

- 有 `selectionPlanId` 时，使用 plan 内 `selectedCaseIds`。
- 同时传 `caseIds` 和 `selectionPlanId` 时，默认拒绝，避免语义冲突。
- plan 未 ready 时不能运行。
- plan 已 running 时按实现选择拒绝或创建新 run group，但必须记录来源。

验收:

- 创建 plan -> 查询 plan -> e2e run -> runGroup 中能看到 `selectionPlanId`。
- plan 中每个 `caseId` 都产生对应 `TestRun` 或明确失败记录。
- API 错误码可读，不静默 fallback。

### B-SEL-7: e2eRunService 集成

目标: 选择计划真正进入 B 线运行链路，而不是只生成一份文档。

交付:

```txt
e2eRunService 支持 selectionPlanId
runGroup metadata 增加 selectionPlanId
TestRun / InteractionTrace metadata 增加 selectionPlanId
```

验收:

- `selectionPlanId -> selectedCaseIds -> TestContext -> TestRun -> InteractionTrace` ID 链不断。
- mock/http_sample/openclaw adapter 至少 mock 链路通过。
- OpenClaw 可用时，openclaw profile 能按 plan 运行。
- 失败 case 不影响其他 case 的错误记录和 runGroup 状态表达。

### B-SEL-8: 验证脚本和黑盒测试

目标: 一条命令证明 B 线能力真实闭合。

新增命令:

```txt
npm run verify:p3:b-test-selection
```

最低覆盖:

```txt
1. rule_only 创建选择计划
2. rule_only 覆盖 3 类攻击场景
3. mock LLM rerank 创建选择计划
4. LLM 返回非法 caseId 被拒绝
5. LLM 缺覆盖时被规则补齐
6. selectionPlanId 可查询
7. selectionPlanId 可触发 e2e mock run
8. TestRun / InteractionTrace 能回指 selectionPlanId
9. LLM 关闭时主链路不退化
```

可选覆盖:

```txt
OpenClaw CLI / realtime Gateway 可用时运行 openclaw profile
DeepSeek / OpenAI-compatible 可用时真实 LLM smoke
```

## 7. 与现有 B-LLM 工具画像计划的关系

现有 `docs/B/p3-b-llm-integration-plan.md` 解决的是:

```txt
外部工具 -> ToolCapabilityProfile 语义增强
```

本文档解决的是:

```txt
攻击库 metadata -> TestSelectionPlan 选择编排
```

两者共用:

```txt
backend/src/modules/llm/llmClient.ts
runtime LLM config
mock / openai-compatible client
LLM audit metadata
```

两者不能混用职责:

- 工具画像 LLM 不选择测试 case。
- 攻击库选择 LLM 不决定工具调用 allow/deny。
- 两者输出都不能直接生成策略包或防御报告。

## 8. 审核重点

阻断项:

- B 线把 LLM 选择理由写成风险结论。
- B 线让 LLM 直接生成 `SupervisionPolicyPack`。
- B 线发送完整攻击 prompt、secret、TestOracle 给 LLM。
- LLM 可以创建不存在的 caseId。
- coverage 不达标仍允许 ready plan。
- `selectionPlanId` 无法回指运行结果。
- rule-only 模式不可用。

次要项:

- selection reason 不够可读。
- coverageSnapshot 缺少部分统计。
- API 错误码不够细。
- plan store 暂时只支持文件存储。

建议项:

- 增加 replay 模式用于答辩复现。
- 增加真实 LLM 和 mock LLM 的选择差异对比。
- 后续让 C 线 ReportBundle 展示选择计划，但不把选择理由当证据结论。

## 9. 最小交付建议

如果只剩很少时间，B 线按以下顺序做:

```txt
1. RuleBasedCaseSelector
2. CoverageValidator
3. TestSelectionPlanStore
4. selectionPlanId -> e2eRunService
5. mock LLM rerank + fallback
6. verify:p3:b-test-selection
```

真实 LLM 接入可以复用已有 runtime config 和 `LlmClient`，但不作为最小验收阻断项。最小版本只要能证明“LLM 辅助选择接口已闭合、规则底线可运行、选择计划能真实驱动检测”，就具备答辩价值。

## 10. 合并前检查

```txt
git status --short
npm run typecheck
npm run verify:p2:api-e2e
npm run verify:p3:b-gateway
npm run verify:p3:b-llm-profiler
npm run verify:p3:b-test-selection
```

如果 `verify:p3:b-test-selection` 尚未实现，不得声称 B 线 LLM 攻击库选择已完成，只能标记为计划项或部分完成。
