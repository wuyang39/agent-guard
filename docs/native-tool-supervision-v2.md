# Agent Guard — 原生工具监督方案 v2

> 修正版：registerHook 接口 + 全工具评估 + ask 通道 + 分级 fail-close

---

## 总体架构

```
OpenClaw Agent 调用任意工具
        │
        ▼
┌─────────────────────────────┐
│  before_tool_call hook       │  ← Agent Guard Plugin
│  (拦截所有工具，跳过已监管的)  │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  Agent Guard 原生工具评估     │
│  POST /supervision/eval      │
│                              │
│  1. 工具名归一化              │
│  2. payload 标准化            │
│  3. supervisor.preCheck()    │
│  4. 策略判定                  │
│  5. 记录 RuntimeSupervision  │
│  6. 推送实时事件              │
│  7. ask 通道处理              │
└──────────┬──────────────────┘
           │
    ┌──────┴──────┐
    ▼              ▼
 allow/deny     ask → askChannel
    │              │
    ▼              ├─ Agent Guard 前端显示 pending
 返回给 hook      ├─ 人工点通过/拒绝
    │              └─ 结果返回 hook
    ▼
 OpenClaw 执行或阻断
```

---

## 优先级路线图

| 优先级 | 层级 | 内容 | 状态 |
|-------|------|------|------|
| 🔴 P0 | 配置 | `openclaw.json` 封锁原生工具（兜底线） | ✅ 可立即生效 |
| 🔴 P1 | 插件 | `registerHook("before_tool_call", ...)` 插件 | 待编写 |
| 🔴 P2 | 后端 | 完整的 `/supervision/eval` 端点 | 待新增 |
| 🟡 P3 | 前端 | native_tool_hook 事件展示 + ask 面板 | 待扩展 |
| 🟡 P4 | 测试集 | bypass 测试用例 | 待新增 |
