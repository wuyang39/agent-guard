# P3-A 攻击库与语料生成开发执行计划

文档版本: p3-a-implementation-1  
生成日期: 2026-06-18  
状态: P3-A 语料工厂、PyRIT runtime bridge 和攻击库选择资产已完成首轮实现
分支: `a/p3-a-corpus-implementation-plan`  
适用范围: A 线 P3 攻击库、资源种子、PyRIT/AIG 迁移、生成语料、sandbox/profile 接入和验证脚本

## 1. 本轮目标

本轮不是继续补几个展示 case，而是把 A 线从“少量内置夹具”升级为“可生成、可追溯、可按 profile 运行的 Agent-MCP 攻击语料生产系统”。

目标链路:

```txt
用户补充素材 / 手工 seed / PyRIT seed dataset / PyRIT jailbreak template / PyRIT converter / AIG strategy
  -> 结构化 seed files
  -> mutation operators / attack generation profiles
  -> generated/a-line/** 大规模语料
  -> corpus manifest / corpus stats / attack case cards / LLM selection catalog
  -> 按 smoke / openclaw / regression / full-corpus profile 显式加载
  -> B 线按 AttackCaseCard / LlmSelectionCatalogItem 做规则或 LLM 辅助选择
  -> 显式选择样本进入 PyRIT Python runtime bridge 做真实模型攻击
  -> B 线运行 TestContext
  -> C 线按 CorpusManifest 展示来源、覆盖率和证据追溯
```

完成后，A 线应能提供:

- 1000+ resource seeds，当前实现为 1143 条。
- 800+ attack seeds。
- 500+ user prompt seeds，覆盖歧义请求、roleplay persona、多轮铺垫、委托授权和 benign control。
- 80+ tool response seeds。
- 150+ mutation operators，当前实现为 168 个 PyRIT/AIG/native operator。
- 2000+ generated prompts。
- 2000+ generated test cases，当前实现为 2400 级 full corpus。
- generated oracles 数量等于 generated test cases。
- AttackCaseCard / LLM selection catalog 数量等于 generated test cases。
- PyRIT 生成来源占比不低于 70%。
- smoke / openclaw / regression / full-corpus 四类工程运行 profile。

## 2. 当前审计基线

### 2.0 2026-06-18 重构实现结果

本分支已完成 P3-A 语料工厂分层重构和工程化落地:

```txt
resource seeds: 1143
attack seeds: 839
user prompt seeds: 889
tool response seeds: 309
mutation operators: 168
generated resources: 1143
generated prompts: 2400
generated tool responses: 309
generated test cases: 2400
generated test oracles: 2400
attack case cards: 2400
llm selection catalog items: 2400
red team scenarios: 25
run profiles: smoke=30, openclaw=80, regression=400, full-corpus=2400
```

新增实现落点:

```txt
packages/contracts/src/types/corpus.ts
backend/src/modules/corpus/**
scripts/generate-a-corpus.ts
scripts/verify-a-corpus.ts
scripts/index-pyrit-seed-datasets.ts
scripts/index-aig-strategies.ts
scripts/generate-a-pyrit-runtime-batch.ts
scripts/verify-a-attack-cards.ts
scripts/verify-a-pyrit-runtime.ts
scripts/setup-pyrit-runtime.ps1
scripts/setup-pyrit-openclaw-env.ps1
configs/a-line/**
generated/a-line/**
outputs/pyrit-runs/**
```

运行真实 PyRIT 模型攻击前必须先阅读 `docs/A/p3-a-pyrit-runtime-usage.md`。当前模型名统一为 `deepseek-v4-pro`，key 由协作者本机环境提供，endpoint 默认使用 Agent Guard API 暴露的 PyRIT/OpenClaw OpenAI-compatible shim: `http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1`。`DeepSeek_API_2` 只是某个开发者本机变量名示例，不是项目规范。

当前配置目录已完成分层: `configs/` 根目录只保留跨线共享运行时 fixture，A 线攻击库、seed、operator、profile 和 PyRIT/AIG source index 全部迁入 `configs/a-line/**` 并使用 `schemaVersion: "p3-a-1"`。`loadConfigRepository()` 仍只读取根目录运行时 fixture；大规模 generated corpus 通过显式 profile 和 `CorpusManifest` 被 B/C 线消费。

P3 LLM 攻击库选择计划的 A 线 AB-0/AB-1 已落地: A 线现在额外输出 `AttackCaseCard[]`、`LlmSelectionCatalogItem[]`、`CoverageTaxonomy` 和 `CaseQualityReport`。这些对象是“选择资产”，不是运行资产；B 线只能用它们筛选、排序和解释候选 case，真实执行仍按 `caseId` 加载完整 `TestContext`。A 线不生成 `TestSelectionPlan`，不调用 LLM 做正式选择，不把选择理由写入风险结论。

