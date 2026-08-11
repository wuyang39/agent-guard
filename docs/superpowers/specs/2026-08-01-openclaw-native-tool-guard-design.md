# OpenClaw 原生工具执行前防护设计规格

设计日期：2026-08-01

适用项目：Agent Guard / AgentSleuth

状态：架构基线已获确认，等待书面规格评审

OpenClaw 研究基线：`2026.7.2`，上游提交 `3edbe19fbd84ba58fdbf8e83042da9efd1d06f81`

## 1. 结论

Agent Guard 采用以下分层解决 OpenClaw 原生工具绕过问题：

1. 未启用 Agent Guard 的会话保持 OpenClaw 原有行为。
2. 检测会话必须在 OpenClaw Docker sandbox 中执行，并使用独立配置与状态目录。
3. 监督会话默认不启用 Docker，通过 OpenClaw 工具执行前管线裁决真实工具调用。
4. OpenClaw `registerTrustedToolPolicy` 负责可信准入和租约异常保护。
5. 低优先级 `before_tool_call` Hook 对最终可见参数执行 Agent Guard 策略裁决。
6. `after_tool_call` 只采集真实执行结果，不承担事后补救式拦截。
7. 启用范围由短期、会话级、可续期租约决定；显式停用后立即恢复透传。

该方案方向合理，但不能照搬历史提交 `8aa25d9` 中的插件。历史插件缺少租约、鉴权、参数改写、可靠事件上报和能力预检，并通过工具名前缀跳过部分调用，无法作为安全边界。

## 2. 最终审计发现

| 等级 | 问题 | 当前表现 | 设计处理 |
| --- | --- | --- | --- |
| P0 | 当前不是执行前监督 | `openclawSession.ts` 在 OpenClaw 已执行后回放工具调用 | 正式 Trace 改由真实 before/after 事件生成；JSONL 只作旁证 |
| P0 | Trusted Policy 后仍可发生参数改写 | 普通 Hook 位于 Trusted Policy 之后 | Trusted Policy 做准入；Agent Guard 普通 Hook 以最低约定优先级裁决最终参数；受支持环境禁止其后再有参数改写 Hook |
| P0 | OFF 状态可能被错误影响 | 历史插件启动即连接 Agent Guard，且无策略时仍阻断部分工具 | 无租约时纯内存判断后返回，不联网、不记录、不改参数、不审批、不阻断 |
| P0 | 租约重启或续租失败可能失守 | 仅内存租约在 Gateway 重启后消失 | 持久化不含秘密的 guarded marker；有效期内进入 recovery 并阻断高风险/未知工具，重新激活后恢复 |
| P0 | 子 Agent 可绕过父会话租约 | 子 Agent 使用不同 `sessionKey` | 租约覆盖会话树；监听 `subagent_spawned` 派生子会话绑定 |
| P0 | 检测 Docker 不是整个 OpenClaw 容器化 | Gateway、原生插件及部分 MCP 工具仍在宿主信任边界 | 明确覆盖矩阵；检测只允许已知模拟 MCP，禁用 elevated 和未授权宿主插件工具 |
| P0 | 检测配置可能污染正常 OpenClaw | 修改全局配置再恢复存在并发和崩溃风险 | 使用独立 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和工作区，不修改用户配置 |
| P0 | 决策接口可被本机伪服务冒充 | 仅使用 loopback HTTP 和 bearer 不能认证响应方 | 每个租约使用 Ed25519 决策签名，插件固定租约公钥并验证响应 |
| P1 | 工具名前缀跳过可被伪装 | 历史插件跳过 `agent_guard__*`、`agw__*` | 不按名称跳过；使用 OpenClaw 可信工具身份和来源元数据，所有调用仍进入准入管线 |
| P1 | 审批存在双状态机风险 | 现有 `askChannel` 与 OpenClaw 审批可能重复等待 | 原生工具只使用 OpenClaw `requireApproval`；Agent Guard 仅镜像状态和提供适配入口 |
| P1 | 审批可能批准 A、执行 B | 审批未绑定参数摘要 | 绑定 lease、session、toolCall、tool identity 和 RFC 8785 参数摘要；只允许单次批准 |
| P1 | 当前脱敏只支持浅层字段 | `redactRequestParameters` 只处理一级 key | 原生决策返回完整改写参数及摘要，支持嵌套字段；OpenClaw 再做工具 schema 校验 |
| P1 | 事件丢失且可能泄露敏感结果 | 历史 after Hook 静默丢弃上报失败，直接发送结果 | 有界本地 spool、幂等批量上报、预览限长、秘密字段过滤和内容摘要 |
| P1 | 本地管理端点缺少完整防护 | API 默认 loopback，但 CORS 为任意来源且没有统一鉴权 | 原生防护管理端点使用操作员令牌；评估/事件端点使用租约凭据；限制来源、大小和速率 |
| P1 | 浏览器和 elevated 可能绕过隔离 | Browser 使用独立容器网络，elevated 可能落到宿主 | 检测默认禁用；需要时只接受受控浏览器网络和模拟出口，禁止 host control |
| P2 | 现有正则策略可能阻塞事件循环 | 策略引擎直接执行任意 JavaScript RegExp | 限制表达式长度和复杂度，原生裁决采用安全正则实现或预编译校验 |

## 3. 目标与非目标

### 3.1 目标

- 对 OpenClaw 注册并通过标准工具执行管线调用的工具进行真实执行前裁决。
- 在有效租约内支持 `allow`、`warn`、`deny`、`ask` 和 `redact`。
- Agent Guard 未启用时不改变 OpenClaw 工具行为和可用性。
- 检测任务在 Docker 不可用或隔离配置不合格时拒绝启动。
- 策略决定、审批结果和实际工具结果可以按同一 `toolCallId` 关联。
- Agent Guard 或 OpenClaw 重启、超时、重复请求和取消时保持确定行为。
- 前端和报告准确显示覆盖状态，不能把事后回放或未安装插件描述为实时防护。

### 3.2 非目标

