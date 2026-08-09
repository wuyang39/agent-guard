# OpenClaw Fork 实现指南

本文档记录从 OpenClaw `2026.7.1` 创建受控 fork 的最终实现。验收 SHA 为 `d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa`，版本号为 `2026.7.1-agentguard.1`，当前已验收 artifact 位于 `<agent-guard-root>/outputs/openclaw-agentguard-active`。

该 fork 尚未发布，不能从 OpenClaw upstream 或公共 package registry 取得。其他机器必须先导入包含 `.git`、`openclaw.mjs`、`dist` 和 buildstamp 的精确 artifact；不得从 `E:\Projects\openclaw-agentguard` 的移动分支重建后冒充同一验收基线。

## 总览

Fork 需要实现 7 项能力（见 `docs/architecture.md` 7.1.1 节）。
变更分布在 4 个模块：registrar、plugin SDK、Gateway registry、sandbox。

## 1. Registrar 返回 live contribution 结果

**文件**: `src/gateway/registrar.ts`（或等效路径）

**现状**: `registerPlugin()` 返回 `void`。

**变更**:

```typescript
// Before
export function registerPlugin(api: PluginApi): void { ... }

// After
export function registerPlugin(api: PluginApi): RegisterResult {
  const contributions = { hooks: [], services: [], routes: [], policies: [] };
  // ... register and collect contribution status ...
  return {
    status: "live" as const,
    contributions: {
      hooks: contributions.hooks.map(h => h.name),
      services: contributions.services.map(s => s.name),
      routes: contributions.routes.map(r => r.path),
      trustedToolPolicies: contributions.policies.map(p => p.id),
    },
  };
}

export type RegisterResult = {
  status: "live" | "partial" | "failed";
  contributions: {
    hooks: string[];
    services: string[];
    routes: string[];
    trustedToolPolicies: string[];
  };
};
```

**验证**: 插件注册后 `registerPlugin()` 返回 `{ status: "live" }`。

## 2. Plugin SDK: `registerHttpRoute` / `on` / `registerService` 返回 true

**文件**: `src/plugin-sdk/plugin-entry.ts`

**现状**: 部分方法返回 `void`。

**变更**: 所有注册方法返回 `true`（表示 live contribution）:

```typescript
// Before
on(event: string, handler: ...): void

// After  
on(event: string, handler: ...): true
//   当 handler 成功绑定到优先级最高的 hook 链时返回 true。
//   如果已有其他插件注册同优先级 or 绑定失败，抛出错误。
```

## 3. Gateway Registry: `plugins list --json` 输出 liveAttestation

**文件**: `src/gateway/registry.ts`（或等效路径）

**变更**: 在 `plugins list --json` 的 `registry` 对象中添加：

```typescript
{
  "registry": {
    "source": "persisted",
    "diagnostics": [...],
    "liveAttestation": true   // ← 新增
  },
  "plugins": [...]
}
```

`liveAttestation` 为 `true` 当且仅当：
- `agent-guard-supervision` plugin `enabled === true`
- 该 plugin 的 `status === "loaded"`（不是 `"error"` 或 `"disabled"`）
- 该 plugin 的 `hookNames` 包含 `before_tool_call`
- 该 plugin 的 `services` 包含 `agent-guard-runtime`
- 该 plugin 的 manifest `contracts.trustedToolPolicies` 包含 `agent-guard-admission`
- 上述所有贡献都是 live registered（`registerResult.status === "live"`）

## 4. Post-approval lease recheck

**文件**: `src/gateway/hooks/before-tool-call.ts`（或等效路径）

**变更**: 在 `before_tool_call` Hook 链中，`agent-guard-supervision` 的 Hook 必须：

1. 执行正常的 PDP 决策流程（发送到 Agent Guard backend）
2. **PDP 允许后、工具执行前**：再次验证 lease 仍然 active 且未过期
3. 如果 lease 已过期/已撤销 → deny tool call

