# A 线配置目录说明

本目录只存放 A 线攻击库和语料工厂配置。`configs/` 根目录保留稳定运行基线配置，例如 `tools.json`、`resources.json`、`test_cases.json`、`risk_rules.json` 和 `supervision_policy_templates.json`。

## 目录分层

```txt
configs/
  *.json                         # 稳定运行基线，由 loadConfigRepository() 默认加载
  a-line/
    sources/                     # PyRIT/AIG 来源索引和攻击库元数据
    corpus/
      seeds/                     # 人工、用户补充、PyRIT/AIG 派生 seed
      operators/                 # mutation operator 目录
      profiles/                  # 生成 profile 和运行 profile

generated/a-line/
  *.generated.json               # 由 npm run a:generate-corpus 生成的运行输入
  corpus_manifest.json           # 来源、profile、coverage 和 ID 追溯
  corpus_stats.json              # 统计摘要
```

## 文件角色

- `sources/pyrit_attack_library.json`: PyRIT 攻击家族、converter catalog、sample 到 case 的映射。
- `sources/pyrit_jailbreak_template_index.json`: PyRIT jailbreak 模板 metadata-only 索引，不包含模板全文。
- `sources/pyrit_seed_dataset_index.json`: PyRIT seed dataset 和 scorer eval 文件索引。
- `sources/pyrit_executor_template_index.json`: PyRIT executor、attack strategy 和 promptgen 模板索引。
- `sources/pyrit_scorer_template_index.json`: PyRIT scorer、metric 和 evaluator 相关素材索引。
- `sources/aig_strategy_index.json`: AIG strategy、skill、testcase、PromptSecurity enhancer 索引。
- `corpus/seeds/*.json`: A 线种子库，是生成输入，不直接进入默认 `TestContext`。
- `corpus/operators/mutation_operators.json`: native/template/metadata operator 目录。
- `corpus/profiles/*.json`: 生成比例和 `smoke/openclaw/regression/full-corpus` 分层。

## 维护规则

1. 不要把 seed、operator、source index、profile 文件放回 `configs/` 根目录。
2. 默认 demo 和常规 `loadConfigRepository()` 只消费根目录稳定基线，full corpus 必须显式按 profile 加载。
3. `generated/a-line/test_oracles.generated.json` 只用于离线验证和质量检查，不进入运行时风险判定。
4. PyRIT 是 A 线攻击库主底座；AIG 只作为 Agent/MCP 策略和 enhancer 补充来源。
5. 运行 `npm run a:generate-corpus` 后必须运行 `npm run verify:a-corpus`，再按影响范围运行全量验证。
