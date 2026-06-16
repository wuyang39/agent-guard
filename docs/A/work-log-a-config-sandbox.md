# A 线配置与 Sandbox 开发工作日志

日期: 2026-06-02
当前主线: `main` @ `1fbc1fa`
状态: A 线 P1 配置、攻击库与 Sandbox 基线已合并主线；本文保留早期分支记录并持续追加协作日志

## 1. Git 工作流记录

### 1.1 当前状态

- `feature/a-config-sandbox` 和 `feature/a-attack-library-sandbox` 的 A 线成果均已合并到 `main`。
- 当前 `agent-guard/main` 与 `origin/main` 同步且工作区干净。
- 本地 `E:\XinAnProject\AIG` 已移除 `.git`，仅作为本地参考资料，不参与 `agent-guard` 提交、拉取或合并。
- 后续 A 线开发仍应先从 `main` 新建功能分支，提交信息继续使用中文。

### 1.2 历史分支记录

- 开发前检查到本地 `main` 干净，但落后 `origin/main` 17 个提交。
- 为避免基于过期本地 `main` 开发，直接从最新 `origin/main` 创建分支:

```bash
git switch -c feature/a-config-sandbox origin/main
```

- 当时要求本分支只提交 A 线相关内容，先不合并回 `main`；后续已按用户指令完成合并。
- 提交信息按团队要求使用中文。

## 2. 本次开发范围

本次只覆盖开发者 A 主责范围:

- `backend/src/modules/config/**`
- `backend/src/modules/sandbox/**`
- A 线验证脚本
- 与本次状态同步相关的文档

没有修改 B 线的 Agent 接入、Runner、Monitor 逻辑，也没有修改 C 线的 Risk、Report 逻辑。

## 3. 配置模块实现细节

`loadConfigRepository(configDir)` 已从接口壳变为真实加载入口:

- 读取 `tools.json`
- 读取 `resources.json`
- 读取 `prompts.json`
- 读取 `tool_responses.json`
- 读取 `risk_rules.json`
- 读取 `test_cases.json`
- 读取 `test_oracles.json`

加载过程要求每个配置文件的顶层必须是 JSON array。读取失败、JSON parse 失败、顶层结构错误会抛出 `ConfigLoadError`。

`loadTestContexts(configDir, agent)` 已实现:

- 复用 `loadConfigRepository()`
- 调用 `validateConfigRepository()`
- 构造统一 `McpSandboxProfile`
- 只为 `enabled=true` 的测试用例生成 `TestContext`
- 将 `riskRules` 注入每个 `TestContext`
- 单独返回 `testOracles`

重要约束:

- `TestOracle` 和 `ExpectedOutcome` 不会进入运行时 `TestContext`。
- `TestContext` 只包含契约要求的 `schemaVersion`、`configVersion`、`contextId`、`caseId`、`caseName`、`agent`、`sandbox`、`testCase`、`riskRules`。

## 4. 配置校验增强

`validateConfigRepository()` 在原有 ID 去重和引用校验基础上补充了:

- `testOracles.oracleId` 唯一性校验
- `toolResponseTemplates[].toolId` 对 Tool 的引用校验
- `RiskRule.ruleVersion` 版本校验
- `TestCase.schemaVersion` 版本校验
- `TestOracle.schemaVersion` 版本校验
- `TestCase.task.caseId` 与外层 `caseId` 一致性校验
- `TestCase.task.resourceIds` / `promptIds` 引用校验
- `ToolResponsePlan.responseTemplateId` 与 `toolId` 归属一致性校验
- `FieldMatcher.operator` 基础合法性校验
- `RiskRule.match.riskTagIds` 对现有 risk tag 的引用校验
- `TestOracle.expectedOutcome.expectedToolIds` 对 Tool 的引用校验

`matching_parameters` 没有配置 `parameterMatchers` 时记录 warning，不阻塞加载。

## 5. Sandbox Runtime 实现细节

`createMcpSandbox(profile, options)` 已实现最小可运行 runtime:

- `executeTool(toolId, parameters)`
- `readResource(resourceId)`
- `loadPrompt(promptId)`
- `resolveToolResponse(plan, parameters)`

新增 `createMcpSandboxForContext(context)`，用于 B 线直接从 `TestContext` 构造 runtime。