```typescript
// 在 PDP 返回 allow 后，执行工具前
if (decision.action === "allow") {
  const leaseStatus = await verifyLeaseActive(decision.leaseId);
  if (!leaseStatus.active) {
    return { action: "deny", reason: "lease_expired" };
  }
}
```

## 5. JSON-only params provenance

**文件**: `src/gateway/params.ts`（或等效路径）

**变更**: 在将工具参数传入 Agent Guard PDP 之前：

```typescript
function assertJsonOnlyParams(params: unknown): void {
  const json = JSON.stringify(params);
  // 拒绝二进制 buffer、Stream、Function、Symbol
  JSON.parse(json); // 往返验证
  if (Buffer.byteLength(json, "utf8") > 256 * 1024) {
    throw new Error("Params exceed 256 KiB limit");
  }
}
```

此函数应在 PDP 请求构造时调用。Agent Guard 插件通过 `X-Agent-Guard-Params-Provenance: json-only` header 声明溯源模式。

## 6. Gateway 版本标识

**文件**: `package.json` / 构建脚本

**变更**:

```json
{
  "version": "2026.7.1-agentguard.1"
}
```

`openclaw --version` 必须输出包含 `agentguard` 标识的版本字符串。
Launcher 通过此标识识别兼容 fork。

## 7. Recovery service 注册

**文件**: 无需额外变更（已由 `registerService("agent-guard-runtime", ...)` 覆盖）。

Agent Guard 插件需要在 `registerAgentGuardPlugin()` 中调用
`api.registerService("agent-guard-runtime", { start, stop })`。
插件已实现此逻辑（见 `plugins/agent-guard-supervision/src/index.ts`）。

## 8. Gateway Core 进程身份与签名证明

这部分必须在 OpenClaw Gateway core 实现，不能由插件注册、自报或覆盖。Bearer token 只证明调用者知道 Gateway 凭据，不能证明监听该端口的进程就是刚刚启动的 OpenClaw child。

### 8.1 fd3 bootstrap

Agent Guard 启动 Gateway 时会设置：

```text
OPENCLAW_NATIVE_GUARD_BOOTSTRAP_FD=3
OPENCLAW_NATIVE_GUARD_BOOTSTRAP_CONTRACT=native-guard-bootstrap-1
```

并将 child fd3 配置为专用 pipe。每次 `startGatewayServer` 必须：

1. 生成新的 Ed25519 keypair，不得跨 Gateway 实例或重启复用。
2. 在加载插件、监听端口或报告 ready 之前，向 fd3 写入且只写入一行 JSON，然后关闭 fd3。
3. private key 只保留在当前 server 实例内存，不能写入环境变量、配置、日志、插件上下文或磁盘。

```json
{"contractVersion":"native-guard-bootstrap-1","attestationPublicKey":"<canonical base64 DER SPKI>"}
```

约束：完整输出不超过 8 KiB；必须单行、以 `\n` 结束并立即 EOF；字段必须 exact；`attestationPublicKey` 必须是规范 base64 DER SPKI，解析后必须是 Ed25519 public key。缺少 fd3 或写入失败时 Gateway 必须启动失败。

### 8.2 reserved core route

Gateway core 保留以下路径，插件 registrar 必须拒绝任何相同 exact/prefix route：

```text
POST /agent-guard/native-guard/v1/gateway-attestation
```

该 route 使用正常 Gateway bearer auth，拒绝 redirect、`Content-Encoding`、非 JSON body、超限 body 和非 32 字符 base64url challenge。响应 exact schema：

```json
{
  "contractVersion": "native-guard-gateway-1",
  "signatureContext": "native_guard.gateway_attestation.v1",
  "challenge": "<request challenge>",
  "gatewayUrl": "http://127.0.0.1:<actual-port>",
  "gatewayInstanceId": "<fresh per-server id>",
  "openclawVersion": "<build VERSION>",
  "nativeGuard": { "contractVersion": "native-guard-1" },
  "signature": "<Ed25519 base64url signature>"
}
```

