# OpenClaw Detection Live Verification Runbook

本文记录 Native Guard 最终真实验收路径。Gateway、Agent Guard 插件和后端运行在宿主隔离 profile；Docker 只运行 agent 原生工具和可选 controlled sink，不把整个 OpenClaw 容器化。

## 固定基线

| 项目 | 固定值 |
|---|---|
| Agent Guard | `6bff05a504738772d82d3f1f5289a21f9b38aeb4` |
| OpenClaw branch | `agentguard/2026.7.1` |
| OpenClaw fork | `2d55b950f357a8186eff433ca666a690d484a8e0` |
| Runtime entrypoint | `<fork-root>/openclaw.mjs` |
| Production inspector | `<fork-root>/dist/cli/native-guard-inspector.js` |
| Tool sandbox image | `openclaw-sandbox@sha256:dcf6e79c5e3f41823c29cffe44103e06c2865ebfcee6434ce5a58f9860975b5d` |

前置条件为 Node.js 20+、可用的 Docker daemon，以及独立的 OpenClaw fork 工作区。宿主全局 OpenClaw 保持不变。

## 1. 构建受控 fork

```powershell
Set-Location E:\Projects\openclaw-agentguard
git switch agentguard/2026.7.1
git rev-parse HEAD
# Expected: 2d55b950f357a8186eff433ca666a690d484a8e0

corepack enable
pnpm install --frozen-lockfile
node scripts/build-all.mjs gatewayWatch

Get-Content .\dist\.buildstamp
Test-Path .\openclaw.mjs
Test-Path .\dist\cli\native-guard-inspector.js
```

`dist/.buildstamp` 必须绑定上述 fork SHA。正式验收禁止使用定向 `tsdown --no-config` 代替该构建；这种产物缺少 `dist/extensions`，Gateway 会卡在启动阶段，不能作为验收证据。

## 2. 选择运行入口

```powershell
$forkRoot = "E:\Projects\openclaw-agentguard"
$env:OPENCLAW_CLI = "$forkRoot\openclaw.mjs"
$env:TEST_OPENCLAW_AGENTGUARD_CLI = "$forkRoot\dist\cli\native-guard-inspector.js"

node $env:OPENCLAW_CLI --version
node $env:TEST_OPENCLAW_AGENTGUARD_CLI --version
```

`OPENCLAW_CLI` 是真实 Gateway child 入口。`TEST_OPENCLAW_AGENTGUARD_CLI` 是 production live-registry inspector，不能用测试 stub 或旧的单文件 CLI 产物替代。

## 3. 构建并安装插件

```powershell
Set-Location E:\Projects\agent-guard
npm ci
npm run build:openclaw-plugin
.\scripts\install-openclaw-native-guard.ps1
```

安装和检测使用独立 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH` 与 workspace；不要修改用户全局 profile。

## 4. 验证工具 sandbox 镜像

```powershell
$env:AGENT_GUARD_DETECTION_IMAGE = "openclaw-sandbox@sha256:dcf6e79c5e3f41823c29cffe44103e06c2865ebfcee6434ce5a58f9860975b5d"
docker image inspect $env:AGENT_GUARD_DETECTION_IMAGE --format '{{.Id}}'
docker run --rm --read-only --user 65532:65532 --network none --entrypoint sh $env:AGENT_GUARD_DETECTION_IMAGE -c "id -u; python3 --version; command -v timeout"
```

该镜像是纯工具 sandbox：non-root，包含 `python3`、`sh`、`timeout`，适配只读 rootfs；不包含 OpenClaw fork 或 Agent Guard 插件。Gateway 与插件继续在宿主隔离 profile 中运行。

## 5. 通过 launcher 启动 Gateway

正常 guarded 启动必须把 child 命令放在 `--` 后：

```powershell
node --import tsx scripts/openclaw-guard-launcher.ts -- gateway run --bind loopback --port <port> --token <token>
```

launcher 在检查 marker 和 live registry 后原子 spawn 真实 Gateway child，并传递退出状态。fd3 bootstrap、签名 attestation 与 child completion 将检测绑定到同一 generation。bootstrap/readiness 使用一个 60 秒绝对截止时间。

maintenance 只做进程外清理，不启动 OpenClaw：

```powershell
node --import tsx scripts/openclaw-guard-launcher.ts --maintenance
```

maintenance 模式不要附带 `-- gateway run ...`。

## 6. 运行真实 release gates

确保没有设置跳过变量：

```powershell
Remove-Item Env:AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP -ErrorAction SilentlyContinue
npm run verify:native-guard:real
npm run verify:native-guard:docker -- --required
```

完整 Native Guard gate 可用：

```powershell
npm run verify:native-guard:all
```

最终 fresh 结果：real registry gate PASS；required Docker default 与 controlled 两种 case 均 PASS。验收证明 controlled sink 可达、无 Internet 出口、宿主 canary 不可读也不可写、Docker socket 不可达，cleanup 后残留容器和网络均为 0。

## 7. Docker 验收项

| 检查项 | 通过条件 |
|---|---|
| Gateway identity | fd3 公钥与 core Ed25519 签名绑定真实 child |
| Child lifetime | 非 cleanup 提前退出立即失败，后续 sample 不启动 |
| Readiness | 60 秒绝对截止时间内完成 auth、nonce 与签名证明 |
| Container identity | container PID 与 host PID 不同 |
| Filesystem | rootfs readonly，host canary 读写均失败 |
| Privilege | `65532:65532`、`Privileged=false`、`CapDrop=ALL` |
| Resources | memory 512 MiB、CPU 1、PIDs 128 |
| Default network | `network=none` |
| Controlled network | sink 可达，Internet 不可达 |
| Host boundary | Docker socket 不存在，无任意 host bind |
| Cleanup | labeled container/network 残留均为 0 |

## 8. 尚未完成的发布硬化

以下项目不影响比赛实现与上述 gate 的完成状态，但发布前仍需单独完成：

- [ ] 推送正式 registry 镜像并固定远端 repository digest。
- [ ] 生成并归档 SBOM 与 provenance。
- [ ] 执行并归档完整人工场景矩阵，包括 OFF、allow、deny、redact、ask、PDP 故障、子 Agent、recovery 和 coverage breach。
- [ ] 完成最终发布安全评审。

## 故障排查

| 故障 | 检查 |
|---|---|
| fork SHA 不符 | `git rev-parse HEAD` 必须等于固定 SHA |
| `dist/.buildstamp` 缺失或不符 | 重新运行 `node scripts/build-all.mjs gatewayWatch` |
| Gateway 启动卡住 | 排除定向 `tsdown --no-config` 产物，确认 `dist/extensions` 存在 |
| real gate 找不到 CLI | 同时检查 `OPENCLAW_CLI` 与 `TEST_OPENCLAW_AGENTGUARD_CLI` |
| launcher 拒绝正常启动 | 检查 marker inventory 和 production inspector 的 live attestation；清理时单独使用 `--maintenance` |
| Docker gate 被拒绝跳过 | required gate 禁止 `AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1` |
| cleanup 失败 | 按 run label 检查残留 container/network，并保留失败证据 |
