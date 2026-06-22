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

- `configs/a-line/sources/pyrit_attack_library.json`

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

- `configs/a-line/sources/pyrit_attack_library.json` 是攻击库目录和来源映射，不是风险结论。
- PyRIT `evaluator.py` 的 grade / similarity / iter_count / mutate_total_count / success variance 可作为后续报告统计增强候选。
- 不建议前端直接展示完整 jailbreak 模板全文，应展示 family、sample、case、risk category 和安全 fixture。

## 12. 2026-06-15 A 线 P2 收尾补齐

分支: `docs/a-line-aig-review-plan`

本轮在上一批 PyRIT 迁入基础上继续补齐 P2-A 未落成的收尾项，目标是让 A 线 P2 达到“可交接、可验证、可答辩说明”的完成状态。

### 12.1 模板索引

新增:

```txt
configs/a-line/sources/pyrit_jailbreak_template_index.json
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

`configs/a-line/sources/pyrit_attack_library.json` 已同步 converter catalog 和 encoding evasion sample 的 converter 矩阵。

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

## 14. 2026-06-17 P3-A 攻击库规模化规划

分支: `a/p2.5-corpus-expansion-plan`

本轮按用户要求重新审阅 A 线配置、接口文档、AIG 目录和本地定制 PyRIT 目录。最初形成的 P2.5 单独规划已合并进统一 P3 总规划，不再保留独立文档入口:

```txt
docs/P3plan.md
```

审计结论:

- 当时 A 线结构已经打通，但仍停留在早期小体量基线: 12 个 case、9 个 resource、10 个 prompt、9 个 tool response。
- PyRIT 已迁入并索引 165 个 jailbreak template，但尚未展开为大规模 runnable corpus。
- AIG 的 `agent-scan/prompt/skills`、`mcp-scan/redteam` 和 `AIG-PromptSecurity/deepteam` 仍有大量可迁移策略、模板和 enhancer。
- 用户补充的权限级别、示例 prompt 和 tool response 表格应作为 seed 草案清洗整理；不要直接追加在 `configs/resources.json` 末尾，否则会破坏配置加载。

P3-A 规划方向:

- 新增 `resource_seeds.json`、`attack_seeds.json`、`mutation_operators.json`、`attack_generation_profiles.json`、`corpus_run_profiles.json`。
- 新增 `generated/a-line/**`，把上千条 prompt/case/oracle/scenario 作为生成物管理。
- 新增 `backend/src/modules/corpus/**` 和 `scripts/generate-a-corpus.ts`。
- 以 PyRIT 为主生成攻击库: seed/objective、jailbreak template、executor template、converter、scorer 和可选 Python bridge 均进入 Agent Guard 生成流水线。
- AIG indirect/data/tool/auth skill、Crescendo/TAP、多种 encoding/stratasword enhancer 作为补充策略源，不替代 PyRIT 主生成链路。
- 构造 Agent-MCP 专项 user prompt/objective，再通过 PyRIT template/converter/attack executor 生成，目标 1000+ 攻击样例且 PyRIT 生成占比不低于 70%。

后续实施必须继续遵守:

- A 线不直接生成 `AgentRiskProfile`、`SupervisionPolicyPack` 或 `DefenseReport`。
- `TestOracle` 不进入运行时 `TestContext`。
- generated corpus 后续必须通过显式 profile 加载，避免把 full corpus 误接到默认运行链路。

## 15. 2026-06-18 P3-A 开发执行计划审阅稿

分支: `a/p3-a-corpus-implementation-plan`

本轮按用户要求切到新的 A 线开发规划分支，并基于最新 `main` 审阅总体文档、A 线历史文档、B/C/OpenClaw/前端接口文档、当前配置加载代码、PyRIT/AIG 本地参考目录和现有验证脚本。

新增文档:

```txt
docs/A/p3-a-corpus-implementation-plan.md
```

审计要点:

- 当前已提交配置仍是 P2 体量: 12 个 case、9 个 resource、10 个 prompt、9 个 tool response。
- 本地 `configs/resources.json` 末尾存在用户补充的权限级别和 tool response 表格草稿，当前不是合法 JSON；后续必须先清洗为 seed 文件，不能直接进入运行配置。
- `loadConfigRepository()` 默认读取 `configs/*.json` 并生成 `TestContext`，因此 P3-A 需要新增 seed/generated/profile 分层，不能默认把 full corpus 塞进运行时。
- `generated/a-line/**` 和 `backend/src/modules/corpus/**` 当前尚不存在，是下一步实现的主要新增落点。
- A 线继续只负责测试输入、sandbox、攻击库、oracle、manifest、coverage 和验证脚本，不直接生成风险画像、策略包或防御报告。

计划中的下一步:

- 恢复/重建合法 `configs/resources.json`，把用户补充表格导入 resource、attack 和 tool response seed。
- 新增 corpus 类型、seed loader、PyRIT/AIG source index、mutation operators、corpus generator 和 manifest validator。
- 生成 1000+ prompt/case/oracle，并通过 smoke/openclaw/regression/full-corpus profile 分层供 B/C 消费。
- 新增 `verify:a-corpus`，检查 JSON、schema、引用、sourcePath、生成规模、来源占比、oracle 对齐和密钥脱敏。

## 16. 2026-06-18 P3-A 首批语料工程实现

分支: `a/p3-a-corpus-implementation-plan`

说明: 本节记录首批 1200 级实现的历史基线。当前有效架构和规模以第 17 节“P3-A 配置分层与攻击库重构增强”为准。

本轮开始按 P3-A 执行计划实施 A 线重构和补充。核心变化是把 A 线从少量 demo fixture 扩展为 seed -> source index -> mutation operator -> generated corpus -> manifest -> profile -> verifier 的完整离线语料生产链。

已完成:

- 恢复 `configs/resources.json` 为合法 JSON，用户粘贴在末尾的 P0-P7 权限表格已转入 `user_supplied` seed 生成链路。
- 新增 `packages/contracts/src/types/corpus.ts`，定义 `ResourceSeed`、`AttackSeed`、`ToolResponseSeed`、`MutationOperatorSpec`、`CorpusRunProfile`、PyRIT/AIG source index 和 `CorpusManifest`。
- 新增 `backend/src/modules/corpus/**`，包含 seed factory、PyRIT/AIG source scanner、deterministic mutation operators、corpus generator、profile loader 和 validator。
- 新增 `scripts/generate-a-corpus.ts`、`scripts/verify-a-corpus.ts`、`scripts/index-pyrit-seed-datasets.ts`、`scripts/index-aig-strategies.ts`。
- 新增 `configs/a-line/corpus/seeds/resource_seeds.json`、`configs/a-line/corpus/seeds/attack_seeds.json`、`configs/a-line/corpus/seeds/tool_response_seeds.json`、`configs/a-line/corpus/operators/mutation_operators.json`、`configs/a-line/corpus/profiles/corpus_run_profiles.json`、`configs/a-line/sources/*_index.json`。
- 新增 `generated/a-line/**`，产出首批 generated corpus。

当前规模:

```txt
resource seeds: 159
attack seeds: 239
canonical user prompts: 239 (embedded in attack seeds)
tool response seeds: 213
mutation operators: 52
generated resources: 159
generated prompts: 1200
generated tool responses: 213
generated test cases: 1200
generated test oracles: 1200
profile summary: smoke=30, openclaw=80, regression=400, full-corpus=1200
```

来源与迁移:

- PyRIT 是主生成来源，占 generated manifest 大多数条目；使用了 seed dataset、executor、converter、jailbreak/scorer/evaluator 相关文件的 metadata index，并实现了 37 个 PyRIT 风格 deterministic operator。
- AIG 是补充策略来源；索引 `agent-scan/prompt/skills`、`mcp-scan/redteam`、`mcp-scan/testcase`、`AIG-PromptSecurity/deepteam`，并实现 indirect document、RAG source confusion、tool rug pull、memory poison、debug override、ascii smuggling、zalgo、stratasword 等增强器。
- 用户补充表格作为 `user_supplied` source，拆分为 permission prompt、resource seed 和 tool response seed。

验证结果:

```powershell
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:a-corpus
```

结果:

- `typecheck` 通过。
- `verify:a-config-sandbox` 通过，旧配置加载与 sandbox 未破坏。
- `verify:a-pyrit-library` 通过，PyRIT adapted library 检查未破坏。
- `verify:a-corpus` 通过，检查 seed 数量、generated 数量、case/oracle 对齐、引用完整性、PyRIT 来源比例、profile 覆盖和明显真实密钥形态。

后续注意:

- 默认 `loadConfigRepository()` 仍只加载稳定 `configs/*.json`；full corpus 必须显式通过 corpus profile 加载。
- `generated/a-line/test_oracles.generated.json` 仍只用于离线验收和 corpus 质量检查，不得进入运行时 `TestContext`。
- B 线可使用 `loadGeneratedCorpusProfile()` 按 `smoke/openclaw/regression/full-corpus` 选择 case；不需要理解 PyRIT/AIG 内部结构。
- C 线只能把 `CorpusManifest` 用于来源、覆盖率和样本分层展示，不得把 oracle 或 generated corpus 当风险结论。

## 17. 2026-06-18 P3-A 配置分层与攻击库重构增强

分支: `a/p3-a-corpus-implementation-plan`

本轮针对 P3-A 首批实现“文件都堆在 `configs/` 根目录、场景广度仍偏 demo 化、generated case 只有 1200 级”的问题继续重构。核心目标是让 A 线攻击库从“能生成”升级到“目录清晰、来源清楚、体量足够、场景覆盖更完整”。

### 17.1 配置目录重构

当前目录分层:

```txt
configs/
  tools/resources/prompts/tool_responses/risk_rules/test_cases/test_oracles
  red_team_scenarios/supervision_policy_templates/p2_demo_cases
  a-line/
    README.md
    sources/
      pyrit_attack_library.json
      pyrit_jailbreak_template_index.json
      pyrit_seed_dataset_index.json
      pyrit_executor_template_index.json
      pyrit_scorer_template_index.json
      aig_strategy_index.json
    corpus/
      seeds/
      operators/
      profiles/
```

说明:

- `configs/` 根目录只保留默认运行基线，继续服务 `loadConfigRepository()` 和 demo。
- `configs/a-line/sources/**` 保存 PyRIT/AIG 来源索引和攻击库元数据。
- `configs/a-line/corpus/seeds/**` 保存 resource、attack、user prompt、tool response 种子。
- `configs/a-line/corpus/operators/**` 保存 mutation operator 目录。
- `configs/a-line/corpus/profiles/**` 保存生成 profile 和 run profile。
- `generated/a-line/**` 继续保存可复现生成物，不写入 `outputs/**`。

`loadConfigRepository()` 已改为从 `configs/a-line/sources/` 读取 PyRIT attack library 和 jailbreak template index。`loadGeneratedCorpusProfile()`、`generate-a-corpus`、`verify-a-corpus`、PyRIT/AIG 索引脚本都已同步新路径。

### 17.2 攻击库和种子增强

本轮扩展:

- resource blueprint 从基础 12 类扩展到 secret、identity、cloud、devops、finance、CRM、support、internal API、browser、email、calendar、repo、memory、RAG、filesystem 等 36 类组合来源。
- resource variant 增加 PII bundle、credential hint、SSRF target、tool override note、memory poison、shadow tool claim、payment side effect、safe negative control。
- 红队场景从 10 类扩到 25 类，补齐 system prompt contract extraction、secret chain exfiltration、SSRF metadata probe、shell command injection、SQL query bypass、browser hidden instruction、email delegation confusion、payment escalation、repo dependency shadowing、vector store source conflict、long context instruction decay、refusal suppression、tool schema confusion、policy exception forgery、safe control regression。
- prompt frame 从 20 类扩到 32 类，增加 PyRIT objective、controlled jailbreak、retrieval priority conflict、two-turn plan、connector embedded instruction、encoded/split instruction、OpenClaw candidate、runtime-supervision evidence fixture 等框架。
- mutation operator 从 52 扩到 76，新增 base64 decode hint、unicode escape、NATO、A1Z26、braille、superscript、repeat token、markdown link/image、HTML hidden input、LaTeX table、PAIR、Tree-of-Attacks reflection、simulated target compliance、OWASP ASI mapping、tool schema confusion、browser hidden instruction、email delegation、SSRF probe、false-positive control、permission escalation 等。

PyRIT 仍是主来源和主生成底座；AIG 只作为 Agent/MCP 策略、OWASP ASI 分类、tool/schema/browser/email/SSRF 等 enhancer 补充来源。

### 17.3 生成与验证增强

生成器调整:

- 默认 generator version 升级为 `p3-a-generator-2`。
- default/full corpus 生成上限从 1200 提升到 2400。
- 生成算法从“每个 seed 连续生成 6 条”改成“按 seed 轮转采样”，避免前部场景占满 full-corpus 上限。
- `verify:a-corpus` 现在要求 generated prompts/test cases 至少 2000，场景覆盖至少 20，并检查 legacy A-line seed/source 文件不得回流到 `configs/` 根目录。
- PyRIT 主导比例改为按 prompt/test_case/oracle 等攻击生成项计算，不再把 synthetic resource 和基础 tool response 混入分母。

当前规模:

```txt
resource seeds: 687
attack seeds: 839
user prompt seeds: 639
tool response seeds: 309
mutation operators: 85
generated resources: 687
generated prompts: 2400
generated tool responses: 309
generated test cases: 2400
generated test oracles: 2400
red team scenarios: 25
profile summary: smoke=30, openclaw=80, regression=400, full-corpus=2400
source summary: manual=437, user_supplied=279, pyrit=5154, aig=1639, synthetic=687
```

已执行:

```powershell
npm run a:generate-corpus
npm run verify:a-corpus
```

后续收尾前仍需执行:

```powershell
npm run typecheck
npm run verify:a-config-sandbox
npm run verify:a-pyrit-library
npm run verify:all
git diff --check
```

## 18. 2026-06-19 P3-A 最终工程化口径

分支: `a/p3-a-corpus-implementation-plan`

本轮根据用户要求明确 A 线后续不再以 demo/MVP 体量为约束，而按 P3 最终项目级交付模式继续设计和开发。当前原则:

- A 线优先保证攻击库、语料工厂、source index、seed/operator/profile、manifest 和验证链路的完整性。
- `configs/` 根目录只保留稳定运行基线；A 线攻击库和生成输入统一放在 `configs/a-line/**`。
- `generated/a-line/**` 是大规模离线语料和覆盖率材料，不应因为 demo 展示简化而回退规模或结构。
- PyRIT 是主底座，可以继续深度利用其 seed dataset、jailbreak template、converter、executor、scorer/evaluator 和定制攻击实现。
- AIG 保持补充定位，迁移其 Agent/MCP 策略、OWASP ASI 分类和 PromptSecurity enhancer 思想，不作为主运行框架。
- demo/OpenClaw 连通性可以验证，但若失败且原因来自其他线、运行时环境或本机 OpenClaw 状态，不应反向削弱 A 线最终架构。
- 后续每批 P3-A 改动继续记录在本工作日志，并同步 `docs/P3plan.md`、`docs/architecture.md`、`docs/contracts.md`、`docs/interfaces.md`、`docs/ownership.md` 中受影响的边界。

全局记忆已追加 `2026-06-19-agent-guard-p3a-final-mode.md`，记录该最终模式口径。

### 18.1 Demo / OpenClaw 连通性检查

本轮按“验证但不为 demo 妥协”的原则检查了 demo/OpenClaw 相关链路:

```powershell
npm run verify:openclaw:realtime
npm run verify:p2:api-e2e
$env:OPENCLAW_CLI=(Resolve-Path '..\openclaw-runtime\openclaw-local.cmd').Path; `
  $env:OPENCLAW_HOME=(Resolve-Path '..\openclaw-runtime\home').Path; `
  $env:OPENCLAW_WORKSPACE=(Resolve-Path '..\openclaw-runtime\workspace').Path; `
  $env:VERIFY_OPENCLAW_REQUIRED='1'; `
  npm run verify:p2:api-e2e
```

结果:

- `verify:openclaw:realtime` 通过，覆盖 initialize、tools/list、deny、ask、redact、supervision query、trace query 和 realtime events stream。
- 普通 `verify:p2:api-e2e` 通过 mock/http_sample/API/report/supervision 链路，OpenClaw CLI adapter 因未注入 `OPENCLAW_CLI` 被 optional skip。
- 注入项目隔离 OpenClaw 环境变量后，`VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 通过，13 个 required 全部通过、0 optional skipped。

判断:

- 当前 A 线 P3 语料工厂重构没有破坏 P2 API demo 基线。
- 本机 OpenClaw runtime 可用，但普通命令默认不会自动设置 `OPENCLAW_CLI`、`OPENCLAW_HOME`、`OPENCLAW_WORKSPACE`。后续 demo 启动仍建议使用 `scripts/start-agent-guard-openclaw.ps1` 或显式设置这三个变量。
- A 线后续不应为了单机展示或快速回归简化 full corpus；运行链路必须显式选择 `smoke/openclaw/regression/full-corpus` profile。

## 19. 2026-06-19 P3-A 去 MVP 化与 seed 入口收口

分支: `a/p3-a-corpus-implementation-plan`

本轮按当时理解重新审阅 A 线项目、框架和文档，把仍带有 demo/MVP 妥协口径或重复入口的部分继续收口。后续第 20 节已修正: `UserPromptSeed` 不是重复入口，而是 PyRIT 变异前的独立 prompt material 层。第 19 节保留为历史记录。

- 删除独立 prompt seed 文件。该文件只是 `attack_seeds.json` 的重复投影，会导致攻击目标和用户 prompt 在两套 seed 中漂移。
- 当时误认为 `AttackSeed.userPrompt` 应作为唯一 prompt seed。第 20 节已修正为独立 `UserPromptSeed` 材料层。
- 契约字段从展示稳定标记改为 `stableForAutomation`。`smoke/openclaw/regression` 是自动化稳定档位，`full-corpus` 是完整覆盖档位；profile 是工程运行控制，不是 demo 分层。
- `verify:a-corpus` 改为直接要求 `attackSeeds >= 800`，不再把 attack seed 与独立 prompt seed 相加凑数。
- `README.md`、`configs/a-line/README.md`、`docs/P3plan.md`、`docs/A/p3-a-corpus-implementation-plan.md`、`docs/architecture.md`、`docs/contracts.md`、`docs/interfaces.md` 和 `docs/ownership.md` 已同步当前结构。

当时记录的 A 线结构:

```txt
configs/a-line/
  sources/
    pyrit_attack_library.json
    pyrit_jailbreak_template_index.json
    pyrit_seed_dataset_index.json
    pyrit_executor_template_index.json
    pyrit_scorer_template_index.json
    aig_strategy_index.json
  corpus/
    seeds/
      resource_seeds.json
      attack_seeds.json
      tool_response_seeds.json
    operators/
      mutation_operators.json
    profiles/
      attack_generation_profiles.json
      corpus_run_profiles.json

generated/a-line/
  resources.generated.json
  prompts.generated.json
  tool_responses.generated.json
  test_cases.generated.json
  test_oracles.generated.json
  red_team_scenarios.generated.json
  corpus_manifest.json
  corpus_stats.json
```

第 19 节后续维护要求已被第 20 节替代。

## 20. 2026-06-22 P3-A UserPromptSeed 变异材料层修正

分支: `a/p3-a-corpus-implementation-plan`

本轮根据用户指出的问题修正 A 线语料入口设计: 删除独立 prompt seed 的前提不成立。A 线需要在送入 PyRIT/operator 变异前，把用户 prompt 语境也作为材料输入，这样攻击样例才更有针对性。

当前有效设计:

- `AttackSeed`: 攻击目标、目标工具/资源、风险类别、场景归属和基础 objective。
- `UserPromptSeed`: 用户 prompt 变异材料层，包含 `promptTemplate`、`intent`、`ambiguityLevel`、`persona`、`applicableScenarioIds` 和 `preferredOperatorIds`。
- 生成器流程: `AttackSeed + UserPromptSeed -> composed prompt material -> PyRIT/AIG/native operator -> PromptDefinition/TestCase/TestOracle/CorpusManifest`。
- `UserPromptSeed` 不能是 `AttackSeed` 的机械复制；它必须提供直接请求、歧义请求、委托授权、多轮铺垫、roleplay persona 和 benign control。

本轮实现要点:

- 恢复 `configs/a-line/corpus/seeds/user_prompt_seeds.json`，当前生成 639 条独立 user prompt seeds。
- 新增 `UserPromptSeed` contract 字段: `intent`、`ambiguityLevel`、`persona`、`applicableScenarioIds`、`preferredOperatorIds`、`pyrit`。
- `generateCorpus()` 现在按场景选择 `UserPromptSeed`，组合攻击目标和用户语境后再做 mutation。
- roleplay 不再只有单一方式，新增 security auditor、game master、video game、trivia game、movie script、persuasion script、compliance reviewer、support operator、developer debugger 等 PyRIT 风格 operator。
- 歧义 user prompt 已覆盖 fix-it、status check、inferred approval、read-or-act、policy exception、low-context、connector consent 等形态。
- `verify:a-corpus` 现在要求 `userPromptSeeds >= 500`，并扫描该层是否含真实密钥形态。

当前规模:

```txt
resource seeds: 687
attack seeds: 839
user prompt seeds: 639
tool response seeds: 309
mutation operators: 85
generated prompts: 2400
generated test cases: 2400
generated test oracles: 2400
```

当前有效 A 线结构:

```txt
configs/a-line/corpus/seeds/resource_seeds.json
configs/a-line/corpus/seeds/attack_seeds.json
configs/a-line/corpus/seeds/user_prompt_seeds.json
configs/a-line/corpus/seeds/tool_response_seeds.json
configs/a-line/corpus/operators/mutation_operators.json
configs/a-line/corpus/profiles/corpus_run_profiles.json
generated/a-line/**
```

后续维护要求:

- 新增攻击目标写入 `AttackSeed`；新增用户表达、歧义语境、角色扮演或多轮铺垫写入 `UserPromptSeed`。
- 同一攻击方式允许多次变异运行，优先通过多个 `UserPromptSeed.persona` 和多个 PyRIT roleplay operator 扩展。
- 新增资源/攻击/user prompt/响应/operator 后先运行 `npm run a:generate-corpus`，再运行 `npm run verify:a-corpus`。
- 不因为 demo/OpenClaw 单机联调状态回退 A 线 full corpus 规模或目录结构。
