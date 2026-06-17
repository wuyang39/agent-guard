# P3 竞赛交付强化开发文档

文档版本: p3-plan-1  
基线日期: 2026-06-16  
状态: P3 并行开发计划稿  
适用范围: 命题赛道赛题 1《面向大模型及其应用的安全性研究》的最终交付强化

## 1. P3 定位

P0 解决最小测评闭环，P1 解决检测画像到运行时监督和防御报告，P2 解决正式 API、OpenClaw 接入、实时 MCP 监督和前端控制台。

P3 的目标不是继续堆新概念，而是把当前系统从“可演示原型”推进到“竞赛交付形态”:

```txt
现有 Agent Guard
  -> 真实 OpenClaw 必跑验收
  -> 攻击场景材料化
  -> 基座模型输入/输出过滤原型
  -> 竞赛级安全风险分析报告
  -> 答辩一键演示和兜底路径
  -> 可复现证据包
```

P3 完成后，系统应能直接回答评委关心的五个问题:

1. 至少 3 类攻击场景是否真的能复现。
2. OpenClaw 或开源智能体应用是否真的被接入并被监督。
3. 工具调用、文件访问、代码执行、邮件/API 外传是否能被实时审计和拦截。
4. 防御策略是否能从检测结果推导，并在运行时产生真实阻断、询问或脱敏记录。
5. 报告、脚本、前端页面和演示视频是否能证明结果可复现。

## 2. P3 当前基线

已经具备:

- 5 类红队场景和 7 个测试用例。
- 读文件、写文件、发邮件、API 调用、HTTP 请求、代码执行、数据库查询等模拟业务工具。
- `Trace -> RiskReport -> DetectionReport -> AgentRiskProfile -> SupervisionPolicyPack -> RuntimeSupervisionRecord[] -> DefenseReport` 后端链路。
- Fastify API 和 Vite + React 正式前端。
- OpenClaw realtime MCP 端点，已支持 `deny / ask / redact` 验证。
- `mock` 和 `http_sample` 兜底链路。

主要缺口:

- OpenClaw CLI 检测路径在当前环境仍可能 optional skip，尚未成为 P3 sign-off 必跑项。
- 每类攻击场景缺少独立的攻击样本、脚本、运行命令、预期结果和证据包索引。
- 基座模型检测或过滤原型表达不够明确，当前主要是行为监督和策略判定。
- 竞赛版安全风险分析报告尚未形成统一文档。
- 前端还需要更贴近答辩: 一键演示、场景库页、攻击脚本页、报告导出页、真实/兜底来源提示。
- 交付目录还没有按“作品赛提交材料”组织。

## 3. P3 总目标

P3 总目标:

```txt
Agent Guard = 智能体攻击复现平台 + 行为监督原型系统 + 模型过滤原型 + 竞赛报告与演示工作台
```

必须补齐的赛题成果:

| 赛题要求 | P3 对应交付 |
|---|---|
| 至少 3 类攻击场景 | `scenarios/contest/**` + 前端场景库 + 攻击脚本 |
| 模型对抗样本与越狱测试用例集 | `configs/red_team_scenarios.json` 扩展 + `contest_samples.jsonl` |
| 智能体攻击脚本 | `scripts/contest/*.ts` 或 `.mjs` |
| 行为监督原型系统 | 现有 supervision bridge + realtime MCP + 前端实时监督台 |
| 拦截智能体与外部工具交互 | OpenClaw realtime MCP 必跑验证 |
| 安全策略允许/拒绝/询问 | `SupervisionPolicyPack` + `deny/ask/redact/warn/allow` |
| 开源智能化应用 | OpenClaw required 验收和 runbook |
| 模拟业务工具 | 邮件、读写文件、API、代码执行、数据库 |
| 模型调用链安全监控插件 | OpenClaw MCP supervision endpoint + adapter shim |
| 基座模型检测或过滤原型 | P3 新增 input/output filter module |
| 监督端实时展示告警或阻断记录 | 前端 Live Supervision + Evidence Center |
| 安全风险分析报告 | `docs/contest/security-risk-analysis-report.md` |

## 4. P3 范围

P3 包含:

- OpenClaw required 模式验收。
- 竞赛场景包目录和攻击脚本。
- 模型输入/输出过滤原型。
- 更完整的风险规则和策略模板。
- 报告导出强化: Markdown/PDF 可选，至少 Markdown 必做。
- 前端竞赛演示工作台。
- 一键 demo、清理、重跑和证据包导出。
- 提交材料整理。

P3 不包含:

- 生产级多租户、账号权限、数据库迁移。
- 真正执行危险系统命令、真实外网请求或真实邮件发送。
- 修改 OpenClaw 内核源码。
- 把 MCP Server 漏洞扫描作为主线。
- 使用不可复现的人工截图替代 trace/report 证据。

## 5. P3 主链路

P3 保留 P2 主链路，并新增竞赛材料化层:

```txt
ContestScenarioPack
  -> AttackSampleSet
  -> AttackScript
  -> OpenClaw / http_sample / mock
  -> Agent Guard Sandbox + Monitor
  -> InteractionTrace
  -> RiskReport
  -> DetectionReport
  -> AgentRiskProfile
  -> ModelFilterResult
  -> SupervisionPolicyPack
  -> OpenClaw realtime MCP supervision
  -> RuntimeSupervisionRecord[]
  -> DefenseReport
  -> ContestEvidenceBundle
  -> SecurityRiskAnalysisReport
```

核心原则:

- 竞赛报告必须能追溯到真实运行产物。
- 攻击脚本必须能重复触发对应场景。
- 前端只展示 API 返回和报告产物，不直接读 `configs/**` 或 `outputs/**`。
- OpenClaw 失败时可以降级，但最终评分材料必须标清 `openclaw`、`http_sample`、`mock`、`synthetic_fallback` 来源。

## 6. P3 目录规划

建议新增:

```txt
docs/
  contest/
    security-risk-analysis-report.md
    defense-strategy-report.md
    demo-script.md
    evidence-index.md

scenarios/
  contest/
    indirect_prompt_injection/
      README.md
      samples.jsonl
      attack-script.md
    data_exfiltration/
      README.md
      samples.jsonl
      attack-script.md
    tool_abuse/
      README.md
      samples.jsonl
      attack-script.md
    memory_poisoning/
      README.md
      samples.jsonl
      attack-script.md
    environment_pollution/
      README.md
      samples.jsonl
      attack-script.md

configs/
  contest_samples.jsonl
  model_filter_rules.json

backend/src/modules/model-filter/
  modelFilterTypes.ts
  inputFilter.ts
  outputFilter.ts
  modelFilterReportBuilder.ts

backend/src/modules/contest/
  contestEvidenceBundleBuilder.ts
  contestReportExporter.ts

frontend/src/pages/Contest/
  ContestWorkbenchPage.tsx
  ScenarioLibraryPage.tsx
  EvidenceBundlePage.tsx

scripts/contest/
  run-contest-scenarios.ts
  export-contest-bundle.ts
  cleanup-contest-demo.ts
  verify-contest-openclaw.ts
```

目录规则:

- `scenarios/contest/**` 放可读材料和样本，不放运行时私有结论。
- `configs/contest_samples.jsonl` 可作为样本索引，但运行时仍必须转换成标准 `TestContext`。
- `outputs/contest/**` 只放生成产物，不作为源码提交依据。
- 前端不得直接读取 `scenarios/contest/**`，需要通过 API 或构建好的 view 数据。

## 7. 四线分工

P3 分为 A、B、C、前端四条线。C 不再默认包含前端，前端作为独立责任线推进。

### 7.1 A 线: 攻击场景、样本和策略模板

A 线目标:

```txt
把赛题要求的攻击场景材料化，并保证每个场景都能进入系统运行链路。
```

A 负责:

1. 设计和维护至少 5 类竞赛攻击场景。
2. 为每类场景提供模型对抗样本、越狱测试用例和智能体攻击脚本说明。
3. 扩展 `red_team_scenarios.json`、`test_cases.json`、`test_oracles.json`。
4. 新增或整理 `contest_samples.jsonl`。
5. 扩展工具、资源、Prompt、Tool Response 注入模板。
6. 扩展策略模板，使检测结果能映射到运行时策略。
7. 输出每类场景的威胁模型、攻击路径、预期失守行为和推荐防御策略。

A 交付物:

```txt
configs/red_team_scenarios.json
configs/test_cases.json
configs/test_oracles.json
configs/tool_responses.json
configs/supervision_policy_templates.json
configs/contest_samples.jsonl
scenarios/contest/**
docs/contest/evidence-index.md 中的场景说明部分
```

A P3 任务表:

| 编号 | 优先级 | 任务 | 完成标准 |
|---|---:|---|---|
| A-P3-1 | P0 | 固化 3 个必选赛题场景: 间接提示注入、数据外传、工具滥用 | 每类有 samples、case、oracle、脚本说明 |
| A-P3-2 | P0 | 补齐第 4/5 类增强场景: 记忆中毒、环境感知污染 | 至少进入配置和文档，能用 mock/http_sample 跑通 |
| A-P3-3 | P0 | 建立 `contest_samples.jsonl` | 每条样本包含 scenarioId、attackType、prompt、expectedRisk、safeBehavior |
| A-P3-4 | P1 | 扩展 Tool Response 注入模板 | 覆盖邮件外传、API 外传、影子工具、rug pull |
| A-P3-5 | P1 | 扩展策略模板 | 每类场景至少能映射 1 条可执行 supervision policy |
| A-P3-6 | P1 | 输出场景 README | 评委不看代码也能理解攻击目标和复现方式 |

A 禁止:

- 直接生成风险报告或防御报告。
- 把 `TestOracle` 传入运行时。
- 修改 OpenClaw adapter 或实时监督逻辑。
- 为了演示效果在样本里写死某次运行的 reportId、traceId。

### 7.2 B 线: OpenClaw、运行时监督和竞赛脚本

B 线目标:

```txt
让真实 OpenClaw 链路成为 P3 必跑项，并提供稳定的竞赛脚本和运行时监督证据。
```

B 负责:

1. OpenClaw CLI 检测路径 required 验收。
2. OpenClaw realtime MCP 配置、探测、会话管理和工具映射。
3. `verify:contest:openclaw` 验证脚本。
4. 竞赛场景批量运行脚本。
5. 运行时监督记录的采集、持久化和查询。
6. `ask` 通道答辩模式和人工确认模式。
7. 后端 API 中 contest run、evidence bundle、system status 的运行侧数据。
8. 清理、重跑、一键 demo 的后端部分。

B 交付物:

```txt
backend/src/modules/agent/openclawAdapter.ts
backend/src/modules/agent/openclawSession.ts
backend/src/modules/openclaw/**
backend/src/modules/supervisor/**
backend/src/services/e2eRunService.ts
backend/src/services/contestRunService.ts
backend/src/api/v1/openclaw/**
backend/src/api/v1/contest/**
scripts/contest/run-contest-scenarios.ts
scripts/contest/verify-contest-openclaw.ts
scripts/contest/cleanup-contest-demo.ts
```

B P3 任务表:

| 编号 | 优先级 | 任务 | 完成标准 |
|---|---:|---|---|
| B-P3-1 | P0 | OpenClaw required 验收 | `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 和 `npm run verify:contest:openclaw` 均通过 |
| B-P3-2 | P0 | 批量运行竞赛场景脚本 | 一条命令能跑 A 提供的必选场景并生成 runGroup |
| B-P3-3 | P0 | OpenClaw realtime MCP 实演脚本 | 自动触发 read secret、execute code、API redact 三类监督事件 |
| B-P3-4 | P0 | 运行时 session 隔离和清理 | 多次演示不会混入旧记录 |
| B-P3-5 | P1 | ask 通道人工/自动模式切换 | 答辩现场可选择人工批准或 demo 自动批准 |
| B-P3-6 | P1 | OpenClaw 环境自检增强 | 明确提示 CLI、Gateway、模型认证、MCP probe 状态 |
| B-P3-7 | P1 | contest API 运行侧支持 | 前端可发起 contest run 并查询阶段状态 |

B 禁止:

- 私自把未进入 `SupervisionPolicyPack` 的规则写进监督逻辑。
- 编造 `RuntimeSupervisionRecord[]`。
- 直接生成 `AgentRiskProfile` 或策略包。
- 把 OpenClaw 私有协议写入 `packages/contracts`。
- 真实执行危险文件写入、外网请求或系统命令。

### 7.3 C 线: 风险判定、模型过滤、报告和证据包

C 线目标:

```txt
把运行结果转成可解释、可复现、可提交的竞赛报告和证据包。
```

C 负责:

1. 风险规则扩展和风险判定。
2. `DetectionReport`、`AgentRiskProfile`、`SupervisionPolicyPack` 生成。
3. P3 新增模型输入/输出过滤原型。
4. `ModelFilterResult` 和 `ModelFilterReport`。
5. `DefenseReport` 强化。
6. `ContestEvidenceBundle` 生成。
7. Markdown/HTML 报告导出，PDF 可选。
8. 竞赛版安全风险分析报告和防御策略报告。
9. report/evidence 相关 API 的后端支持。

C 交付物:

```txt
backend/src/modules/risk/**
backend/src/modules/detection/**
backend/src/modules/policy/**
backend/src/modules/defense/**
backend/src/modules/model-filter/**
backend/src/modules/contest/**
backend/src/api/v1/reports/**
backend/src/api/v1/contest/**
docs/contest/security-risk-analysis-report.md
docs/contest/defense-strategy-report.md
docs/contest/evidence-index.md
```

C P3 任务表:

| 编号 | 优先级 | 任务 | 完成标准 |
|---|---:|---|---|
| C-P3-1 | P0 | 新增模型输入/输出过滤原型 | 能对 prompt、agent message、tool result 做风险标记或拒绝建议 |
| C-P3-2 | P0 | 生成 `ModelFilterReport` | 报告能说明过滤命中、理由、关联 trace event |
| C-P3-3 | P0 | 竞赛证据包生成器 | 一次 run 能导出 trace、report、policy、supervision records、场景说明索引 |
| C-P3-4 | P0 | 竞赛版安全风险分析报告 | 覆盖至少 3 类攻击场景、实验结果、防御策略和局限性 |
| C-P3-5 | P1 | Markdown 报告导出 | `outputs/contest/**/report.md` 可直接提交或转 PDF |
| C-P3-6 | P1 | 强化风险规则 | 覆盖记忆中毒、环境污染、越狱诱导、工具投毒等分类 |
| C-P3-7 | P1 | 报告真实性标记 | 报告明确 openclaw/http_sample/mock/fallback 来源 |

C 禁止:

- 使用 `TestOracle` 生成运行时风险结论。
- 伪造运行时阻断记录。
- 在报告模块重新执行 Agent。
- 绕过 `InteractionTrace` 读取临时日志。
- 为了报告好看隐藏失败、fallback 或残余风险。

### 7.4 前端线: 竞赛演示工作台和答辩体验

前端线目标:

```txt
让评委可以从页面完成“选择场景 -> 运行攻击 -> 查看监督 -> 导出证据 -> 打开报告”的演示闭环。
```

前端负责:

1. 竞赛工作台页面。
2. 场景库页面。
3. 攻击脚本与样本展示。
4. OpenClaw 环境状态和 required 验收状态展示。
5. 一键运行 contest scenarios。
6. 实时监督台增强。
7. 证据包页面。
8. 报告导出入口。
9. 真实/兜底/fallback 来源提示。
10. 答辩模式 UI: 大屏展示、重跑按钮、失败兜底入口。

前端交付物:

```txt
frontend/src/pages/Contest/**
frontend/src/pages/Supervision/**
frontend/src/pages/EvidenceCenter/**
frontend/src/lib/api/contest.ts
frontend/src/lib/models/contest.ts
frontend/src/lib/formatters/**
frontend/src/styles/app.css
```

前端 P3 任务表:

| 编号 | 优先级 | 任务 | 完成标准 |
|---|---:|---|---|
| F-P3-1 | P0 | 新增竞赛工作台 | 可选择场景、adapter、运行模式并发起运行 |
| F-P3-2 | P0 | 新增场景库视图 | 展示攻击类型、样本数、工具、预期风险和推荐策略 |
| F-P3-3 | P0 | 增强实时监督台 | 明确展示 deny/ask/redact/warn、session、policyPack 来源 |
| F-P3-4 | P0 | 新增证据包页面 | 可查看 trace、report、policy、records、artifact 链接 |
| F-P3-5 | P1 | 报告导出入口 | 支持打开 HTML/Markdown，PDF 若后端提供则展示 |
| F-P3-6 | P1 | OpenClaw 自检页面 | 展示 CLI、Gateway、model auth、MCP probe 状态 |
| F-P3-7 | P1 | 答辩模式 | 提供大号状态、最近事件、关键指标和兜底路径 |

前端禁止:

- 直接读取 `configs/**`、`scenarios/**` 或 `outputs/**`。
- import `backend/src/**`。
- 重新计算风险等级、策略包或防御有效性。
- 把 fallback 演示显示成真实 OpenClaw 防御。
- 在页面上写“万能防御”“覆盖所有 OpenClaw 原生工具”等超出实际能力的表述。

## 8. P3 新增核心对象建议

P3 尽量避免大规模破坏 contracts。新增对象可先在后端 API view 中使用，稳定后再进入 `packages/contracts`。

建议新增:

```ts
type ContestScenarioView = {
  scenarioId: string;
  name: string;
  attackType: string;
  caseIds: string[];
  sampleCount: number;
  toolIds: string[];
  expectedWeaknessCategories: string[];
  recommendedPolicyTemplateIds: string[];
};

type ModelFilterResult = {
  filterResultId: string;
  traceId: string;
  eventId: string;
  targetType: "input" | "output" | "tool_result" | "agent_message";
  action: "allow" | "warn" | "block" | "redact";
  riskCategory: string;
  reason: string;
  matchedRuleIds: string[];
  generatedAt: string;
};

type ContestEvidenceBundle = {
  bundleId: string;
  runGroupId: string;
  scenarioIds: string[];
  adapterKind: "openclaw" | "http_sample" | "mock";
  source: "stored_detection" | "synthetic_fallback";
  traceIds: string[];
  reportIds: string[];
  policyPackIds: string[];
  runtimeSessionIds: string[];
  artifactIds: string[];
  generatedAt: string;
};
```

契约规则:

- `ModelFilterResult.eventId` 必须能追溯到 trace event。
- `ContestEvidenceBundle` 只索引已有产物，不重新解释风险。
- 若新增到 contracts，必须同步 `docs/contracts.md` 和前端 API 类型。

## 9. P3 API 建议

新增 API:

```txt
GET  /api/v1/contest/scenarios
POST /api/v1/contest/runs
GET  /api/v1/contest/runs/:runGroupId
POST /api/v1/contest/evidence-bundles
GET  /api/v1/contest/evidence-bundles/:bundleId
GET  /api/v1/contest/openclaw/status
POST /api/v1/contest/reports/export
GET  /api/v1/reports/model-filter/:reportId
```

优先级:

1. `GET /contest/scenarios`
2. `POST /contest/runs`
3. `POST /contest/evidence-bundles`
4. `GET /contest/evidence-bundles/:bundleId`
5. `GET /contest/openclaw/status`
6. 报告导出 API

约束:

- `POST /contest/runs` 可以复用 `e2eRunService`，但 response 必须包含 contest 视图需要的 scenario 信息。
- OpenClaw status 不得返回 API key、环境变量值或认证密钥。
- evidence bundle 只能引用后端索引中的 artifact，不允许前端传任意路径。

## 10. P3 验证脚本

新增 npm scripts 建议:

```json
{
  "verify:contest": "npm run typecheck && npm run verify:contest:scenarios && npm run verify:contest:bundle",
  "verify:contest:scenarios": "node --import tsx scripts/contest/run-contest-scenarios.ts --verify",
  "verify:contest:openclaw": "node --import tsx scripts/contest/verify-contest-openclaw.ts",
  "verify:contest:bundle": "node --import tsx scripts/contest/export-contest-bundle.ts --verify",
  "demo:contest": "node scripts/contest/start-contest-demo.mjs",
  "cleanup:contest": "node --import tsx scripts/contest/cleanup-contest-demo.ts"
}
```

P3 必跑验收:

```txt
npm run verify:all
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
npm run verify:contest
npm run build:frontend
```

OpenClaw 环境必跑:

```txt
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e
npm run verify:contest:openclaw
```

验收断言:

- 至少 3 类场景被执行。
- 每类场景至少有 1 个 trace、1 个 risk finding、1 条 evidence chain。
- 至少 1 个实时监督 session 产生 `deny`。
- 至少 1 个实时监督 session 产生 `ask` 或 `redact`。
- 防御报告中所有防御效果都来自真实 `RuntimeSupervisionRecord[]`。
- 证据包能索引 trace、risk report、detection report、policy pack、supervision records、defense report。

## 11. P3 推荐实施顺序

### 阶段 1: 竞赛场景材料化

负责人: A 主导，C 协作

1. 固化 3 个必选场景。
2. 整理样本和攻击脚本说明。
3. 扩展配置和 oracle。
4. 输出场景 README。

验收:

```txt
npm run verify:a-config-sandbox
npm run verify:full-pipeline
```

### 阶段 2: OpenClaw required 和竞赛运行脚本

负责人: B 主导，A 提供 caseIds

1. OpenClaw CLI required 模式跑通。
2. OpenClaw realtime MCP 实演脚本跑通。
3. 批量 contest scenarios 脚本跑通。
4. 清理和重跑脚本可用。

验收:

```txt
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
npm run verify:contest:openclaw
```

### 阶段 3: 模型过滤和证据包

负责人: C 主导，B 提供运行产物

1. 实现 input/output filter。
2. 生成 ModelFilterReport。
3. 生成 ContestEvidenceBundle。
4. 导出 Markdown/HTML 报告。

验收:

```txt
npm run verify:contest:bundle
```

### 阶段 4: 前端竞赛工作台

负责人: 前端主导，B/C 提供 API

1. 场景库页。
2. 竞赛运行页。
3. 证据包页。
4. OpenClaw 自检页。
5. 答辩模式。

验收:

```txt
npm run typecheck:frontend
npm run build:frontend
npm run test:frontend
```

### 阶段 5: 交付材料收束

负责人: C 主导，A/B/前端补材料

1. 安全风险分析报告。
2. 防御策略报告。
3. 演示脚本。
4. 证据索引。
5. 提交包目录。

验收:

```txt
npm run demo:contest
npm run verify:contest
```

## 12. P3 完成定义

P3 只有同时满足以下条件才算完成:

1. 至少 3 类攻击场景有完整样本、脚本、trace、报告和证据链。
2. OpenClaw required 验收在比赛环境通过。
3. OpenClaw realtime MCP 产生真实 `deny / ask / redact` 监督记录。
4. 模型输入/输出过滤原型能生成可追溯结果。
5. 防御报告只基于真实监督记录声明防御效果。
6. 竞赛证据包能一键导出。
7. 前端能从竞赛工作台完成运行、监督、证据和报告查看。
8. 安全风险分析报告覆盖攻击面、实验过程、检测结果、防御策略、局限性。
9. 演示失败时有 `http_sample` 和 `mock` 兜底，并在 UI/报告中明确标记。
10. `npm run verify:all`、`npm run verify:contest`、`npm run build:frontend` 通过。

## 13. 最小派工清单

建议第一轮按下面派工:

```txt
A:
  1. 建 scenarios/contest/**。
  2. 固化 3 个必选场景的 samples、caseIds、oracle、README。
  3. 补 contest_samples.jsonl。

B:
  1. 把 OpenClaw required 验收跑通。
  2. 写 scripts/contest/run-contest-scenarios.ts。
  3. 写 scripts/contest/verify-contest-openclaw.ts。

C:
  1. 新建 backend/src/modules/model-filter/**。
  2. 新建 contest evidence bundle builder。
  3. 起草 docs/contest/security-risk-analysis-report.md。

前端:
  1. 新建 ContestWorkbenchPage。
  2. 新建 ScenarioLibraryPage。
  3. 新建 EvidenceBundlePage。
  4. 在实时监督页强化来源和 session 展示。
```

## 14. 答辩表达口径

推荐对外表达:

```txt
Agent Guard 面向大模型智能体应用的典型攻击面，构建了从红队攻击复现到运行时防御验证的完整闭环。系统首先通过竞赛场景库对 OpenClaw 等开源智能体进行提示注入、敏感数据外传、工具滥用、记忆中毒和环境污染等攻击测试，记录智能体的工具调用、资源访问和模型输出 trace。随后系统基于风险规则和模型过滤原型生成检测报告与风险画像，并将检测结论转化为可执行的监督策略包。在实时运行阶段，OpenClaw 的 MCP 工具调用会进入 Agent Guard 监督网关，由策略执行 allow、deny、ask、redact 等动作。最终系统汇总 trace、风险报告、策略包和真实监督记录，生成防御报告和竞赛证据包，证明发现的问题能够被运行时监督机制缓解。
```