- 不防御拥有宿主管理员权限、可修改 OpenClaw 或卸载安全插件的恶意操作员。
- 不把不可信原生插件代码本身放入 Docker；原生插件仍属于 OpenClaw Gateway 信任边界。
- 不保证拦截插件在 Hook 之外自行产生的网络、文件或进程副作用。
- 不在第一版支持远程 Agent Guard PDP；只支持同机 loopback，远程模式以后使用 mTLS 单独设计。
- 不用 LLM 直接决定运行时放行或拒绝；LLM 只参与离线画像、解释和策略生成。
- 不用 MCP 原生工具代理替代 OpenClaw 原生工具，也不要求监督阶段默认运行 Docker。

## 4. 信任边界

### 4.1 受信任组件

- OpenClaw Gateway 和本设计支持的 OpenClaw 版本。
- Agent Guard OpenClaw 插件及其 manifest。
- Agent Guard 后端的租约服务、策略引擎和签名密钥。
- 操作员明确安装并允许的其他 OpenClaw 原生插件。
- Docker daemon 及宿主操作系统。

### 4.2 不受信任输入

- 用户 Prompt、模型输出和工具参数。
- MCP ToolResponse、网页内容、文件内容和外部 API 响应。
- Agent 生成的命令、路径、URL、代码和子 Agent 请求。
- 来自浏览器页面的本地 API 请求。
- 重放、乱序、重复和超时的租约或决策消息。

### 4.3 覆盖边界

| 执行面 | 监督阶段 | 检测阶段 |
| --- | --- | --- |
| OpenClaw core/native agent tools | Trusted Policy + `before_tool_call` | 同左，并在 Docker sandbox 执行 |
| MCP tools | 保留 MCP Gateway；同时经过 OpenClaw 准入观察 | 仅允许 Agent Guard 模拟 MCP 或明确受控服务 |
| OpenClaw 原生插件内部副作用 | 不覆盖，插件属于受信任基座 | 不由工具 Docker 隔离；检测配置采用插件 allowlist |
| Browser tool | 可由策略监督 | 默认禁用；受控模式需独立网络验收 |
| Elevated/host execution | 策略默认高风险 | 禁止 |
| Agent Guard 后端 | 宿主 loopback 服务 | 宿主控制面，不进入攻击容器 |

## 5. 总体架构

```text
Agent Guard UI / detection orchestrator
        |
        v
Native Guard Lease Service ---- OpenClaw Control Client
        |                               |
        | signed lease activation       | Gateway-authenticated plugin route
        |                               v
        |                    Agent Guard OpenClaw Plugin
        |                    +---------------------------+
        |                    | Lease Registry            |
        |                    | Trusted Admission Policy  |
        |                    | Final before_tool_call     |
        |                    | after_tool_call Reporter   |
        |                    | Recovery Marker / Spool    |
        |                    +---------------------------+
        |                               |
        | authenticated decision        |
        +<------------------------------+
        |
        v
Native Tool Decision Service -> existing deterministic policy pack

Detection only:
isolated OpenClaw profile -> Docker sandbox -> ephemeral workspace / controlled sink
```

Agent Guard 后端是策略决策点（PDP），OpenClaw 插件是执行点（PEP）。Gateway、插件和 Agent Guard 后端在宿主隔离 profile 中运行；Docker 只承载 agent 原生工具及受控 sink，不包含 OpenClaw 或插件。它是检测阶段的工具隔离层，不是策略引擎，也不把整个 OpenClaw 容器化。

## 6. 插件内执行顺序

### 6.1 Trusted Admission Policy

插件 manifest 在 `contracts.trustedToolPolicies` 声明固定策略 ID，并通过 `registerTrustedToolPolicy` 注册。matcher 省略，使所有标准工具调用进入可信准入检查。

该层只处理不能留给普通 Hook 的状态：

- `OFF`：立即返回，不产生副作用。
- `ACTIVE`：允许继续进入普通 Hook，不在这里提前放行工具。
- `RECOVERY`：高风险和未知工具阻断；明确的只读低风险工具可按租约故障策略处理。
- `REVOKING`：所有尚未完成的 guarded 调用阻断。
- 插件内部状态损坏：fail closed，并返回稳定原因码。

### 6.2 Final `before_tool_call`

普通 Hook 使用固定的低优先级，在受支持的 Hook 组合中最后读取已经过其他普通 Hook 改写的参数，然后执行 Agent Guard 远程裁决。

约束如下：

- 不维护工具名跳过前缀。
- 每次请求使用 OpenClaw 提供的 canonical identity、`toolCallId`、`sessionKey`、`runId`、tool kind、input kind 和 derived paths。
- 计算当前参数 RFC 8785 canonical JSON 的 SHA-256 摘要。
- 收到响应后验证签名、租约、请求 ID、工具身份和参数摘要。
- 返回 `block`、`requireApproval` 或 `params`；不直接执行工具。
- `redact` 和 `ask` 不在同一响应中组合。需要审批的对象始终是最终参数。
- 返回后由 OpenClaw 对最终参数执行工具 schema 校验。

OpenClaw 当前没有公开的“所有普通 Hook 之后再次运行 Trusted Policy”扩展点。因此，第一版的强保证以“其他已安装插件属于受信任基座”为前提，并要求 Agent Guard Hook 是最后一个参数修改者。若预检无法确认兼容 Hook 组合，guarded 模式拒绝启动或明确报告 `coverage=conditional`，不能显示为完整防护。后续应向 OpenClaw 上游提出 post-hook trusted finalizer 能力。

参数输入也依赖同一受信任基座：工具参数内容可以不受信任，但承载对象必须具有宿主提供的、不可由普通 Hook 或调用方伪造的 JSON-only provenance；Agent Guard 之前的其他普通插件必须是 trusted base，不能向参数对象附加 non-enumerable key、symbol、accessor 或其他非 JSON 状态。ECMAScript 没有有界的 own-key 流式枚举接口，因此本地 validator 不能独立证明任意普通对象不存在超量 hidden/symbol fanout。若未来部署不再满足该前提，`ACTIVE` 必须保持 unsupported，直到宿主提供可信 live contract，保证原子执行 Agent Guard 已批准的 clean params snapshot（审批路径也执行同一 snapshot），或提供等价的 JSON-only params contract。