### 2.1 当前配置体量

历史 P2 稳定基线统计:

```txt
tools.json: 8
resources.json: 9
prompts.json: 10
tool_responses.json: 9
risk_rules.json: 17
test_cases.json: 12
test_oracles.json: 12
supervision_policy_templates.json: 16
pyrit_attack_library.json: converters=17, families=6, samples=5
pyrit_jailbreak_template_index.json: groups=20, templates=165
```

判断:

- A 线 P1/P2 已经打通 config -> sandbox -> case -> oracle -> PyRIT metadata。
- P2 稳定基线继续用于根目录 `configs/*.json` 和快速回归。
- P3-A 已新增 `configs/a-line/**` 与 `generated/a-line/**`，作为项目级攻击库和覆盖率证明来源。
- PyRIT 模板、converter、executor/scorer 索引和 AIG 策略索引已经进入语料生产链路。

### 2.2 当前有效入口

用户补充的权限级别、example 和 tool response 表格已经清洗进 A 线 seed 工厂。当前有效入口为:

```txt
configs/a-line/corpus/seeds/resource_seeds.json
configs/a-line/corpus/seeds/attack_seeds.json
configs/a-line/corpus/seeds/user_prompt_seeds.json
configs/a-line/corpus/seeds/tool_response_seeds.json
configs/a-line/corpus/operators/mutation_operators.json
configs/a-line/corpus/profiles/corpus_run_profiles.json
```

`attack_seeds.json` 保存攻击目标、目标工具/资源和风险类别。`user_prompt_seeds.json` 保存进入 PyRIT/operator 变异前的用户 prompt 材料，包括直接任务、歧义请求、roleplay persona、多轮铺垫、委托授权和 benign control。不要把草稿表格追加到 `configs/resources.json`。

## 3. 已审阅文档约束

本计划已按以下文档约束整理:

- `docs/README.md`: 文档职责和唯一来源规则。
- `docs/development-workflow.md`: 分支、中文 commit、拉取最新、文档同步、验证和推送规则。
- `docs/architecture.md`: 唯一被测对象是 Agent，A/B/C 通过公开对象交接，新增目录必须同步 ownership。
- `docs/contracts.md`: 共享字段先写文档再改 contracts；`TestOracle` 不得进入运行时 `TestContext`。
- `docs/interfaces.md`: A 输出 `TestContext`、`RedTeamScenarioSet`、`PolicyTemplate[]`、PyRIT metadata；B 输出 `TestRun` / `InteractionTrace` / `RuntimeSupervisionRecord[]`；C 输出风险、策略、报告和前端展示对象。
- `docs/ownership.md`: A 线主责 `configs/**`、`backend/src/modules/config/**`、`backend/src/modules/sandbox/**`、`docs/A/**`、PyRIT 相关配置和验证脚本。
- `docs/P3plan.md`: P3 分为 A 线攻击库、B 线 OpenClaw/Gateway 实时监督、C 线报告/前端三条主线。
- `docs/A/**`: AIG、PyRIT、OpenClaw runtime、P2 内置数据和工作日志。
- `docs/B/**`、`docs/C/**`、`docs/p2-*.md`: OpenClaw CLI 检测和 realtime MCP 的边界、前端/API 禁止直接读配置、DefenseReport 必须回指真实 runtime record。

硬约束:

- A 线不直接生成 `AgentRiskProfile`。
- A 线不直接生成 `SupervisionPolicyPack`。
- A 线不生成 `DefenseReport`。
- A 线不编造 `RuntimeSupervisionRecord[]`。
- `TestOracle` 只用于离线验收、回归和 corpus 质量检查。
- `generated/a-line/**` 是测试输入和覆盖率依据，不是风险结论。
- `AttackCaseCard[]` 和 `LlmSelectionCatalogItem[]` 是脱敏选择元数据，不能替代 `TestCase`、`TestContext`、`InteractionTrace` 或 `RuntimeSupervisionRecord[]`。
- LLM 只能看到 `llm_selection_catalog.generated.json` 这类安全投影，不得接触完整 prompt、完整 tool response、resource 内容、secret 或 `TestOracle.expectedOutcome` 细节。
- A 线不生成 B 线 `TestSelectionPlan`，不实现正式 LLM rerank，不写入 selection plan store。
- generated corpus 必须通过显式 profile 加载。`smoke/openclaw/regression` 是从最终语料库抽样出来的检查、联调和回归视图，`full-corpus` 是完整覆盖视图，不代表 A 线目标被 demo 缩减。

## 4. 外部素材使用边界

