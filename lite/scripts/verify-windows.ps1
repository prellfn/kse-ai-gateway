<#
    kse-ai-gateway — Windows 端验证脚本

    覆盖:
      W1  Scan Gateway 从 Windows 可达
      W2  scan/upload 干净内容 -> CLEAN
      W3  scan/upload EICAR    -> DETECT
      W4  OpenClaw 插件 handleBeforeToolCall 单元验证 (write 拦截)
      W5  KSE File Watcher 监控 + 隔离
      W6  隔离目录与日志

    用法:
      powershell -ExecutionPolicy Bypass -File verify-windows.ps1 `
        -ScanGateway "http://10.0.0.1:8000" `
        -PluginPath "$env:USERPROFILE\.openclaw\plugins\kse-gate\index.js" `
        -WatchDir  "$env:USERPROFILE\.openclaw\workspace"
#>
param(
    [string]$ScanGateway = "http://127.0.0.1:8000",
    [string]$PluginPath = "$env:USERPROFILE\.openclaw\plugins\kse-gate\index.js",
    [string]$WatchDir = "$env:USERPROFILE\.openclaw\workspace",
    [string]$QuarantineDir = "$env:USERPROFILE\.openclaw\quarantine",
    [string]$WatcherLog = "$env:USERPROFILE\.openclaw\kse-watcher.log",
    [int]$WatchWaitSeconds = 15
)

$ErrorActionPreference = "Continue"
$script:Pass = 0; $script:Fail = 0; $script:Skip = 0; $script:Warn = 0

function Write-Ok($name, $msg) {
    $script:Pass++
    Write-Host "  [PASS]  {0,-44} {1}" -f $name, $msg -ForegroundColor Green
}
function Write-Bad($name, $msg) {
    $script:Fail++
    Write-Host "  [FAIL]  {0,-44} {1}" -f $name, $msg -ForegroundColor Red
}
function Write-Skip($name, $msg) {
    $script:Skip++
    Write-Host "  [SKIP]  {0,-44} {1}" -f $name, $msg -ForegroundColor Yellow
}
function Write-Warn($name, $msg) {
    $script:Warn++
    Write-Host "  [WARN]  {0,-44} {1}" -f $name, $msg -ForegroundColor Yellow
}
function Section($t) { Write-Host "`n-- $t ----------------------------------------" -ForegroundColor Cyan }

$Eicar = 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

Write-Host "=============================================="
Write-Host " kse-ai-gateway Windows 端验证"
Write-Host " Scan Gateway: $ScanGateway"
Write-Host "=============================================="

