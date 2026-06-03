# 开发者 D 前端交接说明

文档版本: initial-1
基线日期: 2026-05-21
状态: 前端开工说明

## 1. D 的定位

D 是正式 Frontend Web Console 负责人，不是第四条后端生产线。D 的工作目标是把 A/B/C 产出的检测、运行、风险、监督和防御结果做成可演示、可追溯、可答辩的前端界面。

D 只消费:

```txt
Backend API response
ReportArtifact[]
packages/contracts types
```

D 不直接生产:

```txt
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord[]
DefenseReport
```

这些对象分别由后端模块生成，前端只负责展示、筛选、跳转、导出入口和用户操作请求。

## 2. 第一轮页面优先级

优先实现能支撑答辩主线的页面，不先做装饰型首页。

第一优先级:

```txt
Dashboard
Detection
Supervision
DefenseReports
TraceDetail
RiskReports
```

第二优先级:

```txt
AgentConnect
TestRuns
TestCases
Configs
System
```

建议主流程:

```txt
Dashboard
  -> Detection report detail
  -> Agent risk profile
  -> Generated policy pack
  -> Runtime supervision records
  -> Defense report
  -> Trace / evidence detail
```

## 3. D 的目录

D 主责:

```txt
frontend/src/**
frontend/public/**
frontend/tests/**
```

建议新增或完善:

```txt
frontend/src/pages/Detection/
frontend/src/pages/Supervision/
frontend/src/pages/DefenseReports/
frontend/src/components/detection/
frontend/src/components/policy/
frontend/src/components/supervision/
frontend/src/components/defense/
frontend/src/lib/api/
frontend/src/lib/models/
frontend/src/lib/formatters/
```

`frontend/demo/**` 只能作为展示原型参考，不得被正式前端引用，也不得反向决定 contracts 字段。

## 4. API Client 设计

D 不在页面里直接拼接数据源。所有后端访问先进入 `frontend/src/lib/api/**`，页面只调用 API client 或 hook。

建议 API client 分组:

```txt
agents
testRuns
traces
risks
reports
detection
policies
supervision
defense
system
```

每个 API client 返回共享契约对象或前端 view model，不返回后端私有类。

## 5. ViewModel 规则

D 可以创建前端私有 view model，但不得改变共享契约语义。

允许:

```txt
RiskLevel -> badgeColor
Finding[] -> groupedFindings
RuntimeSupervisionRecord[] -> timelineItems
DefenseReport -> defenseSummaryCards
```

禁止:

```txt
重新计算 riskLevel
重新推导 AgentRiskProfile
根据前端逻辑生成 SupervisionPolicyPack
根据页面展示统计编造 defenseEffectiveness
```

## 6. 联调输入

D 第一轮可以使用 mock API response，但 mock 必须来自 `packages/contracts` 类型，不得使用 demo 私有 payload 当作正式契约。

联调时 D 至少需要后端提供:

```txt
GET detection report detail
GET agent risk profile
GET policy pack detail
GET runtime supervision records
GET defense report detail
GET trace detail by traceId
GET risk report detail
```

如果后端 API 未完成，D 可以先在 `frontend/src/lib/api/**` 中保留 mock adapter，但必须让 mock adapter 与正式 API client 同接口。

## 7. 禁止事项

D 不得:

- 直接 import `backend/src/**`
- 直接读取 `configs/*.json`
- 直接读取 `outputs/**` 原始文件作为业务数据源
- 在前端重新判定风险等级
- 在前端生成策略包或防御报告
- 使用 `frontend/demo/**` 的字段反向修改 `packages/contracts`
- 未经协调人冻结流程修改 `packages/contracts/src/types/**`

## 8. D 合并前检查

合并前必须确认:

- 页面数据来自 API client、report artifact 或 contracts
- 前端类型来自 `@agent-guard/contracts` 或前端私有 view model
- Detection、Supervision、DefenseReports 页面都能展示空状态、加载状态和错误状态
- 所有详情页都保留 `reportId`、`traceId`、`policyPackId` 或 `runtimeSessionId` 的追溯入口
- 没有把前端展示逻辑写入后端模块
- 没有让后端对象为了页面样式增加展示专用字段

## 9. 给协调人的检查点

D 开工前，协调人应先冻结:

```txt
DetectionReport
AgentRiskProfile
SupervisionPolicyPack
RuntimeSupervisionRecord
DefenseReport
主要 API response shape
```

D 每新增一个页面，应同步确认:

```txt
页面消费哪些对象
是否需要新增 API
是否需要新增 view model
是否涉及 contracts 字段变更
是否影响 A/B/C 的交付物
```
