# P3-A PyRIT Runtime 参数与协作运行说明

日期: 2026-06-22  
状态: P3-A 运行参数说明  
适用范围: A 线 PyRIT Python runtime bridge、DeepSeek 模型目标、项目隔离 OpenClaw gateway 联调

## 0. 必读提醒

运行 `npm run verify:a-pyrit-runtime` 或 `npm run a:pyrit-runtime` 前，先确认本文档的模型参数。不要把 Agent Guard realtime MCP 地址填到 `OPENAI_CHAT_ENDPOINT`，它不是模型 endpoint。

## 1. 三类地址不要混用

| 参数 | 用途 | 当前建议 |
| --- | --- | --- |
| `OPENAI_CHAT_ENDPOINT` | PyRIT `OpenAIChatTarget` 使用的 OpenAI-compatible chat base URL | 优先使用项目隔离 OpenClaw gateway 暴露的 `/v1` 兼容地址，例如 `http://127.0.0.1:18789/v1`；如果团队确认 gateway 不代理模型，则改用显式 DeepSeek/OpenAI-compatible base URL |
| `OPENAI_CHAT_MODEL` | PyRIT 真实模型攻击使用的模型名 | `deepseek-v4-pro` |
| `OPENAI_CHAT_KEY` | PyRIT 真实模型攻击使用的 API key | 本机用户环境变量 `DeepSeek_API_2` 会被脚本映射，不要写入仓库 |
| `http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp` | Agent Guard 暴露给 OpenClaw 的 realtime MCP endpoint | 只给 OpenClaw/MCP 客户端使用，不能作为 `OPENAI_CHAT_ENDPOINT` |
| `http://127.0.0.1:18789` | 项目隔离 OpenClaw local gateway | 只有确认其暴露 OpenAI-compatible `/v1` 接口时，才可作为 PyRIT 模型 endpoint 的基础地址 |

## 2. 推荐本机运行方式

安装项目隔离 PyRIT runtime:

```powershell
npm run pyrit:setup-runtime
```

在当前 PowerShell 会话中准备模型环境:

```powershell
. .\scripts\setup-pyrit-openclaw-env.ps1
```

脚本会设置:

```txt
OPENAI_CHAT_ENDPOINT
AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT
OPENAI_CHAT_MODEL=deepseek-v4-pro
DEEPSEEK_MODEL=deepseek-v4-pro
OPENAI_CHAT_KEY=<来自 DeepSeek_API_2 或其他本机环境变量>
```

注意: 这个脚本只影响当前 PowerShell 进程。要让后续命令继承变量，必须用前导点号执行。

运行验证:

```powershell
npm run pyrit:bridge-smoke
npm run verify:a-pyrit-runtime
```

运行一批 generated corpus:

```powershell
$env:PYRIT_RUNTIME_PROFILE="regression"
$env:PYRIT_RUNTIME_MAX_ITEMS="8"
npm run a:pyrit-runtime
```

如果要把模型未配置视为失败:

```powershell
$env:VERIFY_PYRIT_RUNTIME_REQUIRED="1"
npm run verify:a-pyrit-runtime
```

## 3. 环境变量优先级

`OPENAI_CHAT_ENDPOINT` 映射顺序:

```txt
OPENAI_CHAT_ENDPOINT
AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT
AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT
OPENCLAW_CHAT_ENDPOINT
DEEPSEEK_ENDPOINT
```

`OPENAI_CHAT_KEY` 映射顺序:

```txt
OPENAI_CHAT_KEY
AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY
DeepSeek_API_2
DEEPSEEK_API_KEY
```

`OPENAI_CHAT_MODEL` 映射顺序:

```txt
OPENAI_CHAT_MODEL
AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL
DEEPSEEK_MODEL
deepseek-v4-pro
```

## 4. 协作输入要求

协作者只需要准备以下本机输入:

1. 用户级或会话级环境变量 `DeepSeek_API_2`，值为自己的 DeepSeek API key。
2. 可用的 OpenAI-compatible chat endpoint。默认脚本会尝试 `http://127.0.0.1:18789/v1`，但这依赖本机 OpenClaw gateway 是否真的暴露 `/v1` 兼容接口。
3. `npm run pyrit:setup-runtime` 成功创建的 `.venv/pyrit`。

不允许提交:

- API key。
- `.venv/`。
- `third_party/pyrit_adapted/*.egg-info/`。
- `outputs/pyrit-runs/**` 中包含完整模型输出的临时运行结果，除非团队另行批准并完成脱敏。

## 5. 当前 bridge 行为

- `converter_batch` 会真实调用 vendored PyRIT converter。当前 bridge 支持 Base64/Base32/Base85/Base2048、ROT13/Caesar/Atbash、Binary/BinAscii/Morse/NATO、Braille/Superscript、UnicodeConfusable/Replacement/Substitution、ZeroWidth、Ascii/Variation/SneakyBits smuggling、AsciiArt、AskToDecode、Emoji/Ecoji、CharSwap、Diacritic、Zalgo、Flip、Leetspeak、StringJoin、InsertPunctuation 等文本 converter。
- `attack_cli` 会调用 vendored `run_attack_cli.py`。如果 selected case 的 `operatorId` 是 bridge 支持的 `pyrit.converter.*`，bridge 会先用真实 PyRIT converter 变换 objective，再把变换后的 objective 送入 attack executor。
- 模型环境未配置完整时，attack item 必须返回 `status: "skipped"`，不能用离线模板冒充真实模型攻击。
- `runtimeUsed: "pyrit"` 且 `status: "ok"` 才代表真实 PyRIT runtime 参与。

## 6. 常见错误

- 错误: `OPENAI_CHAT_ENDPOINT=http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp`  
  原因: 这是 Agent Guard 的 realtime MCP endpoint，不是模型 chat endpoint。

- 错误: 只运行 `powershell -File scripts/setup-pyrit-openclaw-env.ps1` 后再开新命令跑验证。  
  原因: 变量只存在于脚本子进程。需要点源执行: `. .\scripts\setup-pyrit-openclaw-env.ps1`。

- 错误: `OPENAI_CHAT_KEY` 缺失。  
  处理: 在本机用户环境变量或当前 shell 中设置 `DeepSeek_API_2`，不要把 key 写入仓库。