签名 payload 是除 `signature` 外的全部字段，使用 `@agent-guard/native-guard-protocol` 的 canonical JSON 与 Ed25519 规则，或实现逐字节兼容算法。`openclawVersion` 必须来自构建产物 `VERSION`，不能来自插件或请求；`gatewayInstanceId` 必须由当前 server 创建；`nativeGuard` 必须来自当前进程的 active live registry 快照。

端口上的进程即使获得 bearer token 和 fresh challenge，只要没有 fd3 对应的 private key，其 unsigned、wrong-key 或篡改响应都必须被 Agent Guard 拒绝。

### 8.3 检测期进程生命周期

bootstrap 与签名证明绑定的是一个具体 Gateway server generation，不是对端口的永久授权。该 child 必须在整个检测、lease 操作、样本执行和事后 attestation 期间持续存活：

- launcher 必须为实际 spawn 的 child 暴露唯一、稳定的 completion promise；`close`、`exit`、spawn error 或 promise rejection 都必须可观察。
- Agent Guard 在签名 attestation 通过后仍持续监听该 promise。非 cleanup 阶段的任何结束都会立即撤销内存中的 Gateway credentials、abort 当前检测 signal，并以稳定的 `GATEWAY_EXITED` 失败整个 run。
- 当前样本必须等待 abort 后收敛，后续样本不得启动；端口随后被知道 bearer token 的进程接管也不能恢复信任。
- cleanup 在发送 `SIGTERM` 前将当前 generation 标记为 expected shutdown。旧 generation 的迟到 exit 不得污染后来创建的新 generation。
- 每个新 generation 必须重新生成 keypair 和 `gatewayInstanceId`，重新完成 fd3 bootstrap 与 signed HTTP attestation。

## 信任模型

Agent Guard 对 fork 的信任由四项证明共同建立：

| 证明 | 来源 | 验证点 |
|---|---|---|
| **Fork 标识** | `openclaw --version` 含 `agentguard` | `detectionSandboxManager.preflight()` |
| **Live attestation** | `plugins list --json` 中 `registry.liveAttestation: true` | Launcher + capability probe |
| **进程身份** | fd3 bootstrap 公钥 + core route Ed25519 签名 | `detectionSandboxManager.start()` |
| **不可变镜像 digest** | `AGENT_GUARD_DETECTION_IMAGE=...@sha256:...` | `detectionSandboxManager.preflight()` |

**SemVer 注意事项**：`2026.7.1-agentguard.1` 是 SemVer prerelease。
版本解析要求规范且安全的数字段；受控 fork 只接受精确标识。因此：

- `2026.7.1-agentguard.1` → base `2026.7.1` → 接受（fork）
- `2026.7.1` 正式版 → base `2026.7.1` → 拒绝（无 fork 标识，需 ≥2026.7.2）
- `2026.7.2` 正式版 → base `2026.7.2` → 接受（官方）

## 运行时部署边界

最终部署不把 fork 或插件装进 Docker 镜像：

```text
host isolated profile
  OpenClaw Gateway (controlled fork)
  Agent Guard plugin
  Agent Guard backend
          |
          v
Docker tool sandbox
  agent native tools
  optional controlled sink
```

Gateway 和插件属于宿主受信基座。Docker 镜像只隔离 agent 原生工具副作用。这与设计目标“不把整个 OpenClaw 容器化”一致。

## 已验收 artifact 与导入检查

