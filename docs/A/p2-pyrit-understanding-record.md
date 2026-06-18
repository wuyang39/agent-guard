# A 线 P2 PyRIT 定制项目理解记录

日期: 2026-06-15  
状态: 已审阅并完成 P2-A 迁移与收尾
本地来源: `E:\XinAnProject\pyrit`  
迁入位置: `third_party/pyrit_adapted`

## 1. 总体判断

用户提供的 PyRIT 目录不是纯原版 PyRIT，而是在 PyRIT 0.12.1.dev0 基础上叠加了中文 CLI、FastAPI 接口、SQLite 评估统计、Excel 数据集读取和多攻击方法选择。它适合直接作为 A 线 P2 的攻击库与 jailbreak 能力来源。

本轮采用两层迁移:

1. `third_party/pyrit_adapted/`: 迁入 PyRIT 核心 Python 包和定制入口脚本，保留源码可追溯。
2. Agent Guard A 线适配层: 把可稳定进入 CI 的部分落到 `configs/**`、TS 离线 mutator、sandbox 工具和验证脚本。

没有把完整 Python runtime 直接挂到主流程中。原因是 PyRIT 原执行器依赖真实模型 target、PyRIT memory、Azure/OpenAI 配置和较重的 Python 依赖。P2 先让攻击库、样本和确定性变异进入 Agent Guard，后续再决定是否开 Python bridge。

## 2. 已迁入内容

已复制到 `third_party/pyrit_adapted/`:

- `pyrit/`: PyRIT Python 核心包，包含 attack executor、prompt converter、datasets、scenario、score、memory、backend 等。
- `run_attack_cli.py`: 定制中文 CLI，支持单条 objective 和 xlsx 批量攻击。
- `api.py`: 定制 FastAPI 统计接口。
- `evaluator.py`: 定制 SQLite 评估与统计模块。
- `pyproject.toml`: Python 包依赖与入口信息。
- `README.md`、`LICENSE`、`NOTICE.txt`、`CITATION.cff`: 来源、许可和引用材料。
- `.env_example`、`.pyrit_conf_example`: 示例配置，仅含占位符。

未迁入:

- `.git`、`.github`、CI 配置。
- Notebook、Excel 数据集、SQLite 运行数据库、`uv.lock`。
- 源项目 frontend、docker、构建脚本和临时运行产物。

迁入后执行了脱敏检查。`pyrit/datasets/scorer_evals/**/privacy.csv` 中两处疑似真实 key 形态字符串已在迁入副本中替换为 `sk-redacted-demo-key`；源 `E:\XinAnProject\pyrit` 未改动。

## 3. PyRIT 结构理解

### 3.1 定制根脚本

`run_attack_cli.py` 是最贴近本项目的定制部分:

- 攻击方法: `prompt_sending`、`flip`、`red_teaming`、`crescendo`、`context_compliance`、`role_play`、`many_shot_jailbreak`、`renellm`。
- 支持交互选择攻击方法和运行模式。
- 支持从 `version-1.xlsx` 读取中文越狱用例，按 `A.1` 到 `A.5` 分类过滤。
- 支持 JSON 输出。
- 可选同步到 `evaluator.py` 的 SQLite 统计库。
- 会提取 `executed_turns`、`last_score`、`last_response`、ReneLLM rounds、最终变异 prompt、变异次数和相似度。

`evaluator.py` 提供五类统计:

- 单条攻击明细。
- 模型 x 场景统计。
- 模型 x 攻击方法统计。
- 攻击方法全局统计和成功率方差。
- 全局总体安全/部分违规/攻击成功比例。

`api.py` 提供 `/api/stat/*` 查询接口，但 `/api/batch/start-test` 依赖 `attack_runner.py`。当前源目录里 `attacker_runner.py` 是空文件，`attack_runner.py` 不存在，所以 batch 接口不能直接作为完整服务运行。该问题已记录为未来 Python bridge 前置修复项。

### 3.2 攻击执行器

核心目录: `pyrit/executor/attack`

- `single_turn`: prompt sending、flip、context compliance、role play、many-shot jailbreak、ReneLLM、skeleton key。
- `multi_turn`: Crescendo、red teaming、tree of attacks、chunked request、simulated conversation。
- `core`: attack config、converter config、scoring config、attack result、conversation manager。

对 Agent Guard 的迁移意义:

- 单轮攻击可转成固定 `TestCase` 与 prompt。
- 多轮攻击先转成 `multi_turn_induction` 场景和固定阶段样本。
- 真正 LLM-assisted 攻击后续需要 Python bridge，不进当前 TS CI 主路径。

### 3.3 Prompt converter

核心目录: `pyrit/prompt_converter`

本轮优先接入无外部模型依赖、可确定性复现的 converter:

- Base64
- ROT13
- Caesar offset 3
- Leetspeak
- Character spacing
- Zero-width spacing
- String join
- Suffix append
- URL encoding
- ASCII smuggler Unicode tags

保留为 Python reference 的 converter:

- Text jailbreak template 渲染。
- ReneLLM rewrite。
- Tense / persuasion / translation / toxic sentence 等需要模型或复杂依赖的 converter。
- 多媒体、PDF、Word、Audio、Image 等非 P2 A 线主路径 converter。

### 3.4 Jailbreak 数据集

核心目录: `pyrit/datasets/jailbreak`

本地统计:

- Jailbreak 模板 YAML: 165 个。
- `Arth_Singh`: 30 个。
- `pliny`: 42 个。
- `multi_parameter`: 3 个。

`TextJailBreak` 的机制:

- 扫描模板目录。
- 排除 `multi_parameter` 后按文件名缓存。
- 可按文件名加载、随机加载或直接使用 string template。
- 要求模板参数完整，常见单参数为 `prompt`。

Agent Guard 当前不直接把长 jailbreak prompt 暴露到 demo 中，而是:

- 在 `third_party/pyrit_adapted` 保留完整模板。
- 在 `configs/prompts.json` 放安全、短、可判定的模拟 prompt。
- 在 `configs/a-line/sources/pyrit_attack_library.json` 建立 PyRIT 模板与 Agent Guard case 的映射。

### 3.5 Scenario 和策略分类

重点文件:

- `pyrit/scenario/scenarios/foundry/red_team_agent.py`
- `pyrit/scenario/scenarios/airt/jailbreak.py`
- `pyrit/scenario/scenarios/airt/leakage.py`
- `pyrit/scenario/scenarios/garak/encoding.py`

FoundryStrategy 的价值最大。它把攻击拆成:

- easy converter: base64、rot13、caesar、leetspeak、unicode confusable、ascii smuggler 等。
- moderate converter: tense 等模型辅助转换。
- difficult attack: multi_turn、Crescendo、PAIR、TAP。

Agent Guard 已把这套分类映射到:

- `pyrit.family.encoding_evasion`
- `pyrit.family.jailbreak`
- `pyrit.family.multi_turn`
- `pyrit.family.foundry_strategy`
- `pyrit.family.leakage`
- `pyrit.family.evaluation`

### 3.6 Score 和评估模型

PyRIT 原 score 体系包含:

- True/False scorer。
- SelfAsk scorer。
- Refusal scorer。
- Prompt shield。
- Markdown injection。
- Decoding scorer。
- Insecure code scorer。
- Substring 类 scorer。

定制 `evaluator.py` 更适合本项目报告统计:

- 三等级答案分级: 0 安全、1 部分违规、2 完全违规。
- 相似度。
- 迭代次数。
- 变异次数。
- 方法成功率。
- 成功率方差。

本轮尚未把这些统计字段进入 `RiskReport` 契约，因为 C 线对报告语义负责。A 线先在文档和 `configs/a-line/sources/pyrit_attack_library.json` 中记录该评估模型，后续可作为 C 线报告增强输入。

### 3.7 Jailbreak 模板元数据索引

P2-A 收尾阶段新增 `configs/a-line/sources/pyrit_jailbreak_template_index.json`:

- 覆盖 165 个 vendored PyRIT jailbreak YAML 模板。
- 按 `root`、`Arth_Singh`、`multi_parameter` 和 `pliny/*` 分组。
- 每条记录包含 `templateId`、名称、来源路径、作者、参数、harm category、大小和 SHA-256。
- 不包含 YAML `value` 字段，不把完整 jailbreak prompt 复制进配置、API 或报告。

生成入口:

```bash
npm run pyrit:index-templates
```

验证入口:

```bash
npm run verify:a-pyrit-library
```

## 4. 本轮已落地到 Agent Guard 的内容

代码和契约:

- 新增 `packages/contracts/src/types/attackLibrary.ts`。
- `ConfigRepository` 新增 `pyritAttackLibrary`。
- `validateConfigRepository()` 新增 PyRIT attack library 校验。
- 新增 `backend/src/modules/sandbox/pyritPromptMutators.ts`。
- 新增 `tool.update_memory` sandbox 模拟。

配置:

- 新增 `configs/a-line/sources/pyrit_attack_library.json`。
- 新增 `configs/a-line/sources/pyrit_jailbreak_template_index.json`。
- 新增 5 个 PyRIT 派生 test case。
- 新增 5 个 PyRIT 派生 oracle。
- 新增 prompt extraction、encoding evasion、debug access leakage、memory poisoning 等场景。
- 新增 system prompt read、debug endpoint、memory poisoning 等规则和策略模板。
- `p2_demo_cases.json` 增加 OpenClaw candidate 和 fallback case 列表。

验证:

- 新增 `npm run verify:a-pyrit-library`。
- 新增 `npm run pyrit:index-templates`。
- 新增 `npm run pyrit:bridge-smoke`，作为可选 Python bridge 边界烟测。
- `npm run verify:all` 已包含 PyRIT 迁移验证。
- `verify:a-config-sandbox` 已覆盖新增 PyRIT debug 和 memory sandbox 行为。

## 5. 已知风险和后续处理

1. Python bridge 尚未接入默认主链路。当前已补 `docs/A/p2-pyrit-python-bridge-contract.md` 和 `npm run pyrit:bridge-smoke`，真实 PyRIT attack execution 仍需显式启用。
2. `api.py` 的 batch 接口依赖缺失的 `attack_runner.py`，不能直接宣称可用；P2 只把它作为 vendored reference 和后续 bridge 输入。
3. 完整 jailbreak 模板很强，不应在正式 demo 页面直接展示全文。P2 仅暴露 metadata-only index。
4. 新增 risk rule 仍是 A/C 协作区，C 线需要确认报告解释。
5. OpenClaw 默认 smoke 仍保持最稳的 `case.resource_injection`，新 PyRIT case 先作为 candidate 和 fallback demo case。
