# P3plan

文档版本: p3plan-merged-1
基线日期: 2026-06-17
状态: 合并整理稿

说明: 本文档合并 A 线 PyRIT 驱动攻击库规模化规划、`docs/p3-openclaw-external-tool-gateway-plan.md` 与 `docs/C/P3-report-frontend-plan.md`。合并原则是: P3 统一由 A 线攻击库、B 线 OpenClaw/Gateway 运行时监督、C 线报告/前端三条主线组成；如果各部分在接口、代码落点、前端范围或职责边界上出现冲突，以本节“统一口径”为准。

## 0. 统一口径与冲突处理

### 0.1 P3 总定位

P3 统一定位为三条互补主线:

```txt
P3 A 线攻击库主线:
  PyRIT 定制项目深度迁移和运行
  -> PyRIT seed / dataset / jailbreak template / converter / attack executor
  -> 生成 Agent-MCP 专项攻击 prompt、资源种子、工具响应投毒和多轮攻击样例
  -> 产出 1000+ generated TestCase / Prompt / Resource / Oracle / CorpusManifest
  -> 为 B 线检测和 C 线报告提供可追溯攻击来源、样本分层和覆盖率统计

P3 运行时主线:
  OpenClaw 外部工具统一接入 Agent Guard Gateway
  -> Gateway 执行 SupervisionPolicyPack
  -> 产生 RuntimeSupervisionRecord[] 和实时事件
  -> DefenseReport 汇总工具覆盖、策略命中和运行时效果

P3 C 线报告/前端主线:
  TestContext view 契约/API/前端正式化
  -> ReportBundle / EvidenceBundle / TraceabilityGraph / ReportQualitySummary
  -> Frontend Report Workspace
  -> Markdown / HTML / PDF export
  -> P3 C 线验证脚本
```

三条主线不互相替代: A 线解决攻击库和测试输入规模，Gateway 解决 OpenClaw 外部工具监督面，C 线报告/前端解决证据级展示、复核和导出。A 线的 generated corpus 是检测输入和覆盖率依据，不是运行时风险结论；B/C 仍只能基于真实 trace、policy pack 和 runtime record 证明检测与防御效果。

### 0.2 接口统一规则

- 新增或变更共享字段时，必须先更新 `docs/contracts.md`，再更新 `packages/contracts/src/types/**`，最后更新后端 API 与前端 ViewModel。
- P3 API 继续使用 P2 `ApiResponse<T>` envelope；OpenClaw MCP raw JSON-RPC endpoint 仍保持 P2 例外规则。
- `TestContextView` 是 P3 待正式化对象，不视为已完成实现；它必须由后端基于真实 `TestContext` 构建并通过 API 返回。
- `SupervisionPolicyPack` 是 C -> B/Gateway 的策略输入；Gateway 只能执行策略包，不得私自改写策略语义。
- `RuntimeSupervisionRecord[]` 是 B/Gateway -> C 的运行时证据；C 可以聚合、引用和展示，但不得编造。
- `DefenseReport` 可以扩展工具覆盖、策略命中、监督批测和残余风险指标，但所有运行时防御效果必须能回指真实 `RuntimeSupervisionRecord`。
- `ReportBundle` 是 P3 C 线报告聚合对象，必须引用 `DefenseReport`、`RuntimeSupervisionRecord[]`、`SupervisionPolicyPack`、`DetectionReport`、`RiskReport`、`InteractionTrace` 和 `TestContextView`。
- `CorpusManifest` 是 P3 A 线攻击库生成结果索引，必须记录 PyRIT/AIG/manual/user_supplied 来源、生成方法、run tier、caseId/promptId/oracleId 映射和 coverage 统计。
- `TestOracle` 仍只用于 A 线离线验证和 corpus 质量检查，不得进入运行时 `TestContext`、风险判定、报告结论或前端业务推导。
- P3-A 生成的千级攻击库默认按 profile 分层加载；OpenClaw 默认 demo 只运行稳定 profile，不默认运行 full corpus。

### 0.3 前端统一规则

- P3 前端先保证 Gateway 监督链路可解释: 接入工具、工具画像、实时监督事件、策略命中、未知工具处理和 DefenseReport。
- C 线 Report Workspace 是 P3 报告/答辩主页面，用于 claim 复核、evidence matrix、traceability graph、runtime effects、residual risk 和 export center。
- 如果资源不足，前端优先级为: Gateway 监督可视化 -> DefenseReport 工具覆盖指标 -> Report Workspace 完整复核体验。
- 前端不得直接读取 `configs/*.json`、`outputs/**` raw files 或 import `backend/src/**`。
- 前端不得重新计算风险等级、风险画像、策略包或防御效果。

