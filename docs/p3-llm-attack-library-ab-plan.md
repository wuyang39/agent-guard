# P3 LLM 攻击库选择 A/B 协同计划

文档版本: p3-llm-attack-selection-ab-1
生成日期: 2026-06-21
视角: 资深产品经理
适用范围: A 线攻击库、B 线检测运行与 OpenClaw/Gateway 监督前测试编排
当前实现状态: A 线 AB-0/AB-1 已落地；B 线 AB-2/AB-3 已在 p3-B 接入，并可在 A 线正式语料资产可用后切换为真实 CorpusManifest / AttackCaseCard 输入。

说明: 本文档中的 A/B 指 A 线与 B 线协同，不是面向用户流量的 A/B 实验。核心目标是让 LLM 参与“攻击库样本选择与测试编排”，但不让 LLM 直接替代风险检测、策略生成或运行时监督决策。

## 1. 产品结论

P3 最后一轮可以引入 LLM 选择攻击库，但定位必须非常克制:

```txt
LLM = 攻击库选择助手 / 测试编排助手
规则与契约 = 覆盖率底线 / 安全边界 / 可复现保障
真实 Agent 运行 trace = 风险检测依据
C 线策略包 = 监督执行依据
B 线 RuntimeSupervisionRecord = 防御效果依据
```

也就是说，LLM 可以帮助从 A 线攻击库中选出更适合当前 OpenClaw、工具面和测试目标的用例，但不能直接说“这个 Agent 有风险”、不能直接生成 `SupervisionPolicyPack`，也不能直接决定运行时 allow / deny / ask / redact。

最终对外表达应为:

```txt
系统先根据攻击库元数据和目标 Agent 工具面，使用规则约束 + LLM 辅助排序生成测试选择计划；
随后 B 线真实运行被选中的测试用例，C 线基于真实 trace 生成风险画像和策略包；
最后 B 线加载策略包进行监督，并把运行时监督记录返回给 C 线生成防御报告。
```

## 2. 用户价值

对评委和用户来说，这个能力解决三个痛点:

1. 攻击库越来越大时，不需要用户手动挑选用例。
2. 不同 Agent / 工具面不同，系统可以动态选择更相关的测试样本。
3. 报告里可以解释“为什么本次选择这些攻击场景”，提升测试计划的可信度。

该能力不追求一开始就完全智能化，第一版重点是:

```txt
选得准
跑得通
可解释
可复现
可降级
不越权
```

## 3. 目标运行链路

```txt
A 线 CorpusManifest / AttackCaseCard[]
  -> B 线 TestSelectionService 读取攻击库元数据
  -> 规则过滤: profile、工具类型、攻击类型、风险标签、运行成本
  -> LLM 辅助排序与补齐覆盖
  -> CoverageValidator 强制校验覆盖率底线
  -> TestSelectionPlan
  -> B 线按 caseId 加载 TestContext 并运行 OpenClaw/Gateway 检测
  -> InteractionTrace / RiskReport / DetectionReport / AgentRiskProfile
  -> C 线生成 SupervisionPolicyPack
  -> B 线使用策略包监督真实或批量外部测试
  -> RuntimeSupervisionRecord[]
  -> C 线 DefenseReport / ReportBundle
```

关键原则:

- LLM 只看攻击库元数据摘要，不直接接收完整敏感 payload。
- LLM 只能推荐 `caseId`、排序、理由和覆盖补齐建议。
- 所有 `caseId` 必须来自 A 线已经生成并校验过的攻击库。
- B 线必须用规则验证 LLM 输出，非法 caseId、重复 caseId、覆盖不足都要拒绝或降级。
- 没有 LLM 时，规则选择器必须仍能完成 smoke / openclaw / regression profile。

## 4. A 线产品要求

A 线要把攻击库从“可运行配置”升级为“可被智能选择的测试资产库”。核心交付不是让 B 线读取完整 prompt，而是给 B 线一组可筛选、可解释、可审计的 metadata。

### 4.1 A 线新增输出

```txt
CorpusManifest
AttackCaseCard[]
CorpusRunProfile[]
CoverageTaxonomy
CaseQualityReport
```

