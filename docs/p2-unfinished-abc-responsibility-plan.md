# P2 未完成项、ABC 分工与并行约束

文档版本: p2-unfinished-abc-1  
生成日期: 2026-06-13  
状态: P2 收尾执行稿  
适用范围: P2 真实 Agent 接入、OpenClaw 检测与实时监督、正式 API、正式前端和答辩演示固化

## 1. 当前判断

P2 现在不是从零开始，而是进入收尾阶段。主体链路已经具备:

```txt
Frontend Web Console
  -> Backend API
  -> adapterKind: openclaw / http_sample / mock
  -> Trace / RiskReport / DetectionReport
  -> AgentRiskProfile
  -> SupervisionPolicyPack
  -> OpenClaw realtime MCP supervision
  -> RuntimeSupervisionRecord[]
  -> DefenseReport
```

但 P2 还没有严格完成。当前缺口集中在四类:

1. 真实 OpenClaw CLI 路线已经有 required sign-off，但其他成员本机仍需各自部署 OpenClaw runtime 和模型凭证后复验。
2. P2-D 答辩演示脚本和清理重跑脚本还没有固化。
3. 后端文件读取、实时 session、fallback 标识等边界还需要收紧。
4. 旧文档和 API 契约中仍有过期表述，容易导致 A/B/C 重复施工或责任冲突。

## 2. 正确 P2 主路线

P2 后续必须按以下路线收尾，不再把 OpenClaw 检测阶段和防御报告阶段混成一个同步 E2E:

```txt
1. 使用系统内置 P2 demo cases 驱动 OpenClaw CLI
   -> 采集 OpenClaw 行为
   -> 生成 Trace / RiskReport / DetectionReport / AgentRiskProfile

2. 事后监督分析
   -> 基于 DetectionReport 和 AgentRiskProfile 生成 SupervisionPolicyPack
   -> 策略包必须可追溯到本次真实检测

3. 实时监督
   -> OpenClaw 通过 realtime MCP endpoint 调用 Agent Guard
   -> Agent Guard 加载指定 SupervisionPolicyPack
   -> 输出 RuntimeSupervisionRecord[]
   -> 这是系统核心防御能力

4. 监督结束后生成 DefenseReport
   -> 只能基于真实 RuntimeSupervisionRecord[]
   -> 不能用检测阶段 trace 直接编造防御效果
```

保留例外:

- `mock` 和 `http_sample` 可以继续使用“检测 + 监督 + 防御报告”的一体化回归路径。
- `synthetic_fallback` 只能用于演示兜底，不能作为最终答辩中“真实 OpenClaw 防御效果”的证据。

## 3. P2 未完成项总表

