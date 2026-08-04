# OpenClaw Fork 实现指南

本文档描述从 OpenClaw 最新正式版（`2026.7.1`）创建受控 fork
所需的所有代码变更。Fork 版本号 `2026.7.1-agentguard.1`。

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

## 信任模型

Agent Guard 对 fork 的信任由三重证明共同建立：

| 证明 | 来源 | 验证点 |
|---|---|---|
| **Fork 标识** | `openclaw --version` 含 `agentguard` | `detectionSandboxManager.preflight()` |
| **Live attestation** | `plugins list --json` 中 `registry.liveAttestation: true` | Launcher + capability probe |
| **不可变镜像 digest** | `AGENT_GUARD_DETECTION_IMAGE=...@sha256:...` | `detectionSandboxManager.preflight()` |

**SemVer 注意事项**：`2026.7.1-agentguard.1` 是 SemVer prerelease。
`versionAtLeast()` 只提取 `(\d+)\.(\d+)\.(\d+)` 前缀进行数值比较，
fork 标识符 `agentguard` 单独检查。因此：

- `2026.7.1-agentguard.1` → base `2026.7.1` → 接受（fork）
- `2026.7.1` 正式版 → base `2026.7.1` → 拒绝（无 fork 标识，需 ≥2026.7.2）
- `2026.7.2` 正式版 → base `2026.7.2` → 接受（官方）

## Docker 镜像集成

宿主机的 `npm link` 不会进入 Docker 容器。Fork 必须构建进镜像：

```dockerfile
# 在 OpenClaw fork 仓库中
FROM node:22-bookworm-slim AS openclaw-build
COPY . /src
WORKDIR /src
RUN npm ci && npm run build && npm pack --pack-destination /tmp

# Agent Guard 检测镜像
FROM python:3.12-slim
COPY --from=openclaw-build /tmp/openclaw-2026.7.1-agentguard.1.tgz /tmp/
RUN npm install -g /tmp/openclaw-2026.7.1-agentguard.1.tgz
# 安装 Agent Guard 插件到全局 OpenClaw
COPY plugins/agent-guard-supervision/dist /opt/agent-guard/plugin
RUN openclaw config set pluginDirs '["/opt/agent-guard/plugin"]'
USER 65532:65532
```

构建后固定 digest：

```bash
docker build -t openclaw-sandbox:agentguard .
docker push openclaw-sandbox:agentguard
# 记录 digest
docker image inspect openclaw-sandbox:agentguard --format '{{.RepoDigests}}'
```

## 本地测试（隔离模式）

```powershell
# 构建产物直接调用，不覆盖全局 openclaw
node .\dist\cli.js --version
node .\dist\cli.js plugins list --json

# 通过 OPENCLAW_CLI 让 agent-guard 使用 fork
$env:OPENCLAW_CLI = "E:\Projects\openclaw-agentguard\openclaw.cmd"
# 或直接指向 .js（需配合包装脚本）
```

`resolveOpenClawCliPath()` 优先检查 `OPENCLAW_CLI` 环境变量，
因此无需 `npm link` 即可在 agent-guard 项目中测试 fork。

## 构建与验证

```bash
# 在 fork 仓库中
npm install
npm run build

# 验证版本
./bin/openclaw --version
# 预期: openclaw 2026.7.1-agentguard.1 (commit-hash)

# 安装插件后验证 live attestation
openclaw plugins list --json | jq '.registry.liveAttestation'
# 预期: true
```

## 发布清单

- [ ] Fork commit: `_________`
- [ ] Fork 版本: `2026.7.1-agentguard.1`
- [ ] Agent Guard 插件版本: `_________`
- [ ] 镜像 digest: `sha256:_________`
- [ ] `registry.liveAttestation === true`
- [ ] `verify:native-guard:docker` 通过
- [ ] SBOM 生成并归档

## Agent Guard 侧配合变更

### 版本接受

`detectionSandboxManager.ts` 的 `versionAtLeast` 需接受 fork 格式：

```typescript
const REQUIRED_OPENCLAW = [2026, 7, 1] as const;
// 接受 >= 2026.7.1 且包含 agentguard 标识的版本
```

### Launcher 接受 Fork

`scripts/openclaw-guard-launcher.ts` 需接受 fork 的 `liveAttestation` 字段。

### 能力探测

`openclawControlClient.inspectCapabilities()` 已读取 `plugins list --json` 并检查
`liveAttestation`。fork 提供此字段后自动通过。

## 安全边界

- Fork 只改变 plugin SDK 返回值和 registry 输出格式。
- 不改变 tool dispatch、message routing、auth、session 管理等核心路径。
- `liveAttestation` 字段仅由 registrar 在插件注册时设置，不可由插件自身伪造。
- Agent Guard 在启动时（launcher）和检测前（capability probe）双重验证 live attestation。