官方对照基线 `3edbe19fbd84ba58fdbf8e83042da9efd1d06f81` 的 Hook、Trusted Policy、service 和 route registrar 均返回 `void`，也不提供上述参数 provenance 或原子 approved-snapshot execution contract，因此只能返回 `coverage=unsupported`、`finalizerAssurance=unverified` 和 `TRUSTED_POLICY_UNATTESTED`，并保留 revoke 作为 marker 清理入口。受控 fork `agentguard/2026.7.1` 固定在 `0cd158ce32d5c53daee74235cf0557fc4d414b17`，已提供显式 live contribution、JSON-only provenance、post-approval lease recheck、fd3 bootstrap 和 Gateway core 签名证明。

插件内 quarantine 不能替代进程外启动门禁。只要存在 guarded marker，而 live registry query 不能同时证明 Agent Guard 插件、final `before_tool_call`、recovery service、可信的 post-approval lease recheck capability，以及 JSON-only provenance 或原子 approved-snapshot execution 参数契约，受管 launcher 必须拒绝正常 Gateway 启动，只开放不调度工具的 maintenance cleanup。参数契约是 post-approval lease recheck 之外的附加门禁，二者都不能来自 config、环境变量或调用方自报。该 launcher 门禁已经实现并通过真实 child 验收；正常用法为 `node --import tsx scripts/openclaw-guard-launcher.ts -- gateway run ...`，maintenance 模式不 spawn child。

### 6.3 `after_tool_call`

- 记录实际 result/error/duration 和最终参数摘要。失败诊断保留 UTF-8 安全的 4 KiB 脱敏文本，而不是固定占位符；过滤通用 token/cookie/bearer/private-key 模式以及当前和原 epoch 的 decision/evidence credential。
- `durationSource="host"` 表示 OpenClaw SDK 明确提供的 `durationMs`。SDK 缺失该值时，插件使用从 Agent Guard 为调用建立 outcome correlation 到 `after_tool_call` 的有界非负单调经过时间并标记 `guard_elapsed`；该值在 `ask` 路径包含人工审批等待，不得解释为纯工具执行耗时。若旧调用没有 correlation，则标记 `unavailable` 并省略 `durationMs`，不能填 0；旧持久化事件迁移为 `legacy_unspecified`。
- 结果正文默认只保留脱敏后的有界预览；完整正文不进入普通审计事件。
- 上报失败写入有界 spool，按事件 ID 幂等重试。
- spool 默认位于 marker/profile 目录下，并在 activation 写 marker 前用 exclusive-create 获取单 owner。owner 文件为有界 mode-`0600` JSON，包含 PID 和随机 token；symlink 或 live PID 冲突 fail closed，既有 ancestor symlink 也拒绝，dead PID 通过带 PID/token recovery gate 的隔离重命名恢复，释放时必须把 canonical owner 原子移到私有 quarantine 并匹配 token。释放失败只重试私有 inode，不回头搬运 replacement owner；完整 corrupt/oversized data 原子 quarantine 后重建空 spool，并只发固定 reason 的本地诊断。OFF 不创建 spool、目录或 owner 文件。
- 新事件必须把 `leaseEpoch` 放在事件顶层。仅对已有持久化数据兼容 `detail.leaseEpoch`：校验通过后迁移到顶层并原子重写；缺失或非安全整数的旧值不能被推断或补造。
- 续租后使用当前 evidence credential 重试同一租约的旧 epoch 事件，不改写事件身份。已结束子会话的绑定只保留为该租约生命周期内的历史证据授权，不能继续用于决策。
- 所有 ACTIVE 可执行返回（签名 allow/warn/redact/可执行 ask，以及低风险 PDP 故障 allow/warn）都先建立包含原 lease/epoch/session/参数摘要和单调基准的 outcome correlation。after 一开始原子取出一次；随后发生 renew 或 child end 仍按原身份入 spool。容量满时保留已有长工具 correlation 并阻断新的可执行返回，不淘汰旧项。
- spool 达到上限时丢弃最旧的低价值 outcome 事件，但保留 deny、ask、错误和状态转换事件。
- outcome 投影的 256 KiB 预算覆盖 escaped key、引号、冒号、逗号、括号和投影值，先完成有界投影再 canonicalize 和计算 digest。超长字符串先截取有界前缀和秘密重叠窗口再脱敏；未闭合的 OpenSSH/PKCS8 私钥标记脱敏到有界 EOF。
- Hook 不因审计服务短暂不可用改变已经完成的工具结果。

## 7. 租约模型

### 7.1 租约字段

```typescript
type NativeGuardLease = {
  schemaVersion: "native-guard-1";
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  mode: "detection" | "supervision";
  scope: "session_tree";
  policyPackId: string;
  policyPackDigest: string;
  backendUrl: string;
  decisionPublicKey: string;
  failurePolicy: {
    lowRisk: "allow" | "warn";
    highRisk: "deny";
    unknownRisk: "deny";
  };
  issuedAt: string;
  expiresAt: string;
  credential: string;
  evidenceCredential: string;
  evidenceSigningKeyId: string;
  evidenceSigningPrivateKey: string;
};
```

`credential` 和 `evidenceCredential` 是两个独立的至少 256 bit 随机值。前者只能调用 decision endpoint；后者只是 evidence 请求的第一因子，不能脱离 proof 单独授权 event ingest 或 session lifecycle。每个 epoch 另生成 Ed25519 evidence signing identity：插件内存持有私钥，后端只持有公钥。bearer、evidence 私钥都不进入日志、Trace、报告、URL、错误消息、spool 或持久化 marker；后端分别保存 bearer 哈希。每次续租同时轮换两个 bearer 和 evidence signing identity，旧身份立即失效。

### 7.2 生命周期

```text
OFF --activate--> ACTIVE --renew--> ACTIVE
                       |                |
                       | gateway restart| renewal failure
                       v                v
                    RECOVERY <----------+
                       |
              reactivate | explicit revoke / expiry
                       v
                 ACTIVE or OFF

ACTIVE --root end ACK + local commit--> ROOT_ENDED --revoke/expiry--> OFF
```