```powershell
$ErrorActionPreference = "Stop"
$agentGuardRoot = (Get-Location).Path
$expectedForkSha = "d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa"
$forkRoot = Join-Path $agentGuardRoot "outputs\openclaw-agentguard-active"

if (-not (Test-Path -LiteralPath (Join-Path $forkRoot ".git"))) {
  throw "Exact controlled fork artifact is missing: $forkRoot"
}
$forkHead = (& git -C $forkRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $forkHead -cne $expectedForkSha) {
  throw "OpenClaw fork HEAD mismatch: expected $expectedForkSha, got $forkHead"
}
$buildStamp = Get-Content -Raw (Join-Path $forkRoot "dist\.buildstamp") | ConvertFrom-Json
if ([string]$buildStamp.head -cne $expectedForkSha) {
  throw "OpenClaw buildstamp mismatch: expected $expectedForkSha, got $($buildStamp.head)"
}
if (-not (Test-Path -LiteralPath (Join-Path $forkRoot "openclaw.mjs")) -or
    -not (Test-Path -LiteralPath (Join-Path $forkRoot "dist\cli\native-guard-inspector.js"))) {
  throw "Controlled fork runtime artifacts are incomplete."
}

node -e "const [a,b,c]=process.versions.node.split('.').map(Number);const ok=(a===22&&(b>22||(b===22&&c>=3)))||(a===24&&(b>15||(b===15&&c>=0)))||(a>25)||(a===25&&(b>9||(b===9&&c>=0)));if(!ok){console.error('Unsupported Node '+process.versions.node);process.exit(1)}"
```

fork `package.json` 的精确 Node engines 为 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`。运行入口是 artifact 根目录 `openclaw.mjs`，production capability inspector 是 `dist/cli/native-guard-inspector.js`。HEAD 或 `dist/.buildstamp` 任一不匹配都必须 fail fast。

原始 fork 的正式构建曾使用 `node scripts/build-all.mjs gatewayWatch` 并产生上述 buildstamp，但本验收流程消费固定 artifact，不重新跟随分支构建。禁止以定向 `tsdown --no-config` 产物替换 artifact；它缺少 `dist/extensions`，即使个别 CLI 命令可运行也不构成正式验收基线。

## Agent Guard 集成

```powershell
$profileRoot = Join-Path $agentGuardRoot "outputs\openclaw-native-guard-profile"
$env:OPENCLAW_HOME = $profileRoot
$env:OPENCLAW_CONFIG_PATH = Join-Path $profileRoot "openclaw.json"
$env:OPENCLAW_STATE_DIR = Join-Path $profileRoot "state"
$env:OPENCLAW_WORKSPACE_DIR = Join-Path $profileRoot "workspace"
$env:OPENCLAW_CLI = Join-Path $forkRoot "openclaw.mjs"
$env:TEST_OPENCLAW_AGENTGUARD_CLI = Join-Path $forkRoot "dist\cli\native-guard-inspector.js"
$env:AGENT_GUARD_OPENCLAW_ISOLATED_PROFILE = "1"

New-Item -ItemType Directory -Force -Path $env:OPENCLAW_HOME, $env:OPENCLAW_STATE_DIR, $env:OPENCLAW_WORKSPACE_DIR | Out-Null
if (-not (Test-Path -LiteralPath $env:OPENCLAW_CONFIG_PATH)) {
  Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH -Value "{}" -Encoding utf8
}

.\scripts\install-openclaw-native-guard.ps1 `
  -OpenClawCli $env:OPENCLAW_CLI `
  -OpenClawHome $env:OPENCLAW_HOME `
  -Force
```

`OPENCLAW_CLI` 直接指向 `.mjs`；安装器原生通过 `node` 执行该入口，不需要 wrapper。`OPENCLAW_CLI` 供 launcher spawn 真实 Gateway child，`TEST_OPENCLAW_AGENTGUARD_CLI` 供真实 registry gate 使用；显式 home/config/state/workspace 保证不修改宿主全局 OpenClaw。

正常启动：

```powershell
$gatewayPort = 18789
$env:OPENCLAW_GATEWAY_URL = "http://127.0.0.1:$gatewayPort"
$env:OPENCLAW_GATEWAY_TOKEN = Read-Host "OpenClaw gateway token"
node --import tsx scripts/openclaw-guard-launcher.ts -- `
  gateway run --bind loopback --port $gatewayPort --token $env:OPENCLAW_GATEWAY_TOKEN
