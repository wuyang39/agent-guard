# P3-B 测试选择实施蓝图

文档版本: p3-b-test-selection-blueprint-1
生成日期: 2026-06-22
状态: 第一版已实现，等待 A 线正式 CorpusManifest 联调
适用范围: B 线 LLM 攻击库选择、rule-only 选择、选择计划持久化、e2eRunService 接入
上游文档:

- `docs/p3-llm-attack-library-ab-plan.md`
- `docs/B/p3-b-llm-attack-selection-work-plan.md`
- `docs/B/p3-b-llm-integration-plan.md`

## 1. 当前判断

A 线正式攻击库还没有上传，但 B 线可以先动工，前提是采用 provider/adapter 模式:

```txt
B 线核心逻辑依赖 CandidateCaseRepository 接口
  -> 当前临时实现: 从现有 configs/test_cases.json / loadTestContexts 派生候选卡片
  -> A 线上传后: 替换为 CorpusManifest / AttackCaseCard provider
```

这样 B 线先完成选择器、校验器、计划存储、API、e2e 运行接入和验证脚本；A 线到位后只需要替换候选池来源，不重写 B 线业务流程。

## 2. 实施目标

第一轮实现目标:

```txt
POST /api/v1/test-selection/plans
  -> 创建 rule_only 或 llm_assisted 选择计划
  -> 返回 TestSelectionPlan

GET /api/v1/test-selection/plans/:id
  -> 查询选择计划

POST /api/v1/test-runs/e2e { selectionPlanId }
  -> 按选择计划运行已选 case
  -> runGroup / trace 能回指 selectionPlanId

npm run verify:p3:b-test-selection
  -> 黑盒证明选择计划能驱动真实 B 线检测链路
```

第一轮不要求:

- A 线完整千级 corpus 到位。
- 真实 DeepSeek 选择效果达到最优。
- 前端完整交互完成。
- C 线 ReportBundle 已展示选择计划。

## 3. 不变边界

B 线必须遵守:

```txt
不生成 SupervisionPolicyPack
不生成 AgentRiskProfile
不生成 DetectionReport 之外的新风险结论
不把 LLM selection reason 写入 Finding / RiskReport / DefenseClaim
不发送完整攻击 prompt / secret / TestOracle 给 LLM
不允许 LLM 创建不存在的 caseId
```

LLM 只允许:

```txt
对候选 caseId 排序
给出选择理由
指出覆盖建议
```

最终能否进入计划由 `CoverageValidator` 决定。

## 4. 数据对象设计

### 4.1 TestSelectionRequest

用途: 创建选择计划的请求。

```ts
type TestSelectionRequest = {
  schemaVersion: "mvp-1";
  agentId?: string;
  manifestId?: string;
  targetProfile: "smoke" | "openclaw" | "regression" | "full-corpus";
  selectionMode: "rule_only" | "llm_assisted";
  maxCaseCount?: number;
  minCaseCount?: number;
  timeBudgetMs?: number;
  requiredAttackFamilies?: string[];
  requiredTargetSurfaces?: string[];
  includeExternalTools?: boolean;
  adapterKind?: "mock" | "http_sample" | "openclaw";
};
```

第一版默认值:

```txt
targetProfile: openclaw
selectionMode: rule_only
maxCaseCount: 7
minCaseCount: 3
requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"]
```

### 4.2 CandidateCaseCard

用途: B 线选择器内部消费的候选用例卡片。A 线正式对象到位前，B 线先使用兼容子集。

```ts
type CandidateCaseCard = {
  caseId: string;
  caseName: string;
  enabled: boolean;
  runProfiles: string[];
  attackFamilies: string[];
  targetSurfaces: string[];
  targetToolHints: string[];
  sensitivityTags: string[];
  estimatedDurationMs?: number;
  requiresExternalTool?: boolean;
  requiresOpenClaw?: boolean;
  sourceOrigin: "pyrit" | "aig" | "manual" | "user_supplied" | "synthetic" | "derived";
  promptSummary?: string;
  payloadRiskSummary?: string;
  expectedSafeBehaviorSummary?: string;
  qualityScore: number;
};
```

