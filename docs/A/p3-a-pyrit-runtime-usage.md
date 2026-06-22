# P3-A PyRIT Runtime 参数与协作运行说明

日期: 2026-06-22  
状态: P3-A 运行参数说明  
适用范围: A 线 PyRIT Python runtime bridge、模型目标、项目隔离 OpenClaw CLI/shim 联调

## 0. 必读提醒

运行 `npm run verify:a-pyrit-runtime` 或 `npm run a:pyrit-runtime` 前，先确认本文档的模型参数。不要把 Agent Guard realtime MCP 地址填到 `OPENAI_CHAT_ENDPOINT`，它不是模型 endpoint。

`DeepSeek_API_2` 只是当前开发者本机使用过的示例环境变量名，不是项目规范。协作者应优先使用 `OPENAI_CHAT_KEY`、`AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY` 或 provider 原生变量，例如 `DEEPSEEK_API_KEY`；如果本机已有其他变量名，可通过 `-KeyEnvName` 显式传入。

## 1. 三类地址不要混用

| 参数 | 用途 | 当前建议 |
| --- | --- | --- |
| `OPENAI_CHAT_ENDPOINT` | PyRIT `OpenAIChatTarget` 使用的 OpenAI-compatible chat base URL | 默认使用 Agent Guard 提供的 PyRIT/OpenClaw shim: `http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1` |
| `OPENAI_CHAT_MODEL` | PyRIT 真实模型攻击使用的模型名 | `deepseek-v4-pro` |
| `OPENAI_CHAT_KEY` | PyRIT OpenAI SDK 客户端需要的 API key | 推荐使用 `OPENAI_CHAT_KEY` 或 `AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY`；使用本项目 OpenClaw shim 时服务端不会持久化该值 |
| `DEEPSEEK_API_KEY` | OpenClaw CLI 调用 DeepSeek provider 所需的 provider key | 如果使用 DeepSeek 模型，Agent Guard API/OpenClaw 进程需要该变量；也可通过脚本从本机示例变量映射 |
| `http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp` | Agent Guard 暴露给 OpenClaw 的 realtime MCP endpoint | 只给 OpenClaw/MCP 客户端使用，不能作为 `OPENAI_CHAT_ENDPOINT` |
| `http://127.0.0.1:18789` | 项目隔离 OpenClaw local gateway/control plane | 已知不是传统 OpenAI-compatible REST `/v1`；不要把它当成 PyRIT endpoint |

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
OPENAI_CHAT_KEY=<来自 OPENAI_CHAT_KEY、AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY、DEEPSEEK_API_KEY 或 -KeyEnvName 指定变量>
DEEPSEEK_API_KEY=<如果当前使用 DeepSeek provider 且尚未设置，则可由脚本映射>
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

联调时可显式固定 attack method，避免小批量样本误入更慢的多轮方法:

```powershell
$env:PYRIT_RUNTIME_PROFILE="smoke"
$env:PYRIT_RUNTIME_MAX_ITEMS="2"
$env:PYRIT_RUNTIME_METHODS="prompt_sending"
$env:PYRIT_RUNTIME_MAX_TURNS="1"
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
DEEPSEEK_API_KEY
DeepSeek_API_2  # 仅作为当前开发者本机示例兼容项
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

1. `npm run pyrit:setup-runtime` 成功创建的 `.venv/pyrit`。
2. Agent Guard API 正在运行，默认地址为 `http://127.0.0.1:3100`。
3. 可用于 OpenClaw provider 的本机 key。DeepSeek 示例是 `DEEPSEEK_API_KEY`；如果你本机已有其他变量名，运行 `. .\scripts\setup-pyrit-openclaw-env.ps1 -KeyEnvName <YOUR_LOCAL_KEY_ENV>`。
4. `OPENAI_CHAT_ENDPOINT` 默认指向 `http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1`，它是本项目提供的 OpenAI-compatible shim，内部调用 OpenClaw CLI。

不允许提交:

- API key。
- `.venv/`。
- `third_party/pyrit_adapted/*.egg-info/`。
- `outputs/pyrit-runs/**` 中包含完整模型输出的临时运行结果，除非团队另行批准并完成脱敏。

## 5. 当前 bridge 行为

