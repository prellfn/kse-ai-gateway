<#
    Codex CLI — kse-ai-gateway 接入安装脚本

    作用:
      1. 把 MCP Server 配置写入 ~/.codex/config.toml (幂等追加)
      2. 安装 kse-scan Skill 到 ~/.codex/skills/kse-scan/

    用法:
      powershell -ExecutionPolicy Bypass -File install.ps1 `
        -ScanGateway "http://10.0.0.1:8000" `
        -PythonPath "/opt/ai-stack/mcp-venv/bin/python" `
        -ServerPath "/opt/ai-stack/mcp-server/server.py"
#>
param(
    [string]$ScanGateway = "http://127.0.0.1:8000",
    [string]$PythonPath = "/opt/ai-stack/mcp-venv/bin/python",
    [string]$ServerPath = "/opt/ai-stack/mcp-server/server.py",
    [string]$CodexHome = "$env:USERPROFILE\.codex",
    [switch]$SkipSkill
)

$ErrorActionPreference = "Stop"

Write-Host "=============================================="
Write-Host " Codex — kse-ai-gateway 接入安装"
Write-Host "=============================================="

# ---------------------------------------------------------------------------
# 1. MCP 配置
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null
$configPath = Join-Path $CodexHome "config.toml"

$block = @"
[mcp_servers.kse-ai-gateway]
command = "$PythonPath"
args = ["$ServerPath"]
env = { KSE_SCAN_GATEWAY = "$ScanGateway", KSE_SCAN_TIMEOUT = "300" }
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 180
"@

if (Test-Path $configPath) {
    $existing = Get-Content -Raw -Encoding UTF8 $configPath
    if ($existing -match '\[mcp_servers\.kse-ai-gateway\]') {
        Write-Host "[1/2] config.toml 已存在 kse-ai-gateway 配置, 跳过 (如需修改请手工编辑)"
    } else {
        Add-Content -Path $configPath -Value "`n$block" -Encoding UTF8
        Write-Host "[1/2] 已追加 MCP 配置到 $configPath"
    }
} else {
    Set-Content -Path $configPath -Value $block -Encoding UTF8
    Write-Host "[1/2] 已创建 $configPath"
}

# ---------------------------------------------------------------------------
# 2. Skill
# ---------------------------------------------------------------------------
if ($SkipSkill) {
    Write-Host "[2/2] 跳过 Skill 安装"
} else {
    $skillSrc = Join-Path $PSScriptRoot "skills\kse-scan"
    $skillDst = Join-Path $CodexHome "skills\kse-scan"
    if (-not (Test-Path $skillSrc)) {
        Write-Warning "未找到 Skill 源目录: $skillSrc"
    } else {
        New-Item -ItemType Directory -Force -Path $skillDst | Out-Null
        Copy-Item -Path (Join-Path $skillSrc "*") -Destination $skillDst -Recurse -Force
        Write-Host "[2/2] 已安装 Skill 到 $skillDst"
    }
}

Write-Host ""
Write-Host "完成。验证:"
Write-Host "  codex mcp list"
Write-Host "  (新开一个 Codex 会话后可用 kse_status 确认连通性)"