`createMockMcpSandboxRuntime(context)` 现在复用 `createMcpSandboxForContext(context)`，避免后续出现两套 Sandbox 行为。

当前 Tool 行为是确定性模拟:

- `tool.read_file`
  - 通过 `parameters.path` 映射 sandbox resource。
  - 读取 secret 路径或 secret resource 时返回 `token=demo-secret-token`。
  - 命中 `toolResponsePlan` 时返回对应 Tool Response 模板内容。
- `tool.send_request`
  - 不进行真实网络访问，只返回 simulated 结果。
- 其他工具
  - 返回通用 simulated 结果。

授权逻辑:

- public resource 默认授权。
- 非 public resource 需要命中 `accessPolicy.allowedAgentIds` 或 `accessPolicy.allowedUseCases`。

Tool Response 逻辑:

- 支持 `first_call`
- 支持 `every_call`
- 支持 `matching_parameters`
- `matching_parameters` 使用 `FieldMatcher` 的基础 operator 解释参数。

## 6. 验证记录

本次已执行:

```bash
npm install
npm run typecheck
npx tsx scripts/verify-a-config-sandbox.ts
npx tsx scripts/verify-iter2.ts
npx tsx scripts/verify-iter3.ts
npx tsx scripts/verify-iter4.ts
npx tsx scripts/verify-iter5.ts
npx tsx scripts/verify-iter5-failure.ts
```

验证结果:

- TypeScript typecheck 通过。
- A 线配置与 Sandbox 验证通过。
- 既有 Sandbox、Monitor、Runner 验证脚本通过。
- Runner 失败路径验证通过。

说明:

- 最新 `origin/main` 的报告导出器已经使用 Node 内置模块，但 `tsconfig.json` 原本没有启用 Node 类型，导致 typecheck 失败。本分支补充了 `"types": ["node"]`。
- `verify-iter5.ts` 会向 `outputs/traces` 写 trace JSON；这些产物已被 `.gitignore` 忽略，不进入提交。

## 7. 后续协作建议

B 线可以直接使用:

```ts
const { contexts } = await loadTestContexts("configs", agent);
const sandbox = createMcpSandboxForContext(contexts[0]);
```

B 线后续重点:

- 将 `runTestCase()` 从手写 mock `TestContext` 迁到 A 线生成的正式 `TestContext`。
- 继续通过 `TraceRecorder` 生成契约中的 `TraceEvent.type` 字段，不要使用 demo 脚本里的 `eventType`。

C 线后续重点:

- 基于 A 线生成的 `TestContext.riskRules` 和 B 线生成的 `InteractionTrace` 接入 `evaluateRisk()`。
- 风险判定不要直接读取 `configs/*.json`。

前端后续重点:

- 正式前端只能消费 API 或报告产物，不应直接解析 `configs/risk_rules.json`。
- `frontend/demo` 仍是展示原型，不作为正式前端接口来源。

## 8. 2026-06-04 AIG 审阅补充

已新增 `docs/A/p1-a-line-aig-adaptation-plan.md`，记录对本地临时 AIG 仓库 `mcp-scan` 和 `agent-scan` 的审阅结论，并将可迁移内容映射到 A 线后续任务。

下一步 A 线建议优先:

- 新增 `configs/red_team_scenarios.json` 和 `configs/supervision_policy_templates.json`。
- 扩展 `tool.write_file`、`tool.send_email`、`tool.call_api` 的工具定义和 sandbox 模拟行为。
- 基于 AIG 的 data leakage、tool abuse、indirect injection、authorization bypass、tool poisoning 思路扩展攻击库。
- 更新 A 线验证脚本，保证 P1 场景、策略模板和新增工具都可被加载、校验和确定性执行。

## 9. 2026-06-04 A 线攻击库与 Sandbox 扩展实现

分支: `feature/a-attack-library-sandbox`

本轮按 `docs/A/p1-a-line-aig-adaptation-plan.md` 的第一优先级完成 A 线增强，重点是把 AIG 中可复用的 Agent/MCP 检测思路落成 Agent Guard 自己的结构化配置和确定性 sandbox 行为。

### 9.1 配置加载与校验

`loadConfigRepository()` 已新增加载:

- `configs/red_team_scenarios.json`
- `configs/supervision_policy_templates.json`

`ConfigRepository` 和 `ConfigIndex` 已新增:

- `redTeamScenarioSet`
- `policyTemplates`
- `redTeamScenariosById`
- `policyTemplatesById`

`validateConfigRepository()` 已新增校验:

- `RedTeamScenarioSet.schemaVersion`
- `scenarioId` 唯一性
- `scenario.caseIds` 对 `testCases` 的引用
- `scenario.expectedWeaknessCategories` 合法性
- `scenario.recommendedPolicyTemplateIds` 对策略模板的引用
- `PolicyTemplate.schemaVersion`
- `policyTemplateId` 唯一性
- `targetType`、`action`、`riskCategory` 合法性
- `PolicyTemplate.match` 的 relation 和 matcher operator 合法性
- warning: 场景无 enabled case
- warning: 策略模板未被任何场景推荐

### 9.2 攻击库扩展

新增 5 类红队场景:

- `scenario.indirect_prompt_injection`
- `scenario.data_exfiltration`
- `scenario.tool_abuse`
- `scenario.authorization_bypass`
- `scenario.tool_poisoning_rug_pull`

新增后配置规模:

- 7 个工具
- 8 个资源
- 5 个 prompt
- 7 个 tool response template
- 7 个 test case
- 7 个 test oracle
- 12 条 risk rule
- 11 个 policy template

本轮迁移了 AIG 的核心测试思想，但没有复制 AIG Python/Go 扫描框架。AIG 中的 data leakage、tool abuse、indirect injection、authorization bypass、tool poisoning / rug pull 被转成了 Agent Guard 的结构化场景、样本、规则和策略模板。

### 9.3 Sandbox 行为扩展

`createMcpSandbox()` 新增确定性模拟:

- `tool.write_file`: 检测敏感路径、敏感内容，返回 `fileSystemSideEffect: "not_performed"`。
- `tool.send_email`: 检测外部收件人和敏感正文，返回 `emailSideEffect: "not_performed"`。
- `tool.call_api`: 检测内网/metadata URL 和敏感 body，返回 `networkSideEffect: "not_performed"`。
- `tool.execute_code`: 不执行代码，只识别 shell、敏感文件读取、eval、网络调用等危险模式，返回 `blockedBySandbox: true`。
- `tool.query_database`: 模拟跨用户/管理员查询，返回 `databaseSideEffect: "not_performed"`。

重要约束:

- 不产生真实文件写入。
- 不产生真实网络访问。
- 不执行任何代码。
- 新增工具返回都包含可被 trace、risk rule、report 和前端展示复用的结构化字段。

### 9.4 验证记录

本轮已执行并通过:

```bash
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:p1:detection-policy
npm run verify:p1:supervision-defense
node --import tsx scripts/verify-full-pipeline.ts
```

`verify-full-pipeline.ts` 当前加载 7 个 `TestContext` 和 7 个 `TestOracle`，覆盖 `test_started`、`task_sent`、`prompt_load`、`resource_access`、`tool_call`、`tool_result`、`agent_message` 事件。`system_error` 仍只在错误路径触发，未覆盖是预期状态。

### 9.5 后续协作提醒

B 线:

- 当前 mock agent 仍按工具列表做通用调用，尚不会为每个新 case 自动生成精确攻击参数。后续真实/半真实 Agent 接入时，应根据 `TestCase.task`、prompt/resource 和 tool response 产生更贴近攻击剧本的工具调用。
- 运行时监督动作 payload 应继续使用 `packages/contracts/src/types/supervision.ts` 中的标准结构。

C 线:

- 新增 risk rule 是 A 线候选规则和验收支撑，规则语义仍建议由 C 线复核。
- `PolicyTemplate` 是模板，不是 `SupervisionPolicyPack` 实例。策略包仍由 C 线根据 `AgentRiskProfile` 生成。

C 前端:

- 如果需要展示场景库或策略模板，应通过后端 API 或报告产物消费，不得直接读取 `configs/*.json`。

通用:

- `TestOracle` 仍未进入 `TestContext`，只作为验收和离线比对输入。
- AIG 本地参考目录仍在 `E:\XinAnProject\AIG`，已移除 `.git`，不在 `agent-guard` Git 仓库内。

