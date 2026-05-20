# 文件框架迭代风险审计

版本: mvp-1
日期: 2026-05-20
状态: 框架风险修订记录

## 1. 审计范围

本次审计只覆盖工程文件框架和模块边界，不实现完整业务逻辑。目标是降低后续系统迭代中的结构性风险，尤其是三人并行开发、配置扩展、Sandbox 演进、规则引擎扩展和报告导出扩展。

## 2. 已发现并修复的风险

### 风险 1: 单一共享契约文件过大

原风险:

- 所有共享类型集中在 `src/shared/contracts.ts`
- 后续 Agent、Sandbox、Trace、Risk、Report 同时演进时容易产生合并冲突
- 类型责任不清，开发者难以判断字段归属

修复:

- 拆分为 `src/shared/types/*.ts`
- 保留 `src/shared/contracts.ts` 作为稳定导出口
- 现有模块仍从 `src/shared/contracts` 导入，避免大面积路径变更

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

## 3. 仍需后续处理的风险

### 风险 A: 配置加载仍未读取真实文件

当前 `loadConfigRepository()` 和 `loadTestContexts()` 仍是接口壳。下一轮应实现文件读取、JSON parse、schema 校验和 `TestContext` 构造。

### 风险 B: Sandbox runtime 仍未实现真实工具行为

当前 `McpSandboxRuntime` 已固定接口，但 `executeTool()`、`readResource()`、`loadPrompt()`、`resolveToolResponse()` 仍未实现。下一轮应优先实现 mock runtime。

### 风险 C: 风险评估仍未把规则结果转为 Finding

当前 `matchesRule()` 已具备基础匹配能力，但 `evaluateRisk()` 还没有遍历 rules 与 events 生成 `Finding`。下一轮应实现规则到发现结果的转换。

### 风险 D: 报告导出器未写入文件

当前 JSON / HTML exporter 只返回 `ReportArtifact`，还没有执行文件写入。下一轮应补充真正的导出实现。

## 4. 下一轮建议

推荐下一轮按以下顺序推进:

1. 实现 `loadConfigRepository()` 与 `validateConfigRepository()`
2. 用配置样例生成 `TestContext`
3. 实现 mock `McpSandboxRuntime`
4. 用 mock trace 跑通 `matchesRule()` 到 `Finding`
5. 实现 JSON / HTML 文件导出

不要先做 UI。当前最大的工程风险仍在运行时闭环，而不是展示层。