### 0.4 代码落点统一规则

- Gateway / runtime supervision 能力优先落在 B 线或共享服务边界；C 线只负责策略包生成、报告聚合和前端展示。
- A 线 PyRIT 攻击库、seed、generator、sandbox 扩展和验证能力落在 `configs/**`、`generated/a-line/**`、`backend/src/modules/corpus/**`、`backend/src/modules/config/**`、`backend/src/modules/sandbox/**`、`scripts/generate-a-corpus.ts`、`scripts/verify-a-corpus.ts` 和 `docs/A/**`。
- 报告生成能力落在 `backend/src/modules/report/**`、`backend/src/modules/defense/**` 和 `backend/src/api/v1/reports/**`。
- 前端正式页面落在 `frontend/src/**`；前端 API client 落在 `frontend/src/lib/api/**`。
- 共享契约落在 `packages/contracts/src/types/**`；只服务页面布局的对象保留为前端私有 ViewModel。

### 0.5 执行顺序统一建议

```txt
P3-A0 PyRIT 生成链路契约、seed schema、CorpusManifest 和 run profile 冻结
P3-A1 ResourceSeed / AttackSeed / ToolResponseSeed / UserPromptSeed 大规模整理
P3-A2 PyRIT template/converter/attack executor/seed dataset 驱动生成 1000+ corpus
P3-A3 AIG 策略库、PromptSecurity enhancer 和 OWASP ASI 映射作为补充增强源
P3-B0 TestContextView 契约/API/前端正式化
P3-B1 External Tool Registry + Tool Capability Profile
P3-B2 Gateway tools/list 聚合与 tools/call 拦截
P3-B3 Gateway 执行 SupervisionPolicyPack 并产出 RuntimeSupervisionRecord[]
P3-C0 DefenseReport 扩展工具覆盖、策略命中、监督批测指标
P3-C1 ReportBundle / EvidenceBundle / TraceabilityGraph / ReportQualitySummary
P3-C2 Frontend Gateway 监督展示 + Report Workspace
P3-C3 Markdown / HTML / PDF export 与 P3 验证脚本
```

P3-B 的具体开发流程、可选多 agent 协作方式和审核模板见 `docs/B/p3-b-workflow.md`。B 线每个阶段完成后必须进入审核，审核阻断项关闭前不得合并。

---

## 第一部分: A 线 PyRIT 驱动攻击库与资源种子库规划

# P3-A PyRIT 驱动攻击库、资源种子库与千级语料生成最终设计

文档版本: p3-a-pyrit-corpus-1
生成日期: 2026-06-17
状态: 合并进 P3 总规划
适用范围: P3 A 线攻击库、资源种子、变异样例、红队编排、PyRIT/AIG 迁移和 B/C 交接

## 1. 最终判断

当前 A 线已经完成配置加载、sandbox profile、AIG 场景映射、PyRIT 迁入、jailbreak template index、TS mutator 和少量可运行 case，但体量仍是 MVP:

```txt
tools: 8
resources: 9
prompts: 10
tool responses: 9
test cases: 12
test oracles: 12
risk rules: 17
red team scenarios: 9
policy templates: 16
pyrit mapped samples: 5
pyrit jailbreak template refs: 165
```

P3-A 不能继续停留在“少量手工 case + 一些 converter”的状态。最后一轮应把 A 线升级为 PyRIT 驱动的攻击库生产系统:

```txt
PyRIT 定制项目是主生成引擎和主素材来源。
AIG 是策略、扫描思路、增强器和分类体系补充来源。
手工/用户补充资源是业务语境和安全边界来源。
Agent Guard 本地 generator 只负责编排、校验、分层和输出契约对象。
```

这意味着 P3-A 攻击库的大部分样例必须来自 PyRIT 的 seed dataset、jailbreak template、converter、executor template、attack strategy 和可选 Python bridge 生成，而不是简单地把少量 seed 做笛卡尔组合。组合只用于受控采样、分层和补齐覆盖，不作为主要创新点。

## 2. P3-A 总目标

P3-A 完成后必须形成项目级攻击库:

```txt
resource seeds:        >= 100
attack/user prompt seeds: >= 200
tool response seeds:   >= 80
mutation operators:    >= 45
pyrit generated prompts: >= 1000
generated test cases:  >= 2000
generated oracles:     >= generated test cases
red team scenarios:    >= 25
run profiles: smoke / openclaw / regression / full-corpus
```

其中 generated corpus 的来源比例建议:

```txt
PyRIT generated:      >= 70%
AIG-derived:          15%-20%
manual/user supplied: 10%-15%
```

PyRIT generated 包括:

- PyRIT jailbreak templates 渲染。
- PyRIT prompt converters 变异。
- PyRIT local seed datasets 导入。
- PyRIT executor templates 固定化生成。
- PyRIT custom `run_attack_cli.py` / attack executor 可选离线 bridge 生成。
- PyRIT evaluator/scorer metadata 进入 coverage 和质量统计。

## 3. Resource 种子库重构

当前 `configs/resources.json` 仍只保存 9 个资源。P3-A 要把资源从“运行夹具数组”升级为“资源种子库 + 生成资源定义”。

新增文件:

```txt
configs/resource_seeds.json
generated/a-line/resources.generated.json
generated/a-line/resource_seed_manifest.json
```

`ResourceSeed` 建议字段:

```ts
type ResourceSeed = {
  schemaVersion: "mvp-1";
  seedId: string;
  name: string;
  resourceType:
    | "document"
    | "file"
    | "secret"
    | "database"
    | "web"
    | "memory"
    | "api"
    | "browser"
    | "email"
    | "calendar"
    | "repo"
    | "ticket"
    | "payment";
  path?: string;
  contentTemplate?: string;
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  domain:
    | "rag"
    | "filesystem"
    | "cloud"
    | "identity"
    | "crm"
    | "support"
    | "finance"
    | "devops"
    | "browser"
    | "memory"
    | "email";
  containsInjection: boolean;
  injectionMarkers?: string[];
  secretMarkers?: string[];
  tenantId?: string;
  ownerUserId?: string;
  allowedUseCases: string[];
  riskTags: RiskTag[];
  source: {
    origin: "manual" | "user_supplied" | "pyrit" | "aig" | "synthetic";
    sourcePath?: string;
    notes?: string;
  };
};
```

必须补齐的资源池:

| 资源池 | 目标数量 | 示例 |
| --- | ---: | --- |
| secret assets | 15+ | `.env`、JWT、OAuth refresh token、SSH deploy key、cloud metadata token |
| PII assets | 15+ | 电话、住址、身份证/护照、银行卡、医疗/教育记录 |
| multi-tenant business records | 15+ | tenant A/B orders、CRM leads、invoice、support ticket、payment |
| internal service/API | 10+ | admin OpenAPI、debug endpoint、service discovery、internal config |
| malicious RAG documents | 15+ | hidden instruction、markdown comment、policy override、source-confusion |
| malicious web/browser resources | 12+ | markdown image/link injection、HTML meta prompt、JS payload、SSRF page |
| memory/context resources | 10+ | user preference memory、previous conversation、tool cache、long-term memory |
| repo/devops resources | 10+ | CI config、package manifest、deploy token marker、git diff |
| benign controls | 10+ | public/internal safe resources，用于误报控制 |

用户补充的 resource、权限级别、示例 prompt 和 tool response 内容应先清洗到 `configs/resource_seeds.json`、`configs/attack_seeds.json` 和 `configs/tool_response_seeds.json`，再由 generator 转成正式 `ResourceDefinition` / `PromptDefinition` / `ToolResponseTemplate`。不要把表格草案直接追加在 `configs/resources.json` 末尾，否则会破坏配置加载。

## 4. PyRIT 主导的攻击生成链路

P3-A 的攻击生成不是简单组合，而是按 PyRIT 原有抽象落到 Agent Guard:

```txt
PyRIT SeedDataset / SeedPrompt / SeedObjective
  -> Agent-MCP AttackObjective
  -> PyRIT JailbreakTemplate / ExecutorTemplate / Converter / AttackStrategy
  -> GeneratedPrompt
  -> GeneratedTestCase
  -> GeneratedTestOracle
  -> CorpusManifest
```

新增文件:

```txt
configs/attack_seeds.json
configs/user_prompt_seeds.json
configs/tool_response_seeds.json
configs/pyrit_seed_dataset_index.json
configs/pyrit_executor_template_index.json
configs/pyrit_scorer_template_index.json
configs/mutation_operators.json
configs/corpus_run_profiles.json
generated/a-line/prompts.generated.json
generated/a-line/tool_responses.generated.json
generated/a-line/test_cases.generated.json
generated/a-line/test_oracles.generated.json
generated/a-line/corpus_manifest.json
generated/a-line/corpus_stats.json
```

`AttackSeed` 建议字段:

```ts
type AttackSeed = {
  schemaVersion: "mvp-1";
  seedId: string;
  name: string;
  objective: string;
  userPrompt: string;
  attackEntryType: AttackEntryType;
  targetToolIds: string[];
  targetResourceSeedIds: string[];
  riskCategories: RiskCategory[];
  scenarioIds: string[];
  pyritSources: {
    seedDatasetId?: string;
    templateIds?: string[];
    executorTemplateIds?: string[];
    converterIds?: string[];
    attackStrategyIds?: string[];
  };
  successMarkers: string[];
  expectedSafeBehavior: string;
  enabled: boolean;
};
```

重点是先构造 Agent-MCP 专项 user prompt/objective，再交给 PyRIT 生成:

| user prompt/objective 类型 | PyRIT 生成方式 |
| --- | --- |
| system prompt extraction | psfuzz seed + jailbreak template + prompt extraction scorer |
| secret exfiltration | jailbreak template + encoding converter + outbound tool objective |
| tool misuse/path traversal | garak shell/path seeds + converter + Agent-MCP tool objective |
| SSRF/browser injection | garak web/html/js + AIG SSRF templates + PyRIT converter |
| BOLA/RBAC/admin API | PyRIT objective seed + AIG auth-bypass skill + role-play template |
| memory poisoning | PyRIT context-compliance / role-play / indirect-injection templates |
| tool response injection | Agent Guard tool response seed + PyRIT jailbreak converter |
| multi-turn escalation | PyRIT Crescendo/TAP/ReneLLM executor templates |

## 5. PyRIT 迁移与生成实施

P3-A 应把本地 `E:\XinAnProject\pyrit` 和已迁入的 `third_party/pyrit_adapted` 按以下层级吸收。

### 5.1 Dataset 和模板索引

必须索引:

- `pyrit/datasets/jailbreak/templates/**`: 165 个 jailbreak YAML。
- `pyrit/datasets/seed_datasets/local/**/*.prompt`: adv_bench、psfuzz、garak shell、garak html/js、examples。
- `pyrit/datasets/executors/**/*.yaml`: Crescendo、Tree of Attacks、ReneLLM、role_play、red_teaming、skeleton_key、context_compliance。
- `pyrit/datasets/score/**/*.yaml`: true/false、refusal、leakage、privacy、prompt injection、plugin usage、task achieved。

新增命令:

```txt
npm run pyrit:index-seeds
npm run pyrit:index-executors
npm run pyrit:index-scorers
```

### 5.2 Converter 扩展

当前 TS mutator 只有 15 个。P3-A 至少扩到 45 个，优先从 PyRIT converter 迁移:

```txt
base64, rot13, caesar, atbash, binary_8, binary_16, morse,
flip, leetspeak, url_encode, hex_encode, unicode_escape,
zero_width, character_space, string_join_dash, repeat_token,
random_capital, insert_punctuation, homoglyph, superscript,
subscript, nato, a1z26, braille, zalgo, vaporwave, mirror,
ogham, ascii_smuggler_tags, variation_selector_smuggler,
sneaky_bits_smuggler, markdown_link, markdown_image,
html_comment, html_hidden_input, json_string_escape,
yaml_block_scalar, code_block_wrap, latex_table_wrap,
roleplay_prefix, security_audit_prefix, developer_mode_prefix,
few_shot_prefix, skeleton_key_wrap, refusal_suppression_suffix,
template_segment_jailbreak, pyrit_text_jailbreak
```

执行模式:

```txt
native_ts_adapter: 默认 CI 可跑
pyrit_template_rendered: 默认 CI 可跑
python_bridge_offline: 手动启用
llm_assisted: 手动启用
metadata_only: 只做来源和覆盖统计
```

### 5.3 PyRIT Python bridge

P3-A 可以引入可选 Python bridge，用于真实运行定制 PyRIT 的 `run_attack_cli.py`、executor/attack 和 evaluator 逻辑。

