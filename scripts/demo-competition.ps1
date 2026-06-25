<#
.SYNOPSIS
  Agent Guard 比赛演示 — 切换 无监督/有监督 模式

.DESCRIPTION
  无监督模式 (baseline):
    - OpenClaw 原生工具全部开放 (profile: "coding")
    - 不加载 agent_guard MCP 网关
    - Agent 可自由使用 exec/read/write/web_search 等工具
  
  有监督模式 (supervised):
    - OpenClaw 原生工具由 Agent Guard 插件拦截
    - Agent Guard MCP 网关加载策略包
    - Agent Guard 前端实时展示阻断事件

.PARAMETER Mode
  baseline | supervised

.EXAMPLE
  .\demo-competition.ps1 -Mode baseline
  .\demo-competition.ps1 -Mode supervised
#>

param(
    [Parameter(Mandatory)]
    [ValidateSet("baseline", "supervised")]
    [string]$Mode
)

$openclawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json"
$backupPath = "$openclawConfigPath.$Mode.backup"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Agent Guard 演示模式切换" -ForegroundColor Cyan
Write-Host " 模式: $Mode" -ForegroundColor Yellow
Write-Host "=========================================" -ForegroundColor Cyan

# 备份当前配置
Copy-Item $openclawConfigPath $backupPath -Force
Write-Host "✅ 已备份当前配置到 $backupPath" -ForegroundColor Gray

# 读取当前配置
$config = Get-Content $openclawConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

switch ($Mode) {
    "baseline" {
        # === 无监督模式 ===
        # 1. 工具配置: coding profile（所有原生工具全开）
        $config.tools = @{
            profile = "coding"
        } | ConvertTo-Json | ConvertFrom-Json

        # 2. 移除 Agent Guard MCP 网关
        $config.mcp = @{
            servers = @{}
        } | ConvertTo-Json | ConvertFrom-Json

        # 3. 移除插件配置（如果有）
        if ($config.plugins.entries.PSObject.Properties.Name -contains "agent-guard-supervision") {
            $config.plugins.entries.PSObject.Properties.Remove("agent-guard-supervision")
        }

        # 4. 移除 sandbox 配置
        if ($config.agents.defaults.PSObject.Properties.Name -contains "sandbox") {
            $config.agents.defaults.PSObject.Properties.Remove("sandbox")
        }

        Write-Host ""
        Write-Host "🔴 已切换到「无监督」模式" -ForegroundColor Red
        Write-Host "   原生工具: 全部可用 (exec / read / write / web_search ...)" -ForegroundColor Gray
        Write-Host "   Agent Guard: 未连接" -ForegroundColor Gray
        Write-Host "   Agent 行为: 不受任何约束" -ForegroundColor Red
    }

    "supervised" {
        # === 有监督模式 ===
        # 1. 工具配置: coding profile（工具仍在，但将由插件拦截）
        $config.tools = @{
            profile = "coding"
        } | ConvertTo-Json | ConvertFrom-Json

        # 2. 配置 Agent Guard MCP 网关
        $config.mcp = @{
            servers = @{
                agent_guard = @{
                    transport = "streamable-http"
                    url = "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp"
                    timeout = 20
                    connectTimeout = 5
                }
            }
        } | ConvertTo-Json | ConvertFrom-Json

        # 3. 配置 Agent Guard 监督插件
        if (-not $config.plugins) {
            $config | Add-Member -NotePropertyName "plugins" -NotePropertyValue @{ entries = @{} }
        }
        if (-not $config.plugins.entries) {
            $config.plugins | Add-Member -NotePropertyName "entries" -NotePropertyValue @{}
        }
        $config.plugins.entries | Add-Member -NotePropertyName "agent-guard-supervision" -NotePropertyValue @{
            enabled = $true
            source = "local"
            path = "E:\agent-guard\plugins\agent-guard-supervision"
        } -Force

        Write-Host ""
        Write-Host "🟢 已切换到「有监督」模式" -ForegroundColor Green
        Write-Host "   原生工具: 由 Agent Guard 插件实时拦截并评估" -ForegroundColor Gray
        Write-Host "   Agent Guard MCP: 已连接" -ForegroundColor Gray
        Write-Host "   监督策略: 活动状态" -ForegroundColor Green
        Write-Host ""
        Write-Host "   🔸 Live Supervision 页面: http://127.0.0.1:5173/supervision" -ForegroundColor Cyan
        Write-Host "   🔸 策略包状态: http://127.0.0.1:3100/api/v1/openclaw/realtime/supervision/status" -ForegroundColor Cyan
    }
}

# 写回配置文件
$config | ConvertTo-Json -Depth 10 | Set-Content $openclawConfigPath -Encoding UTF8

Write-Host ""
Write-Host "✅ 配置已写入: $openclawConfigPath" -ForegroundColor Green
Write-Host ""
Write-Host "⚠️ 需要重启 OpenClaw Gateway 使配置生效" -ForegroundColor Yellow
Write-Host "   命令: openclaw gateway restart" -ForegroundColor White
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
