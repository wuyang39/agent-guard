# Agent Guard 文档索引

文档版本: initial-1
基线日期: 2026-05-21
状态: 初始规范基线

## 1. 基线说明

本目录中的文档以当前系统规划作为初始规范基线。文档版本统一为 `initial-1`，用于表示文本规范状态。

系统最终目标是设计并实现一个可用于信息安全作品赛、具备国一竞争力的 Agent-MCP 交互安全测评系统。当前文档中的 `mvp-1` 表示 P0 垂直闭环阶段的运行时契约版本，不代表最终系统目标只停留在简单 MVP。

运行时共享对象版本仍为 `schemaVersion: "mvp-1"`。不要把文档版本和运行时对象版本混用。

## 2. 文档职责

- `architecture.md`: 系统定位、阶段范围、主数据流、模块边界、目录基线、开发规则、验收方向和架构原则。
- `contracts.md`: 运行时共享数据契约，是字段、枚举和 JSON 可序列化约束的唯一来源。
- `interfaces.md`: A/B/C 开发者之间的交接对象、输入输出和联调检查表。
- `ownership.md`: A/B/C 开发者的严格工作区、可协作区、禁止修改区和共享受控区。
- `development-workflow.md`: 全项目分支、拉取、中文 commit、文档同步、文件架构、验证和合并前检查规范。
- `framework-risk-audit.md`: 工程文件框架、模块边界和后续迭代风险的历史审计记录。
- `A/work-log-a-config-sandbox.md`: A 线配置加载、Sandbox runtime、验证命令和后续协作注意事项。
- `A/p1-a-line-aig-adaptation-plan.md`: A 线 P1 攻击库、Sandbox 扩展和 AIG `mcp-scan` / `agent-scan` 可迁移能力分析。
- `A/p2-pyrit-understanding-record.md`: A 线对本地定制 PyRIT 项目的结构审阅、可迁移能力、已迁入内容和已知限制。
- `A/p2-a-line-pyrit-integration-plan.md`: A 线 P2 PyRIT 攻击库迁移、配置接入、sandbox 适配、验证和后续开发计划。
- `A/p2-built-in-test-data-guide.md`: A 线 P2 内置 case、OpenClaw/fallback 分层、AIG/PyRIT 来源和答辩说明。
- `A/p2-pyrit-python-bridge-contract.md`: 可选 PyRIT Python bridge 的输入输出、边界、烟测和后续接入约束。
- `A/p2-openclaw-project-runtime-test.md`: 项目隔离 OpenClaw runtime 的本机部署、DeepSeek 模型映射和 required 验证结果。
- `A/p3-a-corpus-implementation-plan.md`: A 线 P3 攻击库、资源种子、PyRIT/AIG 迁移、千级 generated corpus、run profile 和验证脚本的实现前执行计划。
- `../configs/a-line/README.md`: A 线攻击库配置分层说明，解释 `sources/`、`corpus/seeds/`、`corpus/operators/`、`corpus/profiles/` 与 `generated/a-line/**` 的职责。
- `B/p1-b-runtime-supervision-work-plan.md`: B 线 P1 运行时监督实现计划。
- `B/superpowers/**`: B 线历史设计规格和实现计划。
- `p1-supervision-defense-plan.md`: P1 检测画像驱动的 Agent 运行时监督、策略包生成和防御报告规划。
- `p2-real-agent-api-frontend-plan.md`: P2 以 OpenClaw 为核心演示 Agent 的正式 API、运行历史和前端演示系统规划。
- `p2-unfinished-abc-responsibility-plan.md`: P2 剩余缺口、A/B/C 分工、OpenClaw 正确路线和并行约束收尾稿。
- `p2-api-contract-plan.md`: P2 并行开发前必须冻结的前后端 API 草案。
- `P3plan.md`: P3 统一总规划，合并 A 线 PyRIT 驱动千级攻击库、B 线 OpenClaw 外部工具实时监督网关、C 线报告生成/前端展示/证据复核和导出路线。
- `C/frontend-d-handoff.md`: C 线前端 Web Console 的开工边界、页面优先级、API Client 和联调检查点。文件名保留历史入口，职责已归入 C。

## 3. 唯一来源规则

- 字段类型以 `contracts.md` 和 `packages/contracts/src/types/**` 为准。
- 开发者工作区以 `ownership.md` 为准。
- 物理目录结构、依赖方向和开发规则以 `architecture.md` 为准。
- 日常开发流程、中文 commit、分支检查、拉取最新进度和合并前检查以 `development-workflow.md` 为准。
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
