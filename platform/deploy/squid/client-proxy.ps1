# 终端（Windows）接入 KAIP 下载代理：信任代理 CA + 设置代理（当前用户，无需管理员）
# 用法：
#   powershell -ExecutionPolicy Bypass -File client-proxy.ps1 -Proxy http://<代理>:3128 -Ca kaip-proxy-ca.crt [-NoProxy "<KAIP 平台>,<模型 API 域名>"] [-SystemProxy]
#   powershell -ExecutionPolicy Bypass -File client-proxy.ps1 -Remove
# -SystemProxy：同时设置 Windows 系统代理（Internet 选项）。WorkBuddy 等 Electron 桌面应用、浏览器只认系统代理；
#               会影响该用户所有走系统代理的程序，PoC 结束后用 -Remove 恢复。
# 导入 CA 到「当前用户 → 受信任的根证书颁发机构」时 Windows 会弹出安全警告，需点「是」。
# 生效范围：环境变量对 Codex、OpenCode、git、npm / Node.js、pip / Python、curl 生效（新开的终端 / 重启后的程序）。
param([string]$Proxy, [string]$Ca, [string]$NoProxy = "", [switch]$SystemProxy, [switch]$Remove)
$ErrorActionPreference = "Stop"
$D = Join-Path $env:USERPROFILE ".kaip"
$Vars = "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PIP_CERT"
$Inet = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

if ($Remove) {
  foreach ($v in $Vars) { [Environment]::SetEnvironmentVariable($v, $null, "User") }
  $bak = Join-Path $D "proxy-inet.bak.json"
  if (Test-Path $bak) {
    $b = Get-Content $bak -Raw | ConvertFrom-Json
    Set-ItemProperty $Inet ProxyEnable ([int]$b.ProxyEnable)
    if ($b.ProxyServer) { Set-ItemProperty $Inet ProxyServer $b.ProxyServer } else { Remove-ItemProperty $Inet ProxyServer -ErrorAction SilentlyContinue }
    if ($b.ProxyOverride) { Set-ItemProperty $Inet ProxyOverride $b.ProxyOverride } else { Remove-ItemProperty $Inet ProxyOverride -ErrorAction SilentlyContinue }
    Remove-Item $bak
    Write-Host "✔ 已恢复系统代理设置"
  }
  Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like "*KAIP Download Proxy CA*" } | ForEach-Object { Remove-Item $_.PSPath; Write-Host "✔ 已删除代理 CA $($_.Thumbprint)" }
  Remove-Item (Join-Path $D "proxy-ca.crt"), (Join-Path $D "ca-bundle.pem") -ErrorAction SilentlyContinue
  Write-Host "✔ 已移除代理设置（新开的终端 / 重启后的程序生效）"
  exit 0
}
if (-not $Proxy -or -not $Ca) { Write-Host "用法：client-proxy.ps1 -Proxy http://<代理>:3128 -Ca kaip-proxy-ca.crt [-NoProxy ...] [-SystemProxy]"; exit 1 }
if (-not (Select-String -Path $Ca -Pattern "BEGIN CERTIFICATE" -Quiet)) { throw "$Ca 不是 PEM 证书" }

New-Item -ItemType Directory -Force $D | Out-Null
$caFile = Join-Path $D "proxy-ca.crt"
Copy-Item $Ca $caFile -Force
# 1. 信任 CA（当前用户根证书存储；Edge / Chrome / Electron / git(schannel) / .NET 使用）
$cert = Import-Certificate -FilePath $caFile -CertStoreLocation Cert:\CurrentUser\Root
Write-Host "✔ 已信任代理 CA（当前用户）：$($cert.Thumbprint)"

# 2. 组合信任库（Windows 根证书 + 代理 CA），供 Python / curl 等只认 PEM 文件的程序使用
$sb = New-Object System.Text.StringBuilder
foreach ($c in (Get-ChildItem Cert:\LocalMachine\Root) + (Get-ChildItem Cert:\CurrentUser\Root)) {
  [void]$sb.AppendLine("-----BEGIN CERTIFICATE-----")
  [void]$sb.AppendLine([Convert]::ToBase64String($c.RawData, "InsertLineBreaks"))
  [void]$sb.AppendLine("-----END CERTIFICATE-----")
}
$bundle = Join-Path $D "ca-bundle.pem"
[IO.File]::WriteAllText($bundle, $sb.ToString().Replace("`r`n", "`n"))

# 3. 代理环境变量（用户级）
$no = "localhost,127.0.0.1,::1" + $(if ($NoProxy) { ",$NoProxy" } else { "" })
$set = @{ HTTP_PROXY = $Proxy; HTTPS_PROXY = $Proxy; NO_PROXY = $no; NODE_EXTRA_CA_CERTS = $caFile;
          SSL_CERT_FILE = $bundle; REQUESTS_CA_BUNDLE = $bundle; CURL_CA_BUNDLE = $bundle; PIP_CERT = $bundle }
foreach ($k in $set.Keys) { [Environment]::SetEnvironmentVariable($k, $set[$k], "User") }
Write-Host "✔ 代理 $Proxy；不走代理：$no"

# 4. 可选：系统代理（Electron 桌面应用、浏览器）
if ($SystemProxy) {
  $bak = Join-Path $D "proxy-inet.bak.json"
  if (-not (Test-Path $bak)) {
    $cur = Get-ItemProperty $Inet
    @{ ProxyEnable = $cur.ProxyEnable; ProxyServer = $cur.ProxyServer; ProxyOverride = $cur.ProxyOverride } | ConvertTo-Json | Set-Content $bak
  }
  $hostPort = ($Proxy -replace "^https?://", "").TrimEnd("/")
  Set-ItemProperty $Inet ProxyEnable 1
  Set-ItemProperty $Inet ProxyServer $hostPort
  Set-ItemProperty $Inet ProxyOverride (($no -split ",") + "<local>" -join ";")
  Write-Host "✔ 已设置系统代理 $hostPort（原设置已备份，-Remove 恢复）"
}
Write-Host "请新开终端，并完全退出后重新打开 AI Agent（WorkBuddy 需退出托盘图标）"
