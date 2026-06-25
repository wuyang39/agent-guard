# Agent Guard Docker 沙箱方案

检测阶段通过 OpenClaw 内置 Docker 沙箱隔离所有原生工具执行，
实现「风险完整披露，宿主机零影响」。

---

## 架构

```
检测阶段 (Docker 沙箱):
  OpenClaw Gateway (宿主机)
      │
      ├─ exec → Docker 容器内执行 ──→ 容器文件系统
      ├─ read → Docker 容器内读取 ──→ 容器文件系统
      ├─ write → Docker 容器内写入 ──→ 容器文件系统
      └─ web_fetch → 容器网络（默认无网络）
  
监督阶段 (插件拦截):
  OpenClaw Gateway (宿主机)
      │
      ├─ exec → before_tool_call 插件 → Agent Guard 判定
      ├─ read → before_tool_call 插件 → Agent Guard 判定
      └─ ...同
```

---

## 实施步骤

### 第一步：启动 Docker Desktop

```powershell
# 启动 Docker Desktop（如果用的是 Docker Desktop）
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# 等它启动完成后验证
docker info
```

### 第二步：构建沙箱镜像

```powershell
# 构建默认沙箱镜像（含 python3, curl, jq 等）
docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash ca-certificates curl git jq python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox
CMD ["sleep", "infinity"]
DOCKERFILE
```

### 第三步：切换检测阶段配置

用脚本或直接改 `openclaw.json`：

```json5
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",                // 所有会话都走沙箱
        "scope": "session",           // 每会话独立容器
        "backend": "docker",          // Docker 后端
        "workspaceAccess": "none",    // 不挂载 workspace（只读可选）
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "network": "none",          // 默认无网络出站
          "readOnlyRoot": false,      // 容器内可写
          "binds": []                 // 不挂载宿主机路径
        }
      }
    }
  },
  "tools": {
    "profile": "coding"               // 所有原生工具全开
  }
}
```

#### 效果

| 工具 | 检测阶段（Docker 沙箱） | 监督阶段（插件拦截） |
|------|-----------------------|-------------------|
| `exec` | 容器内执行 ✅ 安全 | 插件拦截 ✅ 安全 |
| `read` | 容器内文件系统 ✅ | 插件拦截 ✅ |
| `write` | 容器内文件系统 ✅ | 插件拦截 ✅ |
| `web_fetch` | 容器内网络（none=无网络）✅ | 插件拦截 ✅ |
| 宿主机 | ❌ 碰不到 | ❌ 碰不到（政策封禁） |

### 第四步：监督阶段配置

切换后移除 sandbox 配置，加载插件：

```json5
{
  // 不设 sandbox（工具跑在宿主机）
  "tools": {
    "profile": "coding"
  },
  "plugins": {
    "entries": {
      "agent-guard-supervision": {
        "enabled": true,
        "source": "local",
        "path": "E:\\agent-guard\\plugins\\agent-guard-supervision"
      }
    }
  },
  "mcp": {
    "servers": {
      "agent_guard": {
        "transport": "streamable-http",
        "url": "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp"
      }
    }
  }
}
```

### 第五步：更新演示脚本

`scripts/demo-competition.ps1` 加入 Docker 沙箱模式：

```powershell
"detection" {
  # 写入 sandbox 配置
  # 原生工具全开但在 Docker 沙箱内执行
}

"supervised" {
  # 移除 sandbox
  # 启用 agent-guard-supervision 插件
  # 启用 Agent Guard MCP 网关
}
```

### 第六步：验证沙箱隔离

```powershell
# 运行一个测试命令，确认在容器内
openclaw gateway restart

# 在检测阶段让 agent 执行:
# exec → whoami
# 预期: sandbox（容器内用户）
# exec → ls /
# 预期: 容器文件系统，没有 C:\
```

---

## Docker 沙箱注意事项

| 项目 | 说明 |
|------|------|
| 镜像大小 | ~150MB（Debian bookworm-slim + 基础工具） |
| 网络 | 默认 `"none"`，容器无网络出站（web_fetch 会失败） |
| 工作区 | `workspaceAccess: "none"` 不暴露宿主机文件 |
| 性能 | 首次启动拉取镜像较慢，后续秒级启动 |
| 持久化 | 容器重启后文件丢失（对检测阶段正好：每次测试都是干净的） |

---

## 答辩演示流程

```
[第一阶段: 检测 — Docker 沙箱内]
  配置: sandbox.mode="all"
  Agent 调 exec/read/write → 全在容器内
  检测报告: "agent 尝试用 exec 读取 /etc/passwd" → ✅ 风险已披露
  观众证明: 宿主机未受影响 ✅

[第二阶段: 监督 — 插件拦截]
  配置: 插件 + Agent Guard
  Agent 调 exec/read/write → 插件阻断
  LiveSupervisionPage: 实时告警 ✅
  
[第三阶段: 对比报告]
  无监督 vs 有监督
  风险等级从 critical → low
  工具审计显示 bypass 尝试
```

---

## 验证清单

- [ ] Docker Desktop 已启动
- [ ] `openclaw-sandbox:bookworm-slim` 镜像已构建
- [ ] 检测阶段配置已写入 openclaw.json
- [ ] 重启后 exec 命令在容器内执行
- [ ] `demo-competition.ps1 -Mode detection` 一键切换
- [ ] `demo-competition.ps1 -Mode supervised` 一键切换
- [ ] 监督阶段插件生效
- [ ] 前端 LiveSupervisionPage 显示阻断事件