`AttackCaseCard` 是 B 线选择时的最小单元，建议包含:

```txt
caseId
caseName
enabled
runProfiles: smoke / openclaw / regression / full-corpus
attackFamilies: prompt_injection / data_leakage / tool_hijack / auth_bypass / memory_poisoning / environment_poisoning / model_evasion
targetSurfaces: input / output / context / tool_call / file_access / code_execution / network / email / api / browser / memory
targetToolHints
targetResourceHints
sensitivityTags
estimatedCost
estimatedDurationMs
requiresExternalTool
requiresNetwork
requiresOpenClaw
sourceOrigin: pyrit / aig / manual / user_supplied / synthetic
sourceRefs
promptSummary
payloadRiskSummary
expectedSafeBehaviorSummary
oracleSummary
qualityScore
```

注意: `promptSummary` 和 `payloadRiskSummary` 应该是脱敏摘要，不是完整攻击 prompt。完整 TestContext 仍由 A 线加载器按 `caseId` 提供给 B 线运行。

### 4.2 A 线最低覆盖要求

第一版不要追求 full-corpus 全自动。推荐先保证:

```txt
smoke profile:      20-30 cases
openclaw profile:   30-80 cases
regression profile: 200-300 cases
full-corpus:        1000+ cases
```

其中 openclaw profile 至少覆盖:

- 提示注入
- 数据泄露
- 工具调用劫持
- 越权访问
- 文件访问风险
- 代码执行风险
- 外部 API / 网络出站风险

### 4.3 A 线验收标准

- 每个 `caseId` 都能加载为真实 `TestContext`。
- 每个 `AttackCaseCard.caseId` 都能在 `CorpusManifest` 中找到来源。
- 每个 case 至少有一个 attack family、一个 target surface、一个 run profile。
- openclaw profile 至少覆盖 3 类以上比赛要求攻击场景。
- 攻击库元数据不暴露真实 secret、API key、完整恶意 payload。
- 生成物支持稳定排序和可复现抽样。

## 5. B 线产品要求

B 线负责把 A 线攻击库变成“本次测试计划”，并保证这个计划可以真实运行。

### 5.1 B 线新增能力

```txt
TestSelectionService
RuleBasedCaseSelector
LlmAssistedCaseReranker
CoverageValidator
SelectionPlanStore
SelectionAuditLogger
```

### 5.2 选择策略

选择过程分四步:

```txt
1. 候选池过滤:
   按 runProfile、enabled、OpenClaw 可运行性、外部工具依赖、时间预算过滤。

2. 规则底线选择:
   保证至少覆盖必选攻击类型、必选工具面和高风险资源类型。

3. LLM 辅助排序:
   根据 Agent 工具面、历史风险画像、目标测试模式，对候选 case 排序和解释。

4. 覆盖率校验:
   校验 LLM 输出是否满足 coverage gate；不满足则规则补齐或降级到 rule_only。
```

### 5.3 LLM 输入范围

允许发送给 LLM:

```txt
Agent 工具面摘要
外部工具 capability profile 摘要
攻击库 AttackCaseCard 脱敏元数据
测试目标: smoke / openclaw / regression / unknown-risk-batch
时间预算和 case 数量预算
已有风险画像摘要
```

B 线正式接入 LLM 时使用以下环境变量名。A 线 AB-0/AB-1 只声明输入约定并生成安全 catalog，不调用模型做正式选择:

```txt
AGENT_GUARD_LLM_ENDPOINT
AGENT_GUARD_LLM_MODEL=deepseek-v4-pro
AGENT_GUARD_LLM_KEY
```

个人本机变量如 `DeepSeek_API_2` 只能作为开发者自己的兼容示例，不是团队默认变量名，也不得写入配置文件或提交到仓库。

不允许发送给 LLM:

```txt
完整攻击 prompt
真实 secret / token / key
完整用户文件内容
完整 tool result
未脱敏的运行时 payload
TestOracle 细节
```

### 5.4 B 线输出对象

建议新增 `TestSelectionPlan`:

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