# ---------------------------------------------------------------------------
Section "W1  Scan Gateway 连通性"
try {
    $health = Invoke-RestMethod -Uri "$ScanGateway/health" -TimeoutSec 10
    if ($health.status -eq "ok") {
        Write-Ok "健康检查 /health" "status=ok, cache=$($health.cache_size)"
    } else {
        Write-Bad "健康检查 /health" "status=$($health.status)"
    }
} catch {
    Write-Bad "健康检查 /health" "无法连接: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
Section "W2/W3  内容上传扫描"

$tmp = Join-Path $env:TEMP ("kse-verify-" + [guid]::NewGuid().ToString("N").Substring(0,8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$cleanFile = Join-Path $tmp "clean.txt"
"harmless content $(Get-Random)" | Out-File -FilePath $cleanFile -Encoding utf8
try {
    $r = Invoke-RestMethod -Uri "$ScanGateway/scan/upload" -Method Post -TimeoutSec 180 `
        -Form @{ file = Get-Item $cleanFile }
    if ($r.verdict -eq "CLEAN") {
        Write-Ok "scan/upload 干净内容" "verdict=CLEAN"
    } else {
        Write-Bad "scan/upload 干净内容" "verdict=$($r.verdict)"
    }
} catch {
    Write-Bad "scan/upload 干净内容" $_.Exception.Message
}

$eicarFile = Join-Path $tmp "eicar.txt"
$Eicar | Out-File -FilePath $eicarFile -Encoding ascii -NoNewline
try {
    $r = Invoke-RestMethod -Uri "$ScanGateway/scan/upload" -Method Post -TimeoutSec 180 `
        -Form @{ file = Get-Item $eicarFile }
    if ($r.verdict -eq "DETECT") {
        Write-Ok "scan/upload EICAR 检出" "verdict=DETECT, detection=$($r.detection_name)"
    } else {
        Write-Bad "scan/upload EICAR 检出" "verdict=$($r.verdict) (期望 DETECT)"
    }
} catch {
    Write-Bad "scan/upload EICAR 检出" $_.Exception.Message
}

# ---------------------------------------------------------------------------
Section "W4  OpenClaw 插件单元验证"

if (-not (Test-Path $PluginPath)) {
    Write-Skip "插件单元验证" "未找到插件: $PluginPath"
} else {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        Write-Skip "插件单元验证" "未找到 node"
    } else {
        # 探针脚本随仓库分发, 避免在 PowerShell 里拼 JS (EICAR 串含 $, 会被插值破坏)
        $probe = Join-Path $PSScriptRoot "..\integrations\common\plugin-probe.js"
        $probe = (Resolve-Path $probe).Path

        $out = (& node $probe $PluginPath $ScanGateway 2>&1 | Out-String)
        try {
            $res = $out | ConvertFrom-Json
            if ($res.error) {
                Write-Bad "插件单元验证" $res.error
            } elseif ($res.verdict -eq "GATEWAY-UNREACHABLE") {
                Write-Bad "插件单元验证" "Scan Gateway 不可达 ($ScanGateway), 拦截未真正被验证"
            } elseif ($res.verdict -eq "PASS") {
                Write-Ok "write 工具恶意内容被拦截" $res.writeReason
                Write-Ok "write 工具正常内容放行" "未阻断"
                Write-Ok "web_fetch 恶意 URL 被拦截" $res.urlReason
                Write-Ok "web_fetch 正常 URL 放行" "未阻断"
            } else {
                Write-Bad "插件单元验证" "verdict=$($res.verdict)"
            }
        } catch {
            $snippet = $out.Substring(0, [Math]::Min(200, $out.Length))
            Write-Bad "插件单元验证" "解析失败: $snippet"
        }
    }
}

# ---------------------------------------------------------------------------
Section "W5  File Watcher 监控与隔离"

if (-not (Test-Path $WatchDir)) {
    Write-Skip "File Watcher 监控" "监控目录不存在: $WatchDir"
} else {
    $before = 0
    if (Test-Path $QuarantineDir) {
        $before = (Get-ChildItem $QuarantineDir -File -ErrorAction SilentlyContinue | Measure-Object).Count
    }
    $probeFile = Join-Path $WatchDir "kse_verify_eicar.txt"
    $Eicar | Out-File -FilePath $probeFile -Encoding ascii -NoNewline
    Write-Host "  写入测试文件, 等待 $WatchWaitSeconds 秒..." -ForegroundColor DarkGray
    Start-Sleep -Seconds $WatchWaitSeconds

    $stillThere = Test-Path $probeFile
    $after = 0
    if (Test-Path $QuarantineDir) {
        $after = (Get-ChildItem $QuarantineDir -File -ErrorAction SilentlyContinue | Measure-Object).Count
    }

    if ((-not $stillThere) -and ($after -gt $before)) {
        Write-Ok "新文件被扫描并隔离" "原文件已移走, 隔离区 $before -> $after"
    } elseif (-not $stillThere) {
        Write-Warn "新文件被扫描并隔离" "原文件已移走但隔离区未增加, 请检查隔离目录配置"
    } else {
        Write-Bad "新文件被扫描并隔离" "文件仍在原位 -> File Watcher 未运行或未生效"
    }
    Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Section "W6  日志与隔离目录"

if (Test-Path $WatcherLog) {
    $lines = Get-Content $WatcherLog -Tail 50 -ErrorAction SilentlyContinue
    $hasScan = @($lines | Where-Object { $_ -match "SCAN:" })
    if ($hasScan.Count -gt 0) {
        Write-Ok "Watcher 日志有扫描记录" "$($hasScan.Count) 条 SCAN 记录"
    } else {
        Write-Warn "Watcher 日志有扫描记录" "最近 50 行没有 SCAN 记录"
    }
} else {
    Write-Skip "Watcher 日志" "未找到 $WatcherLog"
}

if (Test-Path $QuarantineDir) {
    $n = (Get-ChildItem $QuarantineDir -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Ok "Windows 隔离区存在" "$n 个文件 -> $QuarantineDir"
} else {
    Write-Skip "Windows 隔离区" "未创建: $QuarantineDir"
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=============================================="
Write-Host (" 汇总:  PASS {0}  FAIL {1}  WARN {2}  SKIP {3}" -f $script:Pass, $script:Fail, $script:Warn, $script:Skip) -ForegroundColor Cyan
Write-Host "=============================================="
if ($script:Fail -gt 0) { exit 1 } else { exit 0 }