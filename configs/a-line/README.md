# A 线配置目录说明

本目录只存放 A 线攻击库和语料工厂配置。A 线配置与生成物使用 `schemaVersion: "p3-a-1"`，不再按 demo/MVP 体量妥协；`configs/` 根目录中的 `tools.json`、`resources.json`、`test_cases.json`、`risk_rules.json` 和 `supervision_policy_templates.json` 仅作为跨线共享运行时 fixture 与兼容入口。

## 目录分层

```txt
configs/
  *.json                         # 跨线共享运行时 fixture，由 loadConfigRepository() 默认加载
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

outputs/pyrit-runs/
  */bridge_request.json           # 显式 PyRIT runtime bridge 请求
  */bridge_result.json            # PyRIT runtime bridge 结构化结果
  */*.json                        # run_attack_cli.py 单项输出
```

## 文件角色

- `sources/pyrit_attack_library.json`: PyRIT 攻击家族、converter catalog、sample 到 case 的映射。
- `sources/pyrit_jailbreak_template_index.json`: PyRIT jailbreak 模板 metadata-only 索引，不包含模板全文。
- `sources/pyrit_seed_dataset_index.json`: PyRIT seed dataset 和 scorer eval 文件索引。
- `sources/pyrit_executor_template_index.json`: PyRIT executor、attack strategy 和 promptgen 模板索引。
- `sources/pyrit_scorer_template_index.json`: PyRIT scorer、metric 和 evaluator 相关素材索引。
- `sources/aig_strategy_index.json`: AIG strategy、skill、testcase、PromptSecurity enhancer 索引。
- `corpus/seeds/resource_seeds.json`: 资源、权限边界、上下文污染和敏感数据的结构化种子。
- `corpus/seeds/attack_seeds.json`: 攻击目标、目标工具/资源、风险类别和基础 objective/user prompt。
- `corpus/seeds/user_prompt_seeds.json`: 进入 PyRIT/operator 变异前的用户 prompt 材料层，覆盖直接请求、歧义请求、委托授权、多轮铺垫、roleplay persona 和 benign control。
- `corpus/seeds/tool_response_seeds.json`: 工具响应注入、secret 泄露、debug 泄露和 benign control 种子。
- `corpus/operators/mutation_operators.json`: PyRIT 为主、AIG/手工/用户补充为辅的 native/template/metadata operator 目录。
- `corpus/profiles/*.json`: 生成比例和 `smoke/openclaw/regression/full-corpus` 工程视图。`smoke/openclaw/regression` 是从最终语料库抽样出来的检查/联调/回归视图，`full-corpus` 是完整覆盖视图，不代表 A 线目标被 demo 缩减。
- `generated/a-line/**`: 大规模可追溯输入层，不代表已经真实调用模型。
- `outputs/pyrit-runs/**`: 真实 PyRIT Python runtime 执行层，只有 `runtimeUsed: "pyrit"` 且 `status: "ok"` 的条目才代表实际调用了 vendored PyRIT。

## PyRIT Runtime Bridge

A 线现在有两条明确链路:

```txt
离线输入层:
  configs/a-line/** -> npm run a:generate-corpus -> generated/a-line/**

真实 PyRIT 执行层:
  generated/a-line/profile selection -> npm run a:pyrit-runtime -> outputs/pyrit-runs/**
```

运行时 bridge 使用项目隔离 Python:

```powershell
npm run pyrit:setup-runtime
npm run verify:a-pyrit-runtime
npm run a:pyrit-runtime
```

真实模型调用需要 `OPENAI_CHAT_ENDPOINT`、`OPENAI_CHAT_KEY`、`OPENAI_CHAT_MODEL`。其中 key 可由 `DeepSeek_API_2` 映射，model 当前默认 `deepseek-v4-pro`；endpoint 仍需是可达的 OpenAI-compatible chat base URL。模型目标未配置完整时，bridge 必须返回 `skipped`，不得用模板或 fallback 冒充真实攻击。

协作参数入口见 `docs/A/p3-a-pyrit-runtime-usage.md`。当前模型名统一为 `deepseek-v4-pro`；可用 `. .\scripts\setup-pyrit-openclaw-env.ps1` 在当前 PowerShell 会话中映射 `DeepSeek_API_2 -> OPENAI_CHAT_KEY`，并设置项目 OpenClaw gateway 候选 endpoint。注意 `http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp` 是 Agent Guard realtime MCP endpoint，不是 PyRIT 模型 endpoint。

当前 bridge 已支持两类真实 PyRIT runtime 行为:

- `converter_batch`: 调用 vendored PyRIT 文本 converter，包括 Base2048、Unicode replacement/substitution、token smuggling、AsciiArt、AskToDecode、Braille、Ecoji、Emoji 等。
- `attack_cli`: 调用 vendored `run_attack_cli.py`；如果 generated case 使用 bridge 支持的 `pyrit.converter.*`，会先对 objective 做 PyRIT converter 预处理，再执行真实 attack executor。

## 维护规则

1. 不要把 seed、operator、source index、profile 文件放回 `configs/` 根目录。
2. 常规 `loadConfigRepository()` 只消费根目录共享运行时 fixture，generated corpus 必须显式按 profile 加载。
3. `generated/a-line/test_oracles.generated.json` 只用于离线验证和质量检查，不进入运行时风险判定。
4. PyRIT 是 A 线攻击库主底座；AIG 只作为 Agent/MCP 策略和 enhancer 补充来源。
5. `user_prompt_seeds.json` 必须是非重复材料库，不得退化为 `attack_seeds.json` 的机械复制。
6. 新增 operator 必须有 `mutationOperators.ts` 的确定性实现或明确的 template/metadata 语义，不能只增加空 JSON 条目。
7. PyRIT executor 类 operator 应标记 `executionMode: "pyrit_python_bridge"`；离线 generated corpus 可以保留预览文本，但真实执行结果必须来自 `outputs/pyrit-runs/**`。
8. 运行 `npm run a:generate-corpus` 后必须运行 `npm run verify:a-corpus`，再按影响范围运行全量验证。