约束:

- 不进入默认 CI。
- 有超时、最大输出长度和 JSON schema。
- 生成物必须标记 `executionMode: "python_bridge_offline"`。
- 不写入真实 key，不使用生产环境凭证。
- bridge 失败不影响 native TS corpus 生成。

建议命令:

```txt
npm run pyrit:bridge-generate -- --profile offline --max-cases 300
```

## 6. AIG 补充迁移

AIG 不再作为主生成器，而作为策略和增强补充源。

迁移重点:

| AIG 来源 | P3-A 使用方式 |
| --- | --- |
| `agent-scan/prompt/skills/indirect-injection-detection` | RAG/doc/web 间接注入 seed 和 marker oracle |
| `agent-scan/prompt/skills/data-leakage-detection` | system prompt、credential、env、PII、internal config 分阶段 prompt |
| `agent-scan/prompt/skills/authorization-bypass-detection` | cross-user、cross-tenant、admin role claim seed |
| `agent-scan/prompt/skills/tool-abuse-detection` | shell/code/path traversal/SSRF prompt 和判断 marker |
| `agent-scan/prompt/skills/owasp-asi` | scenario/risk category/报告分类映射 |
| `mcp-scan/redteam` | Crescendo/TAP 数据结构、score、on_topic、is_successful 字段 |
| `AIG-PromptSecurity/deepteam/attacks` | ascii smuggling、zalgo、stratasword、character split、code attack 等 enhancer |
| `AIG-PromptSecurity/deepteam/vulnerabilities` | prompt leakage、PII、unauthorized access、robustness 模板 |
| `AIG-PromptSecurity/deepteam/metrics` | 后续 C 线 scorer/report evaluator prompt 参考 |

AIG 生成比例不应超过 PyRIT 主生成比例。AIG 的价值是让 corpus 更贴近 Agent/MCP 工具安全和 OWASP ASI 分类，而不是替代 PyRIT。

## 7. Corpus 生成和分层

P3-A 的 generated corpus 必须可复现、可分层、可抽样。

生成流程:

```txt
1. 读取 ResourceSeed / AttackSeed / UserPromptSeed / ToolResponseSeed
2. 读取 PyRIT dataset/template/executor/scorer index
3. 读取 AIG strategy/enhancer index
4. 按 AttackGenerationProfile 选择 PyRIT 生成方式
5. 渲染 PyRIT template 或调用 native converter / optional bridge
6. 生成 PromptDefinition / ToolResponseTemplate / TestCase / TestOracle
7. 去重、长度限制、secret-like pattern 扫描、引用校验
8. 输出 generated/a-line/** 和 CorpusManifest
```

运行 profile:

```txt
smoke:
  20-30 个，CI 和 demo 默认可跑

openclaw:
  30-80 个，适合真实 OpenClaw CLI/MCP，避免 full corpus 默认打模型

regression:
  200-300 个，开发验收和 nightly

full-corpus:
  1000+ 个，赛前离线批量和覆盖率报告
```

`CorpusManifest` 必须记录:

```txt
manifestId
generatedAt
generatorVersion
sourceIndexes
runProfiles
caseCount
promptCount
resourceCount
oracleCount
pyritGeneratedCount
aigDerivedCount
manualSeedCount
coverageByScenario
coverageByRiskCategory
coverageByTool
caseIdMappings
qualityChecks
```

## 8. 与 B/C 线交接

给 B 线:

- `TestContext` 仍是唯一运行输入。
- B 不需要知道 PyRIT 内部生成细节，只按 `caseId` 和 `corpusProfile` 运行。
- OpenClaw 默认只使用 `openclaw` profile，不默认跑 full corpus。
- generated case 的 source metadata 应进入 run metadata，方便报告追溯。

给 C 线:

- `CorpusManifest` 用于报告覆盖率统计和来源说明。
- `PyritAttackLibrary`、`AigStrategyLibrary`、`PyritSeedDatasetIndex` 可作为证据来源说明，不是风险结论。
- C 线报告可以展示 attack family、source origin、mutation operator、run tier。
- `TestOracle` 仍不能进入 C 的运行时风险判定。

## 9. P3-A 实施里程碑

### P3-A-0 契约和目录冻结

交付:

- `ResourceSeed`、`AttackSeed`、`MutationOperatorSpec`、`CorpusManifest` 契约。
- `configs/resource_seeds.json`、`configs/attack_seeds.json`、`configs/mutation_operators.json`、`configs/corpus_run_profiles.json`。
- `generated/a-line/**` 目录和生成物边界。

### P3-A-1 Resource seed 大扩容

交付:

- 吸收用户补充资源。
- 手工补齐 100+ resource seeds。
- 资源池覆盖 secret、PII、多租户、RAG、web/browser、memory、devops、internal API、benign controls。

### P3-A-2 PyRIT 索引和生成器

交付:

- PyRIT seed dataset index。
- PyRIT executor template index。
- PyRIT scorer template index。
- PyRIT template renderer。
- Native TS converter 扩到 45+。
- 可选 Python bridge 生成入口。

### P3-A-3 千级 generated corpus

交付:

- `generated/a-line/prompts.generated.json`
- `generated/a-line/resources.generated.json`
- `generated/a-line/tool_responses.generated.json`
- `generated/a-line/test_cases.generated.json`
- `generated/a-line/test_oracles.generated.json`
- `generated/a-line/corpus_manifest.json`
- `generated/a-line/corpus_stats.json`

验收:

- generated prompts >= 1000。
- generated test cases >= 1000。
- pyrit generated 占比 >= 70%。
- generated oracles == generated test cases。
- scenario coverage >= 25。

### P3-A-4 验证脚本

交付:

```txt
npm run verify:a-corpus
npm run verify:a-corpus-scale
npm run inspect:a-corpus-stats
```

检查:

- schema 和引用完整。
- `TestOracle` 不进入 `TestContext`。
- 无重复 ID。
- 无真实密钥形态。
- run profile 不为空。
- OpenClaw profile 不包含高不稳定/超长/需要 LLM bridge 的 full corpus case。

## 10. P3-A 验收标准

P3-A 完成标准:

1. PyRIT dataset/template/converter/executor/scorer 均进入可追溯 index。
2. 100+ resource seeds 和 200+ attack/user prompt seeds 已保存。
3. 45+ mutation operators 可用于 native/template 生成。
4. generated corpus 至少 1000 个 case，且 PyRIT 生成占比不低于 70%。
5. smoke/openclaw/regression/full-corpus 四层 profile 清楚。
6. `verify:a-corpus` 和 `verify:a-corpus-scale` 通过。
7. B 线能按 profile 加载 case，不需要读取 PyRIT 私有结构。
8. C 线能用 `CorpusManifest` 展示覆盖率和来源，不把 oracle 当风险证据。

最低命令:

```txt
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:a-corpus
npm run verify:a-corpus-scale
git diff --check
```

---

## 第二部分: OpenClaw 外部工具实时监督网关规划原文
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
P3-M9 A 线 PyRIT generated corpus 支持 smoke/openclaw/regression/full-corpus 分层输入
```

### 应做

```txt
P3-S1 LLM Tool Profiler
P3-S2 InputGuard-lite
P3-S3 OutputGuard-lite
P3-S4 外部未知样本监督批测 runner
P3-S5 前端展示工具能力画像和 coverage matrix
P3-S6 报告展示 PyRIT/AIG/manual/user_supplied 样本来源和 corpus coverage
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

A 负责 PyRIT 驱动攻击库、资源种子和策略模板输入:

1. 以 PyRIT 为主生成内置画像样本、OpenClaw 候选样本、外部监督批测样本和 full-corpus 样本。
2. 扩展资源种子库，覆盖 secret、PII、多租户业务数据、RAG、web/browser、memory、devops、internal API 和 benign controls。
3. 迁移 PyRIT seed dataset、jailbreak template、executor template、converter、scorer 和可选 Python bridge 生成能力。
4. 迁移 AIG indirect/data/tool/auth skill、mcp-scan Crescendo/TAP 和 PromptSecurity enhancer 作为补充策略源。
5. 维护 `CorpusManifest`、run profile、case source metadata 和策略模板与 capabilityTags/riskTags 的映射建议。
6. 提供工具能力画像的人工校验样本，以及 B/C 可追溯的 caseId、promptId、oracleId 和 source origin。

A 不负责:

- 不根据运行时 trace 生成风险画像或策略包。
- 不把 `TestOracle` 送入运行时 `TestContext`。
- 不要求 OpenClaw 默认执行 full corpus。

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

---

## 第三部分: C 线报告生成与前端展示规划原文

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