临时 adapter 映射原则:

```txt
已有 caseId / name -> caseId / caseName
已有 scenario / risk tags -> attackFamilies
已有 sandbox tools/resources -> targetSurfaces / targetToolHints
没有质量评分 -> qualityScore = 0.6
没有 profile -> 默认 ["smoke", "openclaw"]
```

### 4.3 TestSelectionPlan

用途: B 线输出、可回放、可作为 e2e run 输入的选择计划。

```ts
type TestSelectionPlan = {
  schemaVersion: "mvp-1";
  selectionPlanId: string;
  agentId: string;
  corpusManifestId: string;
  status: "draft" | "ready" | "running" | "completed" | "failed";
  mode: "rule_only" | "llm_assisted" | "replay";
  targetProfile: string;
  requestedCaseCount: number;
  selectedCaseIds: string[];
  selectedCasesSummary: SelectedCaseSummary[];
  coverageSnapshot: CoverageSnapshot;
  selectionReasons: SelectionReason[];
  llmAudit?: LlmSelectionAudit;
  fallbackReasons: string[];
  createdAt: string;
  updatedAt: string;
};
```

### 4.4 CoverageSnapshot

```ts
type CoverageSnapshot = {
  attackFamilyCount: number;
  targetSurfaceCount: number;
  selectedCaseCount: number;
  coveredAttackFamilies: string[];
  coveredTargetSurfaces: string[];
  missingRequiredAttackFamilies: string[];
  missingRequiredTargetSurfaces: string[];
  blockingIssues: string[];
  warnings: string[];
  ready: boolean;
};
```

### 4.5 LlmSelectionAudit

```ts
type LlmSelectionAudit = {
  enabled: boolean;
  provider: string;
  model?: string;
  promptTemplateVersion: string;
  inputDigest: string;
  outputDigest?: string;
  durationMs?: number;
  acceptedCaseIds: string[];
  rejectedCaseIds: string[];
  validationWarnings: string[];
  fallbackUsed: boolean;
};
```

## 5. 模块设计

### 5.1 CandidateCaseRepository

文件:

```txt
backend/src/modules/runner/candidateCaseRepository.ts
```

职责:

```txt
loadCandidateCases(request) -> CandidateCaseCard[]
validateCaseIds(caseIds) -> valid / invalid
resolveCaseIdsFromSelectionPlan(selectionPlanId) -> caseIds
```

第一版实现:

```txt
loadTestContexts(CONFIGS_DIR, agent)
  -> 从 TestContext 派生 CandidateCaseCard
  -> 不读取 TestOracle
  -> 不修改 configs
```

A 线到位后:

```txt
CorpusManifestCandidateCaseRepository
  -> 读取 generated/a-line/corpus_manifest.json
  -> 读取 AttackCaseCard[]
```

### 5.2 RuleBasedCaseSelector

文件:

```txt
backend/src/modules/runner/ruleBasedCaseSelector.ts
```

职责:

```txt
filter disabled / incompatible case
按 requiredAttackFamilies 补齐
按 requiredTargetSurfaces 补齐
按 qualityScore / coverage diversity 排序
输出 selectedCaseIds + reasons
```

排序稳定性:

```txt
score desc
attackFamily scarcity desc
targetSurface scarcity desc
qualityScore desc
caseId asc
```

### 5.3 CoverageValidator

文件:

```txt
backend/src/modules/runner/coverageValidator.ts
```

职责:

```txt
检查 selectedCaseIds 均来自候选池
检查无重复
检查 minCaseCount
检查 requiredAttackFamilies
检查 requiredTargetSurfaces
生成 CoverageSnapshot
必要时返回补齐建议
```

阻断规则:

```txt
unknown caseId -> blocking
duplicate caseId -> blocking
selectedCaseCount < minCaseCount -> blocking
attackFamilyCount < 3 -> blocking
requiredAttackFamilies missing -> blocking
```

### 5.4 LlmAssistedCaseReranker

文件:

```txt
backend/src/modules/runner/llmAssistedCaseReranker.ts
```

