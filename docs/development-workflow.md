# Agent Guard 开发工作流与协作规范

文档版本: workflow-1  
生成日期: 2026-06-16  
状态: 全项目协作基线  
适用范围: 所有功能分支、文档分支、A/B/C 线联调分支和合并前检查

## 1. 开工前必须确认

每次开始开发、审查或合并前，先完成以下检查，并在工作日志、PR 描述或最终汇报中说明结果。

1. 确认当前分支。

   ```bash
   git status --short --branch
   git branch --show-current
   ```

   默认不得直接在 `main` 上开发。只有用户明确要求热修、文档微调或合并操作时，才允许在 `main` 执行对应动作。

2. 拉取最新远端状态。

   ```bash
   git fetch --all --prune
   ```

   如果本次工作不需要同步最新进度，必须在汇报中说明原因。例如只查看本地历史产物、不修改代码、不准备合并。

3. 检查工作区是否已有未提交内容。

   - 不回滚他人或用户已有修改。
   - 如果已有修改和当前任务无关，保持原状并绕开。
   - 如果已有修改会影响当前任务，先读懂再继续，必要时在汇报中说明协作风险。

4. 阅读相关约束文档。

   - 总体架构: `docs/architecture.md`
   - 契约: `docs/contracts.md`
   - 交接接口: `docs/interfaces.md`
   - 权属边界: `docs/ownership.md`
   - 责任线文档: `docs/A/**`、`docs/B/**`、`docs/C/**`
   - P2/OpenClaw/API 相关工作: `docs/p2-real-agent-api-frontend-plan.md`、`docs/p2-unfinished-abc-responsibility-plan.md`、`docs/p2-api-contract-plan.md`

## 2. 分支规则

- 分支按职责命名，推荐格式:
  - `a/<short-topic>`: A 线配置、sandbox、攻击库、内置数据。
  - `b/<short-topic>`: B 线 Agent adapter、runner、实时监督、后端 API。
  - `c/<short-topic>`: C 线报告、正式前端、展示模型。
  - `docs/<short-topic>`: 跨线文档或规范。
  - `fix/<short-topic>`: 明确缺陷修复。
- 一个分支只处理一个可描述的目标，避免把不相关重构、格式化和功能混在一起。
- 合并前必须再次确认目标分支、最新远端状态、验证结果和未提交文件。

## 3. Commit 规则

提交信息必须使用中文，格式为:

```txt
<type>: 中文简洁描述
```

推荐类型:

- `feat`: 新功能或新能力。
- `fix`: 缺陷修复。
- `docs`: 文档和协作规范。
- `test`: 验证脚本、测试用例。
- `chore`: 工程维护、脚本、依赖或忽略规则。
- `refactor`: 不改变行为的结构调整。

示例:

```txt
feat: 接入项目隔离OpenClaw运行环境
fix: 稳定PyRIT模板索引哈希校验
docs: 固化开发工作流规范
```

禁止事项:

- 不提交明文密钥、token、provider key、`.env`、本地 runtime 状态库。
- 不把 OpenClaw、AIG、PyRIT 原始仓库的 `.git` 元数据带入 `agent-guard`。
- 不用英文-only commit 描述，除非是外部工具自动生成且已被团队明确接受。

## 4. 文档与代码同步规则

代码修改必须和对应文档保持一致。

- 修改共享字段、枚举、schema: 先更新 `docs/contracts.md`，再改 `packages/contracts/src/types/**`。
- 修改 A/B/C 交接对象、接口时序或验收方式: 更新 `docs/interfaces.md`。
- 新增目录、移动模块、改变 ownership: 更新 `docs/architecture.md` 和 `docs/ownership.md`。
- A 线改配置、攻击库、sandbox、内置 case: 更新 `docs/A/work-log-a-config-sandbox.md` 或新增 `docs/A/**` 说明。
- B 线改 adapter、runner、OpenClaw、supervision、后端 API: 更新 `docs/B/**` 或 P2 计划文档。
- C 线改报告、正式前端、API client、展示语义: 更新 `docs/C/**` 和相关 API 文档。
- 外部 runtime 或第三方迁移: 记录来源、版本、忽略规则、验证命令和不能提交的文件范围。

如果实现中发现文档已过期，应优先修正文档状态，而不是按旧文档继续开发。

## 5. 文件架构管理

新增文件必须落在已有职责边界内。

