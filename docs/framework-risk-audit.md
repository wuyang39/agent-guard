# 文件框架迭代风险审计

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

说明: 本文档把当前文件框架风险审计结果固化为初始风险基线，后续新增风险在本文档追加。审计结论服务于竞赛级完整系统建设，P0 阶段只实现其中的垂直闭环子集。

## 1. 审计范围

本次审计只覆盖工程文件框架和模块边界，不实现完整业务逻辑。目标是降低完整系统建设中的结构性风险，尤其是三人并行开发、配置扩展、Sandbox 演进、规则引擎扩展、报告导出扩展、前端展示扩展和历史回放扩展。

## 2. 已发现并修复的风险

### 风险 1: 单一共享契约文件和单层 src 目录过大

原风险:

- 所有共享类型曾集中在 `src/shared/contracts.ts`
- 后端、前端和共享契约曾都隐含在单层 `src/` 下
- 后续 Agent、Sandbox、Trace、Risk、Report 同时演进时容易产生合并冲突
- 类型责任和前后端边界不清，开发者难以判断字段归属

修复:

- 后端运行时迁移到 `backend/src/modules/**`
- 前端控制台预留到 `frontend/**`
- 前后端共享契约迁移到 `packages/contracts/src/types/*.ts`
- `packages/contracts/src/index.ts` 作为稳定导出口
- 后端模块通过 `@agent-guard/contracts` 导入共享类型

### 风险 2: Agent Adapter 只支持一次性 sendTask

原风险:

- 真实 Agent 可能需要会话、工具调用回调、流式响应或 SDK 适配
- 单个 `sendTask()` 无法承载 Agent 与 MCP Sandbox 的多轮交互

修复:

- 增加 `AgentAdapter`
- 增加 `AgentSession`
- 增加 `AgentToolBridge`
- 增加 `AgentAdapterRegistry`

### 风险 3: MCP Sandbox 只有 profile，缺少运行时接口

原风险:

- `McpSandboxProfile` 只能描述环境，不能执行 Tool、读取 Resource 或解析 Tool Response
- Test Runner 后续容易绕过 Sandbox 直接写临时代码

修复:

- 增加 `McpSandboxRuntime`
- 固定 `executeTool()`
- 固定 `readResource()`
- 固定 `loadPrompt()`
- 固定 `resolveToolResponse()`

### 风险 4: 配置文件缺少统一索引和校验入口

原风险:

- JSON 配置增多后，容易出现重复 ID、断裂引用、Tool Response 模板找不到等问题
- TypeScript 无法校验运行时 JSON 的引用关系

修复:

- 增加 `ConfigRepository`
- 增加 `ConfigIndex`
- 增加 `buildConfigIndex()`
- 增加 `validateConfigRepository()`
- 校验重复 ID 与关键引用关系

### 风险 5: 规则引擎没有可插拔 operator

原风险:

- `matchesRule()` 没有真实匹配骨架
- 后续增加 `equals`、`contains`、`regex` 等能力时容易硬编码

修复:

- 增加 `OperatorRegistry`
- 增加 `OperatorHandler`
- 增加 `defaultOperatorRegistry`
- 实现基础 `FieldMatcher` 解释逻辑
- `url_decode` 使用安全降级，畸形编码不会中断规则执行

## 3. 当前基线已处理的风险

### 风险 A: 配置加载仍未读取真实文件

`feature/a-config-sandbox` 已实现 `loadConfigRepository()` 和 `loadTestContexts()`:

- 从 `configs/*.json` 读取真实配置文件
- 校验顶层 JSON array、重复 ID、断裂引用、版本号、Tool Response 归属和关键 matcher operator
- 为 enabled test case 构造 `TestContext`
- 单独返回 `TestOracle[]`，不让 `ExpectedOutcome` 进入运行时 `TestContext`

### 风险 B: Sandbox runtime 仍未实现真实工具行为

`feature/a-config-sandbox` 已实现 `createMcpSandbox()` 和 `createMcpSandboxForContext()`:

- `executeTool()` 支持确定性 Tool 模拟、Tool Response 注入计划和 call count
- `readResource()` 支持资源画像、敏感级别、注入标记和 accessPolicy 授权判断
- `loadPrompt()` 支持 Prompt 风险标签和入口类型输出
- `resolveToolResponse()` 支持 `first_call`、`every_call` 和 `matching_parameters`

### 风险 C: 风险评估仍未把规则结果转为 Finding

当前基线已实现 `evaluateRisk()` 到 `Finding` 的转换:

- 遍历 `TestContext.riskRules` 与 `InteractionTrace.events`
- 通过 `matchesRule()` 命中风险规则
- 生成 `Finding.evidenceEventIds`
- 按 findings 最高等级计算 `RiskEvaluationResult.riskLevel`
- 生成 `EvidenceChain` 与 `AttackChain`

### 风险 D: 报告导出器未写入文件

当前基线已实现 JSON / HTML exporter 写入:

- `exportJsonReport()` 写出自包含 JSON 报告
- `exportHtmlReport()` 写出 HTML 报告
- 导出器返回 `ReportArtifact`

## 4. 仍需后续处理的风险

### 风险 E: 正式闭环尚未统一使用 A 线加载入口

当前 Runner 已能消费 `TestContext`，但部分验证脚本和 demo 仍手写配置加载或上下文构造。下一轮应让正式联调入口统一通过 `loadTestContexts()` 获取 `TestContext`，避免多人协作时出现两套配置解释逻辑。

### 风险 F: Demo 脚本与正式模块仍存在重复实现

`scripts/demo-web-server.mjs` 仍保留独立的 `buildContext()`、`buildTrace()`、`evaluateTrace()` 和 `buildReport()`。这对展示有帮助，但后续正式 API / 前端接入时应逐步改为调用正式模块，避免 demo 结果与正式契约漂移。

## 5. 下一轮建议

推荐下一轮按以下顺序推进:

1. B 线将 `runTestCase()` 接入 `loadTestContexts()` 生成的正式 `TestContext`
2. B 线继续稳定 `InteractionTrace`，确保 Tool Call / Tool Result 通过 `callId` 关联
3. C 线基于 A/B 正式输出补充回归验证，确认 `Finding`、`EvidenceChain`、`AttackChain` 与报告视图一致
4. 将 demo server 的独立流程逐步替换为正式模块调用
5. 在正式 API / 前端接入前，保持 `frontend/demo` 与正式契约差异可控

前端目录已经预留，但不要先实现 UI 业务逻辑。当前最大的工程风险仍在运行时闭环，Frontend Web Console 应在 `RiskReport` 与 `ReportArtifact[]` 稳定后推进。
