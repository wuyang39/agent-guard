# Agent-MCP 交互安全测评系统开发协作规则

版本: mvp-1
日期: 2026-05-20
状态: MVP 开发基线

## 1. 协作原则

三人开发以共享契约为边界:

```txt
TestContext -> InteractionTrace -> RiskReport
```

任何模块不得依赖其他模块的内部实现。联调失败时，优先检查 schema、字段命名、版本号和事件顺序，不优先临时修改业务逻辑。

## 2. 模块责任

### 开发者 A

负责配置与测试上下文:

- 维护 `configs/*.json`
- 实现配置加载和校验
- 输出 `TestContext`
- 提供 config 模块 demo

不得:

- 直接生成风险报告
- 修改 trace 采集逻辑
- 在配置模块中读取运行时 trace

### 开发者 B

负责交互监控和事件记录:

- 捕获 Agent-MCP 交互
- 生成标准化 `TraceEvent`
- 输出 `InteractionTrace`
- 提供 monitor 模块 demo

不得:

- 内置风险判定规则
- 直接计算风险等级
- 修改配置文件结构

### 开发者 C

负责风险判定、证据链和报告:

- 输入 `TestContext` 与 `InteractionTrace`
- 输出 `RiskReport`
- 维护风险判定逻辑
- 维护证据链生成逻辑
- 提供 risk/report 模块 demo

不得:

- 绕过 `InteractionTrace` 读取临时日志
- 直接修改配置仓库
- 在报告展示中重新判定风险

## 3. 命名规范

共享数据类型使用名词:

```txt
TestContext
InteractionTrace
TraceEvent
RiskRule
Finding
EvidenceChain
RiskReport
```

模块入口函数使用动词:

```txt
loadTestContext()
recordTraceEvent()
evaluateRisk()
buildEvidenceChain()
buildRiskReport()
exportReport()
```

文件命名:

- TypeScript 文件使用 `camelCase.ts`
- JSON 配置文件使用 `snake_case.json`
- 文档文件使用小写短横线或既有约定

## 4. Import 约束

允许:

```txt
riskEvaluator.ts -> imports TestContext type
riskEvaluator.ts -> imports InteractionTrace type
riskEvaluator.ts -> imports RiskRule type
```

不允许:

```txt
riskEvaluator.ts -> imports traceRecorder.ts
riskEvaluator.ts -> reads outputs/traces/raw.log directly
riskEvaluator.ts -> modifies configs/risk_rules.json at runtime
```

`shared/` 只能存放真正跨模块通用的小工具，例如 ID、时间、错误类型和 schema version。禁止将业务流程塞入 `shared/`。

## 5. MVP 风险规则

第一版只覆盖 4 类核心风险:

1. 工具误用风险: Agent 调用了测试用例不允许的 MCP Tool，或使用明显异常参数
2. 越权访问风险: Agent 访问未授权 Resource，或访问行为不符合资源标签约束
3. 敏感数据泄露风险: Tool 参数、Tool 返回、Agent 消息或 Resource 内容中出现敏感字段泄露迹象
4. 危险动作风险: Agent 触发删除、外传、写入敏感资源、执行未经授权命令等高危操作

风险等级固定为:

```txt
low / medium / high / critical
```

## 6. 禁止事项

MVP 阶段明确禁止:

- 风险模块直接读取原始临时日志文件
- 报告模块重新判定风险等级
- 监控模块内置风险规则
- 配置模块依赖运行时 trace 数据
- 模块间互相 import 对方内部实现文件
- 没有 `schemaVersion` 的共享数据对象进入模块边界
- 前端或展示层直接解析 `risk_rules.json`
- 为了演示效果手写假报告绕过 `RiskReport`
- 私下修改共享字段名或枚举值
- 使用口头约定替代文档契约

## 7. 开发顺序

推荐推进顺序:

1. 先定共享类型: `TestContext`、`InteractionTrace`、`RiskReport`
2. 再做 mock 数据闭环: 用 mock trace 跑通风险判定和报告生成
3. 再接入真实监控: 监控模块替换 mock trace，但保持 `InteractionTrace` 格式不变
4. 最后做展示层: 展示层只消费 `RiskReport`

## 8. 模块级 Demo

每个开发者都要提供自己的模块级 demo:

```txt
开发者 A:
  input: configs/*.json
  output: TestContext

开发者 B:
  input: mock MCP interaction
  output: InteractionTrace

开发者 C:
  input: TestContext + InteractionTrace
  output: RiskReport
```

总联调只接受:

```txt
TestContext + InteractionTrace -> RiskReport
```

## 9. MVP 验收标准

MVP 完成时必须满足:

- 能加载一组内置 JSON 测试配置并生成 `TestContext`
- 能运行至少 1 个测试用例
- 能记录完整 `InteractionTrace`
- 每条 trace event 都有 `eventId`、`caseId`、`traceId`、`sequence`、`timestamp`
- 能基于 `risk_rules.json` 生成 `RiskReport`
- 每个 `Finding` 至少引用 1 个 `evidenceEventIds`
- 能输出 JSON 报告文件
- 报告中能看到总体风险等级、风险列表、证据链、原始 trace 引用
- 三个模块可以分别用 mock 数据单独测试
- 不依赖真实线上 MCP 服务也能跑通 MVP demo

## 10. 变更流程

共享契约变更流程:

1. 提出变更原因
2. 修改 `docs/contracts.md`
3. 更新相关类型或 JSON Schema
4. 更新至少一个 mock 样例
5. 通知其他开发者按文档更新

未经文档更新的共享字段变更不得进入联调分支。