- `packages/contracts/` 只放共享类型和稳定 API 类型，不放运行时业务逻辑。
- `backend/src/api/**` 只做请求响应组装，业务编排放在 `backend/src/services/**`。
- `backend/src/modules/**` 按 Agent、config、sandbox、runner、risk、report、supervisor、defense 等领域拆分。
- `frontend/src/**` 只能通过 API client 和 `packages/contracts` 消费后端能力，不直接 import `backend/src/**`、`configs/**` 或 `outputs/**`。
- `configs/**` 放系统内置测试数据、攻击库元数据、规则、场景和策略模板。
- `third_party/**` 只放受控迁入的参考或适配源码；主链路不得直接执行未经适配的第三方 runtime。
- `outputs/**`、本地 runtime、日志、缓存和模型凭证默认不提交。

新增共享目录前，必须先说明 ownership、依赖方向、是否会进入验证链路，以及是否需要 `.gitignore` 保护。

## 6. 验证规则

根据改动范围选择最小但足够的验证组合。跳过验证时必须说明原因。

| 改动范围 | 建议验证 |
|---|---|
| 文档、忽略规则 | `git diff --check` |
| 共享类型、TS 逻辑 | `npm run typecheck` |
| A 线配置和 sandbox | `npm run verify:a-config-sandbox`、`npm run verify:a-pyrit-library` |
| PyRIT bridge | `npm run pyrit:bridge-smoke` |
| P1 检测/监督 | `npm run verify:p1:detection-policy`、`npm run verify:p1:supervision-defense` |
| P2 API/E2E | `npm run verify:p2:api-e2e` |
| OpenClaw required sign-off | `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` |
| OpenClaw realtime MCP | `npm run verify:openclaw:realtime` |
| 前端 | `npm run typecheck:frontend`、`npm run build:frontend` |
| 全链路回归 | `npm run verify:all`、必要时 `npm run verify:e2e` |

OpenClaw 相关验证必须区分两类结果:

- CLI 检测: 采集真实 OpenClaw agent 行为，生成 trace、风险、检测画像和策略包；这是检测链路，不等于实时阻断。
- Realtime MCP: OpenClaw 或验证脚本通过 Agent Guard MCP endpoint 发起工具调用，产生 `RuntimeSupervisionRecord[]`；这是实时监督和防御证据来源。

## 7. 合并前检查

合并回 `main` 前至少确认:

1. 当前分支目标已经完成，未混入无关改动。
2. 已 `git fetch --all --prune`，并确认目标分支没有意外落后。
3. 工作区无未提交的应提交文件。
4. 必要验证已通过，失败或跳过项已经记录。
5. 文档、工作日志、接口说明和验收口径已同步。
6. `.gitignore` 覆盖本地 runtime、第三方临时仓库、日志、outputs 和密钥文件。
7. 用户要求先审阅时，不得擅自合并。

## 8. 推送规则

审核完成并完成本地 commit 后，可以推送到远端，但推送前必须再次确认:

1. 当前仓库是 `agent-guard`，不是 AIG、PyRIT、OpenClaw runtime 或其他本地参考项目。
2. 当前分支和目标远端分支正确。
3. 已 `git fetch --all --prune`，远端目标分支没有新的未整合提交。
4. `git status --short --branch` 显示工作区干净。
5. 最近提交信息符合中文 commit 规则。
6. 没有把本地 runtime、outputs、日志、密钥、第三方临时仓库 `.git` 元数据加入提交。

推送主线推荐命令:

```bash
git push origin main
```

如果用户只要求本地合并或先审阅，不得擅自推送。

## 9. 本地 runtime 与密钥

- OpenClaw 本体、workspace、状态库和模型凭证属于本地 runtime，不进入 `agent-guard` 仓库。
- 本机可使用项目隔离 runtime，例如 `E:\XinAnProject\openclaw-runtime`，但只提交启动脚本、runbook 和忽略规则。
- provider key 只能来自用户环境变量或本地未提交配置，不写入文档、命令行明文、提交记录或 `AgentAdapterConfig`。
- 如果需要把用户环境变量映射成 OpenClaw 识别的变量，只能在当前进程内完成，并避免打印 key 值。

## 10. 工作日志

每个阶段性任务都要留下可追溯记录，至少包含:

- 分支名和提交摘要。
- 做了哪些代码/文档改动。
- 使用了哪些外部材料或本地 runtime。
- 验证命令和结果。
- 已知限制、后续方向、与 A/B/C 的接口影响。

A 线记录优先放在 `docs/A/work-log-a-config-sandbox.md`；跨线规范放在本文档或对应总文档；OpenClaw 本地演示操作放在 `docs/C/openclaw-local-install-and-demo-runbook.md` 和相关 B 线文档。