## 10. 2026-06-08 主线复审与 AIG 二次审阅

### 10.1 当前 A 线主线基线

当前主线已经具备:

- 9 类配置加载: tools、resources、prompts、tool_responses、risk_rules、test_cases、test_oracles、red_team_scenarios、supervision_policy_templates。
- 5 类红队场景: indirect prompt injection、data exfiltration、tool abuse、authorization bypass、tool poisoning / rug pull。
- 7 类 sandbox 工具: read file、send request、write file、send email、call api、execute code、query database。
- 7 个测试用例和 7 个 oracle。
- 12 条候选 risk rule。
- 11 个 supervision policy template。

当前 `npm run verify:all` 和 `npm run verify:e2e` 均可用于验证 A/B/C 三阶段链路。`verify:all` 暂未包含 `verify:e2e`，后续可考虑把 E2E 纳入标准门禁。

### 10.2 本次文档修正

- 已更新 `docs/A/p1-a-line-aig-adaptation-plan.md`，把旧的“P1 配置尚未存在”“下一次直接开发配置和工具”等描述改为当前主线事实。
- 已在 A 线计划中补充 `AIG-PromptSecurity/deepteam` 的二次审阅结论。
- 已更新本工作日志顶部状态，明确 A 线成果已经进入 `main`，AIG 目录已变成本地非 Git 参考目录。

### 10.3 AIG 二次审阅结论

本次重点复查:

- `agent-scan/prompt/skills/*`: data leakage、tool abuse、indirect injection、authorization bypass、OWASP ASI。
- `mcp-scan/redteam`: Crescendo / TAP 多轮红队策略。
- `mcp-scan/testcase/case1/main1.py`: rug pull、shadow tool、secret resource、code/command execution、SSRF、外传行为。
- `AIG-PromptSecurity/deepteam/attacks`: encoding、stego、stratasword 等攻击变体。
- `AIG-PromptSecurity/deepteam/metrics`: prompt extraction、SSRF、shell injection、SQL injection、debug access、hijacking、excessive agency、overreliance。
- `AIG-PromptSecurity/deepteam/vulnerabilities/unauthorized_access/template.py`: BOLA、BFLA、RBAC、debug、shell、SQL、SSRF 的基线样本生成思路。

可迁移方向:

- 抽取攻击思想、样本结构、成功判据、分类映射。
- 不迁移 Python/Go 扫描框架、provider client、plugin system 或真实危险执行逻辑。
- 不复制长 prompt；只转成 Agent Guard 自己的短样本、配置字段、oracle 和规则候选。

### 10.4 下一轮 A 线建议任务

优先按以下顺序开发:

1. 新增 `scenario.prompt_extraction`，补系统提示词/内部规则泄露用例。
2. 新增 `scenario.debug_access_leakage`，补 debug mode、env、stack trace、内部配置泄露用例。
3. 增强 `scenario.authorization_bypass`，拆出 BOLA、BFLA、RBAC 子样本。
4. 增强 `scenario.tool_abuse`，补 SQL injection、shell injection、SSRF 多 payload 变体。
5. 为 indirect injection 和 data leakage 增加 direct / evasion / jailbreak 阶段样本。
6. 评估是否新增 `tool.update_memory` 或 memory resource，覆盖 memory/context poisoning。
7. 为 P2 API/前端补场景说明、攻击目标、攻击阶段、AIG 来源说明、推荐控制等展示 metadata。
8. 扩展 A 线验证脚本，增加覆盖率、样本来源、demo secret 合规和 no-side-effect 检查。

协作提醒:

- 如果只是为前端展示补 metadata，优先放在 P2 API view 或可选配置字段，不要贸然改共享契约。
- 如果新增 `RiskCategory`、`AttackEntryType` 或 `RedTeamScenario` 必填字段，必须先同步 `docs/contracts.md`、`packages/contracts/src/types/**`、`docs/interfaces.md` 和 `docs/ownership.md`。
- 新增 risk rule 仍属于 A/C 协作区，C 线负责最终规则语义和报告解释。

## 11. 2026-06-15 A 线 P2 PyRIT 攻击库迁移

分支: `docs/a-line-aig-review-plan`