| 编号 | 优先级 | 未完成项 | 负责人 | 输出物 | 完成标准 |
|---|---:|---|---|---|---|
| P2-R1 | P0 | 真实 OpenClaw CLI 验收从 optional 变成 sign-off 必跑项 | B | required verify 模式和文档说明 | 已在 2026-06-16 项目隔离 OpenClaw runtime 通过；后续其他机器按同命令复验 |
| P2-R2 | P0 | 固化 P2-D 一键演示入口 | B + C | `npm run demo:p2` 或等价脚本 | 一条命令能启动 API、前端、必要 sample/fallback，并输出访问地址 |
| P2-R3 | P0 | 固化演示清理和重跑入口 | B + C | cleanup/rerun script | 能清理 P2 demo 输出、保留必要配置、重新跑通演示 |
| P2-R4 | P0 | 报告读取路径边界校验补齐 | B | backend API hardening | defense/detection/policy/report/dashboard 所有文件读取都限制在 `outputs/**` 预期目录内 |
| P2-R5 | P0 | runtime session 不再使用固定全局 ID | B + C | session 生成和传递规则 | 每次实时监督 session 可唯一追踪，不混入旧记录 |
| P2-R6 | P1 | 明确 realtime MCP 覆盖范围 | B | 工具白名单和能力说明 | 文档和 UI 都说明当前覆盖的是 Agent Guard MCP 工具，不宣称覆盖所有 OpenClaw 原生工具 |
| P2-R7 | P1 | fallback 与真实策略包在 API/UI/报告中强区分 | B + C | `policyContextSource` 展示和报告标记 | 用户能一眼分清 `stored_detection`、`synthetic_fallback`、`mock`、`http_sample` |
| P2-R8 | P1 | OpenClaw CLI 产物路径信任边界 | B | session file allowlist/resolve 校验 | adapter 不读取任意 OpenClaw 输出声称的外部路径 |
| P2-R9 | P1 | 文件 store 并发写保护 | B | 单写锁或原子写策略 | 并发 run/report index 不互相覆盖 |
| P2-R10 | P1 | API 契约修订 | C + B | 更新 `docs/p2-api-contract-plan.md` | `generateDefenseReport`、OpenClaw 分阶段流程、realtime endpoints 和 fallback 语义一致 |
| P2-R11 | P1 | 前端演示状态表达补齐 | C | 页面状态和提示 | pending/running/failed/completed、真实/兜底路径、报告缺失原因都可见 |
| P2-R12 | P2 | 旧 demo 目录边界说明 | C | 文档和 README 更新 | `frontend/demo/**` 被明确标为 legacy/fallback，不反向决定正式 API |
| P2-R13 | P2 | HTTP sample auth 取舍 | B + C | 已决: P2 删除 `authRef`，P3 再设计认证 | P2 契约不再暴露未实现认证字段 |

## 4. A/B/C 分工

### 4.1 A 线: 内置数据、场景和策略模板

A 的 P2 收尾目标是保证“系统内置数据可以稳定驱动 OpenClaw 检测”，不参与真实运行时监督实现。

A 负责:

1. 维护 P2 demo case 集合。
2. 确认内置 case 能覆盖答辩要展示的风险类型。
3. 维护 MCP sandbox profile、tool/resource/prompt fixture。
4. 维护红队场景与策略模板之间的推荐关系。
5. 给 B 提供“OpenClaw CLI 应该跑哪些 case”的稳定输入清单。
6. 给 C 提供“这些 case 预期能解释哪些 weakness/category”的说明，但不能把 oracle 注入运行时。

A 的交付物:

```txt
configs/*.json
configs/red_team_scenarios.json
configs/supervision_policy_templates.json
docs/A/**
必要时更新 docs/contracts.md 中与 TestContext / Scenario / PolicyTemplate 有关的说明
```

A 必须补齐的 P2 任务:

| 编号 | 任务 | 验收 |
|---|---|---|
| A-P2-1 | 梳理 P2 默认 demo case 列表 | B 可以不读临时说明，直接按 caseIds 跑 |
| A-P2-2 | 标记哪些 case 适合 OpenClaw CLI、哪些只适合 mock/http_sample | `caseIds` 不再靠口头约定 |
| A-P2-3 | 校验策略模板可支持 C 生成 policy pack | C 不需要在代码里硬编码临时策略 |
| A-P2-4 | 输出答辩用“系统内置数据说明” | 能解释系统测的是 Agent，而不是测 MCP Server |

A 线状态更新 (2026-06-15):

- A-P2-1 / A-P2-2 已由 `configs/p2_demo_cases.json` 和 `docs/A/p2-built-in-test-data-guide.md` 固化。
- A-P2-3 已由 `verify:a-config-sandbox`、`verify:a-pyrit-library` 和配置校验覆盖。
- A-P2-4 已由 `docs/A/p2-built-in-test-data-guide.md` 输出。
- PyRIT adapted 迁入、attack library、jailbreak template index、converter adapter 和 bridge 草案记录在 `docs/A/p2-a-line-pyrit-integration-plan.md`、`docs/A/p2-pyrit-understanding-record.md` 和 `docs/A/work-log-a-config-sandbox.md`。

A 禁止:

- 直接生成 `AgentRiskProfile`。
- 直接生成 `SupervisionPolicyPack`。
- 在配置中写入某次运行的私有检测结论。
- 修改 OpenClaw adapter、realtime MCP、DefenseReport 或前端业务逻辑。