职责:

```txt
接收候选 case metadata 摘要
调用已有 LlmClient
解析 rankedCaseIds / selectionReasons / coverageNotes
过滤非法 caseId
交给 CoverageValidator 二次校验
失败 fallback 到 rule-only
```

复用:

```txt
backend/src/modules/llm/llmClient.ts
runtime LLM config
mock / openai_compatible 模式
```

LLM prompt 必须强调:

```txt
只能从 candidateCaseIds 中选择
不能创造 case
不能输出风险结论
只返回 JSON
```

### 5.5 TestSelectionPlanStore

文件:

```txt
backend/src/modules/runner/selectionPlanStore.ts
```

职责:

```txt
saveSelectionPlan(plan)
getSelectionPlan(id)
listSelectionPlans()
updateSelectionPlanStatus(id, status)
```

存储位置:

```txt
outputs/test-selection/plans/<selectionPlanId>.json
```

### 5.6 TestSelectionService

文件:

```txt
backend/src/modules/runner/testSelectionService.ts
```

职责:

```txt
createSelectionPlan(request)
  -> load candidates
  -> rule select
  -> optional llm rerank
  -> validate coverage
  -> save ready/draft plan

getSelectionPlan(id)
listSelectionPlans()
```

状态规则:

```txt
coverageSnapshot.ready = true  -> status ready
存在 blockingIssues           -> status draft
e2e run 开始                   -> status running
e2e run 完成                   -> status completed
e2e run 失败                   -> status failed
```

## 6. API 设计

### 6.1 POST /api/v1/test-selection/plans

请求:

```json
{
  "schemaVersion": "mvp-1",
  "agentId": "agent.openclaw.main",
  "targetProfile": "openclaw",
  "selectionMode": "llm_assisted",
  "maxCaseCount": 7,
  "requiredAttackFamilies": [
    "prompt_injection",
    "data_leakage",
    "tool_hijack"
  ],
  "adapterKind": "openclaw"
}
```

响应:

```txt
ApiResponse<TestSelectionPlan>
```

错误:

```txt
400 INVALID_SELECTION_REQUEST
400 INSUFFICIENT_CASE_POOL
500 TEST_SELECTION_FAILED
```

### 6.2 GET /api/v1/test-selection/plans

响应:

```txt
ApiResponse<{ items: TestSelectionPlan[] }>
```

### 6.3 GET /api/v1/test-selection/plans/:selectionPlanId

响应:

```txt
ApiResponse<TestSelectionPlan>
```

错误:

```txt
404 TEST_SELECTION_PLAN_NOT_FOUND
```

### 6.4 POST /api/v1/test-runs/e2e 增强

新增请求字段:

```txt
selectionPlanId?: string
```

规则:

```txt
selectionPlanId 与 caseIds 不能同时传
selectionPlanId 存在时从 plan 读取 selectedCaseIds
plan.status 必须是 ready / completed / replayable 语义之一
runGroup.metadata.selectionPlanId 必须写入
```

建议第一版:

```txt
只允许 ready plan 运行
运行后 plan status 改为 running -> completed / failed
```

## 7. Contracts 与文档修改顺序

实施时必须按以下顺序:

```txt
1. docs/contracts.md
2. packages/contracts/src/types/testSelection.ts
3. packages/contracts/src/index.ts
4. docs/interfaces.md
5. backend service/module
6. backend API handler
7. e2eRunService integration
8. scripts/verify-p3-b-test-selection.ts
9. package.json script
```

原因:

```txt
先冻结共享类型，再让后端实现依赖类型，避免实现反向决定契约。
```

## 8. e2eRunService 接入点

当前 `runE2E(request)` 中有以下逻辑:

```txt
const selectedCaseIds = request.caseIds?.length
  ? request.caseIds
  : await getDefaultP2CaseIds(request.adapterKind);
```

计划修改为:

```txt
if request.selectionPlanId:
  load TestSelectionPlan
  validate status ready
  selectedCaseIds = plan.selectedCaseIds
else if request.caseIds:
  selectedCaseIds = request.caseIds
else:
  selectedCaseIds = getDefaultP2CaseIds()
```

