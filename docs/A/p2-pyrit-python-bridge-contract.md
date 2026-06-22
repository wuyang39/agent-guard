# A 线 PyRIT Python Runtime Bridge 契约

日期: 2026-06-22
状态: P3-A 已实现运行时桥接
适用范围: A 线显式调用 vendored PyRIT runtime、真实模型攻击批测、bridge 结果归档和后续 B/C 线证据对接

## 1. 当前定位

P2 时本文档只是可选草案；P3-A 已经把 bridge 落成两层能力:

```txt
generated/a-line/**                # 可复现输入层，提供 case/objective/profile/manifest
third_party/pyrit_adapted/**       # vendored PyRIT runtime 和定制 run_attack_cli.py
backend/src/modules/corpus/pyritPythonBridge.ts
scripts/verify-a-pyrit-runtime.ts
scripts/generate-a-pyrit-runtime-batch.ts
outputs/pyrit-runs/**              # bridge request/result 和 PyRIT output JSON
```

这条链路不再是“确定性离线变异 + 模板化编排”的替代说法。它会在模型环境配置齐全时真实调用 PyRIT 的 `run_attack_cli.py`，执行 `role_play`、`crescendo`、`red_teaming`、`context_compliance`、`many_shot_jailbreak`、`renellm`、`flip`、`prompt_sending` 等攻击方法。

## 2. 安装和环境

项目隔离 Python runtime:

```powershell
npm run pyrit:setup-runtime
```

该命令在项目内创建或复用:

```txt
.venv/pyrit
```

`.venv/` 和 editable install 产生的 `third_party/pyrit_adapted/*.egg-info/` 已被 `.gitignore` 忽略，不进入主线提交。

真实模型攻击需要以下环境变量:

```txt
OPENAI_CHAT_ENDPOINT
OPENAI_CHAT_KEY
OPENAI_CHAT_MODEL
```

兼容映射:

```txt
OPENAI_CHAT_KEY       <- DeepSeek_API_2 或 AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY
OPENAI_CHAT_ENDPOINT  <- AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT 或 DEEPSEEK_ENDPOINT
OPENAI_CHAT_MODEL     <- AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL 或 DEEPSEEK_MODEL
```

密钥只允许来自用户环境变量或本地未提交配置，不得写入 configs、docs、outputs 摘要、commit 或命令行明文。

## 3. Bridge 输入

共享类型已进入:

```txt
packages/contracts/src/types/corpus.ts
```

核心请求:

```ts
type PyritBridgeRequest = {
  schemaVersion: "p3-a-1"
  bridgeVersion: string
  requestId: string
  mode: "converter_batch" | "attack_cli"
  generatedAt: string
  items: PyritBridgeRequestItem[]
  options?: JsonObject
}
```

`converter_batch` 用于验证 PyRIT converter runtime 和离线转换结果；`attack_cli` 用于调用 `run_attack_cli.py` 做真实模型攻击。

`attack_cli` item 必须包含:

```ts
type PyritBridgeRequestItem = {
  itemId: string
  operatorId: string
  input: string
  method?: PyritAttackMethod
  objective?: string
  maxTurns?: number
  renellmMaxRounds?: number
  renellmRewriteStyle?: string
  evaluatorSync?: boolean
  metadata?: JsonObject
}
```

`objective` 必须来自 A 线 generated corpus、受控 seed 或人工明确传入的安全 fixture；不要从前端自由拼接。

## 4. Bridge 输出

核心结果:

```ts
type PyritBridgeResult = {
  schemaVersion: "p3-a-1"
  bridgeVersion: string
  requestId: string
  mode: "converter_batch" | "attack_cli"
  startedAt: string
  endedAt: string
  pythonExecutable?: string
  pyritAvailable: boolean
  modelConfigured?: boolean
  fallbackAllowed: boolean
  items: PyritBridgeResultItem[]
  errors: string[]
  metadata?: JsonObject
}
```

`PyritBridgeResultItem` 会记录 `method`、`objective`、`outputJsonPath`、`executedTurns`、`outcome`、`lastScore`、`lastResponsePreview`、`runtimeUsed` 和 `status`。

安全要求:

- `lastResponsePreview` 必须截断和脱敏。
- 完整模型输出只落在 `outputs/pyrit-runs/**`，不写入 configs。
- `runtimeUsed: "pyrit"` 才代表真实 PyRIT runtime 参与。
- 模型环境未配置时必须返回 `status: "skipped"` 和 `modelConfigured: false`，不能用 fallback 假装成功。

## 5. 命令

安装/烟测:

```powershell
npm run pyrit:setup-runtime
npm run pyrit:bridge-smoke
npm run verify:a-pyrit-runtime
```

真实运行一批 generated corpus 样本:

```powershell
npm run a:pyrit-runtime
```

可选环境:

```powershell
$env:PYRIT_RUNTIME_PROFILE="regression"
$env:PYRIT_RUNTIME_MAX_ITEMS="8"
$env:PYRIT_RUNTIME_METHODS="role_play,crescendo,red_teaming,renellm"
$env:PYRIT_RUNTIME_MAX_TURNS="3"
$env:PYRIT_RUNTIME_TIMEOUT_MS="180000"
$env:VERIFY_PYRIT_RUNTIME_REQUIRED="1"
```

`VERIFY_PYRIT_RUNTIME_REQUIRED=1` 会把模型未配置或无真实 attack 完成视为失败；未设置时，缺少 endpoint/model 会按 `SKIP` 处理。

## 6. 安全边界

- 子进程必须有 timeout。
- 运行目录固定在项目根或 `third_party/pyrit_adapted`。
- 输出路径限制在 `outputs/pyrit-runs/**`。
- bridge 不允许修改 `configs/**` 或 generated corpus。
- bridge 不允许把密钥值写入结果。
- 失败必须结构化返回，不能让 API 层吞异常。
- 这条链路不替代 B 线 `InteractionTrace` 或 realtime `RuntimeSupervisionRecord[]`；它提供 A 线攻击生成/执行证据和后续 C 线报告素材。

## 7. 与 A/B/C 的关系

A 线负责:

- 生成受控 objective。
- 选择 profile/case。
- 调用 PyRIT runtime bridge。
- 归档 `PyritBridgeResult` 和 `outputs/pyrit-runs/**`。

B 线仍负责真实 Agent 执行和 `InteractionTrace` / `RuntimeSupervisionRecord[]`。
C 线后续可以消费 `PyritBridgeResult` 作为攻击库来源与模型攻击执行证据，但不能把它直接当成 Agent 风险结论。
