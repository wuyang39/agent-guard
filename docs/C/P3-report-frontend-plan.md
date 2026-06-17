# C 线 P3 报告生成与前端展示系统性优化计划

文档版本: p3-c-report-frontend-plan-1
基线日期: 2026-06-17
状态: 设计计划稿

说明: 本文档只规划开发者 C 的 P3 工作，不替代 A/B 线开发文档。P3 的核心目标不是再做一套自包含 demo，而是在 P2 已跑通的正式 API、OpenClaw、运行记录和前端展示基础上，把 C 线的报告生成和前端体验升级到证据级、答辩级、可复核、可导出的水平。所有实现必须继续遵守 `docs/ownership.md`、`docs/interfaces.md`、`docs/contracts.md` 和 `docs/p2-api-contract-plan.md`。

## 1. P3 总目标

P2 解决的是“正式链路能跑、前端能看、答辩能演示”。P3 解决的是“报告结论可信、证据链完整、前端能复核、导出材料可交付”。

P3 C 线目标:

```txt
TestContext view 契约/API/前端正式化
  -> TestRun / InteractionTrace
  -> RiskReport / DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack
  -> RuntimeSupervisionRecord[]
  -> DefenseReport
  -> Evidence Bundle / Report Bundle
  -> Frontend Report Workspace
  -> Markdown / HTML / PDF export
  -> P3 validation script
```

P3 完成后，C 线必须能回答:

- 某条报告结论来自哪个测试上下文、哪段 trace、哪个 finding、哪个策略和哪条运行时监督记录。
- 某个防御效果是否真实来自 B 线输出的 `RuntimeSupervisionRecord[]`，而不是 C 线或前端自行推导。
- 前端展示的上下文、策略、阻断、残余风险是否全部来自后端 API 和共享契约。
- 导出的报告能否在不打开前端的情况下独立说明测试对象、攻击路径、证据、控制措施、运行时效果和限制。
- 答辩现场能否从 Dashboard 进入一次运行，并完整追溯到报告导出文件。

## 2. 当前基线

P2 当前主链路已经形成:

```txt
Frontend Web Console
  -> Backend API
  -> Agent Registry / Adapter
  -> loadTestContexts()
  -> runTestCase()
  -> evaluateRisk()
  -> buildRiskReport()
  -> buildDetectionReport()
  -> buildAgentRiskProfile()
  -> buildSupervisionPolicyPack()
  -> OpenClaw realtime MCP supervision
  -> buildDefenseReport()
  -> export reports
  -> RunHistory / ReportIndex
  -> Frontend Web Console
```

C 线当前已有职责:

- 生成 `RiskReport`、`DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack`、`DefenseReport` 和 `ReportArtifact[]`。
- 维护正式前端、API client、ViewModel 和展示验收。
- 通过 Backend API 消费 `TestRun`、`InteractionTrace`、`RuntimeSupervisionRecord[]` 等对象。

P3 必须修正的不足:

- `TestContext view` 尚未作为 C 线正式规划项完成契约、后端 API 和前端展示闭环。
- 报告内容偏“展示结果”，不足以逐条复核结论来源。
- `DefenseReport` 中的控制效果、残余风险、限制说明还不够结构化。
- 前端缺少专门的报告工作台，不能像审计材料一样逐条检查 claim 和 evidence。
- 导出格式仍以 JSON/HTML 为主，缺少 Markdown/PDF 等答辩和提交友好的材料。
- 对“真实链路”和“兜底链路”的标识还不够强，容易让 C 线报告看起来像自娱自乐。

## 3. P3 范围

P3 C 线包含:

- 将 `TestContext view` 正式落到契约、后端 API 和前端展示，用作 C 线报告追溯的上下文视图。
- 在不破坏 P2 契约的前提下，新增报告级 view object 和可选字段。
- 设计并生成 `ReportBundle`、`EvidenceBundle`、`ReportQualitySummary` 和 `TraceabilityGraph`。
- 优化 `DefenseReport` 的 claim、evidence、runtime effect、residual risk 和 limitation 表达。
- 建设正式前端 Report Workspace，用于查看、复核、导出和答辩展示。
- 新增报告导出能力，至少覆盖 Markdown 和 HTML；PDF 作为 P3 推荐目标。
- 新增 P3 C 线验证脚本，证明报告结论与 A/B 产物真实连通。