```

maintenance cleanup：

```powershell
node --import tsx scripts/openclaw-guard-launcher.ts --maintenance
```

maintenance 模式不接受 child 命令，也不会 spawn OpenClaw。正常模式在通过 marker 和 registry 检查后启动 child，并把检测生命周期绑定到该进程；bootstrap 使用 60 秒绝对截止时间，随后 readiness 使用独立的 120 秒绝对截止时间。

## 工具 Sandbox 镜像

当前本机固定镜像：

```text
openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38
```

`docker/openclaw-sandbox/Dockerfile`、`docker/openclaw-sandbox/README.md` 和 `scripts/build-openclaw-sandbox.ps1` 已提供可重复的本地构建入口。无 registry 的本地 digest 输出要求启用 containerd image store；经典 image store 必须先 push/pull 到受控 registry 或导入已发布 artifact。构建脚本最终输出的 digest 是本机验收的权威引用；不得继续使用被同 tag 重建替换的旧 `dcf6e...` 引用，也不得退回可变 tag。

该 digest 目前只登记在当前机器的 Docker image store，尚未推送到正式 registry。其他机器不能假设可 `docker pull`；必须先导入受控 image artifact 或等待 registry 发布，再用构建脚本输出/`docker image inspect` 验证精确 digest。

镜像要求和已验收属性：

- 用户为 `65532:65532`，适配 readonly rootfs。
- 包含 `python3`、`sh`、`timeout` 和验收所需工具。
- 不包含 OpenClaw、Agent Guard 插件、credentials 或 Docker socket。
- default case 使用 `network=none`。
- controlled case 只能访问内部 sink，不能访问 Internet。

## 最终验收

```powershell
Set-Location $agentGuardRoot
Remove-Item Env:AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP -ErrorAction SilentlyContinue
$env:AGENT_GUARD_DETECTION_IMAGE = "openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38"
npm run verify:native-guard:real
npm run verify:native-guard:docker -- --required
```

`d895b2d...` artifact 已完成正式 targeted build 和 buildstamp 绑定。real registry gate 与新 artifact 的 required Docker default/controlled gate 必须在当前收口工作树 fresh 重跑；旧 `2d55b95...` artifact 的 122.2 秒结果不能外推到新基线。

Agent Guard 最终收口提交：

| Commit | 作用 |
|---|---|
| `5a90814` | launcher 原子接管 Gateway spawn |
| `cba8ada` | default/controlled Docker required gate |
| `22c48dc` | 强制真实 launcher child |
| `6bff05a` | 建立基于绝对 deadline 的 readiness baseline |
| `2230444` | readiness 120 秒/2,400 次对齐、`.mjs` installer、可重建工具镜像与最终操作手册 |

## 完成清单

- [x] Fork commit 固定为 `d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa`。
- [x] 正式 build 与 `dist/.buildstamp` 绑定固定 SHA。
- [x] `registry.liveAttestation === true`。
- [x] fd3 每实例 Ed25519 key、正确签名、wrong-key 和 port-hijack 负例通过。
- [x] attestation route 是插件不可覆盖的 reserved core route。
- [x] launcher 原子 spawn 真实 child，maintenance 不 spawn。
- [x] Dockerfile、README 和本地 build 脚本已提供；脚本输出固定本机 digest。
- [ ] 在 `d895b2d...` artifact 上 fresh 重跑新 `01630c...` digest 的 required Docker default/controlled gate，并证明两轮 cleanup 残留为 0。
- [ ] 推送正式 registry 镜像。
- [ ] 生成并归档 SBOM/provenance。
- [ ] 执行并归档完整人工场景矩阵。
- [ ] 完成最终发布安全评审。

以上未完成项属于比赛外发布硬化，不影响当前比赛实现与真实 gate 的完成结论。

## 安全边界

- `liveAttestation` 只能由 Gateway registrar 的 live registry 生成，插件不能自报。
- Gateway attestation route 由 core 保留，插件不能注册、替换或获得签名私钥。
- Bearer token 不证明进程身份；身份由 fd3 bootstrap、每实例 Ed25519 签名和 child lifetime 共同绑定。
- Agent Guard 在 launcher 和检测 capability probe 两处验证 live attestation。
- Docker 只隔离 agent 原生工具，不覆盖宿主受信插件内部副作用。
