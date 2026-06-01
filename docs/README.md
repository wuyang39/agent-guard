# Agent Guard 文档索引

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

## 1. 基线说明

本目录中的文档以当前系统规划作为初始规范基线。文档版本统一为 `initial-1`，用于表示文本规范状态。

系统最终目标是设计并实现一个可用于信息安全作品赛、具备国一竞争力的 Agent-MCP 交互安全测评系统。当前文档中的 `mvp-1` 表示 P0 垂直闭环阶段的运行时契约版本，不代表最终系统目标只停留在简单 MVP。

运行时共享对象版本仍为 `schemaVersion: "mvp-1"`。不要把文档版本和运行时对象版本混用。

## 2. 文档职责

- `architecture.md`: 系统定位、阶段范围、主数据流、模块边界、完整系统验收方向和架构原则。
- `contracts.md`: 运行时共享数据契约，是字段、枚举和 JSON 可序列化约束的唯一来源。
- `interfaces.md`: 三名开发者之间的交接对象、输入输出和联调检查表。
- `directory-structure.md`: FAROS-style 完整文件目录、前后端分离结构和依赖方向。
- `ownership.md`: 三名开发者的严格工作区、可协作区、禁止修改区和共享受控区。
- `development-rules.md`: 开发协作纪律、命名规范、Import 约束、禁止事项、开发顺序、P0 验收和完整系统演进约束。
- `framework-risk-audit.md`: 当前文件框架和迭代风险审计记录。

## 3. 唯一来源规则

- 字段类型以 `contracts.md` 和 `packages/contracts/src/types/**` 为准。
- 开发者工作区以 `ownership.md` 为准。
- 物理目录结构以 `directory-structure.md` 为准。
- 交接链路以 `interfaces.md` 为准。
- 系统边界和主流程以 `architecture.md` 为准。

## 4. 变更要求

任何文档变更都必须保持以下关键约束不丢失:

- 唯一被测对象是 Agent。
- 最终目标是竞赛级完整测评系统，P0 只是第一阶段垂直闭环。
- MCP Server、Tool、Resource、Prompt、Tool Response、风险规则和测试用例都是系统内部提供的测试夹具。
- `TestOracle` 和 `ExpectedOutcome` 不得进入运行时 `TestContext`。
- B 模块只输出 `TestRun` 和 `InteractionTrace`，不得生成风险结论。
- C 模块只基于 `TestContext`、`TestRun` 和 `InteractionTrace` 生成风险、证据链、攻击链和报告。
- Frontend Web Console 不得直接解析 `risk_rules.json`，只能消费 API 或报告产物。
- 前端不得直接引用 `backend/src/**`。
- `packages/contracts/` 不得包含运行时业务逻辑。
- `frontend/demo/` 只是展示型原型，不作为正式前端架构或接口契约来源。
