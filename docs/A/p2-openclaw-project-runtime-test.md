# A 线 P2 OpenClaw 项目隔离运行记录

日期: 2026-06-16
分支: `a/openclaw-project-runtime-demo`
状态: 项目本地 OpenClaw runtime 已部署；Agent Guard 可识别 OpenClaw CLI；真实 OpenClaw agent required 验证已通过

## 1. 部署目标

本次部署只为 `E:\XinAnProject\agent-guard` 的 P2 联调和 demo 使用，不做系统级安装。

隔离要求:

- 不执行 `npm install -g openclaw`。
- 不修改 Windows 全局 `PATH`。
- 不把 OpenClaw 本体、配置、workspace、token、模型 key 提交到 `agent-guard`。
- OpenClaw 状态只写入项目旁边的本地目录 `E:\XinAnProject\openclaw-runtime`。

## 2. 当前本机 runtime

本机路径:

```txt
E:\XinAnProject\openclaw-runtime
  home\.openclaw\openclaw.json
  workspace\
  logs\
  node_modules\
  openclaw-local.cmd
```

版本选择:

- `openclaw@2026.6.6`
- `npm dist-tag latest`
- 未选择 `beta`，避免 demo 环境使用预发布版本。

安装方式:

```powershell
npm install --prefix E:\XinAnProject\openclaw-runtime openclaw@2026.6.6 --no-audit --no-fund
```

本机 wrapper:

```txt
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd
```

该 wrapper 只在当前进程设置:

```txt
OPENCLAW_HOME=E:\XinAnProject\openclaw-runtime\home
OPENCLAW_WORKSPACE=E:\XinAnProject\openclaw-runtime\workspace
OPENCLAW_NO_ONBOARD=1
```

本机额外约定:

- 本机示例环境变量 `DeepSeek_API_2` 可映射为 OpenClaw DeepSeek provider 识别的 `DEEPSEEK_API_KEY`；该名称不是团队规范，其他成员可使用自己的 key env。
- 默认模型设置为 `deepseek/deepseek-v4-flash`。
- 启动脚本只在进程环境中映射 key，不把 key 写入仓库文档或命令行参数。

## 3. Agent Guard 启动方式

新增脚本:

```txt
scripts/start-agent-guard-openclaw.cmd
scripts/start-agent-guard-openclaw.ps1
```

作用:

1. 检查 `..\openclaw-runtime\openclaw-local.cmd` 是否存在。
2. 为当前 Agent Guard demo 进程设置 `OPENCLAW_CLI`、`OPENCLAW_HOME`、`OPENCLAW_WORKSPACE`。
3. 如果 `18789` 未监听，则启动 OpenClaw gateway。
4. 如果 `5173` 未监听，则启动前端。
5. 打开 `http://127.0.0.1:5173`。
6. 在当前终端运行 `npm run demo:p2`，启动 API 和 sample agent。

注意: Agent Guard 的 OpenClaw adapter 会把 Windows npm shim 解析成 `node openclaw.mjs`。因此只设置 `OPENCLAW_CLI` 不够，demo 进程必须同时设置 `OPENCLAW_HOME`，否则 OpenClaw 可能回落到用户目录。

## 4. 验证结果

已通过:

```powershell
$env:OPENCLAW_CLI="E:\XinAnProject\openclaw-runtime\openclaw-local.cmd"
$env:OPENCLAW_HOME="E:\XinAnProject\openclaw-runtime\home"
$env:OPENCLAW_WORKSPACE="E:\XinAnProject\openclaw-runtime\workspace"
npm run verify:openclaw:realtime
```

结果:

- Realtime MCP endpoint 可用。
- 工具列表返回 6 个 `agent_guard_*` 工具。
- `deny`、`ask`、`redact` 三类监督记录均可生成。
- trace 查询和 realtime event stream 均通过。

已通过可降级 P2 API E2E:

```powershell
npm run verify:p2:api-e2e
```

结果:

- 12 个 required 检查通过。
- OpenClaw CLI adapter 被识别为可用。
- 补充 DeepSeek key 映射前，OpenClaw agent 检测因缺模型 key 被 optional skip。

补充 DeepSeek key 映射后，已通过 required P2 API E2E:

```powershell
$env:OPENCLAW_CLI="E:\XinAnProject\openclaw-runtime\openclaw-local.cmd"
$env:OPENCLAW_HOME="E:\XinAnProject\openclaw-runtime\home"
$env:OPENCLAW_WORKSPACE="E:\XinAnProject\openclaw-runtime\workspace"
$env:VERIFY_OPENCLAW_REQUIRED="1"
npm run verify:p2:api-e2e
```

结果:

- 13 个 required 检查通过。
- 0 个 optional skipped。
- `openclaw` adapter 已跑通真实 CLI agent 检测。

注意:

- `openclaw-local.cmd` 可在进程内把本机示例 key env 映射为 `DEEPSEEK_API_KEY`，验证命令不需要写明 key 值。
- required 验证不要设置 `OPENCLAW_GATEWAY_URL`。OpenClaw `2026.6.6` 遇到 gateway URL override 会要求显式 gateway auth，可能报 `GatewayExplicitAuthRequiredError: gateway url override`。

补充模型 key 前，required OpenClaw 检测未通过:

```powershell
$env:VERIFY_OPENCLAW_REQUIRED="1"
npm run verify:p2:api-e2e
```

当时失败点:

```txt
OpenClaw CLI 可执行，gateway 可连接，但模型 provider 认证缺失。
OpenClaw 返回 No API key。
```

这不是 Agent Guard adapter 的路径问题，而是 OpenClaw 本体尚未配置可用模型凭证。2026-06-16 已补充“本机 key env → `DEEPSEEK_API_KEY`”的运行时映射，后续验证以最新命令结果为准。

## 5. 后续维护注意

当前本机曾通过个人环境变量示例提供模型认证。其他成员本地部署时需要提供自己的模型 provider 认证，推荐使用 provider 原生变量如 `DEEPSEEK_API_KEY` 或脚本参数显式指定本机变量名。

示例:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models auth paste-api-key --provider openai
```

或:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd models auth login --provider openai --set-default
```

验证命令:

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

## 6. 与 A/B/C 线关系

A 线:

- 继续提供内置 case、攻击库、PyRIT/AIG 来源映射和 sandbox fixture。
- 不把 OpenClaw runtime 当作 A 线配置输入提交。

B 线:

- OpenClaw CLI adapter 和 realtime MCP endpoint 仍是 B 线职责。
- 当前项目 runtime 用于验证 B 线 OpenClaw adapter 是否能在真实 CLI 环境中工作。

C 线:

- 前端只展示 API 返回的 OpenClaw 可用性、fallback 状态、trace、监督记录和报告。
- 不直接读取 `openclaw-runtime` 目录或 OpenClaw 私有配置。

## 7. 当前结论

项目隔离部署已经成立:

- OpenClaw CLI: 可运行。
- OpenClaw gateway: 可在 `127.0.0.1:18789` 启动。
- Agent Guard system status: 可识别 `openclawAdapter=true`。
- Agent Guard realtime MCP: 已通过完整脚本验证。
- 真实 OpenClaw agent 检测: 已通过 `VERIFY_OPENCLAW_REQUIRED=1 npm run verify:p2:api-e2e`。

## 8. 2026-06-17 本地代理超时修复记录

现象:

- Agent Guard demo 能启动，`/api/v1/system/status` 显示 `openclawCli=true`、`realtimeMcp=true`。
- OpenClaw gateway 未启动时，检测报 `GatewayTransportError: gateway closed (1006)`。
- gateway 启动后，OpenClaw agent 仍报 `FailoverError: LLM request timed out`。

定位:

- 本机进程环境存在 `HTTP_PROXY=http://127.0.0.1:7890` 和 `HTTPS_PROXY=http://127.0.0.1:7890`。
- 通过该代理访问 `https://api.deepseek.com` 会连接超时。
- 使用 `curl.exe --noproxy "*"` 或清理代理变量后，DeepSeek API 与 `deepseek-v4-flash` 模型可正常返回。
- Agent Guard 后端可能把 `openclaw-local.cmd` 解析为 `node openclaw.mjs` 执行，因此只在 wrapper 中清理代理还不够，必须在后端 OpenClaw 子进程环境中也清理代理。

修复:

- `openclaw-local.cmd` 在项目进程内清理 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写变体，并设置 `NO_PROXY=*`。
- `backend/src/modules/agent/openclawAdapter.ts` 增加 `buildOpenClawProcessEnv()`，所有 OpenClaw CLI 子进程统一使用直连环境。
- `backend/src/modules/agent/openclawSession.ts` 的真实 agent run 使用同一环境构造函数。
- `scripts/start-agent-guard-openclaw.ps1` 启动 gateway、frontend、demo 时显式清理代理变量。
- 后端 OpenClaw runtime 推断补充支持 `openclaw-runtime/home/.openclaw/openclaw.json`，避免项目隔离 runtime 被误判为缺少本地配置。

验证:

```powershell
E:\XinAnProject\openclaw-runtime\openclaw-local.cmd agent --session-key agent-guard-smoke-fixed-2 --message "只回复 OK" --json --timeout 90
```

结果: 返回 `status=ok`、`provider=deepseek`、`model=deepseek-v4-flash`、文本 `OK`。

```powershell
$env:OPENCLAW_CLI="E:\XinAnProject\openclaw-runtime\openclaw-local.cmd"
$env:OPENCLAW_HOME="E:\XinAnProject\openclaw-runtime\home"
$env:OPENCLAW_WORKSPACE="E:\XinAnProject\openclaw-runtime\workspace"
$env:VERIFY_OPENCLAW_REQUIRED="1"
npm run verify:p2:api-e2e
```

结果: `13 required passed, 0 optional skipped`，OpenClaw 检测不再降级或跳过。
