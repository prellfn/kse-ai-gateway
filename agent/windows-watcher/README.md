# KSE File Watcher (Windows)

Windows 端**事后扫描兜底**：定时轮询 OpenClaw 的 workspace / plugins / npm 目录，发现新文件即上传到
远端 Scan Gateway 扫描，检出威胁则移入本地隔离区。

> 与 OpenClaw Plugin 互补：Plugin 是**事前拦截**（write/exec，文件不落盘），
> Watcher 是**事后兜底**（`openclaw skills install` / `npm install` 等批量落盘场景）。

## 工作方式

| 项目 | 值 |
| --- | --- |
| 调度方式 | Windows 计划任务 `KSE-FileWatcher`，SYSTEM 权限，开机自启 |
| 轮询间隔 | 5 秒 |
| 扫描方式 | `curl.exe` multipart 上传到 `POST /scan/upload` |
| 隔离区 | `%USERPROFILE%\.openclaw\quarantine\{SHA256}_{文件名}` |
| 日志 | `%USERPROFILE%\.openclaw\kse-watcher.log` |

### 监控目录

- `%USERPROFILE%\.openclaw\workspace` — OpenClaw 工作区（含 skills 安装目录）
- `%USERPROFILE%\.openclaw\plugins` — 插件目录
- `%USERPROFILE%\.openclaw\npm\projects` — npm 项目目录
- `%APPDATA%\npm\node_modules` — 全局 npm 包目录

### 排除规则

- 目录：`\out\`、`\state`、`\.clawhub\`、`\logs\`、`\tmp\`
- 扩展名：`.log`、`.tmp`、`.lock`、`.pid`、`.sqlite-wal`、`.sqlite-shm`
- 大小：超过 100MB 的文件自动跳过（模型文件由 Ollama 监控覆盖）

## 安装

```powershell
# 1. 复制脚本
$dst = "$env:USERPROFILE\.openclaw"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item .\kse-file-watcher.ps1 $dst -Force

# 2. 修改脚本顶部的 $ScanGateway 为你的 Scan Gateway 地址
notepad $dst\kse-file-watcher.ps1

# 3. 注册计划任务
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$dst\kse-file-watcher.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "KSE-FileWatcher" -Action $action -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force

# 4. 启动
Start-ScheduledTask -TaskName "KSE-FileWatcher"
```

## 管理

```powershell
Get-ScheduledTask -TaskName "KSE-FileWatcher" | Select-Object TaskName, State
Start-ScheduledTask -TaskName "KSE-FileWatcher"
Stop-ScheduledTask  -TaskName "KSE-FileWatcher"

Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" -Tail 20
Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" -Wait -Tail 20
Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" | Select-String "DETECTED"

Get-ChildItem "$env:USERPROFILE\.openclaw\quarantine\"
```

## 实现说明

- **定时轮询而非 FileSystemWatcher**：Windows 上 FSW 子目录监控不可靠，轮询 100% 稳定
- **`curl.exe` 而非 `Invoke-RestMethod -Form`**：兼容 PowerShell 5.1（`-Form` 是 6.1+ 才有）
- **纯英文注释 + UTF-8 BOM**：避免 PowerShell 5.1 中文乱码导致脚本解析失败
- **首次启动不扫描存量文件**：只记录已知文件清单，从之后的新文件开始监控
- **Fail-Open**：扫描请求失败时放行，只记录日志，不阻断 Agent

## 验证

```powershell
$eicar = 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
$eicar | Out-File -FilePath "$env:USERPROFILE\.openclaw\workspace\test_eicar.py" -Encoding ascii

Start-Sleep -Seconds 10

Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" -Tail 5
Test-Path "$env:USERPROFILE\.openclaw\workspace\test_eicar.py"          # 期望 False
Get-ChildItem "$env:USERPROFILE\.openclaw\quarantine\"                # 期望有隔离文件
```