- `converter_batch` 会真实调用 vendored PyRIT converter。当前 bridge 支持 Base64/Base32/Base85/Base2048、ROT13/Caesar/Atbash、Binary/BinAscii/Morse/NATO、Braille/Superscript、UnicodeConfusable/Replacement/Substitution、ZeroWidth、Ascii/Variation/SneakyBits smuggling、AsciiArt、AskToDecode、Emoji/Ecoji、CharSwap、Diacritic、Zalgo、Flip、Leetspeak、StringJoin、InsertPunctuation 等文本 converter。
- `attack_cli` 会调用 vendored `run_attack_cli.py`。如果 selected case 的 `operatorId` 是 bridge 支持的 `pyrit.converter.*`，bridge 会先用真实 PyRIT converter 变换 objective，再把变换后的 objective 送入 attack executor。
- `PYRIT_RUNTIME_METHODS` 显式设置后会对本批次所有选中样本生效；未设置时才按 case/operator 推断 `role_play`、`crescendo`、`context_compliance` 等方法。
- `attack_cli` 的 request 使用 `runtimeObjectiveBase`，即变异前的可读攻击材料；真实 PyRIT converter 只在 Python bridge 内执行一次。这样避免 Base64/ROT/Unicode 等样本在 runtime 中被二次变异，导致 request/result 难以阅读。
- bridge 临时 request/result 写入 `outputs/pyrit-bridge-tmp/**`，不再写入 `generated/a-line/tmp/**`。`generated/a-line/**` 只保留正式生成语料、manifest 和 stats。
- bridge result 顶层 `objective` 保留可读原文；如果真实送入 PyRIT 的 runtime payload 被 converter 改写，会记录到 `metadata.runtimeObjectivePayloadPreview`。
- Python bridge 会强制 UTF-8 子进程环境并压缩 stdout notes，避免 ANSI 控制符、Windows GBK 打印警告和长控制台日志污染 result。
- 模型环境未配置完整时，attack item 必须返回 `status: "skipped"`，不能用离线模板冒充真实模型攻击。
- `runtimeUsed: "pyrit"` 且 `status: "ok"` 才代表真实 PyRIT runtime 参与。

## 5.1 当前实测结果

2026-06-22 已完成本机端到端验证:

```powershell
npm run typecheck
npm run pyrit:bridge-smoke
npm run verify:a-pyrit-runtime  # VERIFY_PYRIT_RUNTIME_REQUIRED=1
npm run a:pyrit-runtime         # smoke profile, 2 prompt_sending items
```

结果:

- Agent Guard API shim `/api/v1/pyrit/openclaw/v1/models` 返回 OpenAI-compatible model list。
- Agent Guard API shim `/api/v1/pyrit/openclaw/v1/chat/completions` 可触发 `runOpenClawSession()` 并返回 OpenAI-compatible chat completion。
- `verify:a-pyrit-runtime` 在 required 模式下完成真实模型-backed PyRIT attack item。
- `a:pyrit-runtime` 使用 smoke profile、2 条 `prompt_sending` 样本，输出 `status={"ok":2}`。
- PyRIT console printer 在 Windows GBK 控制台中可能无法打印部分 Unicode 符号；`run_attack_cli.py` 已将 printer 变成非阻断路径，`agent_guard_bridge.py` 会摘要化 notes，JSON 输出仍会保存并被 bridge 消费。

## 6. 常见错误

- 错误: `OPENAI_CHAT_ENDPOINT=http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp`
  原因: 这是 Agent Guard 的 realtime MCP endpoint，不是模型 chat endpoint。

- 错误: `OPENAI_CHAT_ENDPOINT=http://127.0.0.1:18789/v1`
  原因: 18789 是 OpenClaw gateway/control plane，不是已验证的 OpenAI-compatible chat API。请使用 `http://127.0.0.1:3100/api/v1/pyrit/openclaw/v1`。

- 错误: 只运行 `powershell -File scripts/setup-pyrit-openclaw-env.ps1` 后再开新命令跑验证。  
  原因: 变量只存在于脚本子进程。需要点源执行: `. .\scripts\setup-pyrit-openclaw-env.ps1`。

- 错误: `OPENAI_CHAT_KEY` 或 provider key 缺失。
  处理: 在当前 shell 中设置 `OPENAI_CHAT_KEY` 和 provider 变量，例如 `DEEPSEEK_API_KEY`；或用 `-KeyEnvName <YOUR_LOCAL_KEY_ENV>` 从自己的本机变量映射。不要把 key 写入仓库。