P3 C 线不包含:

- 不新增或修改 A 线 `configs/*.json` 中的测试用例、测试 oracle、红队场景和策略模板语义。
- 不修改 B 线 Agent adapter、runner、monitor 或 OpenClaw 私有协议。
- 不执行 `SupervisionPolicyPack`，不生成 `RuntimeSupervisionRecord[]`。
- 不让前端读取 `configs/*.json`、`outputs/**` 原始文件或 `backend/src/**`。
- 不在前端重新计算风险等级、风险画像、策略包或防御效果。
- 不用 demo payload 反向决定正式 contracts 字段。

## 4. C 线边界

P3 C 线输入:

```txt
TestContext view                 # P3 待正式化
TestRun
InteractionTrace
RiskEvaluationResult
RiskReport
PolicyTemplate[]
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord[]
DefenseReport
ReportArtifact[]
```

P3 C 线输出:

```txt
ReportBundle
EvidenceBundle
ReportQualitySummary
TraceabilityGraph
ExportJob / ExportArtifact
Frontend route / page
ViewModel
API request payload
```

关键边界:

- `TestContext view` 是 P3 C 线待完成规划项，必须先进入契约和 API 设计，再进入前端展示。
- `TestContext view` 只能由后端基于真实 `TestContext` 构建并通过 API 返回，前端不得读取配置文件补字段。
- `SupervisionPolicyPack` 是 C -> B 的交接对象；字段变化必须同步 B 确认可执行。
- `RuntimeSupervisionRecord[]` 是 B -> C 的交接对象；C 可以聚合、引用和展示，但不得编造。
- `DefenseReport` 中任何阻断、告警、脱敏、询问、放行效果，都必须能回指真实 runtime record。
- 如果没有 runtime record，报告只能表达“未观察到运行时防御效果”或“缺少运行时证据”，不能表达“已阻断”“已缓解”等结论。

## 5. P3 主链路

P3 的主链路在 P2 基础上先补齐 `TestContext view` 正式化，再新增报告级聚合和复核层:

```txt
GET /api/v1/test-runs/:runGroupId
  -> P2RunGroup + TestContextView[]
  -> traceIds / reportIds / policyPackId / runtimeSessionIds

GET /api/v1/reports/defense/:reportId
  -> DefenseReport + TestContextView[] + linked artifacts

P3 report composer
  -> collect linked RiskReport / DetectionReport / PolicyPack / Runtime records
  -> build EvidenceBundle
  -> build TraceabilityGraph
  -> build ReportQualitySummary
  -> build ReportBundle

Frontend Report Workspace
  -> Summary
  -> Claims
  -> Evidence Matrix
  -> Traceability Graph
  -> Runtime Effects
  -> Residual Risk
  -> Export Center
```

P3 必须保留并增强追溯链:

```txt
ReportBundle
  -> DefenseReport
  -> RuntimeSupervisionRecord[]
  -> SupervisionPolicyPack
  -> AgentRiskProfile
  -> DetectionReport
  -> RiskReport[]
  -> InteractionTrace[]
  -> TestRun[]
  -> TestContextView[]
```

## 6. P3 契约草案

以下对象属于 P3 新增草案。实现前必须先更新 `docs/contracts.md`，再更新 `packages/contracts/src/types/**` 或前端私有 view model。跨端复用对象进入 contracts；只服务前端布局的对象保留在 frontend view model。

### 6.1 ReportBundle

用途: 表示一次运行或一个防御报告的完整提交级报告包。

```ts
type ReportBundle = {
  schemaVersion: "mvp-1";
  bundleId: string;
  runGroupId: string;
  agentId: string;
  generatedAt: string;
  source: {
    testContextViewIds: string[];
    testRunIds: string[];
    traceIds: string[];
    riskReportIds: string[];
    detectionReportId?: string;
    riskProfileId?: string;
    policyPackId?: string;
    runtimeSessionIds: string[];
    defenseReportId?: string;
  };
  executiveSummary: ReportSection;
  claims: DefenseClaim[];
  evidenceBundle: EvidenceBundle;
  traceabilityGraph: TraceabilityGraph;
  quality: ReportQualitySummary;
  exports: ExportArtifact[];
};
```

约束:

- `ReportBundle.source` 中的每个 ID 必须能被当前 API 或报告索引解析。
- `defenseReportId` 为空时，bundle 只能作为检测报告包，不得展示防御效果。
- `claims` 为空时，前端必须显示“暂无可复核结论”，不能自动生成宣传性文案。

### 6.2 DefenseClaim

用途: 把报告里的自然语言结论结构化，便于复核。

```ts
type DefenseClaim = {
  claimId: string;
  title: string;
  statement: string;
  claimType: "risk" | "detection" | "policy" | "runtime_effect" | "residual_risk" | "limitation";
  confidence: "low" | "medium" | "high";
  sourceIds: {
    contextIds?: string[];
    traceEventIds?: string[];
    findingIds?: string[];
    policyIds?: string[];
    runtimeRecordIds?: string[];
  };
  reviewStatus: "auto_checked" | "needs_review" | "blocked_by_missing_evidence";
};
```

约束:

- `claimType: "runtime_effect"` 必须至少包含一个 `runtimeRecordIds`。
- `claimType: "policy"` 必须至少包含一个 `policyIds`。
- `claimType: "risk"` 或 `"detection"` 必须能回指 finding 或 trace event。
- 缺证据的 claim 只能进入 `blocked_by_missing_evidence`，不得进入 `auto_checked`。

### 6.3 EvidenceBundle

用途: 汇总报告可引用证据，避免前端或导出器散落式拼接。

```ts
type EvidenceBundle = {
  evidenceBundleId: string;
  reportId: string;
  coverage: EvidenceCoverageMatrix;
  items: EvidenceItem[];
  missingEvidence: MissingEvidenceItem[];
};
```

最低覆盖项:

- 测试上下文: case、scenario、tool/resource/prompt 摘要。
- 交互证据: trace event、tool call、tool result、agent message。
- 风险证据: finding、evidence chain、attack chain。
- 策略证据: policy pack、policy、control action。
- 运行时证据: runtime supervision record、alert、blocked action。

### 6.4 EvidenceCoverageMatrix

用途: 量化每类结论是否有足够证据。

```ts
type EvidenceCoverageMatrix = {
  riskClaims: EvidenceCoverageRow[];
  detectionClaims: EvidenceCoverageRow[];
  policyClaims: EvidenceCoverageRow[];
  runtimeEffectClaims: EvidenceCoverageRow[];
  residualRiskClaims: EvidenceCoverageRow[];
};
```

每行必须至少包含:

```txt
claimId
requiredEvidenceKinds
availableEvidenceKinds
missingEvidenceKinds
coverageStatus: complete | partial | missing
```

### 6.5 TraceabilityGraph

用途: 支持前端图谱和导出报告中的“对象关系图”。

```ts
type TraceabilityGraph = {
  graphId: string;
  nodes: TraceabilityNode[];
  edges: TraceabilityEdge[];
};
```

节点类型必须覆盖:

```txt
test_context
test_run
trace
trace_event
risk_report
finding
detection_report
risk_profile
policy_pack
policy
runtime_session
runtime_record
defense_report
artifact
```

边类型必须覆盖:

```txt
produced_by
derived_from
uses_policy
observed_in
supports_claim
exported_as
```

### 6.6 ReportQualitySummary

用途: 让报告生成模块明确报告质量，不让前端用颜色或文案掩盖证据缺口。

```ts
type ReportQualitySummary = {
  reportId: string;
  score: number;
  level: "draft" | "reviewable" | "submission_ready";
  checks: ReportQualityCheck[];
  blockingIssues: string[];
  generatedAt: string;
};
```

评分原则:

- 证据完整性权重大于页面美观。
- 运行时防御效果缺证据时，最高只能到 `reviewable`，不能到 `submission_ready`。
- 任一 required ID 无法解析时，必须降级并列入 `blockingIssues`。

## 7. 报告生成优化

P3 后端报告模块应新增 report composer 层，职责是聚合已有对象、生成复核视图和导出材料。composer 不重新执行风险判定，不重新执行策略包。

建议模块:

```txt
backend/src/modules/report/reportBundleComposer.ts
backend/src/modules/report/evidenceBundleBuilder.ts
backend/src/modules/report/traceabilityGraphBuilder.ts
backend/src/modules/report/reportQualityChecker.ts
backend/src/modules/report/exporters/markdownExporter.ts
backend/src/modules/report/exporters/pdfExporter.ts
```

