# OpenClaw Detection Live Verification Runbook

Task 14 P0-3 — 真实 Docker 环境验收操作手册。

## 前置条件

| 组件 | 要求 | 验证 |
|---|---|---|
| Docker daemon | 运行中 | `docker version` |
| OpenClaw CLI | ≥ 2026.7.2 或兼容 fork | `openclaw --version` |
| Agent Guard 插件 | 已构建 + 已安装 | `openclaw plugins list --json` |
| 不可变镜像 | sha256 digest pinned | `docker image inspect <image>` |
| Node.js | ≥ 20 | `node --version` |

## 第一步：构建插件

```powershell
cd E:\Projects\agent-guard
npm ci
npm run build:openclaw-plugin
# → plugins/agent-guard-supervision/dist/index.js (216 KB)
```

## 第二步：准备镜像

```powershell
# Pull or build the detection image
docker pull <registry>/openclaw-sandbox@sha256:aaaa...

# Set the env var for all subsequent commands
$env:AGENT_GUARD_DETECTION_IMAGE = "registry/openclaw-sandbox@sha256:aaaa..."
```

镜像要求：
- 非 root 用户 (65532:65532)
- 包含 OpenClaw fork binary (`2026.7.1-agentguard.1`)
- 包含已构建的 Agent Guard 插件
- 包含 `python3`、`nc`、`sh`、`wget`/`curl`
- 不可变（digest pinned）
- 只读文件系统友好

**注意**：Fork 完成前可先用现有镜像测试基础设施（Docker daemon、port hijack 防御）。
Fork 完成后必须重新构建镜像，digest 会变化——记录新 digest 并用它运行验收。

## 第三步：安装插件

```powershell
.\scripts\install-openclaw-native-guard.ps1
```

检查插件状态：
```powershell
openclaw plugins list --json
```

预期：`agent-guard-supervision` 状态为 `loaded`，hook 包含 `before_tool_call`，service 包含 `agent-guard-runtime`。

## 第四步：非 Docker 回归

```powershell
npm run verify:native-guard
```

预期：protocol 8/8、plugin 319/319、backend tests 全部通过。

## 第五步（fork 后）：镜像内验证

```powershell
# 确认 fork 版本
docker run --rm --entrypoint "" $env:AGENT_GUARD_DETECTION_IMAGE openclaw --version
# 预期: openclaw 2026.7.1-agentguard.1

# 确认 live attestation
docker run --rm --entrypoint "" $env:AGENT_GUARD_DETECTION_IMAGE openclaw plugins list --json
# 预期: "liveAttestation": true
```

## 第六步：Docker 真实验收

```powershell
npm run verify:native-guard:docker
```

验证项目：

| # | 检查项 | 说明 |
|---|---|---|
| 1 | Port hijack defense | TOCTOU 端口抢占被 auth gate 阻止 |
| 2 | Sandbox lifecycle | preflight → start → cleanup 正常 |
| 3 | Gateway auth | 无认证 → 401/403；nonce challenge 通过 |
| 4 | Container PID ≠ host | 真实容器隔离 |
| 5 | Readonly rootfs | `docker inspect` 确认 |
| 6 | Non-privileged | `Privileged=false` |
| 7 | Non-root user | `65532:65532` |
| 8 | CapDrop ALL | 所有 capabilities dropped |
| 9 | Resource limits | Memory 512m, CPU 1, PIDs 128 |
| 10 | Host canary unreadable | 容器不能访问宿主 canary |
| 11 | Docker socket absent | 容器内无 Docker socket |
| 12 | Network isolation | 无 Internet 出口 |
| 13 | Cleanup | 无残留容器/网络 |

失败时设置 `AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1` 仅可在非发布环境跳过。发布环境禁止该变量。

## 第七步：全链路

```powershell
npm run verify:native-guard:all
```

## 第八步：E2E 场景手动验收

按顺序执行，每一步都需验证结果：

### 1. Guard OFF
```powershell
# openclaw.json: agent-guard-supervision enabled = false
openclaw agent --json --message "read /docs/readme.md"
```
预期：`read` 正常执行，无 Hook 事件。

### 2. ACTIVE allow
```powershell
# 激活 detection lease
curl -X POST http://127.0.0.1:3100/api/v1/openclaw/native-guard/leases \
  -H "X-Agent-Guard-Control-Token: <token>" \
  -H "Content-Type: application/json" \
  -d '{"rootSessionKey":"test-1","mode":"detection"}'

openclaw agent --session-key test-1 --json --message "read /docs/readme.md"
```
预期：`read` 执行一次，before/after 对齐，no breach。

### 3. deny
```powershell
openclaw agent --session-key test-deny --json --message "exec rm -rf /"
```
预期：`exec` 被 deny，零副作用。

### 4. redact
预期：hook 改写参数，实际执行参数等于签名后的改写参数。

### 5. ask
预期：批准一次执行、拒绝一次、超时 deny、取消 deny。

### 6. PDP 故障
停止 Agent Guard backend，高风险工具 deny，未知工具 deny。

### 7. 子 Agent 继承 lease
子 session 的 before_tool_call 在同一 lease 下生效。

### 8. Gateway 重启 → recovery
重启 Gateway 后 lease 仍然 active，recovery marker 存在。

### 9. Coverage breach
修改 JSONL 添加 tool_call 但 Hook 不触发 → run failed。

### 10. Docker 隔离 + 清理
容器内 exec PID ≠ host PID，canary/socket/network 不可达，cancel 后无残留。

## 故障排查

| 故障 | 检查 |
|---|---|
| `openclaw` not found | `$env:PATH` 包含 OpenClaw 安装目录 |
| Docker daemon unavailable | `docker version` 确认 daemon 运行 |
| Image not found | `docker pull` 或检查 digest 拼写 |
| Plugin not loaded | `openclaw plugins list --json` 确认 `agent-guard-supervision` |
| Gateway does not start | 检查端口冲突，`netstat -ano \| findstr <port>` |
| Launcher rejects startup | 使用 `--maintenance` 清理模式，或修复 registry |
