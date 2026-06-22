# OpenClaw 项目隔离安装与演示 Runbook

状态: 2026-06-16 已按当前本机路径重写

这份文档面向本地演示操作。OpenClaw 本体不提交到 `agent-guard`，只作为项目旁边的私有 runtime。

## 1. 当前部署

当前本机路径:

```txt
E:\XinAnProject\openclaw-runtime
```

核心文件:

```txt
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd
E:\XinAnProject\openclaw-runtime\home\.openclaw\openclaw.json
E:\XinAnProject\openclaw-runtime\workspace
```

OpenClaw 版本:

```txt
OpenClaw 2026.6.6 (8c802aa)
```

模型配置:

```txt
Provider env: provider key from local env, for example DEEPSEEK_API_KEY
Default model: deepseek/deepseek-v4-flash
```

隔离规则:

- 不使用全局 `npm install -g`。
- 不修改 Windows 全局 `PATH`。
- 不把 OpenClaw 本体、workspace、token、模型 key 提交到 Git。
- Agent Guard 运行时通过环境变量接入该 runtime。

## 2. 一键启动 Agent Guard + OpenClaw Runtime

在 `agent-guard` 目录运行:

```powershell
scripts\start-agent-guard-openclaw.cmd
```

脚本会:

1. 检查 `..\openclaw-runtime\openclaw-local.cmd`。
2. 设置 `OPENCLAW_CLI`、`OPENCLAW_HOME`、`OPENCLAW_WORKSPACE`。
3. 启动或复用 OpenClaw gateway: `127.0.0.1:18789`。
4. 启动前端: `http://127.0.0.1:5173`。
5. 运行 `npm run demo:p2` 启动 API 和 sample agent。

常用地址:

```txt
Agent Guard 前端: http://127.0.0.1:5173
Agent Guard API:  http://127.0.0.1:3100/api/v1/system/status
OpenClaw 面板:    http://127.0.0.1:18789
Realtime MCP:     http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp
```

## 3. 当前验证状态

已通过:

```powershell
npm run verify:openclaw:realtime
```

说明:

- Agent Guard 的 realtime MCP endpoint 可用。
- `agent_guard_read_file`、`agent_guard_write_file`、`agent_guard_execute_code`、`agent_guard_send_email`、`agent_guard_call_api`、`agent_guard_send_request` 可列出。
- `deny`、`ask`、`redact` 三类监督记录可生成。

普通 P2 API E2E 已通过:

```powershell
npm run verify:p2:api-e2e
```

说明:

- mock/http_sample 路径通过。
- OpenClaw CLI adapter 被识别为可用。
- 补充 DeepSeek key 映射前，OpenClaw agent 检测因未配置模型 key 被 optional skip。

required 模式在补充本机 provider key 映射后已通过:

```powershell
$env:VERIFY_OPENCLAW_REQUIRED="1"
npm run verify:p2:api-e2e
```

当前结果:

```txt
13 required passed, 0 optional skipped.
```

注意: required E2E 不要额外设置 `OPENCLAW_GATEWAY_URL`。OpenClaw `2026.6.6` 在检测到 gateway URL override 时会要求显式 gateway auth，可能报 `GatewayExplicitAuthRequiredError: gateway url override`。CLI 检测只需要 `OPENCLAW_CLI`、`OPENCLAW_HOME`、`OPENCLAW_WORKSPACE` 和模型认证。

## 4. 配置模型认证

真实 OpenClaw agent 检测必须有可用模型 provider。推荐使用 provider 原生环境变量，例如 `DEEPSEEK_API_KEY`。如果本机已有其他变量名，可以通过启动脚本参数把它进程内映射为 OpenClaw 识别的 provider key；`DeepSeek_API_2` 只是某个开发者本机示例名称。

如果其他成员没有该用户环境变量，可以按自己的 provider 配置。示例:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models auth paste-api-key --provider openai
```

或:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models auth login --provider openai --set-default
```

配置后检查:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models status
```

然后重新执行:

```powershell
$env:OPENCLAW_CLI="E:\XinAnProject\openclaw-runtime\openclaw-local.cmd"
$env:OPENCLAW_HOME="E:\XinAnProject\openclaw-runtime\home"
$env:OPENCLAW_WORKSPACE="E:\XinAnProject\openclaw-runtime\workspace"
$env:VERIFY_OPENCLAW_REQUIRED="1"
npm run verify:p2:api-e2e
```

如果当前终端曾设置过 `OPENCLAW_GATEWAY_URL`，先清理:

```powershell
Remove-Item Env:OPENCLAW_GATEWAY_URL -ErrorAction SilentlyContinue
```

## 5. 演示顺序

推荐顺序:

1. 运行 `scripts\start-agent-guard-openclaw.cmd`。
2. 打开 `http://127.0.0.1:5173` 查看系统状态。
3. 确认 OpenClaw adapter 状态。
4. 在前端跑 mock/http_sample E2E，验证完整页面链路。
5. 跑 OpenClaw adapter required 验证，确认 `0 optional skipped`。
6. 演示 realtime MCP 时，重点展示 `deny`、`ask`、`redact` 监督记录和 trace。

## 6. 排查顺序

1. 检查 OpenClaw CLI:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd --version
```

2. 检查 OpenClaw gateway:

```powershell
Get-NetTCPConnection -LocalPort 18789 -State Listen
```

3. 检查 Agent Guard API:

```txt
http://127.0.0.1:3100/api/v1/system/status
```

4. 检查模型认证:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models status
```

5. 检查 realtime MCP:

```powershell
npm run verify:openclaw:realtime
```

6. 如果 gateway 可连接但 DeepSeek 请求超时，检查本机代理环境:

```powershell
Get-ChildItem Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY,Env:NO_PROXY -ErrorAction SilentlyContinue
```

本项目的 `openclaw-local.cmd` 与 `scripts/start-agent-guard-openclaw.ps1` 会在项目进程内清理 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写变体，并设置 `NO_PROXY=*`。这是项目级隔离处理，不会修改 Windows 用户环境变量。

可用以下命令确认 DeepSeek 直连行为:

```powershell
curl.exe --noproxy "*" --connect-timeout 10 --max-time 30 https://api.deepseek.com/models
```

未带 key 时应快速返回 `401`，而不是连接超时。随后验证 OpenClaw agent:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd agent --session-key agent-guard-smoke --message "只回复 OK" --json --timeout 90
```

预期返回 `status=ok`，并在 `agentMeta` 中看到 `provider=deepseek`、`model=deepseek-v4-flash`。