### 4.2 B 线: OpenClaw 接入、运行时监督和后端 API

B 的 P2 收尾目标是把 OpenClaw 作为核心演示 Agent 接进正式后端，并保证实时监督记录真实、可追溯、可被 C 用来生成防御报告。

B 负责:

1. `adapterKind: openclaw` 的 CLI 检测路径。
2. `adapterKind: http_sample` 和 `mock` 的兜底路径。
3. OpenClaw CLI 可用性检查。
4. OpenClaw CLI JSONL/session 解析与路径安全校验。
5. OpenClaw realtime MCP endpoint。
6. `SupervisionPolicyPack` 加载和执行。
7. `RuntimeSupervisionRecord[]` 采集、保存和查询。
8. `runGroupId`、`runtimeSessionId` 与后端运行状态维护。
9. Fastify API 中属于运行、监督、agent check、system status 的 handler。
10. 文件 store 的并发写和路径边界安全。

B 的交付物:

```txt
backend/src/modules/agent/**
backend/src/modules/runner/**
backend/src/modules/supervisor/**
backend/src/modules/openclaw/**
backend/src/api/v1/agents/**
backend/src/api/v1/test-runs/**
backend/src/api/v1/supervision/**
backend/src/api/v1/openclaw/**
backend/src/storage/**
scripts/verify-p2-api-e2e.ts
scripts/verify-openclaw-realtime-mcp.ts
P2 demo/cleanup scripts 中的后端部分
```

B 必须补齐的 P2 任务:

| 编号 | 任务 | 验收 |
|---|---|---|
| B-P2-1 | 增加真实 OpenClaw required 验收说明和脚本路径 | OpenClaw 环境中 `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 失败即阻断 P2 sign-off |
| B-P2-2 | 报告、trace、session 文件读取统一做 path resolve + inside directory 校验 | 不存在通过 reportId/runGroupId/sessionId 逃逸目录的路径 |
| B-P2-3 | runtimeSessionId 生成和 reset 规则后端化 | 前端不再固定 `session.openclaw.realtime` |
| B-P2-4 | realtime MCP 工具覆盖范围定稿 | `agent_guard_*` 白名单、别名和“不覆盖全部原生工具”的边界写入文档 |
| B-P2-5 | fallback policy 标记进入 session/report API | C 前端和报告可以明确展示 fallback 来源 |
| B-P2-6 | OpenClaw CLI `sessionFile` 做可信目录校验 | 不读取任意外部路径 |
| B-P2-7 | file store 增加单写锁或原子写 | 并发 API run 不互相覆盖 index |
| B-P2-8 | `demo:p2` 后端启动和健康检查 | API 启动、system status、OpenClaw availability 可见 |

B 禁止:

- 根据 `RiskReport` 自行生成新策略。
- 直接生成 `AgentRiskProfile`。
- 直接生成 `SupervisionPolicyPack`。
- 直接生成最终 `DefenseReport` 的业务结论。
- 在监督接口中内置未进入 `SupervisionPolicyPack` 的临时风险规则。
- 为了通过前端展示而改变共享契约字段语义。

### 4.3 C 线: 报告、策略包、正式前端和演示表达

C 的 P2 收尾目标是把 B 产出的 trace、检测结果、策略包和监督记录变成可解释、可答辩、可前端展示的产品闭环。

C 负责:

1. `RiskReport`、`DetectionReport`、`AgentRiskProfile` 生成。
2. `SupervisionPolicyPack` 生成。
3. `DefenseReport` 生成和 JSON/HTML artifact。
4. Report index 和报告详情 API 的展示字段协作。
5. 正式前端 API client。
6. Dashboard、Test Runs、Trace Detail、Detection & Policy、Live Supervision、Defense Report 页面。
7. 前端 loading/empty/error/running/failed/completed 状态。
8. 报告、策略、监督 session、artifact 之间的可追溯链接。
9. 答辩演示文案和 legacy demo 边界说明。

C 的交付物:

```txt
backend/src/modules/detection/**
backend/src/modules/risk/**
backend/src/modules/policy/**
backend/src/modules/defense/**
backend/src/api/v1/reports/**
backend/src/api/v1/dashboard/**
frontend/src/**
frontend/vite.config.ts
docs/C/**
P2 demo/cleanup scripts 中的前端部分
```

C 必须补齐的 P2 任务:

| 编号 | 任务 | 验收 |
|---|---|---|
| C-P2-1 | 更新 API 契约中 OpenClaw 分阶段流程 | 契约不再默认 OpenClaw 同步生成 DefenseReport |
| C-P2-2 | DefenseReport 严格只使用真实监督记录 | 没有 runtime records 时报告必须说明无法证明防御效果 |
| C-P2-3 | 前端显示真实/兜底/合成来源 | 用户可以区分 OpenClaw CLI、http_sample、mock、synthetic_fallback |
| C-P2-4 | 前端 session 选择和生成逻辑配合 B 改造 | 不再依赖固定 session ID |
| C-P2-5 | 前端展示 run 的阶段状态 | 检测完成但未监督、监督中、可生成防御报告等状态可分辨 |
| C-P2-6 | `frontend/demo/**` 标注为 legacy/fallback | 正式页面不从 legacy demo 反推 API 字段 |
| C-P2-7 | `demo:p2` 前端启动和访问说明 | 一键演示后可以打开正式 Web Console |

C 禁止:

- 编造运行时阻断记录来生成防御效果。
- 在报告模块中重新采集 Agent 运行时行为。
- 前端直接读取 `configs/*.json` 或 `outputs/**`。
- 前端 import `backend/src/**`。
- 前端重新计算风险等级、风险画像、策略包或防御效果。
- 修改 B 的 OpenClaw adapter 私有逻辑来适配页面。

## 5. 需要提前写死的约束

以下约束必须在继续并行开发前冻结，否则很容易发生冲突。

### 5.1 OpenClaw 分阶段语义

冻结规则:

```txt
OpenClaw CLI pass:
  只负责检测与策略包生成
  不直接声明防御有效

OpenClaw realtime MCP pass:
  负责实时监督
  产出 RuntimeSupervisionRecord[]

DefenseReport:
  只能在监督结束后基于 RuntimeSupervisionRecord[] 生成
```

冲突风险:

- B 为了 E2E 方便在 OpenClaw CLI 阶段生成防御报告。
- C 前端把“检测完成”误显示成“防御完成”。
- A 把预期防御效果写进配置，导致报告像 oracle 驱动。

处理规则:

- OpenClaw 的 `POST /api/v1/test-runs/e2e` 默认只完成检测和策略包。
- mock/http_sample 可以继续作为一体化回归路径，但必须在 runGroup 上标明 adapterKind。

### 5.2 ID 生成权

冻结规则:

```txt
runGroupId: 后端生成
traceId: 后端产物生成
reportId: 后端产物生成
policyPackId: C 生成的策略包产物决定
runtimeSessionId: 后端生成，或由 OpenClaw MCP request 显式传入但必须被后端登记
artifactId: 后端生成
```

冲突风险:

- 前端固定 `runtimeSessionId`，导致多次演示混跑。
- B/C 分别生成 policyPackId，导致监督记录无法追溯。

处理规则:

- 前端不得再硬编码业务 session ID。
- 如果 MCP 客户端必须传 `_agentGuardSessionId`，也要由后端先创建或在首次调用时登记。

### 5.3 策略包唯一语义

冻结规则:

```txt
SupervisionPolicyPack 由 C 生成。
B 只能加载和执行。
B 发现策略不可执行时，输出兼容性问题，不得私自改策略含义。
```

冲突风险:

- B 在 realtime MCP 中硬编码额外阻断规则。
- C 为了报告效果直接读取 B 私有日志反推策略。

处理规则:

- 任何策略字段变更必须同时过 B 可执行性和 C 可生成性检查。
- 新增字段优先可选，删除字段或改枚举必须更新 contracts/interfaces。

### 5.4 fallback 来源标记

冻结规则:

```txt
stored_detection: 来自真实检测生成的策略包
synthetic_fallback: 系统合成兜底策略包
mock: mock adapter 链路
http_sample: HTTP sample adapter 链路
openclaw: OpenClaw CLI / realtime MCP 链路
```

冲突风险:

- 演示成功但无法说明它是真实 OpenClaw 还是 fallback。
- DefenseReport 把 fallback 当真实防御效果。

处理规则:

- API、前端和报告都必须显示 source。
- `synthetic_fallback` 报告不能作为最终真实 OpenClaw 防御证明。

### 5.5 文件访问边界

冻结规则:

```txt
reports: outputs/reports/**
traces: outputs/traces/**
sessions: outputs/run-store/sessions/**
run index: outputs/run-store/**
```

所有由 ID 间接定位到文件的读取都必须:

```txt
path.resolve(target)
  -> path.relative(base, target)
  -> 确认不以 .. 开头且不是绝对路径
```

冲突风险:

- report index 中的 runGroupId 被污染后读取目录外文件。
- OpenClaw 输出的 sessionFile 指向任意外部路径。

处理规则:

- 不允许只对 artifact 做边界检查，report/detection/policy/dashboard 读取也必须一致。
- OpenClaw CLI sessionFile 只能来自允许目录或复制进系统输出目录后再解析。

### 5.6 Realtime MCP 覆盖范围

冻结规则:

P2 当前实时监督覆盖的是 Agent Guard 暴露给 OpenClaw 的 MCP 工具入口，不默认宣称拦截所有 OpenClaw 原生工具调用。

冲突风险:

- 答辩时把“工具白名单监督”讲成“全 OpenClaw 内核拦截”。
- C 前端展示范围超过 B 实际能力。

处理规则:

- 文档、UI 和报告写清楚“已监督工具列表”。
- 若要扩展到更多 OpenClaw 原生工具，先由 B 提交工具映射和 schema，C 再展示。

### 5.7 文件 store 并发模型

冻结规则:

P2 可以继续使用 file-based store，但必须承认并约束并发模型。

冲突风险:

- 多个 run 同时写 `run-groups.json` 或 report index，导致数据覆盖。

处理规则:

- P2 最低要求: 单进程内写锁或原子写。
- P3 再考虑数据库，不在 P2 临时引入新持久层。

### 5.8 API 契约与前端边界

冻结规则:

- `POST /api/v1/openclaw/realtime/mcp` 是 raw JSON-RPC 例外，不使用 `ApiResponse<T>`。
- 其他正式 API 使用统一 envelope。
- 前端只消费 API 和 artifact URL，不直接读本地文件。

冲突风险:

- C 为了页面方便直接读取 `outputs/**`。
- B 修改 API shape 后没有同步前端类型。

处理规则:

- 改 API shape 必须同步 `docs/p2-api-contract-plan.md`、`frontend/src/lib/api/types.ts` 和验证脚本。
- 共享字段只允许加可选字段；删除或改义需要协调评审。

### 5.9 HTTP sample auth 取舍

冻结规则:

`authRef` 当前不能停留在“契约写了但实现没有”的状态。

处理结果:

P2 从 `docs/p2-api-contract-plan.md` 的 `RunE2ERequest.connection` 中删除 `authRef`，认证注入推迟到 P3 重新设计。

冲突风险:

- 前端展示了 auth 配置，后端实际不使用。
- 后端私自读取环境变量，前端和文档无法解释。

## 6. 共享文件修改规则

以下文件属于 P2 收尾共享冲突点，修改前必须说明影响范围:

```txt
docs/contracts.md
docs/interfaces.md
docs/ownership.md
docs/p2-api-contract-plan.md
docs/p2-real-agent-api-frontend-plan.md
packages/contracts/src/**
backend/src/api/types.ts
backend/src/services/e2eRunService.ts
backend/src/modules/openclaw/realtimeMcpServer.ts
backend/src/storage/**
frontend/src/lib/api/**
package.json
scripts/verify-p2-api-e2e.ts
scripts/verify-openclaw-realtime-mcp.ts
```

规则:

1. A 修改配置和模板时，需要通知 B/C 是否影响 caseIds、weakness category 或 policy template id。
2. B 修改 runtime/session/API 字段时，需要通知 C 更新前端类型和页面状态。
3. C 修改 report/policy/defense 字段时，需要通知 B 确认策略包仍可执行。
4. `package.json` 脚本名一旦进入文档验收，不得随意改名。
5. `frontend/demo/**` 不能反向驱动正式 API 契约。

## 7. 建议收尾顺序

### 阶段 1: 冻结和安全补洞

负责人: B 主导，C 协作

1. 修复 report/detection/policy/dashboard 文件读取路径边界。
2. 冻结 OpenClaw 分阶段语义。
3. 修改 API 契约中过期的 `generateDefenseReport` 和流程描述。
4. 固化 source 标记字段。

验收:

```txt
npm run typecheck
npm run typecheck:frontend
npm run verify:p2:api-e2e
```

### 阶段 2: OpenClaw required 验收

负责人: B 主导，A 提供 caseIds

1. 梳理 OpenClaw CLI demo case。
2. 在 OpenClaw 环境中启用 required 模式。
3. 确认 CLI 检测能生成 policy pack。
4. 确认 realtime MCP 能加载该 policy pack。

验收:

```txt
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
```

### 阶段 3: 前端和报告表达

负责人: C 主导，B 协作

1. 前端显示 run 阶段状态。
2. 前端显示 policy source 和 adapter source。
3. 前端去掉固定 realtime session 假设。
4. DefenseReport 明确真实记录数量、fallback 标记和无法证明项。

验收:

```txt
npm run typecheck:frontend
npm run build:frontend
```

### 阶段 4: P2-D 演示固化

负责人: B + C，A 提供 demo case 说明

1. 新增 `npm run demo:p2`。
2. 新增 P2 demo cleanup/rerun 脚本。
3. 更新 OpenClaw local install/runbook。
4. 更新系统边界说明。
5. 明确真实 OpenClaw 不可用时的 fallback 话术。

验收:

```txt
npm run demo:p2
npm run verify:p2:api-e2e
VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e
npm run verify:openclaw:realtime
```

## 8. P2 完成定义

P2 只有同时满足以下条件才算完成:

1. `npm run verify:all` 通过。
2. `npm run verify:p2:api-e2e` 通过。
3. 在装有 OpenClaw 的环境中，`VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e` 通过。
4. `npm run verify:openclaw:realtime` 通过。
5. `npm run build:frontend` 通过。
6. `npm run demo:p2` 可启动正式演示入口。
7. OpenClaw CLI 检测阶段能生成可追溯的 `SupervisionPolicyPack`。
8. OpenClaw realtime MCP 监督阶段能生成真实 `RuntimeSupervisionRecord[]`。
9. `DefenseReport` 只基于真实监督记录声明防御效果。
10. 前端能展示 Dashboard、Run、Trace、Detection & Policy、Live Supervision、Defense Report，并清楚区分真实/兜底/fallback 来源。
11. API、前端、报告、文档对 OpenClaw 分阶段路线的表述一致。
12. 所有 ID 间接文件读取都有路径边界保护。

## 9. 当前最小下一步

建议按以下顺序派工:

```txt
B:
  1. 补 report/detection/policy/dashboard 路径校验。
  2. 改 runtimeSessionId 生成和登记规则。
  3. 固化 VERIFY_OPENCLAW_REQUIRED 的 sign-off 文档。

C:
  1. 更新 p2-api-contract-plan 的 OpenClaw 分阶段流程。
  2. 前端显示 source/fallback/session 状态。
  3. DefenseReport 页面明确真实监督记录数量。

A:
  1. 已完成: 整理 P2 demo case 清单。
  2. 已完成: 标注 OpenClaw CLI 适配 case 和 fallback-only case。
  3. 已完成: 输出系统内置测试数据说明。

B + C:
  1. 新增 demo:p2。
  2. 新增 P2 cleanup/rerun。
  3. 更新 runbook 和演示边界说明。
```