- 默认 TTL 为 5 分钟，最大 TTL 为 15 分钟。
- 后端在租约生命周期过半前续租。
- 检测和受管运行在无法续租时先取消 OpenClaw run，再让租约到期。
- 显式 revoke 或到达 `expiresAt` 后删除 marker 并进入 `OFF`。根会话结束先进入不可续租的 `ROOT_ENDED`，不能直接降为 OFF。
- Gateway 重启后，如果存在尚未过期的 guarded marker 但没有内存凭据，则进入 `RECOVERY`。
- `session_end(reason="compaction")` 只是 transcript 生命周期切换，不得删除根会话或子会话 marker；`shutdown` 和 `restart` 同样保留 marker。
- `OFF` 只表示从未启用、已显式停用或租约已经到期；这些状态不得调用 Agent Guard。`ROOT_ENDED` 对 root 和既有 descendants 返回固定 `NATIVE_GUARD_ROOT_ENDED` block，但允许同租约晚到 evidence 在到期前排空。

子会话 bind/end 使用持久化三阶段 FIFO：先原子追加 lifecycle operation，再同步后端，最后在同一 marker 事务中提交本地树变化并弹出队首。每个队首在联网前持久化不含秘密的 signed evidence proof；验证先 reserve exact proof，mutation/ACK/append 失败只 release 匹配 reservation，成功 signed ACK commit；失败或重启后重放完全相同的 proof。FIFO 最多 128 项且受 64 KiB marker 上限约束；overflow 状态即使在已接受队列排空后仍保持 fail closed，只有 revoke 清除。队列、overflow 或任一步失败都会让整个租约进入 `LIFECYCLE_PENDING`。root end 是 terminal barrier，成功后写 durable tombstone，不能被续租或后续队列操作复活；marker 带已知的 top-level `leaseEpoch`，legacy 无 epoch 时保持 RECOVERY，不虚构 tombstone。公开 status 不返回队列中的 session key、proof 或其他细节。

该定义保留“租约到期后 OpenClaw 恢复正常”的要求，同时在尚未到期的异常重启窗口内避免静默失守。

### 7.3 会话树

- `rootSessionKey` 必须由 Agent Guard 使用不可预测的 run ID 创建。
- `subagent_spawned` 事件中的 child session 继承父租约、到期时间和策略摘要。
- 子会话不能延长根租约，也不能替换策略包。
- 无法证明父子关系的 session 不继承租约。
- 检测结束、取消或 revoke 时递归清除所有派生绑定。
- 决策鉴权只接受当前 epoch 的 live session binding。child end 后，后端保留 lease-scoped historical binding 仅用于接收该 child 已产生的旧 epoch evidence；renew 后当前 evidence identity 可完成重试，decision identity、旧 evidence identity 及历史 binding 均不能获得执行权。

### 7.4 激活通道

Agent Guard 通过插件注册的 OpenClaw HTTP route 主动下发、续租和撤销租约。route 使用 OpenClaw `auth: "gateway"`，不开放匿名激活。插件反向同步子会话生命周期时，只能从已验证的 loopback decision URL 派生固定的 `/lifecycle/bind-child` 和 `/lifecycle/end-session` 路径，使用 evidence bearer 加 `X-Agent-Guard-Evidence-Proof`，禁止重定向，并限制连接、proof header、响应体和总超时。proof 使用 `native_guard.evidence_request.v1`，绑定 method、exact path、lease/epoch、canonical body digest、key ID、proof ID 和 issued time。

后端对通过 proof 的 lifecycle/event 成功响应使用 lease decision key 签署 `native_guard.evidence_ack.v1`。生命周期 ACK 绑定 proof/body/type；事件 ACK 还绑定 accepted count 和有序 event-ID digest。插件不接受 unsigned 或字段被改写的成功响应。所有 completed lifecycle ACK 都可用完全相同的 signed proof/path/body 幂等读取，child bind/end 仍必须提供当前 evidence bearer。根结束在后端已提交但插件丢失响应时，可以不带 bearer 读取 exact root-end ACK；这是唯一的 bearer-less evidence 恢复例外，不接受新 proof，不重复改变状态。cache 每 lease 最多 4,096 项并随 lease expiry/revoke/renew 清除。Event upload 每次 retry 生成 fresh proof，重复持久化由 event ID 幂等处理，不使用 lifecycle ACK cache。

插件不通过轮询判断是否启用，因此 `OFF` 状态没有 Agent Guard 网络依赖。`backendUrl` 第一版必须解析为 `127.0.0.1`、`::1` 或明确允许的 loopback 主机，禁止重定向。

## 8. 决策协议

### 8.1 请求

```typescript
type NativeToolDecisionRequest = {
  schemaVersion: "native-guard-1";
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  sessionKey: string;
  runId?: string;
  toolCallId: string;
  toolName: string;
  toolKind?: string;
  toolInputKind?: string;
  providerId?: string;
  params: Record<string, unknown>;
  paramsDigest: string;
  derivedPaths?: string[];
  requestedAt: string;
};
```

请求使用 `Authorization: Bearer <lease credential>`。后端验证凭据哈希、租约有效期、会话树绑定、策略摘要、请求体大小和时间偏差。

### 8.2 响应

```typescript
type NativeToolDecisionResponse = {
  schemaVersion: "native-guard-1";
  decisionId: string;
  requestId: string;
  leaseId: string;
  leaseEpoch: number;
  policyPackId: string;
  policyPackDigest: string;
  action: "allow" | "warn" | "deny" | "ask" | "redact";
  reasonCode: string;
  reason: string;
  evaluatedParamsDigest: string;
  rewrittenParams?: Record<string, unknown>;
  rewrittenParamsDigest?: string;
  decidedAt: string;
  signature: string;
};
```

响应使用租约内固定的 Ed25519 公钥验证。签名覆盖除 `signature` 外的完整 canonical JSON。以下任一情况均视为无效响应：

- 字段缺失、未知 action 或 schema 不兼容。
- 请求、租约、策略包或参数摘要不匹配。
- 响应签名错误。
- `redact` 缺少改写参数或改写摘要。
- 非 `redact` 响应携带改写参数。
- 决策时间超出允许偏差。

无效响应按 Agent Guard 不可用处理，绝不默认为 allow。

### 8.3 防重放与幂等