生成规则:

- 从 report index、run history 或 service 层读取已存在对象，不从前端请求体信任业务结论。
- `EvidenceBundle` 只引用真实对象中的字段，不引入无法回指的二次文案。
- `TraceabilityGraph` 构建失败时，报告仍可生成 draft，但必须暴露 blocking issue。
- 导出器只消费 `ReportBundle`，不得自己再去读取 configs 或 raw outputs。
- Markdown / HTML / PDF 导出内容必须基于同一个 `ReportBundle`，避免多格式结论不一致。

报告内容最低结构:

```txt
1. Executive Summary
2. Tested Agent and Test Context
3. Attack / Risk Findings
4. Detection Summary
5. Generated Policy Pack
6. Runtime Supervision Effects
7. Defense Effectiveness
8. Residual Risk
9. Evidence Coverage Matrix
10. Traceability Graph
11. Limitations and Missing Evidence
12. Reproducibility Metadata
```

## 8. 前端优化

P3 前端从 P2 的“页面展示”升级为“报告工作台”。前端仍然只消费 API、report artifact 和 contracts 类型，不承担报告业务推导。

建议新增或强化页面:

```txt
/reports/workspace/:runGroupId
/reports/defense/:reportId
/reports/bundles/:bundleId
```

Report Workspace 必备区域:

- Summary: 展示 agent、adapter kind、run group、报告状态和质量等级。
- Context: 展示 `TestContextView[]`，说明测试 case、场景、工具、资源和 prompt 摘要。
- Claims: 逐条列出 `DefenseClaim`，显示 confidence、review status 和证据入口。
- Evidence Matrix: 按 claim 展示 required、available、missing evidence。
- Traceability: 展示从 TestContext 到 DefenseReport 的对象图谱。
- Runtime Effects: 展示真实 `RuntimeSupervisionRecord[]`，区分 deny、ask、redact、allow 等动作。
- Residual Risk: 展示未缓解风险和限制说明。
- Export Center: 触发导出、查看导出状态、下载 artifact。

前端禁止:

- 在组件内根据 trace event 自行生成 finding。
- 根据 policy wording 自行推断 runtime effect。
- 用本地静态 payload 覆盖 API 返回的 report quality。
- 隐藏 `missingEvidence` 或 blocking issue。
- 在 UI 文案中把 fallback/mock 链路包装成真实 OpenClaw 运行。

交互要求:

- 所有 claim 均可展开看到 source IDs。
- 点击 source ID 能跳转或定位到对应 trace、policy、runtime record 或 report section。
- 缺证据 claim 必须有明确视觉状态，但不得阻断用户查看原始对象。
- Export Center 必须显示导出基于哪个 `bundleId` 和 `generatedAt`。
- 答辩模式可以优化排版，但不能改变数据来源或隐藏缺证据状态。

## 9. P3 API 草案

P3 API 必须在实现前形成冻结草案。以下接口为 C 线建议，不得在未更新接口文档时直接让前端依赖。

```txt
GET  /api/v1/reports/bundles/:bundleId
GET  /api/v1/test-runs/:runGroupId/report-bundle
GET  /api/v1/reports/defense/:reportId/evidence
GET  /api/v1/reports/defense/:reportId/quality
POST /api/v1/reports/defense/:reportId/exports
GET  /api/v1/reports/exports/:exportJobId
```

Response 原则:

- 继续使用 P2 `ApiResponse<T>` envelope。
- API 返回共享契约对象或 API view，不返回后端私有 class。
- 导出接口返回 `ExportJob`，前端轮询或刷新读取导出结果。
- `ExportArtifact` 的下载 URL 必须由后端提供，前端不得拼接 `outputs/**` 路径。
- 如果某个 bundle 因缺少 B 线 runtime records 无法达到提交级质量，API 必须返回 quality blocking issue。

## 10. 实施里程碑

### P3-C-0 TestContext view 正式化

交付:

- 在 `docs/contracts.md` 中冻结 `TestContextView` 的展示字段和语义。
- 在 `packages/contracts/src/types/**` 中新增或对齐 `TestContextView` 类型。
- 后端 API 在运行详情、检测报告和防御报告响应中返回 `testContextViews`。
- 前端在 Test Run Detail、Detection / Policy 和 Defense Report 页面展示上下文视图。