`llmAudit` 至少包含:

```txt
enabled
provider
model
promptTemplateVersion
inputDigest
outputDigest
durationMs
acceptedCaseIds
rejectedCaseIds
validationWarnings
```

### 5.5 B 线验收标准

- LLM 关闭时，规则选择器可生成可运行的 `TestSelectionPlan`。
- LLM 开启时，只能从候选 `caseId` 中选择，不得创造新 case。
- LLM 输出非法 caseId、重复 caseId 或覆盖不足时会被拦截。
- `TestSelectionPlan.selectedCaseIds` 能逐个加载 `TestContext`。
- 运行后 trace / detection / policy / runtime record 能回指本次 selection plan。
- 同一输入、同一 manifest、同一 rule_only 模式下结果可复现。

## 6. A/B 分阶段计划

### AB-0: 契约冻结

目标: 先冻结 A 给 B 的攻击库选择元数据，避免 B 直接依赖 A 的私有配置。

交付:

```txt
AttackCaseCard 草案
CorpusManifest 选择字段
TestSelectionPlan 草案
coverage gate 定义
```

验收:

- `docs/contracts.md` 更新。
- `docs/interfaces.md` 更新 A -> B 新交接对象。
- 明确哪些字段进入 `packages/contracts`，哪些为后端私有。

### AB-1: A 线攻击库卡片化

目标: A 线把现有 test cases 和 generated corpus 转成可选择资产。

交付:

```txt
AttackCaseCard[] 生成器
CorpusManifest 扩展 coverage 统计
openclaw profile 样本集
case quality check
```

验收:

- openclaw profile 至少 30 个可运行 case。
- 每个 case 有 attack family、target surface、source origin、quality score。
- `caseId -> TestContext` 可加载。

### AB-2: B 线 rule-only 选择器

目标: 先不用 LLM，完成稳定选择闭环。

交付:

```txt
RuleBasedCaseSelector
CoverageValidator
TestSelectionPlanStore
selectionPlanId -> test run
```

验收:

- `rule_only + openclaw profile` 可生成计划并跑通。
- 覆盖至少 3 类攻击场景。
- 选择计划和运行结果 ID 链不断裂。

### AB-3: B 线 LLM-assisted rerank

目标: 在规则底线之上引入 LLM 排序和解释。

交付:

```txt
LlmAssistedCaseReranker
LLM prompt template
LLM output validator
fallback to rule_only
selection audit
```

验收:

- mock LLM 稳定验证。
- openai-compatible LLM 可选启用。
- LLM 失败、超时、输出非法时不影响 rule-only 主链路。
- 选择理由可以进入后续报告素材，但不作为风险结论。

### AB-4: A/B 联调与前端展示

目标: 用户可以在检测前看到“本次将测什么、为什么测、覆盖了哪些风险面”。

交付:

```txt
选择计划 API
选择计划详情 API
前端检测配置页选择 profile / mode / case count
覆盖率预览
选择理由展示
```

验收:

- 用户可一键生成测试选择计划。
- 用户可锁定计划后运行检测。
- 前端明确显示 LLM 是辅助选择，不是风险判定。

### AB-5: 黑盒与答辩验证

目标: 证明这个能力真实提高测试编排质量，而不是做一个装饰性 LLM 功能。

验证项:

```txt
1. 关闭 LLM: rule_only 能跑通
2. 开启 mock LLM: 选择结果被 validator 接受
3. 开启真实 LLM: 可生成带理由的选择计划
4. LLM 返回不存在 caseId: 被拒绝
5. LLM 漏掉必测攻击类型: 规则补齐
6. 选择计划运行后 trace 能回指 selectedCaseIds
7. C 线策略包仍来自真实检测结果，不来自 LLM 选择理由
```

## 7. 建议 API

第一版建议 API:

```txt
GET  /api/v1/corpus/manifests
GET  /api/v1/corpus/manifests/:manifestId/cases
POST /api/v1/test-selection/plans
GET  /api/v1/test-selection/plans/:selectionPlanId
POST /api/v1/test-runs/e2e
```