- `requestId`、`decisionId` 和 `toolCallId` 在租约内唯一。
- 后端对重复的同摘要请求返回同一决定；同 request ID 不同摘要直接拒绝。
- 插件只接受当前 in-flight 请求对应的响应。
- revoke 或租约 epoch 变化后，旧的 in-flight allow、redact 和审批结果全部失效。

## 9. 策略语义

### 9.1 决策优先级

继续使用现有顺序：

```text
deny > ask > redact > warn > allow
```

租约激活前必须解析出确切的 `policyPackId` 和 `policyPackDigest`。没有策略包、策略包为空、解析失败或运行时摘要变化时不允许创建租约。

### 9.2 工具映射

- 不以固定工具名列表作为唯一风险依据。
- 优先使用 OpenClaw canonical tool identity、tool kind、provider、derived paths 和 Agent Guard capability profile。
- 未识别工具归类为 `unknown_side_effect`，在服务故障时按高风险处理。
- MCP 工具即使已经由 Agent Guard Gateway 监督，也进入可信准入检查；是否避免重复 PDP 由可信 provider identity 决定，不能由名称前缀决定。

### 9.3 `redact`

- 后端返回完整的最终参数对象，而不是不受约束的字符串替换。
- 决策记录保存修改字段路径、修改前后摘要和策略 ID，不保存被移除的秘密正文。
- 插件和后端复用 protocol 层的迭代参数 validator：最大深度 32、累计对象键 4,096、canonical UTF-8 最大 256 KiB，字节超限时立即停止，并拒绝危险原型键、accessor、稀疏/定制数组、共享/循环引用、Proxy 和其他非 JSON 值。dense array 必须先根据最小 canonical 大小在 own-key 枚举前拒绝；object 使用剩余累计 key/byte budget 单次有界收集 key，budget 通过后才允许完整 own-key 一致性检查和逐项 descriptor 检查。ACTIVE 输入参数的 trap-free 预扫描必须早于风险分类及任何反射/属性访问，拒绝 Proxy 时不得调用其 trap；OFF 和 RECOVERY 不新增该参数扫描。后端在 request digest/policy 前验证输入，在 rewritten params digest/sign 前再次验证输出。
- 上述本地 key/byte bound 只在宿主已证明 JSON-only provenance 的输入上构成资源边界；它是 supported host contract 内的 defense in depth，不是对任意 JavaScript 对象 hidden/symbol own-key fanout 的独立证明。
- ACTIVE 对可选 `derivedPaths` 不使用 iterator，而是仅从非 Proxy、标准、稠密、无额外键的数组 numeric data descriptor 建立 snapshot；最多 256 项、每项非空且最长 4,096 字符，数组 canonical UTF-8 最多占 64 KiB envelope budget。accessor、自定义 iterator 和超限数组均在不调用用户代码的情况下拒绝。
- `toolKind`/`toolInputKind` 先在 event/context 间规范化：单边存在则保留，双边冲突则阻断；PDP request 与风险分类必须使用同一份规范化 metadata。输入参数和签名改写参数使用同一边界；HTTP 请求体上限保持 320 KiB，即 256 KiB canonical params 加 64 KiB envelope allowance。

### 9.4 `ask`

- 插件返回 OpenClaw 原生 `requireApproval`。
- `allowedDecisions` 仅允许 `allow-once` 和 `deny`；第一版不允许 `allow-always`。
- 固定基线 `3edbe19f` 的 `onResolution` 是 fire-and-forget，宿主不等待回调且回调不能 veto `allow-once`。因此该宿主及任何没有可信、只读 post-approval lease recheck capability attestation 的宿主必须把 `ask` 稳定降级为 `NATIVE_APPROVAL_UNATTESTED` deny，公开覆盖状态保持 `conditional`，不得从 plugin config、环境变量或调用方自报推断能力。
- 未来宿主只有在公开 live capability contract 明确保证审批结束后、工具执行前复查 `leaseId + leaseEpoch + session binding` 时，插件才可返回可执行的 `requireApproval`。构造器 capability seam 仅用于 unit/compat contract；生产注册入口在宿主没有该字段时恒为 false。
- 审批绑定 `leaseId + sessionKey + toolCallId + tool identity + paramsDigest`。
- 缺失、畸形、超时、取消、重启或过期审批全部拒绝。
- 原生工具审批不使用 `AGENT_GUARD_ASK_TIMEOUT=demo_approve`，也不在 Agent Guard `askChannel` 中再次阻塞同一调用。
- Agent Guard 前端若提供批准按钮，必须通过 OpenClaw approval adapter 解决同一个 OpenClaw 审批，而不是修改 Agent Guard 自己的平行状态。

### 9.5 服务故障

| 状态 | 明确低风险 | 高风险或未知 |
| --- | --- | --- |
| OFF | OpenClaw 原样执行 | OpenClaw 原样执行 |
| ACTIVE，PDP 正常 | 按策略 | 按策略 |
| ACTIVE，PDP 超时/不可达 | 按租约内签名故障策略 allow/warn | deny |
| RECOVERY | 按签名故障策略 | deny |
| 检测 Docker 不合格 | 不启动检测 | 不启动检测 |

第一版 Agent Guard fetch 超时为 2 秒，低于 OpenClaw 默认 15 秒 Hook 预算，并使用独立 AbortController 清理请求。

## 10. 检测 Docker 设计

### 10.1 独立运行配置

每个检测批次创建独立目录：

```text
outputs/openclaw-detection/<runGroupId>/
  state/
  workspace-seed/
  workspace-runtime/
  openclaw.json
  sandbox-evidence.json
```

启动 OpenClaw 时显式设置独立的 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 和 `OPENCLAW_WORKSPACE_DIR`。不得修改或恢复用户的全局 `~/.openclaw/openclaw.json`。