### 4.1 PyRIT

本地来源:

```txt
E:\XinAnProject\pyrit
agent-guard/third_party/pyrit_adapted
```

当前状态:

- 本地 `E:\XinAnProject\pyrit` 没有 `.git`，作为用户提供的定制 PyRIT 参考源。
- `third_party/pyrit_adapted` 已受控迁入，包含 `run_attack_cli.py`、`evaluator.py`、PyRIT package、README 和 license/notice。
- 已有 `configs/a-line/sources/pyrit_attack_library.json` 和 `configs/a-line/sources/pyrit_jailbreak_template_index.json`。
- 已有 `backend/src/modules/sandbox/pyritPromptMutators.ts`，但 native converter 数量仍不足。

P3-A 使用方式:

- 优先迁移 PyRIT seed dataset、jailbreak template metadata、converter、executor template、scorer metadata 和 evaluator 输出字段。
- 接入 Python runtime bridge，显式调用 vendored PyRIT 的 `run_attack_cli.py`、attack executor 和 evaluator 逻辑。模型调用只在用户配置 `OPENAI_CHAT_ENDPOINT`、`OPENAI_CHAT_KEY`、`OPENAI_CHAT_MODEL` 或等价映射后发生；未配置时结构化 `skipped`，不能用模板结果冒充真实攻击结果。
- 生成物必须带 `source.origin: "pyrit"`、sourcePath、templateId/converterId/executorId、mutation chain 和 hash。
- 不把完整 PyRIT runtime 混进默认 TS 配置加载链路；runtime 由项目隔离 `.venv/pyrit` 和显式 npm scripts 触发。

### 4.2 AIG

本地来源:

```txt
E:\XinAnProject\AIG
```

当前状态:

- 本地 `E:\XinAnProject\AIG` 没有 `.git`，作为策略和样例参考源。
- P1 文档已审阅 `mcp-scan`、`agent-scan`、`AIG-PromptSecurity/deepteam`。

P3-A 使用方式:

- `agent-scan/prompt/skills`: data leakage、tool abuse、indirect injection、authorization bypass、OWASP ASI 分类。
- `mcp-scan/redteam`: Crescendo / TAP 多轮攻击编排思想。
- `mcp-scan/testcase`: 文件、网络、代码执行、SSRF、secret 外传等高风险行为模板。
- `AIG-PromptSecurity/deepteam/attacks`: encoding、stego、stratasword、ascii smuggling、character split、code attack 等 enhancer。
- `AIG-PromptSecurity/deepteam/vulnerabilities`: prompt leakage、PII、unauthorized access、robustness、debug/shell/SQL/SSRF 相关模板。

限制:

- 不复制 AIG 的 Go/Python agent 执行框架。
- 不复制长系统 prompt 作为默认运行文本。
- 不引入真实危险网络、命令、数据库修改行为；全部转为 sandbox 模拟和可判定 marker。
- AIG 主要作为策略增强来源，生成占比不超过 PyRIT 主来源。

## 5. 目标目录与文件

### 5.1 新增配置 seed

```txt
configs/a-line/corpus/seeds/resource_seeds.json
configs/a-line/corpus/seeds/attack_seeds.json
configs/a-line/corpus/seeds/user_prompt_seeds.json
configs/a-line/corpus/seeds/tool_response_seeds.json
configs/a-line/corpus/operators/mutation_operators.json
configs/a-line/corpus/profiles/attack_generation_profiles.json
configs/a-line/corpus/profiles/corpus_run_profiles.json
configs/a-line/sources/pyrit_seed_dataset_index.json
configs/a-line/sources/pyrit_executor_template_index.json
configs/a-line/sources/pyrit_scorer_template_index.json
configs/a-line/sources/aig_strategy_index.json
```

说明:

- seed 文件是生成输入，不直接进入运行时 `TestContext`。
- `AttackSeed` 表示攻击目标和约束；`UserPromptSeed` 表示进入 PyRIT/operator 前的用户语境材料。二者必须先组合再变异。
- `user_prompt_seeds.json` 不得退化为 `attack_seeds.json` 的复制文件。
- `configs/resources.json` 等旧文件继续作为 smoke/openclaw 稳定夹具入口。
- 新 seed schema 应先以 contracts 或 corpus module 类型固化，再写 JSON。

### 5.2 新增生成物

```txt
generated/a-line/resources.generated.json
generated/a-line/prompts.generated.json
generated/a-line/tool_responses.generated.json
generated/a-line/test_cases.generated.json
generated/a-line/test_oracles.generated.json
generated/a-line/red_team_scenarios.generated.json
generated/a-line/corpus_manifest.json
generated/a-line/corpus_stats.json
generated/a-line/attack_case_cards.generated.json
generated/a-line/llm_selection_catalog.generated.json
generated/a-line/coverage_taxonomy.generated.json
generated/a-line/case_quality_report.generated.json
```