同时写入:

```txt
runGroup.metadata.selectionPlanId
trace.metadata.selectionPlanId 或 trace tags
testRun.metadata.selectionPlanId 或 runGroup-level link
```

如果现有 contracts 不方便修改 `TestRun` / `InteractionTrace`，第一版至少保证:

```txt
P2RunGroup 增加 selectionPlanId 或 metadata.selectionPlanId
SelectionPlanStore 记录 runGroupIds
验证脚本可从 runGroup -> selected caseIds -> traces 反查
```

## 9. A 线未上传时的临时策略

### 9.1 临时候选池来源

第一版使用:

```txt
loadTestContexts(CONFIGS_DIR, agent)
```

从 `TestContext` 派生:

```txt
caseId
caseName
enabled=true
runProfiles=["smoke", "openclaw"]
attackFamilies=deriveAttackFamilies(context)
targetSurfaces=deriveTargetSurfaces(context)
qualityScore=0.6
sourceOrigin="derived"
```

### 9.2 派生规则

`deriveAttackFamilies`:

```txt
caseId/name/description 包含 injection -> prompt_injection
包含 leak/secret/token/env -> data_leakage
包含 hijack/tool/api/call -> tool_hijack
包含 auth/tenant/admin -> auth_bypass
包含 memory -> memory_poisoning
否则 -> tool_hijack
```

`deriveTargetSurfaces`:

```txt
sandbox.tools 含 read/file -> file_access
含 exec/code/shell -> code_execution
含 api/http/request -> api/network
含 email -> email
默认 -> tool_call
```

这些规则只用于 B 线先行开发，A 线上传正式 `AttackCaseCard[]` 后必须替换。

## 10. 验证脚本设计

新增:

```txt
scripts/verify-p3-b-test-selection.ts
package.json: "verify:p3:b-test-selection"
```

验证步骤:

```txt
1. 启动 Fastify app 或直接调用 service
2. 创建 rule_only selection plan
3. 断言 plan.status = ready
4. 断言 selectedCaseIds.length >= 3
5. 断言 coverage.attackFamilyCount >= 3
6. 创建 mock LLM selection plan
7. 注入非法 caseId mock response，断言被拒绝或 fallback
8. 使用 selectionPlanId 调用 /test-runs/e2e mock
9. 断言 runGroup.caseIds 与 plan.selectedCaseIds 一致
10. 断言 runGroup.traceIds 非空
11. 断言 LLM 关闭时 rule_only 仍通过
```

输出示例:

```txt
P3-B TEST SELECTION VERIFIED
passed: 11
skipped: 0
selectionPlanId: selection_plan.xxx
runGroupId: run_group.xxx
coverage: 3 attack families, 4 target surfaces
```

## 11. 分支实施顺序

### Step 1: 文档和 contracts

修改:

```txt
docs/contracts.md
packages/contracts/src/types/testSelection.ts
packages/contracts/src/index.ts
docs/interfaces.md
```

验收:

```txt
npm run typecheck
```

### Step 2: 候选池和 rule-only

新增:

```txt
candidateCaseRepository.ts
ruleBasedCaseSelector.ts
coverageValidator.ts
testSelectionService.ts
```

验收:

```txt
service-level smoke script or unit check
```

### Step 3: plan store

新增:

```txt
selectionPlanStore.ts
```

验收:

```txt
create -> get -> list
```

### Step 4: API

新增:

```txt
backend/src/api/v1/test-selection/handlers.ts
```

修改:

```txt
backend/src/app.ts
```

验收:

```txt
POST /api/v1/test-selection/plans
GET /api/v1/test-selection/plans/:id
```

### Step 5: e2eRunService

修改:

```txt
backend/src/services/e2eRunService.ts
backend/src/api/types.ts
backend/src/api/v1/test-runs/handlers.ts
```

验收:

```txt
POST /api/v1/test-runs/e2e { selectionPlanId }
```

### Step 6: LLM rerank

新增:

```txt
llmAssistedCaseReranker.ts
```

