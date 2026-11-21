# Kaspersky AI Protect 终端一键安装（Windows 10/11, Windows Server 2016+）
# 用法: powershell -ExecutionPolicy Bypass -File install.ps1 -Server https://kaip.example:8080 -Token <注册令牌> [-Agents codex,opencode,workbuddy] [-NoWatch]
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Agents = "",
  [switch]$NoWatch,
  [switch]$Secure   # 校验平台 TLS 证书（默认允许自签证书）
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not $Secure) {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    Add-Type @"
using System.Net; using System.Security.Cryptography.X509Certificates;
public class KaipTrustAll : ICertificatePolicy { public bool CheckValidationResult(ServicePoint a, X509Certificate b, WebRequest c, int d) { return true; } }
"@
    [Net.ServicePointManager]::CertificatePolicy = New-Object KaipTrustAll
  }
}

Write-Host "== Kaspersky AI Protect 终端安装 ==" -ForegroundColor Cyan
$kaipHome = Join-Path $env:USERPROFILE ".kaip"
$node = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys) { try { if ([int](& $sys.Source -p "process.versions.node.split('.')[0]") -ge 18) { $node = $sys.Source } } catch {} }
if (-not $node) {
  # 离线 / 无 Node 终端：从 KAIP 平台下载私有运行时
  Write-Host "未找到 Node.js 18+，从平台下载 KAIP 私有运行时……"
  $nz = Join-Path $env:TEMP "kaip-node.zip"; $nt = Join-Path $env:TEMP "kaip-node-x"
  $ca = @("-fsSL", "-o", $nz, "$($Server.TrimEnd('/'))/dl/runtime/node-win-x64.zip"); if (-not $Secure) { $ca = @("-k") + $ca }
  & curl.exe @ca
  if ($LASTEXITCODE -ne 0) { throw "平台未提供 Node 运行时，请先安装 Node.js 18+" }
  if (Test-Path $nt) { Remove-Item -Recurse -Force $nt }
  Expand-Archive -Path $nz -DestinationPath $nt -Force
  $inner = Get-ChildItem $nt -Directory | Select-Object -First 1
  $nd = Join-Path $kaipHome "node"
  if (Test-Path $nd) { Remove-Item -Recurse -Force $nd }
  New-Item -ItemType Directory -Force -Path $kaipHome | Out-Null
  Move-Item $inner.FullName $nd
  Remove-Item -Recurse -Force $nt, $nz
  $node = Join-Path $nd "node.exe"
  Write-Host "已安装私有运行时：$(& $node --version)（$node）"
}
$clientDir = Join-Path $kaipHome "client"
New-Item -ItemType Directory -Force -Path $kaipHome | Out-Null
$zip = Join-Path $env:TEMP "kaip-client.zip"
$Server = $Server.TrimEnd("/")
Write-Host "下载客户端：$Server/dl/kaip-client.zip"
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curl) {
  $cargs = @("-fsSL", "-o", $zip, "$Server/dl/kaip-client.zip")
  if (-not $Secure) { $cargs = @("-k") + $cargs }
  & curl.exe @cargs
  if ($LASTEXITCODE -ne 0) { throw "下载客户端失败（curl 退出码 $LASTEXITCODE）" }
} else {
  $iwrArgs = @{ Uri = "$Server/dl/kaip-client.zip"; OutFile = $zip; UseBasicParsing = $true }
  if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $Secure) { $iwrArgs["SkipCertificateCheck"] = $true }
  Invoke-WebRequest @iwrArgs
}
if (Test-Path $clientDir) { Remove-Item -Recurse -Force $clientDir }
Expand-Archive -Path $zip -DestinationPath $clientDir -Force
Remove-Item $zip -Force

$kaip = Join-Path $clientDir "bin\kaip.js"
$enroll = @($kaip, "enroll", "--server", $Server, "--token", $Token)
if (-not $Secure) { $enroll += "--insecure" }
& $node @enroll
if ($LASTEXITCODE -ne 0) { throw "注册失败" }

$inst = @($kaip, "install")
if ($Agents) { $inst += @("--agents", $Agents) }
if ($NoWatch) { $inst += "--no-watch" }
& $node @inst

# 把 ~/.kaip/bin 加入用户 PATH，便于使用 kaip 命令
$bin = Join-Path $kaipHome "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$bin*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$bin", "User") }

& $node $kaip test
Write-Host "`n安装完成。新开终端后可使用 kaip status / kaip scan <路径>。" -ForegroundColor Green