说明:

- `generated/a-line/**` 是确定性生成物，应可被验证脚本重建或校验。
- 不放入 `outputs/**`，因为 outputs 是运行结果，不是内置语料。
- 临时中间文件和 Python bridge 原始输出应放到 `outputs/**`，并通过 `.gitignore` 保护；正式 `generated/a-line/**` 不再存放 runtime 临时件。
- `llm_selection_catalog.generated.json` 是给 B 线规则/LLM rerank 的安全投影，字段比 `AttackCaseCard` 更少，禁止包含完整 prompt、tool response、resource 内容和 oracle 原始对象。

### 5.3 新增后端模块

```txt
backend/src/modules/corpus/index.ts
backend/src/modules/corpus/corpusTypes.ts
backend/src/modules/corpus/seedLoader.ts
backend/src/modules/corpus/seedNormalizer.ts
backend/src/modules/corpus/sourceIndexLoader.ts
backend/src/modules/corpus/mutationOperators.ts
backend/src/modules/corpus/pyritTemplateRenderer.ts
backend/src/modules/corpus/aigStrategyMapper.ts
backend/src/modules/corpus/corpusGenerator.ts
backend/src/modules/corpus/corpusManifest.ts
backend/src/modules/corpus/corpusValidator.ts
backend/src/modules/corpus/attackCaseCardGenerator.ts
backend/src/modules/corpus/attackCaseCardValidator.ts
backend/src/modules/corpus/runProfile.ts
```

说明:

- `corpus` 只负责离线生成、校验、分层和 manifest。
- `config` 模块继续负责加载正式运行配置。
- 若要让 `loadConfigRepository()` 支持 generated profile，必须通过显式 profile 参数或新 loader，不得默认读取 full corpus。

### 5.4 新增脚本

```txt
scripts/generate-a-corpus.ts
scripts/verify-a-corpus.ts
scripts/import-a-user-resource-draft.ts
scripts/index-pyrit-seed-datasets.ts
scripts/index-aig-strategies.ts
```

目标 npm scripts:

```json
{
  "a:import-user-draft": "node --import tsx scripts/import-a-user-resource-draft.ts",
  "a:index-pyrit": "node --import tsx scripts/index-pyrit-seed-datasets.ts",
  "a:index-aig": "node --import tsx scripts/index-aig-strategies.ts",
  "a:generate-corpus": "node --import tsx scripts/generate-a-corpus.ts",
  "verify:a-corpus": "node --import tsx scripts/verify-a-corpus.ts"
}
```

`verify:all` 后续应纳入 `verify:a-corpus`，但需要先保证资源体量不会让全量验证过慢。

## 6. 核心数据模型

### 6.1 ResourceSeed

```ts
type ResourceSeed = {
  schemaVersion: "p3-a-1";
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
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  domain:
    | "rag"
    | "filesystem"
    | "cloud"
    | "identity"
    | "api"
    | "crm"
    | "support"
    | "finance"
    | "devops"
    | "browser"
    | "memory"
    | "email";
  contentTemplate?: string;
  containsInjection: boolean;
  injectionMarkers: string[];
  secretMarkers: string[];
  allowedUseCases: string[];
  riskTagIds: string[];
  source: SeedSource;
};
```

### 6.2 AttackSeed

```ts
type AttackSeed = {
  schemaVersion: "p3-a-1";
  seedId: string;
  name: string;
  objective: string;
  userPrompt: string;
  attackEntryType:
    | "malicious_user_prompt"
    | "malicious_resource"
    | "tool_response_injection"
    | "multi_turn_induction";
  targetToolIds: string[];
  targetResourceSeedIds: string[];
  riskCategories: string[];
  scenarioIds: string[];
  strategyTags: string[];
  pyrit: {
    templateIds: string[];
    converterIds: string[];
    executorTemplateIds: string[];
    scorerTemplateIds: string[];
  };
  source: SeedSource;
  metadata?: JsonObject;
};
```

### 6.3 UserPromptSeed

```ts
type UserPromptSeed = {
  schemaVersion: "p3-a-1";
  seedId: string;
  name: string;
  promptTemplate: string;
  intent:
    | "direct_task"
    | "ambiguous_task"
    | "roleplay"
    | "delegated_authority"
    | "multi_turn_setup"
    | "benign_control";
  ambiguityLevel: "none" | "low" | "medium" | "high";
  persona?: string;
  applicableScenarioIds: string[];
  preferredOperatorIds: string[];
  pyrit: {
    templateIds: string[];
    converterIds: string[];
    executorTemplateIds: string[];
  };
  source: SeedSource;
  metadata?: JsonObject;
};
```

