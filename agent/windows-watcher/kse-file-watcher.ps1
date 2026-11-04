<#
    KSE File Watcher — Windows 端事后扫描兜底

    监控 OpenClaw 的 workspace / plugins / npm 目录, 新文件自动上传到 Scan Gateway
    扫描; 检出威胁则移入本地隔离区。

    设计要点:
      - 使用定时轮询而非 FileSystemWatcher: Windows 上 FSW 子目录监控不可靠
      - 使用 curl.exe 而非 Invoke-RestMethod -Form: 兼容 PowerShell 5.1
      - 纯英文注释 + UTF-8 BOM: 避免 PowerShell 5.1 中文乱码导致脚本解析失败
      - 超 100MB 跳过: 大文件由 Ollama 监控覆盖, 避免影响性能
#>

$ScanGateway   = "http://127.0.0.1:8000"
$WatchDirs     = @(
    "$env:USERPROFILE\.openclaw\workspace",
    "$env:USERPROFILE\.openclaw\plugins",
    "$env:USERPROFILE\.openclaw\npm\projects",
    "$env:APPDATA\npm\node_modules"
)
$ExcludeDirs   = @("\out\", "\state\", "\.clawhub\", "\logs\", "\tmp\")
$ExcludeExt    = @(".log", ".tmp", ".lock", ".pid", ".sqlite-wal", ".sqlite-shm")
$MaxSize       = 104857600      # 100MB
$PollInterval  = 5              # seconds
$CacheLimit    = 500000
$QuarantineDir = "$env:USERPROFILE\.openclaw\quarantine"
$LogFile       = "$env:USERPROFILE\.openclaw\kse-watcher.log"

# ---------------------------------------------------------------------------
# Logging helpers (ASCII only to avoid encoding issues on PS 5.1)
# ---------------------------------------------------------------------------
function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    try {
        Add-Content -Path $LogFile -Value $line -Encoding UTF8
    } catch { }
}

function Write-Banner {
    Write-Log "========== KSE File Watcher (Polling) START =========="
    Write-Log "Scan Gateway: $ScanGateway/scan/upload"
    foreach ($d in $WatchDirs) { Write-Log "Watching: $d" }
    Write-Log "Exclude dirs: $($ExcludeDirs -join ', ')"
    Write-Log "Max file size: $MaxSize bytes"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Test-Excluded {
    param([string]$Path)
    foreach ($ex in $ExcludeDirs) {
        if ($Path.ToLower().Contains($ex.ToLower())) { return $true }
    }
    $ext = [System.IO.Path]::GetExtension($Path).ToLower()
    if ($ext -and ($ExcludeExt -contains $ext)) { return $true }
    return $false
}

function Get-WatchedFiles {
    $files = @()
    foreach ($dir in $WatchDirs) {
        if (-not (Test-Path $dir)) { continue }
        try {
            $files += Get-ChildItem -Path $dir -Recurse -File -Force -ErrorAction SilentlyContinue
        } catch { }
    }
    return $files
}

function Get-FileSha256 {
    param([string]$Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $stream = [System.IO.File]::OpenRead($Path)
        $hash = $sha.ComputeHash($stream)
        $stream.Close()
        $sha.Dispose()
        return ([System.BitConverter]::ToString($hash) -replace "-", "").ToLower()
    } catch {
        return $null
    }
}

function Invoke-Scan {
    param([string]$Path)
    $url = "$ScanGateway/scan/upload"
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        # curl.exe is used because Invoke-RestMethod -Form requires PowerShell 6.1+
        & curl.exe -s -X POST $url -F "file=@$Path" 2>$null | Out-String | ForEach-Object { $_.Trim() }
    } catch {
        return $null
    } finally {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Move-ToQuarantine {
    param([string]$Path, [string]$Sha)
    if (-not (Test-Path $QuarantineDir)) {
        New-Item -ItemType Directory -Force -Path $QuarantineDir | Out-Null
    }
    $dest = Join-Path $QuarantineDir ("{0}_{1}" -f $Sha, [System.IO.Path]::GetFileName($Path))
    try {
        Move-Item -LiteralPath $Path -Destination $dest -Force
        return $dest
    } catch {
        Write-Log "Failed to quarantine $Path : $_" "ERROR"
        return $null
    }
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
$knownFiles = New-Object 'System.Collections.Generic.HashSet[string]'

Write-Banner

# Initial population: record existing files without scanning them
$existing = Get-WatchedFiles
foreach ($f in $existing) { [void]$knownFiles.Add($f.FullName) }
Write-Log "Initialized. Existing files (not scanned): $($knownFiles.Count)"
Write-Log "Ready. Waiting for new/modified files..."

while ($true) {
    try {
        $current = Get-WatchedFiles
        $seen = New-Object 'System.Collections.Generic.HashSet[string]'

        foreach ($f in $current) {
            [void]$seen.Add($f.FullName)

            if ($knownFiles.Contains($f.FullName)) { continue }
            if (Test-Excluded $f.FullName) { continue }
            if ($f.Length -gt $MaxSize) {
                Write-Log "SKIP (too large): $($f.FullName) ($($f.Length) bytes)"
                continue
            }

            Write-Log "SCAN: $($f.FullName) ($($f.Length) bytes)"
            $raw = Invoke-Scan -Path $f.FullName
            if (-not $raw) {
                Write-Log "Scan request failed (fail-open): $($f.FullName)" "WARN"
                continue
            }

            try {
                $result = $raw | ConvertFrom-Json
            } catch {
                Write-Log "Invalid scan response, skip: $($f.FullName)" "WARN"
                continue
            }

            if ($result.verdict -eq "DETECT") {
                $sha = $result.sha256
                if (-not $sha) { $sha = Get-FileSha256 -Path $f.FullName }
                $dest = Move-ToQuarantine -Path $f.FullName -Sha $sha
                Write-Log "[DETECTED] $($result.detection_name) -> QUARANTINED  file=$($f.FullName) dest=$dest" "ALERT"
                [void]$knownFiles.Remove($f.FullName)
            } else {
                Write-Log "[CLEAN] $($f.FullName)"
                [void]$knownFiles.Add($f.FullName)
            }
        }

        # Prune deleted files from cache
        foreach ($k in @($knownFiles)) {
            if (-not $seen.Contains($k)) { [void]$knownFiles.Remove($k) }
        }

        # Avoid unbounded growth of the cache
        if ($knownFiles.Count -gt $CacheLimit) {
            Write-Log "Cleaned known files cache (count=$($knownFiles.Count))" "WARN"
            $knownFiles.Clear()
        }
    } catch {
        Write-Log "Loop error: $_" "ERROR"
    }

    Start-Sleep -Seconds $PollInterval
}