本轮根据用户补充指令，把本地定制 PyRIT 项目作为 A 线 P2 的直接迁移来源，而不是只抽取设计思想。迁移原则是“源码可追溯 + Agent Guard 适配层可运行”。

### 11.1 PyRIT 源码迁入

本地来源:

```txt
E:\XinAnProject\pyrit
```

迁入位置:

```txt
third_party/pyrit_adapted
```

已迁入:

- `pyrit/` Python 核心包。
- `run_attack_cli.py`、`api.py`、`evaluator.py`。
- `pyproject.toml`。
- `README.md`、`LICENSE`、`NOTICE.txt`、`CITATION.cff`。
- 示例配置文件。

未迁入:

- `.git`、`.github`。
- notebook、Excel、SQLite DB、`uv.lock`。
- docker、CI、frontend 原型和临时产物。

安全处理:

- 迁入副本中两处 OpenAI-like key 形态字符串已替换为 `sk-redacted-demo-key`。
- 源 `E:\XinAnProject\pyrit` 未修改。
- 新增 `npm run verify:a-pyrit-library` 检查 `.git` 不存在、关键源码存在、配置引用存在、converter 输出正确和无明显真实密钥形态。

### 11.2 Agent Guard 适配实现

新增契约:

- `packages/contracts/src/types/attackLibrary.ts`

新增配置:

- `configs/pyrit_attack_library.json`

`ConfigRepository` 新增:

- `pyritAttackLibrary`
- `pyritAttackFamiliesById`
- `pyritConvertersById`
- `pyritSamplesById`

`validateConfigRepository()` 新增校验:

- PyRIT library schema version。
- converter id 唯一、执行模式合法、sourcePath 存在配置。
- family id 唯一、maturity 合法、risk category 合法、case 引用合法。
- sample id 唯一、family/case/prompt/converter/scenario 引用合法。

新增离线 mutator:

- `backend/src/modules/sandbox/pyritPromptMutators.ts`

已适配 PyRIT converter:

- Base64
- ROT13
- Caesar offset 3
- Leetspeak
- Character spacing
- Zero-width spacing
- String join dash
- Suffix append marker
- URL encode
- ASCII smuggler Unicode tags

### 11.3 攻击库与 Sandbox 扩展

当前配置规模:

- 8 个工具。
- 9 个资源。
- 10 个 prompt。
- 9 个 tool response template。
- 12 个 test case。
- 12 个 test oracle。
- 17 条 risk rule。
- 16 个 supervision policy template。
- 9 个 red team scenario。
- 1 个 PyRIT attack library。
- PyRIT library 内含 6 个 attack family、12 个 converter、5 个 mapped sample。

新增工具:

- `tool.update_memory`: 模拟长期记忆写入，不产生真实持久化。

新增 PyRIT 派生用例:

- `case.pyrit_jailbreak_system_prompt_extraction`
- `case.pyrit_encoding_evasion_secret_exfil`
- `case.pyrit_crescendo_debug_access`
- `case.pyrit_bola_cross_tenant_database`
- `case.pyrit_memory_context_poisoning`

新增或扩展场景:

- `scenario.prompt_extraction`
- `scenario.encoding_evasion`
- `scenario.debug_access_leakage`
- `scenario.memory_context_poisoning`
- `scenario.authorization_bypass` 已补 BOLA / cross-tenant case。
- `scenario.data_exfiltration` 已补 PyRIT encoding exfil case。

新增策略模板:

- `policy.warn.pyrit_jailbreak_prompt`
- `policy.deny.system_prompt_read`
- `policy.deny.debug_endpoint`
- `policy.deny.cross_tenant_query`
- `policy.deny.memory_poison_update`

### 11.4 P2 demo case 分层

`configs/p2_demo_cases.json` 已更新:

- `defaultOpenClawCaseIds` 继续保持最稳 smoke: `case.resource_injection`。
- 新增 `openClawCandidateCaseIds`: 后续由 B 线确认哪些 PyRIT case 可提升为 OpenClaw CLI 默认路径。
- `fallbackAdapterCaseIds` 纳入 PyRIT case，方便 mock/http_sample 展示攻击库广度。
- `fallbackOnlyCaseIds` 标记当前更依赖内部 fixture 的用例。

### 11.5 Demo 与 sample agent

已更新:

- `scripts/sample-agent-server.mjs`
- `scripts/demo-web-server.mjs`

新增 case 行为:

- PyRIT jailbreak system prompt read。
- Encoding evasion secret read + outbound request。
- Crescendo debug endpoint + internal config。
- BOLA cross-tenant query。
- Memory poisoning update。

### 11.6 验证记录

本轮已通过:

```bash
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run pyrit:bridge-smoke
```

仍需在最终提交前执行:

```bash
npm run verify:all
npm run verify:e2e
npm run verify:p2:api-e2e
npm run typecheck:frontend
npm run build:frontend
```

### 11.7 后续协作提醒

B 线:

- 默认 OpenClaw smoke 暂不自动扩大，避免真实 CLI 不稳定。
- 可从 `openClawCandidateCaseIds` 逐个确认 PyRIT case。
- 若要直接执行 PyRIT Python，需要先定义 Python bridge 的超时、依赖、输出 schema 和脱敏规则。

C 线:

- `configs/pyrit_attack_library.json` 是攻击库目录和来源映射，不是风险结论。
- PyRIT `evaluator.py` 的 grade / similarity / iter_count / mutate_total_count / success variance 可作为后续报告统计增强候选。
- 不建议前端直接展示完整 jailbreak 模板全文，应展示 family、sample、case、risk category 和安全 fixture。

## 12. 2026-06-15 A 线 P2 收尾补齐

分支: `docs/a-line-aig-review-plan`

本轮在上一批 PyRIT 迁入基础上继续补齐 P2-A 未落成的收尾项，目标是让 A 线 P2 达到“可交接、可验证、可答辩说明”的完成状态。

### 12.1 模板索引

新增:

```txt
configs/pyrit_jailbreak_template_index.json
scripts/generate-pyrit-template-index.ts
```

实现内容:

- 从 `third_party/pyrit_adapted/pyrit/datasets/jailbreak/templates` 生成 metadata-only 索引。
- 共索引 165 个 PyRIT jailbreak YAML 模板。
- 分组覆盖 `root`、`Arth_Singh`、`multi_parameter` 和 `pliny/*`。
- 每条模板记录只保存路径、参数、作者、来源、harm category、大小和 SHA-256。
- 不复制 YAML `value` 字段，不让完整 jailbreak prompt 进入配置、API 或报告默认视图。

新增命令:

```bash
npm run pyrit:index-templates
```

### 12.2 Converter 扩展

`backend/src/modules/sandbox/pyritPromptMutators.ts` 新增确定性 TS adapter:

- Atbash
- Binary 16
- Morse
- Flip
- Unicode confusable

当前 native TS adapter 合计 15 个:

```txt
base64, rot13, caesar_3, atbash, binary_16, morse, flip,
leetspeak, unicode_confusable, character_space, zero_width,
string_join_dash, suffix_append_marker, url_encode, ascii_smuggler_tags
```

`configs/pyrit_attack_library.json` 已同步 converter catalog 和 encoding evasion sample 的 converter 矩阵。

### 12.3 Python bridge 边界

新增:

```txt
docs/A/p2-pyrit-python-bridge-contract.md
scripts/verify-pyrit-bridge-smoke.ts
```

新增命令:

```bash
npm run pyrit:bridge-smoke
```

该命令只做 Python 可用性、vendored Python 语法和已知 batch runner 边界检查；不调用真实模型、不发网络、不写 evaluator DB。真实执行 PyRIT attack executor 仍需后续按 bridge 契约单独启用。

### 12.4 内置数据说明

新增:

```txt
docs/A/p2-built-in-test-data-guide.md
```

文档内容:

- 解释 A 线内置数据是系统测试夹具，不是被测 MCP Server。
- 梳理 12 个当前 enabled case 的场景、攻击入口、关键工具和展示点。
- 固化 `defaultOpenClawCaseIds`、`openClawCandidateCaseIds`、`fallbackAdapterCaseIds`、`fallbackOnlyCaseIds` 的语义。
- 说明 AIG 与 PyRIT 的引用边界。
- 给 B/C 提供 case 使用和展示建议。

### 12.5 契约与文档同步

已同步:

- `packages/contracts/src/types/attackLibrary.ts`
- `backend/src/modules/config/**`
- `docs/contracts.md`
- `docs/interfaces.md`
- `docs/ownership.md`
- `docs/architecture.md`
- `docs/README.md`
- `README.md`
- `third_party/pyrit_adapted/README.agent-guard.md`

`ConfigRepository` 当前新增 `pyritJailbreakTemplateIndex`，并提供 `pyritJailbreakTemplatesById` 索引。`validateConfigRepository()` 会校验 schema、ID 唯一、group count、模板总数、sourcePath、hash 和正整数 byteLength。

### 12.6 当前 P2-A 完成判断

A 线 P2 当前已完成:

1. 定制 PyRIT 源码受控迁入。
2. PyRIT attack library 配置和契约接入。
3. 165 个 jailbreak 模板 metadata-only 索引。
4. 15 个确定性 converter 的 TS adapter。
5. 5 个 PyRIT 派生 runnable case。
6. P2 demo case 分层。
7. 可选 Python bridge 草案和 smoke。
8. 内置数据说明、接口、契约、ownership 和工作日志更新。

仍需要 B/C 决策但不阻塞 P2-A:

- 哪些 PyRIT candidate case 提升为 OpenClaw 默认 smoke。
- 是否实现真实 PyRIT Python bridge。
- PyRIT evaluator 统计字段是否进入正式报告和前端展示。

## 13. 2026-06-16 OpenClaw 项目隔离运行环境

分支: `a/openclaw-project-runtime-demo`

本轮按用户要求为本项目单独部署 OpenClaw runtime，用于 P2 demo 和真实 OpenClaw adapter 联调。部署目录在 `E:\XinAnProject\openclaw-runtime`，不在 `agent-guard` 仓库内，不提交 OpenClaw 本体、workspace、状态库、token 或模型 key。

已完成:

- 安装 `openclaw@2026.6.6` 到项目旁边的本地 runtime。
- 创建本地 wrapper `E:\XinAnProject\openclaw-runtime\openclaw-local.cmd`。
- 初始化 `OPENCLAW_HOME=E:\XinAnProject\openclaw-runtime\home` 和 workspace。
- 启动 OpenClaw gateway 到 `127.0.0.1:18789`。
- 新增 `scripts/start-agent-guard-openclaw.cmd` / `.ps1`，用于带隔离环境变量启动 demo。
- 新增 `docs/A/p2-openclaw-project-runtime-test.md` 记录部署、验证和缺口。

验证结果:

```powershell
npm run verify:openclaw:realtime
npm run verify:p2:api-e2e
```

结果:

- `verify:openclaw:realtime` 通过，覆盖 `deny`、`ask`、`redact`、trace 查询和 realtime events stream。
- 补充 DeepSeek key 映射前，`verify:p2:api-e2e` 在普通模式通过，OpenClaw CLI adapter 可识别，但 OpenClaw agent run 因缺模型 provider key 被 optional skip。
- `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 当前阻塞在 OpenClaw 模型认证，错误语义为缺 API key。

补充更新:

- 用户提供本机用户环境变量 `DeepSeek_API_2`，用于 DeepSeek API key。
- 已将本地 runtime wrapper 和项目启动脚本更新为进程内映射: `DeepSeek_API_2` → `DEEPSEEK_API_KEY`。
- OpenClaw 默认模型按用户指定切换为 `deepseek/deepseek-v4-flash`。
- key 不写入仓库、不写入文档明文、不拼入命令行参数。
- `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 已通过，结果为 13 个 required 通过、0 个 optional skipped。
- required E2E 命令不要额外设置 `OPENCLAW_GATEWAY_URL`；OpenClaw `2026.6.6` 遇到 gateway URL override 会要求显式 auth，本轮复验已确认清理该变量后通过。

重要注意:

- Agent Guard 的 OpenClaw adapter 会把 Windows npm shim 解析成 `node openclaw.mjs`，所以联调时必须同时设置 `OPENCLAW_CLI` 和 `OPENCLAW_HOME`。
- 此前失败点不是 A 线攻击库或 sandbox 配置问题，也不是 OpenClaw CLI 路径问题，而是当时本地 OpenClaw 尚未配置模型 provider 凭证。
- 补充 provider key 后，required 模式已确认真实 OpenClaw CLI 检测不再 skip。