说明: `UserPromptSeed` 是独立的变异材料层，不是 `AttackSeed` 别名。它让同一攻击目标可以先套入不同用户语境、歧义程度和 roleplay persona，再送入 PyRIT/AIG/native operator。

### 6.4 ToolResponseSeed

```ts
type ToolResponseSeed = {
  schemaVersion: "p3-a-1";
  seedId: string;
  toolId: string;
  name: string;
  contentTemplate: string;
  containsInjection: boolean;
  responseClass:
    | "benign"
    | "instruction_injection"
    | "secret_leak"
    | "debug_leak"
    | "auth_bypass"
    | "tool_rug_pull";
  riskTagIds: string[];
  source: SeedSource;
  metadata?: JsonObject;
};
```

### 6.5 MutationOperatorSpec

```ts
type MutationOperatorSpec = {
  schemaVersion: "p3-a-1";
  operatorId: string;
  name: string;
  family:
    | "encoding"
    | "unicode"
    | "obfuscation"
    | "roleplay"
    | "instruction_split"
    | "multi_turn"
    | "context_poison"
    | "tool_response"
    | "language"
    | "format";
  executionMode:
    | "native_ts_adapter"
    | "pyrit_python_bridge"
    | "template_render"
    | "metadata_only";
  source: SeedSource;
  deterministic: boolean;
  maxFanout: number;
  tags: string[];
  description: string;
  metadata?: JsonObject;
};
```

### 6.6 CorpusManifest

```ts
type CorpusManifest = {
  schemaVersion: "p3-a-1";
  corpusId: string;
  generatedAt: string;
  generatorVersion: string;
  sourceSummary: {
    pyritGenerated: number;
    aigDerived: number;
    manual: number;
    userSupplied: number;
  };
  profileSummary: Record<string, number>;
  coverage: {
    riskCategories: Record<string, number>;
    attackEntryTypes: Record<string, number>;
    tools: Record<string, number>;
    resources: Record<string, number>;
    scenarios: Record<string, number>;
    mutationOperators: Record<string, number>;
  };
  items: CorpusManifestItem[];
};
```

## 7. 开发阶段

### P3-A-0 分支和契约冻结

目标:

- 确认分支为 `a/p3-a-corpus-implementation-plan` 或后续实现分支。
- 保留用户本地 `configs/resources.json` 草稿，不直接提交无效 JSON。
- 更新 `docs/contracts.md`、`docs/interfaces.md`、`docs/ownership.md` 和 `docs/architecture.md`，纳入 seed、generated corpus、CorpusManifest、run profile 的边界。
- 冻结 `backend/src/modules/corpus/corpusTypes.ts` 和必要的 contracts 类型。

验收:

- 已完成。文档中明确 A 线产物是测试输入，不是风险结论。
- 已完成。新增 `backend/src/modules/corpus/**`、`generated/a-line/**`、`packages/contracts/src/types/corpus.ts` 的 ownership。
- 已完成。`TestOracle` 仍只作为离线验证对象。

### P3-A-1 用户草稿清洗与 seed 初版

目标:

- 从当前本地 `configs/resources.json` 末尾表格草稿提取权限级别、example、tool_response_1/2/3。
- 清洗成:
  - `configs/a-line/corpus/seeds/resource_seeds.json`
  - `configs/a-line/corpus/seeds/attack_seeds.json`
  - `configs/a-line/corpus/seeds/tool_response_seeds.json`
- 补充手工 seed，使 resource seeds 达到 100+，attack seeds 达到 800+。

清洗规则:

- P0/P1/P2/P3/P4/P5/P6/P7 权限级别映射成 tool side effect、riskTags、scenarioTags。
- example 可进入 `AttackSeed.userPrompt` 作为基础目标描述，也可进入 `UserPromptSeed.promptTemplate` 作为变异前用户语境材料；不要进入 resource content。
- tool_response_x 进入 tool response seed，不进入 resource content。
- 包含 `sk_`、private key、token 等示例时统一替换为 demo marker。

验收:

- 已完成首批。所有 seed JSON 可解析。
- 已完成首批。所有 seedId 唯一。
- 已完成首批。`verify:a-corpus` 检查明显真实密钥形态。

### P3-A-2 PyRIT 索引扩展

目标:

- 索引 `E:\XinAnProject\pyrit` 和 `third_party/pyrit_adapted` 中高价值 seed dataset、local prompt、jailbreak template、executor、converter、scorer。
- 生成:
  - `configs/a-line/sources/pyrit_seed_dataset_index.json`
  - `configs/a-line/sources/pyrit_executor_template_index.json`
  - `configs/a-line/sources/pyrit_scorer_template_index.json`