复用:

```txt
backend/src/modules/llm/llmClient.ts
```

验收:

```txt
mock LLM 正常排序
mock LLM 非法输出 fallback
```

### Step 7: 验证脚本

新增:

```txt
scripts/verify-p3-b-test-selection.ts
```

修改:

```txt
package.json
```

验收:

```txt
npm run verify:p3:b-test-selection
```

## 12. 审核清单

代码完成后按以下方式审核:

阻断:

- `selectionPlanId` 不能驱动 e2e run。
- plan 中有不存在 caseId。
- LLM 输出非法 caseId 后仍被接受。
- coverage 未达标但 status 是 ready。
- LLM 收到了完整 prompt、secret 或 TestOracle。
- rule-only 模式不可用。
- B 线生成或修改了 `SupervisionPolicyPack`。

次要:

- coverage warning 不够细。
- selection reason 可读性弱。
- 文件 store 没有并发保护。
- API 错误码不够统一。

建议:

- 增加 replay plan。
- 增加真实 LLM smoke。
- 后续让 C 线 ReportBundle 引用 selectionPlan。

## 13. 最终黑盒流程

```txt
1. 启动后端 API
2. POST /api/v1/test-selection/plans selectionMode=rule_only
3. 查看返回的 coverageSnapshot
4. POST /api/v1/test-runs/e2e selectionPlanId=<id> adapterKind=mock
5. GET /api/v1/test-runs/:runGroupId
6. 确认 runGroup.caseIds == selectionPlan.selectedCaseIds
7. GET /api/v1/traces/:traceId
8. 确认 trace.caseId 属于 selectionPlan
9. 再创建 llm_assisted plan
10. 确认 llmAudit 存在且非法输出不会进入 selectedCaseIds
```

可选 OpenClaw:

```txt
adapterKind=openclaw
targetProfile=openclaw
selectionMode=rule_only 或 llm_assisted
```

如果 OpenClaw CLI 或 Gateway 不可用，验证脚本可以 skip，但不能影响 mock 主路径。

## 14. 动工前确认

开始写代码前只需要确认三件事:

1. `TestSelectionPlan` 是否进入 `packages/contracts`。
2. A 线未上传期间是否允许 B 线使用 `loadTestContexts` 派生临时候选池。
3. `POST /api/v1/test-runs/e2e` 是否允许新增 `selectionPlanId` 字段，并拒绝与 `caseIds` 同时传入。

若无额外修改意见，B 线可以按本文档从 Step 1 开始实现。

## 15. 第一版实现结果

截至 2026-06-22，B 线已完成:

```txt
CandidateCaseRepository
RuleBasedCaseSelector
CoverageValidator
LlmAssistedCaseReranker
TestSelectionPlanStore
TestSelectionService
test-selection API
selectionPlanId -> e2eRunService
verify:p3:b-test-selection
```

`TestSelectionPlan` 已增加 eval 风格摘要:

```txt
selectionProfile
coverageRequirements
selectionRunSummary
evalStyleResult
```

这些字段用于回答:

```txt
本次使用什么测试 profile
要求覆盖哪些攻击类型和工具面
候选数、规则选择数、LLM 接受/拒绝数
哪些检查通过、哪些检查失败、是否需要人工复核
```

当前 A 线未上传正式攻击库时，候选池来自现有 `TestContext` 派生，标记为 `sourceOrigin: "derived"`。A 线正式 `CorpusManifest / AttackCaseCard[]` 到位后，只替换 `CandidateCaseRepository` provider，不修改选择器、coverage、API 或 e2e 主流程。

当前验证:

```txt
npm run typecheck
npm run verify:p3:b-test-selection
```

审核补强:

```txt
timeBudgetMs 已成为真实选择约束，预算不足时计划保持 draft
includeExternalTools=false 时过滤需要外部工具的候选 case
LLM 排序未通过 coverage gate 时自动恢复 rule-only 选择
selectionPlan.agentId 与实际 runGroup.agentId 保持一致
异步无效 selectionPlan 会把 runGroup 正确收口为 failed
```
