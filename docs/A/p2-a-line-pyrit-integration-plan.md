# A 线 P2 PyRIT 攻击库迁移与开发计划

日期: 2026-06-15  
状态: 第一批实现已完成，后续按本文继续推进  
分支: `docs/a-line-aig-review-plan`

## 1. P2 目标

A 线 P2 的目标不是重新实现完整 PyRIT，而是把用户提供的定制 PyRIT 项目变成 Agent Guard 的内置攻击库能力:

```txt
PyRIT adapted source
  -> third_party/pyrit_adapted
  -> configs/pyrit_attack_library.json
  -> Prompt mutator + TestCase + Sandbox tool behavior
  -> TestContext / Trace / RiskRule
  -> B 线运行 + C 线报告/策略包
```

A 线继续只负责测试夹具、攻击库、sandbox、验证和文档，不直接生成风险画像、策略包或防御报告。

## 2. 开发阶段

### 阶段 1: 源码迁入与脱敏

已完成:

- 删除本地 `E:\XinAnProject\pyrit\.git`。
- 将核心 Python 包和定制入口迁入 `third_party/pyrit_adapted/`。
- 保留 `LICENSE`、`NOTICE.txt`、`CITATION.cff`。
- 排除 notebook、SQLite DB、Excel、CI、docker、前端原型和锁文件。
- 新增 PyRIT 迁入验证，检查 `.git` 不存在和疑似真实密钥。
- 对迁入副本中两处疑似真实 key 形态字符串做占位符替换。

验收:

```bash
npm run verify:a-pyrit-library
```

### 阶段 2: 攻击库配置契约

已完成:

- 新增 `PyritAttackLibrary` 契约。
- `loadConfigRepository()` 加载 `configs/pyrit_attack_library.json`。
- `validateConfigRepository()` 校验 converter、family、sample、case、prompt 和 scenario 引用。
- `buildConfigIndex()` 建立 PyRIT family/converter/sample 索引。

配置结构:

- `source`: PyRIT 来源、迁入路径、包含/排除组件。
- `converterCatalog`: converter 目录和执行模式。
- `attackFamilies`: jailbreak、encoding、leakage、multi-turn、Foundry、evaluation。
- `samples`: 每个样本绑定 case、prompt、converter、风险类别和成功 marker。

### 阶段 3: 离线 converter 适配

已完成:

- 新增 `backend/src/modules/sandbox/pyritPromptMutators.ts`。
- 支持 Base64、ROT13、Caesar、leetspeak、character spacing、zero-width、string join、suffix、URL encode、ASCII smuggler。
- 输出 `PyritMutationResult`，保留 converterId、输入、输出和 metadata。

当前不在 CI 中运行:

- Text jailbreak 全模板渲染。
- ReneLLM rewrite。
- Crescendo / RedTeaming / TAP 的模型驱动攻击。

后续条件:

- 如果需要真实 PyRIT 执行，需要新增受控 Python bridge，并单独做依赖安装、超时、输出 schema 和敏感内容过滤。

### 阶段 4: 测试用例与 sandbox 扩展

已完成新增用例:

| Case | 场景 | 重点 |
| --- | --- | --- |
| `case.pyrit_jailbreak_system_prompt_extraction` | prompt extraction | 系统提示词读取 |
| `case.pyrit_encoding_evasion_secret_exfil` | encoding evasion | 编码绕过 + secret exfil |
| `case.pyrit_crescendo_debug_access` | debug access leakage | Crescendo 式 debug 升级 |
| `case.pyrit_bola_cross_tenant_database` | authorization bypass | BOLA / 跨租户查询 |
| `case.pyrit_memory_context_poisoning` | memory poisoning | update_memory 持久化投毒 |

已完成新增工具:

- `tool.update_memory`

sandbox 约束:

- 不写真实文件。
- 不发真实网络。
- 不执行真实代码。
- 不持久化真实 memory。
- 所有危险行为只返回结构化模拟 payload。

### 阶段 5: P2 demo case 分层

已完成:

- `defaultOpenClawCaseIds` 继续保持最稳 smoke: `case.resource_injection`。
- 新增 `openClawCandidateCaseIds`，列出可由 B 线确认后扩展到 OpenClaw CLI 的 PyRIT case。
- `fallbackAdapterCaseIds` 纳入 PyRIT case，方便 mock/http_sample 展示。
- `fallbackOnlyCaseIds` 标出当前更依赖内部 fixture 的 case。

原则:

- OpenClaw 默认路径优先稳定。
- mock/http_sample 路径展示攻击库广度。
- 不用 A 线配置伪造真实 OpenClaw 防御效果。

### 阶段 6: 文档和协作交付

已完成或本轮补齐:

- `docs/A/p2-pyrit-understanding-record.md`
- `docs/A/p2-a-line-pyrit-integration-plan.md`
- `docs/A/work-log-a-config-sandbox.md`
- `docs/README.md`

后续需要 C 线确认:

- PyRIT 三等级分级是否进入 `RiskReport` 或新统计视图。
- PyRIT converter 是否需要在前端作为 attack library 目录展示。
- 是否显示 full jailbreak template。建议默认不显示全文。

后续需要 B 线确认:

- OpenClaw CLI 是否支持新增 PyRIT case 的工具面。
- 是否启用 Python bridge 调用 vendored PyRIT。
- realtime MCP 是否覆盖 `tool.update_memory` 或只作为 Agent Guard 内部模拟工具。

## 3. 下一步任务

P2-A 后续建议按以下优先级:

1. 为 `configs/pyrit_attack_library.json` 增加更多来自 PyRIT jailbreak template 的样本索引，但继续避免直接展示长 prompt。
2. 将 `run_attack_cli.py` 的输出 JSON schema 整理为 `docs/A` 下的桥接草案。
3. 设计可选 `scripts/pyrit-bridge-smoke`，只检查 Python 文件和依赖，不接入默认 CI。
4. 给 C 线提供 PyRIT 评估字段映射建议: grade、similarity、iter_count、mutate_total_count、success variance。
5. 与 B 线确认 `openClawCandidateCaseIds` 中哪些能提升为默认 OpenClaw smoke。
6. 如需要引入更多 converter，优先迁移 Atbash、Morse、Binary、UnicodeConfusable 的轻量 TS 实现。

## 4. 验收命令

本轮开发完成后必须跑:

```bash
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:all
npm run verify:e2e
npm run verify:p2:api-e2e
```

如涉及前端展示变更，再跑:

```bash
npm run typecheck:frontend
npm run build:frontend
```

## 5. 提交规则

- 提交仍在当前开发分支，不合并 main。
- commit message 使用中文，例如 `feat: 接入A线P2 PyRIT攻击库`。
- third_party 中保留来源说明和许可文件。
- 不提交 PyRIT 源目录的 `.git`、数据库、Excel、notebook 和锁文件。