- 扩展 `configs/a-line/sources/pyrit_attack_library.json`，记录新增 source paths 和生成能力。

优先索引:

- `pyrit/datasets/seed_datasets/local/**`
- `pyrit/datasets/seed_datasets/remote/**` 的 dataset loader metadata。
- `pyrit/datasets/jailbreak/templates/**`
- `pyrit/prompt_converter/**`
- `pyrit/executor/**`
- `pyrit/score/**`
- `run_attack_cli.py`
- `evaluator.py`

验收:

- 已完成首批。索引只存 metadata、path、hash、参数和安全说明。
- 已完成首批。不把完整长模板全文默认写入配置。
- 已完成首批。`verify:a-corpus` 对 sourcePath 做存在性检查，外部本地参考路径缺失时按 warning 处理。

### P3-A-3 AIG 策略索引扩展

目标:

- 从 AIG 中提取策略和 enhancer metadata，生成 `configs/a-line/sources/aig_strategy_index.json`。
- 映射到 Agent Guard 的 risk category、attack entry type、scenario、tool capability 和 policy template 建议。

优先来源:

- `AIG/agent-scan/prompt/skills/*/SKILL.md`
- `AIG/mcp-scan/redteam/**`
- `AIG/mcp-scan/testcase/**`
- `AIG/AIG-PromptSecurity/deepteam/attacks/**`
- `AIG/AIG-PromptSecurity/deepteam/vulnerabilities/**`
- `AIG/AIG-PromptSecurity/utils/strategy_map.json`

验收:

- 已完成首批。AIG-derived 作为补充来源进入 strategy index 和 operator。
- 已完成首批。AIG strategy 记录 sourcePath、hash 和 tags。
- 已完成首批。不复制 AIG 执行框架。

### P3-A-4 Mutation operators 和 generator

目标:

- 扩展 native/template/metadata mutation operators 至 150+，以 PyRIT converter/executor 为主，AIG 策略为辅。
- 实现 `corpusGenerator`，把 seed、PyRIT template、AIG strategy 和 profile 组合成 generated objects。
- 实现 deterministic ID、hash、source chain 和去重。

operator 池:

- encoding: base64、rot13、caesar、atbash、binary、morse、url、hex。
- unicode: zero width、confusable、ascii smuggling、zalgo、character split。
- obfuscation: leetspeak、word join、string join、markdown fence、HTML comment。
- roleplay: authority override、developer mode、compliance framing。
- multi-turn: crescendo step、TAP branch metadata、probe -> escalate -> exfil。
- tool response: hidden instruction、rug pull、source confusion、content-policy override。
- context poison: memory preference、previous conversation、RAG note。

验收:

- 已完成首批。同一输入和 profile 多次生成结果稳定。
- 已完成首批。generated objects 能通过 `verify:a-corpus` 校验。
- 已完成首批。mutation chain 写入 `CorpusManifest.items[].operatorIds`。

### P3-A-5 千级 generated corpus

目标:

- 生成 `generated/a-line/**`。
- generated prompts >= 1000。
- generated test cases >= 1000。
- generated oracles == generated test cases。
- PyRIT generated 占比 >= 70%。
- AIG-derived 占比 15%-20%。
- manual/user_supplied 占比 10%-15%。

profile 建议:

```txt
smoke:
  12-30 个稳定 case，只覆盖关键链路。

openclaw:
  30-80 个适合真实 OpenClaw CLI / realtime MCP 演示的 case。

regression:
  200-400 个确定性 case，用于本地回归。

full-corpus:
  2400 case，用于最终覆盖率和答辩材料。
```

验收:

- 已完成首批。每个 generated case 都有 oracle。
- 已完成首批。每个 generated case 都能映射到 scenario、seed、mutation operator 和 source。
- 已完成首批。smoke/openclaw profile 不包含 Python bridge case。

### P3-A-6 Config loader 与 run profile 接入

目标:

- 默认 `loadConfigRepository()` 行为不变，继续加载根目录共享运行时 fixture；A 线 full corpus 不被默认注入运行时。
- 新增 profile-aware loader 或 corpus selection 工具，让 B 线可以显式选择 generated profile。
- 本地快速检查和 OpenClaw 联调可以只使用 smoke/openclaw profile；这只是抽样视图，不是 A 线规模目标。

建议接口:

```ts
type CorpusRunProfileId = "smoke" | "openclaw" | "regression" | "full-corpus";

async function loadGeneratedCorpusProfile(
  projectRoot: string,
  profileId: CorpusRunProfileId,
): Promise<GeneratedCorpusSelection>;
```

