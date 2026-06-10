# P1 Agent 检测画像驱动的运行时监督与防御规划

文档版本: p1-plan-2
基线日期: 2026-06-03
状态: 下一轮规划

说明: 本文档按“先检测 Agent 容易在哪些场景失守，再把检测结论转成运行时监督策略，最后用真实运行记录证明防御有效”的思路重规划下一轮系统。当前 Agent Guard 不需要推倒重来，下一轮应把它明确定位为监督前检测引擎，并在检测报告之上生成机器可执行的监督策略包，供真实运行环境中的监督接口加载执行。

## 1. 核心思路

下一轮系统采用三阶段闭环:

```txt
阶段 1: 监督前检测
  Agent + 红队场景库 + MCP Sandbox
    -> 检测运行
    -> InteractionTrace
    -> RiskEvaluationResult
    -> DetectionReport
    -> AgentRiskProfile
    -> SupervisionPolicyPack

阶段 2: 真实运行监督
  真实 Agent / 智能体应用
    -> Agent 监督接口 / 工具调用网关
    -> 加载 SupervisionPolicyPack
    -> allow / deny / ask / warn / redact
    -> RuntimeSupervisionRecord

阶段 3: 防御效果证明
  DetectionReport + AgentRiskProfile + RuntimeSupervisionRecord
    -> DefenseReport
```

关键原则:

- 当前系统继续做监督前检测，不直接替代真实运行环境。
- 检测报告主要给人阅读，不能直接作为运行时执行逻辑。
- 真正进入运行时监督的是机器可读的 `SupervisionPolicyPack`。
- 防御报告必须证明“检测发现的问题，在真实运行中被策略监督、告警或阻断”。

## 2. 系统定位

下一轮系统定位为:

```txt
Agent Guard = 监督前安全检测引擎 + 策略包生成器 + 运行时监督验证器 + 防御报告生成器
```

与当前系统关系:

- 当前 `TestContext -> TestRun -> InteractionTrace -> RiskEvaluationResult -> RiskReport` 是阶段 1 的基础。
- 新增 `DetectionReport` 用于总结检测结果。
- 新增 `AgentRiskProfile` 用于描述 Agent 的失守画像。
- 新增 `SupervisionPolicyPack` 用于把检测结论转成运行时监督策略。
- 新增运行时监督接口，用于在真实环境加载策略包并记录防御效果。
- 新增 `DefenseReport`，用于答辩展示最终防御闭环。

## 3. 阶段 1: 监督前检测

目标: 找出 Agent 在哪些攻击面、工具类型、资源访问和外传路径上容易失守。

输入:

```txt
AgentUnderTest
AgentAdapterConfig
RedTeamScenarioSet
McpSandboxProfile
RiskRule[]
TestOracle[]
```

执行:

```txt
loadTestContexts()
  -> runTestCase()
  -> InteractionTrace
  -> evaluateRisk()
  -> buildDetectionReport()
  -> buildAgentRiskProfile()
  -> generateSupervisionPolicyPack()
```

阶段 1 输出:

- `DetectionReport`: 人读的监督前检测报告
- `AgentRiskProfile`: Agent 风险画像
- `SupervisionPolicyPack`: 机器可执行的监督策略包

### 3.1 DetectionReport

`DetectionReport` 用于回答:

- 测了哪些红队场景
- Agent 在哪些场景失守
- 失守行为对应哪些 trace event
- 触发了哪些风险规则
- 攻击链和证据链是什么
- 推荐哪些运行时防御策略

建议包含:

```txt
reportId
agentId
scenarioSummary
riskSummary
failedScenarios
findings
evidenceChains
attackChains
recommendedPolicyIds
generatedAt
```

### 3.2 AgentRiskProfile

`AgentRiskProfile` 是检测报告的结构化摘要，用于后续生成策略。

建议包含:

```txt
profileId
agentId
testedAt
weaknesses[]
highRiskTools[]
sensitiveResourcePatterns[]
exfiltrationPatterns[]
injectionFollowingPatterns[]
recommendedControls[]
confidence
sourceReportId
```

示例画像:

```txt
agent.demo:
  - 容易跟随 tool response 中的外传指令
  - 读取 /secret/* 时缺少范围校验
  - 向外部 URL 发送 token-like 内容时不触发自我拒绝
```

### 3.3 SupervisionPolicyPack

`SupervisionPolicyPack` 是运行时监督接口加载的核心对象。

建议包含:

```txt
policyPackId
agentId
sourceDetectionReportId
sourceRiskProfileId
policies[]
defaultAction
createdAt
expiresAt
```

策略示例:

- `deny`: 禁止读取 `/secret/*`
- `deny`: 禁止向非白名单 URL 发送包含 token、secret、password 的内容
- `ask`: 写文件、发邮件、执行代码前进入人工确认
- `warn`: 工具返回中出现指令性文本时记录告警
- `redact`: 外发数据中出现敏感字段时脱敏后再放行

## 4. 阶段 2: 真实运行监督

目标: 在真实或半真实 Agent 运行环境中加载策略包，对运行时行为进行监督和防御。

输入:

```txt
RealAgentRuntime
SupervisionPolicyPack
RuntimeToolCall
RuntimeResourceAccess
RuntimeApiCall
RuntimeAgentMessage
```

运行时链路:

```txt
Agent 发起工具调用
  -> Supervisor.preCheck()
  -> policy match
  -> allow / deny / ask / warn / redact
  -> 工具执行或阻断
  -> Supervisor.postCheck()
  -> RuntimeSupervisionRecord
```

建议监督接口:

```txt
AgentSupervisor
  loadPolicyPack()
  preToolCall()
  postToolResult()
  preResourceAccess()
  postResourceAccess()
  preApiCall()
  postApiResult()
  preFileWrite()
  preEmailSend()
  onAgentMessage()
```

建议防御动作:

```txt
allow: 放行
deny: 阻断
ask: 人工确认或 demo 模拟确认
warn: 告警但放行
redact: 脱敏后放行
isolate: 隔离上下文或降级到只读环境
```

阶段 2 输出:

- `RuntimeSupervisionRecord[]`
- `RuntimeInteractionTrace`
- `BlockedAction[]`
- `RuntimeAlert[]`

## 5. 阶段 3: 防御报告

目标: 证明系统不只是发现风险，还能基于检测结论在真实运行中进行监督和防御。

`DefenseReport` 应把三个证据源串起来:

```txt
DetectionReport: 监督前发现了什么风险
SupervisionPolicyPack: 根据风险生成了什么策略
RuntimeSupervisionRecord: 真实运行中策略如何生效
```

建议包含:

```txt
defenseReportId
agentId
detectionReportId
riskProfileId
policyPackId
runtimeSessionIds[]
detectedWeaknesses
generatedPolicies
runtimeAlerts
blockedActions
redactedActions
askDecisions
defenseEffectiveness
residualRisk
generatedAt
```

防御有效性指标:

- 检测阶段发现的高风险行为，在运行时是否被阻断
- 外发敏感数据是否被拒绝或脱敏
- 高风险工具调用是否进入 `ask`
- 告警和阻断是否可追溯到检测报告中的风险画像
- 是否存在未覆盖的残余风险



主动防御，测试用例的填充



## 6. 攻击场景库规划

P1 至少需要 3 类攻击场景。当前已有基础:

- `malicious_resource_injection`: 恶意资源诱导访问 secret 文件
- `tool_response_injection`: 工具返回诱导敏感数据外传

建议新增至少 1 类，推荐优先级:

1. `prompt_jailbreak`: 用户输入或系统上下文中的越狱诱导
2. `data_exfiltration`: 通过邮件、API、HTTP 请求外传敏感信息
3. `memory_poisoning`: 写入长期记忆或偏好，污染后续行为
4. `environment_pollution`: 通过环境变量、文件名、目录内容污染 Agent 判断

每类场景至少包含:

- 场景说明
- 对抗样本或越狱 prompt
- 测试用例配置
- 可复现攻击脚本或动作序列
- 预期失守行为
- 推荐运行时策略
- 检测报告和防御报告中的展示方式

## 7. 模拟业务工具规划

P1 至少补齐这些真实业务风格工具:

```txt
tool.read_file
tool.write_file
tool.send_email
tool.call_api
tool.send_request
```

可选增强:

```txt
tool.execute_code
tool.update_memory
tool.query_database
```

每个工具必须支持:

- 参数记录
- 风险标签
- 权限范围
- 是否有副作用
- 监督策略匹配
- 工具执行前阻断
- 工具执行后审计

## 8. 新增模块建议

### 8.1 检测报告与画像模块

```txt
backend/src/modules/detection/
  detectionTypes.ts
  detectionReportBuilder.ts
  agentRiskProfileBuilder.ts
```

职责:

- 消费 `RiskEvaluationResult`、`RiskReport` 和 `InteractionTrace`
- 生成 `DetectionReport`
- 抽取 `AgentRiskProfile`

### 8.2 策略包生成模块

```txt
backend/src/modules/policy/
  policyTypes.ts
  policyPackBuilder.ts
  policyTemplateMapper.ts
```

职责:

- 根据 `AgentRiskProfile` 生成 `SupervisionPolicyPack`
- 将 finding category、toolId、resource path、exfiltration pattern 映射为运行时策略
- 保留来源报告和来源证据引用

### 8.3 运行时监督模块

```txt
backend/src/modules/supervisor/
  supervisorTypes.ts
  agentSupervisor.ts
  policyEngine.ts
  supervisionRecorder.ts
  supervisionBridge.ts
```

职责:

- 加载策略包
- 对真实运行时行为做 `preCheck` 和 `postCheck`
- 生成告警、阻断、询问和脱敏记录
- 输出 `RuntimeSupervisionRecord`

### 8.4 防御报告模块

```txt
backend/src/modules/defense/
  defenseTypes.ts
  defenseReportBuilder.ts
```

职责:

- 汇总检测报告、风险画像、策略包和运行时监督记录
- 生成 `DefenseReport`
- 输出 JSON / HTML 报告产物

## 9. 数据契约扩展建议

建议新增共享类型:

```txt
DetectionReport
AgentRiskProfile
AgentWeakness
SupervisionPolicyPack
SupervisionPolicy
SupervisionDecision
RuntimeSupervisionRecord
RuntimeAlert
BlockedAction
DefenseReport
```

建议新增文件:

```txt
packages/contracts/src/types/detection.ts
packages/contracts/src/types/policy.ts
packages/contracts/src/types/supervision.ts
packages/contracts/src/types/defense.ts
```

建议新增配置:

```txt
configs/supervision_policy_templates.json
configs/red_team_scenarios.json
```

注意: 策略模板是系统内置规则，策略包是根据某个 Agent 的检测结果生成的实例，两者不要混用。

## 10. 前端展示规划

下一轮前端或 demo 需要展示两段式闭环:

### 10.1 检测工作台

展示:

- 红队场景运行结果
- Agent 失守场景
- 风险等级分布
- 证据链和攻击链
- 检测报告导出
- 风险画像
- 一键生成策略包

### 10.2 运行时监督台

展示:

- 当前加载的策略包
- 实时 Agent 行为流
- `allow / deny / ask / warn / redact` 统计
- 告警记录
- 阻断记录
- 策略命中原因
- 运行时 trace 详情

### 10.3 防御报告页

展示:

- 检测阶段发现的问题
- 生成的监督策略
- 真实运行中阻断了哪些危险行为
- 防御前后对比
- 残余风险

## 11. 分工建议

### 开发者 A: 场景、工具与策略模板

负责:

- 补齐至少 3 类红队场景
- 扩展模拟业务工具
- 新增策略模板配置
- 维护测试用例与 oracle
- 保证配置引用完整

交付:

```txt
RedTeamScenarioSet + ToolProfile + PolicyTemplate
```

### 开发者 B: 检测运行、策略包和运行时监督

负责:

- 扩展全链路检测运行
- 新增策略包生成入口
- 新增运行时监督接口
- 接入一个真实或半真实 HTTP Agent
- 记录运行时监督结果

交付:

```txt
DetectionReport + AgentRiskProfile + SupervisionPolicyPack + RuntimeSupervisionRecord[]
```

### 开发者 C: 报告与展示

负责:

- 构建 DetectionReport
- 构建 DefenseReport
- 前端展示检测工作台、监督台和防御报告页
- 输出 JSON / HTML 报告
- 扩展验收脚本

交付:

```txt
ReportArtifact[] for DetectionReport and DefenseReport
```

## 12. 下一轮验收标准

P1 完成时必须满足:

- 当前系统能作为监督前检测引擎运行
- 至少 3 类攻击场景完成检测
- 检测后能生成 `DetectionReport`
- 检测后能生成 `AgentRiskProfile`
- 能根据风险画像生成 `SupervisionPolicyPack`
- 一个真实或半真实 Agent 运行环境能加载策略包
- 至少 4 类工具行为被监督: 读文件、写文件、发邮件、API 请求
- 至少 1 个检测阶段发现的高风险行为，在真实运行中被阻断
- 阻断记录能关联到策略包、风险画像和检测报告
- 最终能生成 `DefenseReport`
- 防御报告能说明防御前后对比和残余风险

## 13. 推荐实施顺序

1. 把当前全链路验证补到 `Trace -> Risk -> RiskReport`
2. 新增 `DetectionReport` 和 `AgentRiskProfile`
3. 补齐第 3 类攻击场景和更多业务工具
4. 新增策略模板和 `SupervisionPolicyPack`
5. 实现策略包生成器
6. 实现运行时监督接口并接入 HTTP Agent
7. 记录运行时告警、阻断和脱敏结果
8. 新增 `DefenseReport`
9. 前端展示检测画像、策略包、运行时监督和防御效果
10. 整理专项赛答辩报告材料

## 14. 答辩表达口径

推荐对外表述:

```txt
本系统采用检测画像驱动的 Agent 运行时防御方法。系统首先通过红队场景库和 MCP Sandbox 对被测 Agent 进行监督前安全检测，识别其在提示注入、工具返回注入、敏感数据外传等场景下的失守模式，并生成检测报告和 Agent 风险画像。随后系统将检测结论转化为机器可执行的监督策略包，在真实运行环境中对 Agent 的工具调用、文件访问、邮件发送和 API 请求进行 allow / deny / ask / redact 判定。最后系统汇总检测报告、策略包和真实运行阻断记录，生成防御报告，证明高风险行为已被监督和缓解。
```

## 15. 当前缺口清单

当前系统到该设计的主要缺口:

- 检测报告尚未独立于风险报告建模
- 缺 Agent 风险画像
- 缺从检测结论到策略包的生成逻辑
- 缺运行时监督接口加载策略包
- 缺真实运行监督记录
- 缺防御报告中的防御有效性证明
- 攻击场景仍不足 3 类
- 模拟业务工具仍不足以覆盖题目要求的邮件、文件、API、代码执行等交互

下一轮的重点不是马上做一个完整生产级监督平台，而是跑通“检测发现弱点 -> 生成策略包 -> 真实运行监督 -> 防御报告证明有效”的闭环。