验收:

- `TestContextView` 由后端基于真实 `TestContext` 构建。
- 前端不得读取 `configs/*.json` 或 `outputs/**` raw files 补上下文字段。
- `TestContextView.contextId` 必须能与 `TestRun.contextId` 或 `InteractionTrace.contextId` 对齐。
- 该项完成前，P3 报告质量最高只能标记为 `reviewable`，不能标记为 `submission_ready`。

### P3-C-1 契约冻结

交付:

- 更新 `docs/contracts.md`，冻结 P3 报告对象草案。
- 更新 `docs/interfaces.md`，说明 P3 C 线新增输出和前端消费对象。
- 明确哪些对象进入 `packages/contracts`，哪些保留为前端私有 view model。

验收:

- 新增对象只新增可选字段或新增类型，不破坏 P2 字段。
- `SupervisionPolicyPack` 与 `RuntimeSupervisionRecord` 变更必须得到 B 线确认。
- 前端需要的展示字段都能从 API 或 report bundle 得到。

### P3-C-2 Report Bundle Composer

交付:

- `ReportBundle` 构建器。
- `EvidenceBundle` 构建器。
- `TraceabilityGraph` 构建器。
- `ReportQualitySummary` 检查器。

验收:

- 每个 claim 都能回指至少一个上游对象。
- runtime effect claim 必须回指真实 runtime record。
- 缺证据对象进入 `missingEvidence` 和 `blockingIssues`。

### P3-C-3 导出器

交付:

- Markdown exporter。
- HTML exporter 升级为基于 `ReportBundle`。
- PDF exporter 作为 P3 推荐目标。
- 导出 artifact index。

验收:

- 同一个 bundle 导出的多格式报告结论一致。
- 导出文件包含 evidence matrix 和 limitation。
- 导出结果可重复，稳定运行时不产生随机文案漂移。

### P3-C-4 Frontend Report Workspace

交付:

- Report Workspace 页面。
- Evidence Matrix 组件。
- Claim Review 组件。
- Traceability Graph 组件。
- Export Center 组件。

验收:

- 页面从 API client 加载数据。
- 前端不 import `backend/src/**`。
- 前端不读取 `configs/*.json` 或 `outputs/**` raw files。
- source ID 可定位到对应对象或展示缺失原因。

### P3-C-5 P3 验证脚本

交付:

- `npm run verify:p3:c-report`。
- 覆盖 OpenClaw 主路径和 fallback 路径的报告质量检查。
- 至少一个导出文件的结构化校验。

验收:

- 检查 `ReportBundle -> DefenseReport -> RuntimeSupervisionRecord[] -> SupervisionPolicyPack -> DetectionReport -> RiskReport -> InteractionTrace -> TestContextView` 全链路 ID。
- 检查防御效果不允许在缺少 runtime records 时被声明为已生效。
- 检查前端 API type 和 contracts 同步。

## 11. 验收标准

P3 C 线完成标准:

- `ReportBundle` 可从一次真实或半真实运行生成，且包含完整 source ID。
- 每条 `DefenseClaim` 都能在前端展开查看证据。
- 每条 runtime effect claim 都能回指 B 线产生的 `RuntimeSupervisionRecord`。
- 没有 runtime record 时，报告不会声称防御已生效。
- `EvidenceCoverageMatrix` 能明确标出 complete、partial、missing。
- `TraceabilityGraph` 能覆盖从测试上下文到导出 artifact 的主链路节点。
- `ReportQualitySummary.level` 能被前端和导出报告一致展示。
- 前端 Report Workspace 不重新计算风险、画像、策略或防御效果。
- 导出文件包含 summary、evidence、traceability、limitations 和 reproducibility metadata。
- P3 验证脚本能在本地一键证明 C 线报告真实连接 A/B 产物。

最低命令:

```txt
npm run typecheck
npm run test:frontend
npm run build:frontend
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
npm run verify:p3:c-report
git diff --check
```

其中 `verify:p3:c-report` 是 P3 新增脚本，P3-C-5 前可以先作为计划项存在。

## 12. 真实连通性检查

为避免 C 线工作变成自娱自乐，P3 必须新增以下硬检查:

- `TestContextView.contextId` 必须能与 `TestRun.contextId` 或 `InteractionTrace.contextId` 对齐。
- `RiskReport.traceId` 必须能找到真实 `InteractionTrace`。
- `Finding.evidenceEventIds` 必须能在 trace events 中找到。
- `DetectionReport.sourceRiskReportIds` 必须能解析到真实风险报告。
- `AgentRiskProfile.sourceDetectionReportId` 必须等于当前检测报告。
- `SupervisionPolicyPack.sourceRiskProfileId` 必须等于当前风险画像。
- `RuntimeSupervisionRecord.policyPackId` 必须等于当前策略包。
- `RuntimeSupervisionRecord.policyId` 必须能在策略包 policies 中找到。
- `DefenseReport.policyPackId` 必须与 runtime records 一致。
- `ReportBundle.claims[].sourceIds` 必须能被 bundle 内对象解析。
- `ExportArtifact.reportId` 或 `bundleId` 必须指向本次报告包。

任一硬检查失败:

```txt
ReportQualitySummary.level = "draft"
对应 claim.reviewStatus = "blocked_by_missing_evidence"
前端和导出报告必须展示 blocking issue
```

## 13. 风险与处理

风险: C 线报告过度宣称防御效果。
处理: runtime effect claim 必须绑定 runtime record；无记录则只能写缺证据或未观察到。

风险: 前端为了展示效果重新拼接或计算业务结论。
处理: 前端只做 view model，不做风险、策略、防御效果计算；需要新字段时先改 contracts 和 API。

风险: 导出器和前端使用不同数据源导致结论不一致。
处理: 前端和导出器都消费同一个 `ReportBundle`。

风险: API 字段膨胀影响 P2 稳定链路。
处理: P3 新字段优先新增可选字段；新增接口先进入 P3 API 冻结文档。

风险: fallback/mock 链路被误认为 OpenClaw 真实运行。
处理: bundle 和前端必须显示 `adapterKind`、runtime source 和 quality limitation。

## 14. 文件归属与建议落点

C 线主责文件:

```txt
backend/src/modules/risk/**
backend/src/modules/report/**
backend/src/modules/detection/**
backend/src/modules/policy/**
backend/src/modules/defense/**
backend/src/api/v1/reports/**
backend/src/api/v1/detection/**
backend/src/api/v1/policies/**
backend/src/api/v1/defense/**
frontend/src/**
frontend/public/**
frontend/tests/**
packages/contracts/src/types/risk.ts
packages/contracts/src/types/report.ts
packages/contracts/src/types/detection.ts
packages/contracts/src/types/policy.ts
packages/contracts/src/types/defense.ts
docs/C/**
```

共享受控文件:

```txt
packages/contracts/src/index.ts
packages/contracts/src/types/common.ts
backend/src/services/**
frontend/src/lib/api/**
docs/contracts.md
docs/interfaces.md
docs/ownership.md
docs/architecture.md
package.json
package-lock.json
```

修改共享受控文件时必须同步说明影响范围，并至少运行 `npm run typecheck`。如果改变 A/B/C 交接对象，必须同步 `docs/interfaces.md`；如果改变共享对象字段，必须同步 `docs/contracts.md` 和 `packages/contracts/src/types/**`。

## 15. P3 完成后的答辩路径

推荐答辩路径:

```txt
1. 打开 Frontend Dashboard，选择 OpenClaw run group。
2. 进入 Test Run Detail，展示 TestContextView 与 trace。
3. 进入 Detection / Policy，展示风险发现、画像和策略包。
4. 启动或查看 realtime supervision，展示 RuntimeSupervisionRecord[]。
5. 进入 Report Workspace，逐条展开 claim 和 evidence。
6. 打开 Evidence Matrix，说明哪些结论完整、哪些仍有限制。
7. 打开 Traceability Graph，从 DefenseReport 回溯到 TestContext。
8. 在 Export Center 导出 Markdown / HTML / PDF。
9. 打开导出文件，展示与前端一致的 report bundle 内容。
```

最终表达:

```txt
C 线不是独立做漂亮报告。
C 线是在 A 的测试上下文和策略模板、B 的真实运行和监督记录之上，
把风险、检测、策略、防御和证据组织成可复核、可答辩、可导出的报告系统。
```