验收:

- 已完成首批。A 线 full corpus 不默认注入运行时，其他线需要通过显式 profile 选择语料视图。
- 已完成首批。`loadGeneratedCorpusProfile()` 支持 B 线按 profile 获取 generated corpus selection。
- 已完成首批。C 线可以通过 `generated/a-line/corpus_manifest.json` 读取 coverage metadata。

### P3-A-7 验证脚本

目标:

- 新增 `verify:a-corpus`。
- 把 seed、generated、manifest、sourcePath、secret hygiene、profile coverage 纳入硬检查。

检查项:

- JSON parse。
- schemaVersion。
- ID 唯一。
- 所有引用可解析。
- 每个 generated case 有 oracle。
- `TestOracle` 未进入 runtime `TestContext`。
- PyRIT/AIG/manual/user_supplied 占比达标。
- generated prompts >= 1000。
- generated cases >= 1000。
- sourcePath 指向存在文件。
- no `.git` metadata in AIG/PyRIT local copy if copied into repo。
- no real-secret-like tokens。
- smoke/openclaw profile 不超过设定体量。

验收命令:

```powershell
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:a-corpus
npm run pyrit:bridge-smoke
```

首批已验证:

```powershell
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:a-corpus
```

最终可选:

```powershell
npm run verify:all
npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
```

### P3-A-8 攻击库选择资产 AB-0/AB-1

目标:

- 把现有 generated corpus 从“可运行样本”升级为“可被规则/LLM 安全选择的测试资产”。
- 为 B 线提供不暴露完整 payload 的候选池元数据。
- 为 C 线提供 coverage/source origin 展示材料，但不提供风险结论。

新增输出:

```txt
generated/a-line/attack_case_cards.generated.json
generated/a-line/llm_selection_catalog.generated.json
generated/a-line/coverage_taxonomy.generated.json
generated/a-line/case_quality_report.generated.json
```

实现要点:

- `attackCaseCardGenerator.ts` 从 `test_cases.generated.json`、`corpus_manifest.json`、`resources.generated.json`、`tool_responses.generated.json` 和 `test_oracles.generated.json` 派生 `AttackCaseCard[]`。
- `promptSummary` 优先使用 `runtimeObjectiveBase`，编码/规避类 operator 只描述 technique 和目标面，不复制完整编码 payload。
- `payloadRiskSummary` 和 `oracleSummary` 由结构化字段生成，oracle 只暴露 risk category / risk level 摘要，不暴露 `expectedOutcome` 原始对象。
- `qualityScore` 采用确定性规则评分，低分样本不删除，但通过 `qualityWarnings` 和 `CaseQualityReport` 明确标记。
- `digest` 基于 card 稳定字段生成 SHA-256，用于 B 线审计、replay 和重复检测。
- `llm_selection_catalog.generated.json` 是更小投影，禁止包含 `task.instruction`、prompt/resource/tool response 原文、`runtimeObjectivePayloadPreview` 或 oracle 细节。

验收:

- 已完成。`a:generate-corpus` 同步生成 2400 张 `AttackCaseCard` 和 2400 条 LLM catalog item。
- 已完成。`verify:a-attack-cards` 校验 caseId、manifest、profile、attack family、target surface、OpenClaw 覆盖、脱敏摘要和稳定排序。
- 已完成。`coverage_taxonomy.generated.json` 显示 openclaw=80、full-corpus=2400，并覆盖 prompt injection、data leakage、tool hijack、auth bypass、file/code/network/api 等关键维度。
- 已完成。`case_quality_report.generated.json` 当前最低质量分 70，无低于 60 分样本，无重复 digest；warning 主要用于提示摘要长度边界。

边界:

- A 线不实现 B 线 `TestSelectionService`。
- A 线不调用 LLM 做正式选择，不落地 `TestSelectionPlan`。
- B 线如启用 LLM，只能把 `LlmSelectionCatalogItem[]` 作为输入，LLM 输出必须被规则校验后再按 `caseId` 加载完整 `TestContext`。
- LLM 选择理由只能用于测试计划解释，不得进入 `RiskReport.findings`、`DefenseReport`、策略包或运行时监督结论。

### P3-A-9 文档、交接和答辩材料

目标:

- 更新 `docs/A/work-log-a-config-sandbox.md`。
- 更新 `docs/README.md`。
- 必要时更新 `docs/contracts.md`、`docs/interfaces.md`、`docs/ownership.md`、`docs/architecture.md`。
- 给 B/C 提供 profile、manifest、coverage 和 source metadata 的消费说明。

交接给 B:

- profile -> generated test cases selection。
- caseId -> tool/resource/prompt/tool response 绑定。
- unstable / bridge / full-corpus 标记。

