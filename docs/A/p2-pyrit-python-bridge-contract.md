# A 线 P2 PyRIT Python Bridge 草案

日期: 2026-06-15  
状态: P2 可选能力草案，未进入默认运行主链路  
适用范围: 后续需要真实执行 vendored PyRIT 攻击时的接口约束

## 1. 当前状态

P2 已经把用户提供的定制 PyRIT 项目迁入:

```txt
third_party/pyrit_adapted
```

默认 Agent Guard 主链路仍使用 TypeScript:

```txt
configs -> TestContext -> sandbox -> trace -> risk/policy/report
```

当前不在默认 CI 中真实执行 PyRIT Python attack executor。原因:

- 真实攻击依赖模型 target、API key、PyRIT memory 和 Python 依赖环境。
- 多轮攻击会引入网络、耗时和不稳定性。
- P2 默认验收需要可重复、可离线、无真实副作用。

因此 P2 的 Python bridge 是可选能力，不是默认必跑项。

## 2. 已有可复用入口

vendored PyRIT 中最重要的三个定制入口:

| 文件 | 当前价值 | P2 状态 |
| --- | --- | --- |
| `run_attack_cli.py` | 中文 CLI、攻击方法选择、单条/xlsx 批量、JSON 输出、evaluator sync | 已迁入，作为 bridge 主要执行入口候选 |
| `evaluator.py` | SQLite 评估统计、0/1/2 grade、similarity、iter/mutate count、成功率方差 | 已迁入，作为报告统计增强候选 |
| `api.py` | FastAPI 统计查询和 batch endpoint | 已迁入，但 batch endpoint 依赖缺失 `attack_runner.py`，不作为 P2 默认服务 |

当前新增脚本:

```bash
npm run pyrit:bridge-smoke
```

该脚本只做:

- Python 可用性检查。
- `py_compile` 语法检查。
- 确认 `run_attack_cli.py` 保留核心攻击方法。
- 确认 `api.py` 对缺失 batch runner 有明确错误边界。

它不调用真实模型、不发网络、不写 evaluator 数据库。

## 3. 建议 bridge 输入契约

后续如接入真实 PyRIT，建议新增独立 bridge 请求对象，不直接复用 `TestContext` 全量对象。

```ts
type PyritBridgeRequest = {
  schemaVersion: "mvp-1"
  requestId: string
  caseId: string
  sampleId: string
  method:
    | "prompt_sending"
    | "flip"
    | "red_teaming"
    | "crescendo"
    | "context_compliance"
    | "role_play"
    | "many_shot_jailbreak"
    | "renellm"
  objective: string
  maxTurns?: number
  timeoutMs: number
  outputDir: string
  evaluatorSync: boolean
  envKeys: string[]
}
```

约束:

- `objective` 必须来自 A 线安全 fixture 或显式人工输入，不从前端自由拼接。
- `outputDir` 必须限制在 `outputs/pyrit-runs/**`。
- `envKeys` 只允许列环境变量名，不能保存密钥值。
- 默认 `evaluatorSync=false`，避免无意写入 SQLite。

## 4. 建议 bridge 输出契约

```ts
type PyritBridgeResult = {
  schemaVersion: "mvp-1"
  requestId: string
  caseId: string
  sampleId: string
  status: "completed" | "failed" | "skipped"
  method: PyritBridgeRequest["method"]
  startedAt: string
  endedAt: string
  outputJsonPath?: string
  executedTurns?: number
  outcome?: string
  outcomeReason?: string
  lastScore?: {
    value?: string | boolean | number
    scoreType?: string
    scoreRationale?: string
  }
  lastResponsePreview?: string
  metrics?: {
    answerGrade?: 0 | 1 | 2
    similarity?: number
    iterCount?: number
    mutateTotalCount?: number
  }
  error?: string
}
```

约束:

- `lastResponsePreview` 必须截断和脱敏。
- 不能把完整模型输出、完整 jailbreak 模板或密钥写进正式 API。
- 如果 PyRIT 产生的输出包含疑似 secret，bridge 必须先落本地隔离文件，再由 C 线决定是否进入报告。

## 5. 安全边界

必须满足:

- 子进程 timeout。
- 运行目录固定。
- 输出路径 allowlist。
- 不允许 Python bridge 修改 `configs/**`。
- 不允许 bridge 写入 `third_party/**`。
- 默认不启用真实网络，除非用户显式配置模型 target 环境。
- 所有失败都要结构化返回，不能让 API 层吞异常。

## 6. 与 P2 主链路的关系

P2 默认完成定义仍以 TS 可复现链路为准:

```txt
PyRIT source/config/index
  -> TestCase
  -> sandbox deterministic behavior
  -> trace/risk/policy/report
```

Python bridge 后续最多作为增强入口:

```txt
PyRITBridgeResult
  -> 生成额外 evidence artifact
  -> C 线可选纳入 DetectionReport 统计
```

它不能替代 B 线真实 Agent trace，也不能直接生成 C 线风险结论。