### 10.2 强制配置

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        scope: "session",
        backend: "docker",
        workspaceAccess: "ro",
        docker: {
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          capDrop: ["ALL"]
        }
      }
    }
  }
}
```

补充约束：

- 当前工具镜像固定为 `openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38`，禁止 `latest`。镜像由 `scripts/build-openclaw-sandbox.ps1` 从固定 base 构建；镜像不包含 OpenClaw fork 或 Agent Guard 插件，只提供 non-root、`python3`、`sh`、`timeout` 和只读文件系统友好的工具运行环境。
- OpenClaw Gateway 与插件在宿主隔离 profile 中运行；agent 原生工具进入 Docker。该边界符合“不把整个 OpenClaw 容器化”的设计目标。
- 容器使用非 root 用户、`no-new-privileges`、CPU/内存/PID/时长限制。
- 禁止 Docker socket、宿主秘密目录和任意外部 bind mount。
- 工作区默认只读；需要验证写行为的 case 使用容器内临时副本，不回写宿主。
- 默认无网络。网络型 case 接入没有 Internet 路由的模拟 sink 网络，并记录 sink 收到的请求。
- Browser 默认禁用。启用时必须使用独立受控网络、限制 CDP 来源并保持 `allowHostControl=false`。
- Elevated、host exec、未知原生插件工具和未授权 MCP 工具在检测配置中禁用。
- 失败、取消和进程崩溃后按 run label 清理残留容器和临时目录。

### 10.3 三次验证

检测不能只相信静态配置：

1. 启动前运行 Docker daemon、镜像 digest 和 OpenClaw capability preflight。
2. 会话启动后读取 `openclaw sandbox explain --session <key>`，验证有效配置。
3. 会话结果检查 OpenClaw meta、容器 ID、network、mount、capabilities 和实际 canary 行为。

任一次验证失败都将检测标记为 `sandbox_preflight_failed` 或 `sandbox_attestation_failed`，不得继续生成“安全检测完成”的结论。

最终验收同时覆盖 default `network=none` 与 controlled sink 网络。两者均在 required Docker gate 中通过；controlled sink 可达但无 Internet 路由，宿主 canary 不可读也不可写，Docker socket 不可达，清理后残留容器和网络计数为 0。

## 11. 后端组件

### 11.1 Native Guard Lease Service

负责创建、续租、撤销、live 会话树绑定、lease-scoped 历史证据绑定、两类凭据哈希、decision signing key、evidence public key、proof replay window、root tombstone 和 exact root-ACK cache。决策只读取 live binding；证据可读取 live、root-ended 或仍在同一租约生命周期内的 historical binding。原始凭据与私钥只驻留对应进程内存；服务重启后旧租约不可恢复，OpenClaw 插件在尚未过期的 marker 窗口进入 recovery。

### 11.2 OpenClaw Control Client

使用 OpenClaw Gateway auth 调用插件的 activate、renew、revoke 和 status route。所有操作带幂等 key，严格限制 loopback URL，不跟随重定向，并对响应设置大小上限。

### 11.3 Native Tool Decision Service

将 OpenClaw 事件归一化为现有 `SupervisionRuntimeAction`，复用确定性 policy pack，生成单一最高优先级决定并签名。该服务不调用 LLM。

### 11.4 Native Event Ingestor

验证 evidence credential、事件顶层 `leaseEpoch`、live/historical session evidence binding、事件 schema、事件 ID 和内容上限，将 before decision、approval resolution、blocked outcome 和 after outcome 写入统一监督记录。当前 evidence identity 可提交同一 lease 的旧 epoch evidence；重复事件不重复计数。旧 `detail.leaseEpoch` 仅在可验证时迁移并原子重写，不能为无 epoch 事件发明身份。

### 11.5 Detection Sandbox Manager

管理独立 OpenClaw profile、Docker 预检、配置生成、会话证明、取消和清理。`runOpenClawSession` 必须在 spawn 前获得有效 detection lease 和 sandbox attestation。

## 12. API 与本地安全

新增接口分为四类：

| 接口类别 | 调用方 | 鉴权 |
| --- | --- | --- |
| Agent Guard 管理接口 | UI / detection orchestrator | 操作员控制令牌和受限 Origin |
| OpenClaw 插件控制接口 | Agent Guard 后端 | OpenClaw Gateway auth |
| decision | OpenClaw 插件 | decision bearer；响应额外使用 Ed25519 签名 |
| event ingest / session lifecycle | OpenClaw 插件 | 独立 evidence bearer + per-epoch Ed25519 PoP；成功 ACK 由 decision key 签名 |

共同要求：

- Agent Guard 继续默认绑定 loopback。
- 原生防护端点使用精确 CORS allowlist，不接受任意 Origin。
- 请求使用 JSON schema、独立 body limit、超时和每租约速率限制。
- 日志对 Authorization、credential、私钥、完整参数和工具结果做 redact。
- 错误响应只返回稳定 reason code，不回显秘密或后端正文。
- 健康检查不泄露活跃 session key、策略内容或凭据状态。

## 13. 事件与证据

### 13.1 事件类型

- `native_guard.lease_activated`
- `native_guard.lease_renewed`
- `native_guard.lease_recovery`
- `native_guard.lease_revoked`
- `native_guard.decision`
- `native_guard.approval_requested`
- `native_guard.approval_resolved`
- `native_guard.tool_outcome`
- `native_guard.sandbox_attested`
- `native_guard.coverage_changed`

### 13.2 关联键

```text
runGroupId -> runtimeSessionId -> leaseId -> sessionKey -> toolCallId
           -> decisionId -> approvalId? -> outcomeEventId?