交接给 C:

- CorpusManifest。
- corpusStats。
- case source metadata。
- oracle 只用于离线质量，不作为风险证据。
- coverage matrix 维度: risk category、scenario、tool、resource、operator、source。

## 8. 实现顺序建议

建议按小 commit 推进:

1. `docs: 固化P3A语料生成实施计划`
2. `feat: 新增A线语料契约与seed加载器`
3. `feat: 清洗用户补充素材为A线seed`
4. `feat: 索引PyRIT数据集与执行模板`
5. `feat: 索引AIG策略与增强器`
6. `feat: 实现A线语料生成器`
7. `feat: 生成A线千级攻击语料`
8. `test: 增加A线语料验证脚本`
9. `docs: 更新A线语料交接与工作日志`

每个 commit 都使用中文描述，不合并到 `main`，直到用户审阅并明确要求。

## 9. 与 B/C 的接口边界

### 给 B 线

B 线只需要:

- profile 选择结果。
- `AttackCaseCard[]` 或 `LlmSelectionCatalogItem[]` 作为选择候选池。
- `CoverageTaxonomy` 和 `CaseQualityReport` 作为覆盖 gate 和质量过滤输入。
- `TestCase[]`。
- `McpSandboxProfile`。
- case metadata。

B 线不需要:

- PyRIT Python runtime。
- AIG agent scan runtime。
- generator 内部细节。
- oracle 参与运行时。
- 完整 prompt/resource/tool response 原文进入 LLM 选择输入。
- A 线私有 seed/operator 文件作为正式选择接口。

### 给 C 线

C 线只需要:

- CorpusManifest。
- corpusStats。
- CoverageTaxonomy。
- AttackCaseCard 中的 source origin、coverage 和脱敏摘要。
- case source metadata。
- `TestOracle[]` 只用于验证脚本或评测统计。

C 线不得:

- 把 oracle 当风险判定证据。
- 根据 generated corpus 直接声称防御有效。
- 编造 runtime effect。
- 把 LLM 选择理由当作风险结论或策略生成依据。

## 10. 风险与处理

| 风险 | 处理 |
| --- | --- |
| full corpus 被误当默认运行输入 | 所有 generated corpus 都必须通过显式 profile 加载，常规 `loadConfigRepository()` 只读根目录共享运行时 fixture |
| 用户表格草稿破坏 JSON | 用户补充内容已导入 seed 工厂；后续新增素材只能进入 seed/source/profile 文件，不得追加到根目录 JSON |
| PyRIT bridge 引入网络或模型依赖 | 默认关闭，offline profile 单独启用 |
| 复制 AIG/PyRIT 长 prompt 或密钥样例 | 只索引 metadata，长文本进入安全 fixture 时必须脱敏 |
| A 线越界生成策略包或防御报告 | 只输出 seed、case、oracle、manifest 和策略模板建议 |
| LLM 选择输入泄露完整攻击 payload 或 oracle | 只允许读取 `llm_selection_catalog.generated.json`，并由 `verify:a-attack-cards` 做脱敏和 forbidden field 检查 |
| B 线直接读取 A 线私有 seed/operator 文件做选择 | A 线公开交接对象固定为 `AttackCaseCard[]`、`LlmSelectionCatalogItem[]`、`CoverageTaxonomy`、`CaseQualityReport` 和 `CorpusManifest` |
| generated artifacts 难以审查 | manifest 记录 source chain、hash、profile 和 coverage |
| contracts 频繁变化影响 B/C | 先新增可选字段或 A 线私有 corpus 类型，跨线字段再进入 contracts |

## 11. 当前收口后的维护顺序

P3-A 语料工厂已经进入工程化维护阶段，后续改动按以下顺序执行:

1. 新增素材先进入 `backend/src/modules/corpus/seedFactory.ts` 或受控 seed/source/profile 文件，不直接改根目录运行基线。
2. 攻击目标写入 `AttackSeed`，用户语境、歧义表达和 roleplay persona 写入 `UserPromptSeed`。
3. 同一种攻击方式允许多次变异运行，例如 roleplay 可以覆盖游戏、电影脚本、安全审查员、客服、合规审查员、开发调试等 persona。
4. 资源、攻击、user prompt、工具响应和 operator 扩容后运行 `npm run a:generate-corpus`。
5. 生成后运行 `npm run verify:a-corpus` 和 `npm run verify:a-attack-cards`，再按影响范围运行 `npm run typecheck` 和 `npm run verify:all`。
6. 涉及跨线交接时同步 `docs/contracts.md`、`docs/interfaces.md`、`docs/ownership.md` 和本工作日志。