`POST /api/v1/test-selection/plans` 请求建议:

```txt
agentId
manifestId
targetProfile
selectionMode: rule_only / llm_assisted
maxCaseCount
requiredAttackFamilies
requiredTargetSurfaces
timeBudgetMs
includeExternalTools
```

`POST /api/v1/test-runs/e2e` 可新增可选字段:

```txt
selectionPlanId
```

如果传入 `selectionPlanId`，B 线按计划中的 `selectedCaseIds` 运行；如果不传，保留 P2/P3 现有 caseIds/profile 运行方式。

## 8. 前端体验建议

入口放在“监督前检测 / 风险画像生成”之前，不放在运行时监督页面。

页面区域:

```txt
1. 被测 Agent / OpenClaw 状态
2. 攻击库 profile 选择: smoke / openclaw / regression / full-corpus
3. 选择模式: 规则选择 / LLM 辅助选择
4. 测试预算: case 数量 / 预计耗时
5. 覆盖率预览: 攻击类型、工具面、资源敏感级别
6. 已选用例列表: caseId、攻击类型、目标工具面、选择理由
7. 操作按钮: 生成选择计划 / 锁定计划并运行检测 / 重新选择
```

文案口径:

```txt
LLM 辅助选择攻击样本，实际风险结论来自真实运行 trace 和检测规则。
```

## 9. 指标体系

产品指标:

```txt
selection coverage completeness
selected case diversity
openclaw runnable rate
selection-to-detection success rate
LLM fallback rate
invalid LLM output rejection count
average selection time
average run time
```

答辩指标:

```txt
覆盖攻击类型数
覆盖工具面数
覆盖敏感资源类型数
真实运行 trace 数
风险发现数
策略包生成数
监督命中数
阻断/告警/询问记录数
```

## 10. 风险与兜底

风险: LLM 选择偏向看起来“语义丰富”的 case，漏掉基础高危场景。
兜底: CoverageValidator 强制补齐必测攻击类型和高危工具面。

风险: LLM 输出不存在的 caseId。
兜底: 只接受候选池 caseId，其他全部拒绝并记录 audit。

风险: LLM 选择理由被误当作风险结论。
兜底: UI 和报告中明确标记 selection reason，不进入 Finding / RiskReport / DefenseClaim。

风险: 向 LLM 泄露攻击 payload 或敏感资源内容。
兜底: 只发送 AttackCaseCard 脱敏摘要和 digest，不发送完整 TestContext。

风险: LLM 不稳定导致测试计划不可复现。
兜底: 支持 rule_only、replay selectionPlan、记录 prompt/version/inputDigest/outputDigest。

风险: A/B 边界混乱，B 线直接读 A 线私有配置。
兜底: A 线输出 CorpusManifest / AttackCaseCard；B 线只按公开对象和 caseId 加载。

## 11. 最小可交付版本

如果时间很紧，建议只做以下最小版本:

```txt
1. A 线提供 openclaw profile 的 AttackCaseCard[]
2. B 线实现 rule_only selector + CoverageValidator
3. B 线接入 mock LLM rerank，证明接口可用
4. 前端展示选择计划和覆盖率
5. 验证 selectionPlanId -> TestContext -> Trace -> DetectionReport 链路不断
```

真实 DeepSeek / OpenAI-compatible 选择可以作为增强项，只要 mock LLM 和接口设计已经闭合，就能在答辩中说明系统具备 LLM-assisted test planning 能力。

## 12. 最终验收口径

P3 A/B 这项能力完成时，应能回答:

```txt
攻击库有哪些样本？
为什么本次选择这些样本？
是否覆盖比赛要求的 3 类以上攻击场景？
这些样本是否真实跑过 OpenClaw / Gateway？
风险画像是否来自真实 trace，而不是 LLM 主观判断？
策略包是否仍由 C 线根据检测结果生成？
监督效果是否能回指 RuntimeSupervisionRecord？
LLM 失败时系统是否仍可运行？
```

只有这些问题都能回答，LLM 选择攻击库才算是产品级能力，而不是一个“看起来很智能”的附加按钮。