```

正式防御报告只把含有效 Hook 来源、参数摘要和实际 outcome 的记录称为原生工具监督证据。JSONL 解析得到的调用用于交叉校验：

- Hook 有事件、JSONL 有调用：完整证据。
- Hook deny、JSONL 无实际结果：符合预期。
- JSONL 有调用、Hook 无对应 before：coverage breach，检测或监督运行失败。
- Hook allow、无 after 且无取消/错误：incomplete evidence，不能计入成功执行。

## 14. 兼容性与覆盖状态

### 14.1 最低能力

guarded 模式要求 OpenClaw 提供：

- `registerTrustedToolPolicy`
- `before_tool_call` 的 `block`、`params` 和 `requireApproval`
- `after_tool_call` 的 result/error/duration
- `toolCallId`、`sessionKey` 和 run context
- 插件 Gateway HTTP route 及 gateway auth
- Docker sandbox `mode=all`、`scope=session` 和 `sandbox explain`

官方能力研究对照固定在 OpenClaw `2026.7.2` / `3edbe19f`；最终真实验收固定在受控 fork `0cd158ce32d5c53daee74235cf0557fc4d414b17`，并使用 capability preflight，而不是只根据版本字符串推断。

capability preflight 必须校验 Agent Guard 插件状态，以及 registry 输出的顶层 `diagnostics` 和 `registry.diagnostics`。Agent Guard 自身的 error 状态，或涉及其 route、service、Trusted Policy、Hook 的 error diagnostic，均强制 `supportsNativeGuard=false` 和 `finalizerAssurance=unverified`；畸形或超限 diagnostic 输出按无能力处理。warning 和无关插件 error 不得误杀。普通 manifest/snapshot CLI 输出不是 live contribution attestation；真实 gate 必须使用受控 fork 的 production inspector，并验证 host-produced live registry contract。

### 14.2 覆盖状态

```text
off
ready
active
recovery
conditional
unsupported
misconfigured
```

- `off`：没有租约，OpenClaw 正常透传。
- `ready`：插件与能力可用，但没有活跃租约。
- `active`：租约、策略和 Hook 证明均有效。
- `recovery`：存在未到期 marker，但凭据或后端连接需要恢复。
- `conditional`：存在无法确认顺序的参数改写 Hook 或非覆盖插件执行面。
- `unsupported`：OpenClaw 缺少必要能力。
- `misconfigured`：插件、鉴权、策略或 Docker 配置错误。

只有 `active` 可以在 UI 和报告中显示“原生工具完整监督”。

## 15. 错误处理

| 故障 | 行为 |
| --- | --- |
| 无租约 | 立即透传，无网络和审计 |
| 激活失败 | 不启动 guarded run，OpenClaw 其他会话不受影响 |
| PDP 2 秒超时 | 高风险/未知 deny；低风险按签名故障策略 |
| 响应签名或摘要错误 | 视为 PDP 故障并记录安全告警 |
| 参数被后续 Hook 改写 | 兼容性测试失败；运行标记 coverage breach |
| 审批超时/缺失/格式错误 | deny |
| lease revoke 与调用并发 | 返回前复查 epoch，旧决定失效 |
| child bind/end 同步或 marker 提交失败 | 持久化 intent，整个租约进入 lifecycle pending 并阻断所有工具，重启后重放 |
| lifecycle FIFO 超限 | 持久化 overflow，排空已有队列后仍阻断，直到 revoke |
| lifecycle ACK 丢失 | child bind/end 需当前 bearer + exact proof/path/body；root end 可 exact bearer-less；其他请求 401 且零 mutation |
| root end 本地提交成功 | durable root tombstone 阻断 root/children；晚到 evidence 可排空，revoke/expiry 后 OFF |
| after 上报失败 | 写入有界 spool，不改变工具已完成结果 |
| spool 损坏 | 隔离损坏文件，保留高等级本地告警 |
| Docker daemon/image 不可用 | 检测拒绝启动 |
| sandbox explain 与预期不符 | 立即取消检测并清理 |
| OpenClaw Gateway 重启 | 未到期 guarded session 进入 recovery |
| 官方对照基线 registrar 无 live attestation | activate/renew 返回稳定 503；只允许 revoke/maintenance cleanup |
| marker 存在但 live registry 无法证明插件、final Hook、recovery service | launcher 拒绝正常 Gateway 启动，不调度任何工具 |
| Gateway fd3 bootstrap 超过 60 秒，或 readiness 超过随后独立的 120 秒绝对截止时间 | 终止 child，撤销 credentials，检测失败 |

## 16. 测试策略

### 16.1 单元测试

- Lease 的 activate、renew、revoke、expiry、recovery 和 session tree 状态转换。
- RFC 8785 摘要、Ed25519 签名、畸形响应、重放和 epoch 失效。
- OpenClaw 工具身份归一化和 unknown 风险分类。
- 策略优先级、嵌套 redact、安全正则和默认动作。
- outcome 限长、秘密过滤、spool 上限及幂等出队。
- renew/child-end 与 fire-and-forget after 的竞态保持原 epoch outcome；revoke 后 lazy spool 不启动上传或重试。
- host/guard-elapsed/unavailable/legacy duration source 合同，以及错误诊断的 4 KiB UTF-8 边界和秘密过滤。
- 双凭据隔离、续租轮换、旧 epoch evidence 重试和历史子会话 evidence-only binding。
- PoP 篡改/重放/轮换、signed lifecycle/event ACK、延迟 exact root-ACK 恢复和不同 proof/body 的零 mutation 拒绝。
- spool 单 owner、跨进程争用、dead PID 恢复、token-matching release、OFF 零文件系统，以及 lifecycle FIFO/overflow/root tombstone 重启。
- lifecycle intent 的写入、后端确认、本地提交、失败阻断及重启重放。
- 顶层 `leaseEpoch` 强制校验和可验证 legacy epoch 的原子迁移。

### 16.2 插件契约测试

- 无租约时所有工具返回 `undefined`，fetch、日志和事件函数调用次数为零。
- Trusted Policy matcher 覆盖 core、plugin、MCP 和未知工具名。
- final Hook 看到前序 Hook 改写后的参数。
- deny 不产生工具副作用。
- redact 的实际执行参数等于已签名参数。
- ask 仅支持 allow-once/deny，并绑定参数摘要。
- Hook 超时时 Agent Guard 自有 fetch 已取消。
- 子 Agent 继承和清理正确。
- 子 Agent bind 必须在任何 signed allow 前完成后端同步；pending intent 时低风险工具同样阻断。

### 16.3 后端集成测试

- Fastify `inject()` 验证三类鉴权、CORS、body limit 和错误码。
- 无策略包不能激活租约。
- 不同 session、lease 或参数摘要不能复用决定。
- 决策、审批和 outcome 生成一条一致的监督证据链。
- 原生事件不会重复计入 MCP 监督批次。

### 16.4 Docker 集成测试

- Docker 缺失、daemon 停止或镜像 digest 不符时 fail fast。
- `exec` 的 PID 位于目标容器，不能访问宿主 canary。
- 默认无法访问 Internet、Gateway、Docker socket 或宿主工作区写路径。
- 写入 case 只改变容器临时副本。
- 受控 sink 能观察外传尝试，但容器没有其他出口。
- Browser/elevated 未经专门配置不可用。
- 取消和崩溃后没有带 run label 的残留容器。

### 16.5 端到端验收场景

1. 插件已安装、Agent Guard 后端关闭、无租约：OpenClaw 的 read/write/exec 行为与未安装插件一致。
2. ACTIVE + allow：工具执行一次，before/after 可关联。
3. ACTIVE + deny：工具副作用为零。
4. ACTIVE + redact：真实工具只收到改写后参数。
5. ACTIVE + ask：批准一次后执行；拒绝、超时、取消均不执行。
6. ACTIVE + PDP 故障：高风险和 unknown 阻断，低风险符合故障策略。
7. Gateway 重启：未到期会话进入 recovery，不静默透传高风险工具。
8. 子 Agent：继承父租约，不能通过新 sessionKey 绕过。
9. 名称伪装：`agent_guard__exec` 等名称仍进入可信准入。
10. 冲突 Hook：无法确认最终参数时不能宣称完整覆盖。
11. Detection：Docker 不合格时零攻击样例执行。
12. Detection：合格时危险行为只影响临时容器环境。
13. Trace reconciliation：任何 JSONL 原生调用缺少 before 事件都会使运行失败。
14. 固定 `void` registrar 宿主：所有贡献即使被调用也不能新建或续租 guarded lease，状态保持 `unsupported/unverified`，revoke 仍可清理 marker。
15. 启动恢复：存在 guarded marker 且 live registry 缺少插件、final Hook、recovery service、可信 post-approval lease recheck capability，或 JSON-only provenance / 原子 approved-snapshot execution 参数契约任一必要证明时，launcher 零工具调度并只开放 maintenance cleanup。

## 17. 性能与容量指标

- OFF 状态不产生网络请求，Hook 本地判断 p95 小于 1 ms。
- ACTIVE 非审批决策的本机端到端 p95 小于 100 ms。
- Agent Guard fetch 超时 2 秒，OpenClaw Hook 总预算保持不低于 5 秒且低于其 15 秒默认上限。
- 单个 canonical 参数对象默认上限 256 KiB，decision HTTP 信封另预留 64 KiB，工具结果预览默认上限 8 KiB。
- spool 默认上限 10,000 个事件或 50 MiB，先到者生效。
- lifecycle FIFO 默认最多 128 项，并与 proof、tombstone 共同受 64 KiB marker 上限约束。
- evidence proof replay 集和 completed lifecycle ACK cache 每 lease 分别最多 4,096 项；普通 proof 接受窗口为 30 秒，cache 随 lease renewal/revoke/expiry 删除。
- 同一租约的 decision endpoint 必须限制并发和速率，但不能让低风险洪泛饿死高风险裁决。

## 18. 上线顺序

1. 固定 OpenClaw 兼容基线并完成 Hook 顺序、审批和 HTTP route 契约测试。
2. 实现共享协议、租约服务、签名和后端 decision/event 接口。
3. 实现插件 Trusted Policy、final Hook、after reporter、recovery 和子 Agent 继承。
4. 将检测编排迁移到独立 OpenClaw profile，并固化 Docker 三次验证。
5. 用真实 Hook 事件替换正式 Trace 的事后回放来源，保留 JSONL reconciliation。
6. 接入覆盖状态、租约控制、审批镜像和 sandbox evidence UI。
7. 完成 OFF 回归、故障注入、Docker live 和端到端验收后再默认展示该能力。

任何阶段均不得让“安装插件”自动等于“启用 Agent Guard”。上线默认状态必须是 `ready` 或 `off`。

## 19. 已确定的设计决策

- 检测阶段强制 Docker，监督阶段默认不使用 Docker。
- 所有 OpenClaw 标准工具调用进入可信准入管线，不使用工具名前缀跳过。
- 使用 Trusted Policy 做硬准入，普通 `before_tool_call` 做最终参数裁决。
- 使用会话树范围的短期可续租 lease，OFF 状态纯透传。
- decision 与 evidence 使用独立且随续租轮换的 bearer；evidence 还要求每 epoch 轮换的 Ed25519 PoP，所有成功 ACK 必须由 decision key 签名。历史子会话绑定只能上传同一租约的既有证据。
- 子会话生命周期使用 durable FIFO 和持久化 exact proof；本地与后端未共同提交、队列 overflow 或 root tombstone 存在时保持 fail closed。
- 使用 OpenClaw 原生审批，不复用平行阻塞状态机。
- 高风险和未知工具在 ACTIVE/RECOVERY 的 PDP 故障下 fail closed。
- 检测使用独立 OpenClaw profile，不修改用户全局配置。
- 决策使用 Ed25519 签名，租约凭据不持久化。
- 正式证据来自真实 before/after，JSONL 只作交叉校验。
- 不把 OpenClaw 原生插件代码或 Gateway 本身误称为 Docker 已隔离。
- 官方对照 `3edbe19f` 仍为 unsupported/quarantined；Task 14 的进程外 launcher gate、真实 child 绑定和 required Docker gate 已在受控 fork 上完成验收。

## 20. 参考项目与上游依据

- OpenClaw：Trusted Tool Policy、`before_tool_call`、原生审批、Docker sandbox。
- OpenHands、SWE-agent、E2B：隔离运行环境、一次性工作区和执行轨迹。
- LangGraph：durable interrupt 和人工审批恢复。
- OPA、Cedar：策略决策点与执行点分离、结构化决定。
- MCP Servers、ToolHive：外部工具边界和容器化服务管理。
- PyRIT：攻击生成和评分，不作为生产运行时执行点。

主要上游资料：

- <https://github.com/openclaw/openclaw/blob/main/docs/plugins/hooks.md>
- <https://github.com/openclaw/openclaw/blob/main/docs/plugins/manifest.md>
- <https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md>
- <https://github.com/openclaw/openclaw/blob/main/src/plugins/trusted-tool-policy.ts>
- <https://github.com/openclaw/openclaw/blob/main/src/agents/agent-tools.before-tool-call.policy.ts>
