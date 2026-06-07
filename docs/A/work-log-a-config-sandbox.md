# A 线配置与 Sandbox 开发工作日志

日期: 2026-06-02
分支: `feature/a-config-sandbox`
基线: `origin/main` @ `2e13048`
状态: A 线开发完成，暂不合并回 `main`

## 1. Git 工作流记录

- 开发前检查到本地 `main` 干净，但落后 `origin/main` 17 个提交。
- 为避免基于过期本地 `main` 开发，直接从最新 `origin/main` 创建分支:

```bash
git switch -c feature/a-config-sandbox origin/main
```

- 本分支只提交 A 线相关内容，不合并回 `main`。
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

已新增 `docs/a-line-aig-adaptation-plan.md`，记录对本地临时 AIG 仓库 `mcp-scan` 和 `agent-scan` 的审阅结论，并将可迁移内容映射到 A 线后续任务。

下一步 A 线建议优先:

- 新增 `configs/red_team_scenarios.json` 和 `configs/supervision_policy_templates.json`。
- 扩展 `tool.write_file`、`tool.send_email`、`tool.call_api` 的工具定义和 sandbox 模拟行为。
- 基于 AIG 的 data leakage、tool abuse、indirect injection、authorization bypass、tool poisoning 思路扩展攻击库。
- 更新 A 线验证脚本，保证 P1 场景、策略模板和新增工具都可被加载、校验和确定性执行。

## 9. 2026-06-04 A 线攻击库与 Sandbox 扩展实现

分支: `feature/a-attack-library-sandbox`

本轮按 `docs/a-line-aig-adaptation-plan.md` 的第一优先级完成 A 线增强，重点是把 AIG 中可复用的 Agent/MCP 检测思路落成 Agent Guard 自己的结构化配置和确定性 sandbox 行为。

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

D 线:

- 如果需要展示场景库或策略模板，应通过后端 API 或报告产物消费，不得直接读取 `configs/*.json`。

通用:

- `TestOracle` 仍未进入 `TestContext`，只作为验收和离线比对输入。
- AIG 临时仓库仍在 `E:\XinAnProject\AIG`，不在 `agent-guard` Git 仓库内。
