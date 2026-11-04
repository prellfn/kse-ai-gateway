# KSE + AI 安全扫描平台 — 运维手册

## 1. 架构概述

本平台基于卡巴斯基扫描引擎（KSE）构建，对 Agent 下载的 Skill、生成的脚本、使用的模型文件以及
知识库文档进行安全检测。

| 组件 | 部署方式 | 地址/端口 | 作用 |
| --- | --- | --- | --- |
| KSE | 原生 systemd | `https://<host>:8443` | 卡巴斯基扫描引擎，HTTPS + Token 认证 |
| KSE Web UI | 原生 systemd | `https://<host>` | Web 管理界面，配置管理、扫描日志 |
| Scan Gateway | 原生 systemd (Python) | `http://<host>:8000` | KSE 封装层：路径校验、结果缓存、威胁自动隔离 |
| Upload Gateway | 原原生 systemd (Python) | `http://<host>:8002` | 安全上传页面，文件先扫再入库 AnythingLLM |
| AnythingLLM | Docker | `http://<host>:3001` | 知识库前端，文档存储与问答 |

**关键路径**：扫描队列目录 `/opt/kaspersky/scanqueue`，隔离区目录 `/opt/kaspersky/quarantine`。
只有扫描队列目录下的文件允许被 KSE 扫描。

---

## 2. 部署步骤

### 2.1 系统要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| 操作系统 | Ubuntu 22.04 LTS 64 位 | Ubuntu 22.04 LTS 64 位 |
| CPU | 4 核 | 8 核以上 |
| 内存 | 4GB | 8GB 以上 |
| 磁盘 | 10GB | 50GB 以上 |

### 2.2 KSE 原生安装

1. 安装依赖：

```bash
sudo apt update
sudo apt install -y libc6 libcurl4 libxml2 libssl3 zlib1g libgcc-s1 libstdc++6
```

2. 安装 KSE DEB 包：

```bash
sudo dpkg -i kavscanengine_2.2.0.xxxx_amd64.deb
sudo apt -f install -y
```

3. 创建工作目录：

```bash
sudo mkdir -p /opt/kaspersky/scanqueue
sudo mkdir -p /opt/kaspersky/quarantine
sudo chown -R $USER:$USER /opt/kaspersky/scanqueue
sudo chown -R $USER:$USER /opt/kaspersky/quarantine
```

4. 复制许可证 key 文件到 KSE bin 目录：

```bash
sudo cp 你的许可证.key /opt/kaspersky/ScanEngine/bin/
```

### 2.3 KSE 配置（Web UI 方式，推荐）

> 推荐使用 Web UI 配置，不要手动改 XML。Web UI 会自动加密 Token、验证配置正确性、重启服务。

1. 浏览器打开 KSE Web UI：`https://<host>`
2. 配置 Service（`Settings → Service`）：
   - Protocol：HTTPS
   - IP address：0.0.0.0
   - Port：8443
   - Private key path：`/opt/kaspersky/ScanEngine/etc/kavhttpd_key.pem`
   - Certificate：`/opt/kaspersky/ScanEngine/etc/kavhttpd_cert.pem`
3. 配置 Authorization（`Settings → Authorization`）：
   - Enable authorization for HTTP clients：On
   - Authorization header field：Authorization
   - Add bearer prefix：On
   - **Add token → Generate token → 复制保存明文 Token → Enable token：On → Save**
4. 配置扫描目录（`Settings → Scanning`）：添加 `/opt/kaspersky/scanqueue`
5. 点 Save，等 KSE 自动重启。
6. 验证：

```bash
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /opt/kaspersky/scanqueue/eicar.txt

curl -k -X POST https://127.0.0.1:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer 你的明文Token" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
```

返回 `scanResult: DETECT` 即为成功。

### 2.4 Scan Gateway 部署

```bash
sudo apt install -y python3-pip python3-venv
python3 -m venv /opt/ai-stack/venv
source /opt/ai-stack/venv/bin/activate
pip install fastapi uvicorn httpx
deactivate
```

程序：`/opt/ai-stack/scan-gateway/app.py`（见本仓库 `gateway/scan-gateway/app.py`），关键配置：

```python
KSE_URL = "https://127.0.0.1:8443"
KSE_TOKEN = "你的KSE明文Token"
SCAN_QUEUE = Path("/opt/kaspersky/scanqueue")
QUARANTINE = Path("/opt/kaspersky/quarantine")
```

systemd 服务（`/etc/systemd/system/scan-gateway.service`）：

```ini
[Unit]
Description=KSE Scan Gateway
After=network.target kavhttpd.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-stack/scan-gateway
ExecStart=/opt/ai-stack/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable scan-gateway
sudo systemctl start scan-gateway
```

### 2.5 Upload Gateway 部署

```bash
source /opt/ai-stack/venv/bin/activate
pip install python-multipart
deactivate
```

程序：`/opt/ai-stack/upload-gateway/app.py` + `templates/index.html`（见本仓库 `gateway/upload-gateway/`），
关键配置：

```python
SCAN_GATEWAY = "http://127.0.0.1:8000"
ANYTHINGLLM_URL = "http://<host>:3001"
ANYTHINGLLM_API_KEY = "你的AnythingLLM_API_Key"
WORKSPACE_SLUG = "你的工作区slug"
SCAN_QUEUE = Path("/opt/kaspersky/scanqueue")
```

systemd 服务（端口 **8002**，8001 被 ClickHouse 占用）：

```ini
[Unit]
Description=AnythingLLM Secure Upload Gateway
After=network.target scan-gateway.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-stack/upload-gateway
ExecStart=/opt/ai-stack/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8002
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 2.6 AnythingLLM 对接

1. 在 AnythingLLM 网页生成 API Key：设置 → 开发者 API → 生成 API Key
2. 获取工作区 slug：

```bash
curl -s -H "Authorization: Bearer <你的API_Key>" \
  http://<host>:3001/api/v1/workspaces | python3 -m json.tool
```

3. 将 API Key 和工作区 slug 填入 Upload Gateway 的 `.env`，重启服务。

---

## 3. 日常管理命令

### 3.1 服务管理

| 操作 | KSE | Scan Gateway | Upload Gateway |
| --- | --- | --- | --- |
| 启动 | `systemctl start kavhttpd` | `systemctl start scan-gateway` | `systemctl start upload-gateway` |
| 停止 | `systemctl stop kavhttpd` | `systemctl stop scan-gateway` | `systemctl stop upload-gateway` |
| 重启 | `systemctl restart kavhttpd` | `systemctl restart scan-gateway` | `systemctl restart upload-gateway` |
| 状态 | `systemctl status kavhttpd` | `systemctl status scan-gateway` | `systemctl status upload-gateway` |
| 开机自启 | `systemctl enable kavhttpd` | `systemctl enable scan-gateway` | `systemctl enable upload-gateway` |

一键查看所有服务状态：

```bash
for svc in kavhttpd scan-gateway upload-gateway; do
  printf "%-20s %s\n" "$svc" "$(systemctl is-active $svc)"
done
```

### 3.2 日志查看

| 组件 | 实时日志 | 最近 50 行 |
| --- | --- | --- |
| KSE | `journalctl -u kavhttpd -f` | `journalctl -u kavhttpd -n 50 --no-pager` |
| Scan Gateway | `journalctl -u scan-gateway -f` | `journalctl -u scan-gateway -n 50 --no-pager` |
| Upload Gateway | `journalctl -u upload-gateway -f` | `journalctl -u upload-gateway -n 50 --no-pager` |
| KSE 自身日志 | — | `sudo tail -50 /opt/kaspersky/ScanEngine/bin/logs/*.log` |
| 网关审计日志 | — | `tail -f /opt/ai-stack/scan-gateway/logs/audit.jsonl` |

### 3.3 健康检查

```bash
ss -tlnp | grep 8443                 # KSE 端口监听
curl http://127.0.0.1:8000/health    # Scan Gateway
curl http://127.0.0.1:8002/health    # Upload Gateway
```

### 3.4 扫描测试

```bash
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /opt/kaspersky/scanqueue/eicar.txt

# 直接调 KSE
curl -k -X POST https://127.0.0.1:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer 你的明文Token" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'

# 通过 Scan Gateway
curl -X POST http://127.0.0.1:8000/scan/file \
  -H "Content-Type: application/json" \
  -d '{"file_path":"/opt/kaspersky/scanqueue/eicar.txt","timeout":60}'
```

---

## 4. 故障排查

### 4.1 KSE 启动失败

| 错误信息 | 原因 | 解决方案 |
| --- | --- | --- |
| `Authorization token value length is invalid, expected 88 bytes` | 手动改 XML 时 Token 不是 88 字节加密值 | 用 Web UI 配置 Token |
| `Authorization is used without https connection` | 开启 Token 认证但 Protocol 是 HTTP | Web UI → Service → Protocol 改成 HTTPS |
| `Node 'Configuration.ServerSettings.TlsCertificateFile' is absent` | 开启 HTTPS 但没填证书路径 | Web UI → Service → 填证书路径 |
| `Node 'Configuration.ServerSettings.TlsCertificateKeyFile' is absent` | 填了证书但没填私钥 | Web UI → Service → 填 Private key path |

```bash
journalctl -u kavhttpd -n 30 --no-pager
```

### 4.2 Token 认证失败

| 错误信息 | 原因 | 解决方案 |
| --- | --- | --- |
| `Token value is invalid` | 测试用的 Token 与 Web UI 保存的不一致 | 重新 Generate token，复制明文，Save 后用新 Token 测试 |
| `Token value is invalid` | Enable token 开关没打开 | Web UI → Authorization → 编辑 Token → 打开 Enable token |

### 4.3 Scan Gateway 异常

| 现象 | 原因 | 解决方案 |
| --- | --- | --- |
| `路径不在允许的扫描目录内` | 文件不在 `ALLOWED_SCAN_DIRS` 内 | 在 `.env` 中添加目录后重启 |
| `Internal Server Error` | 参数名错误 / KSE 异常 | 参数名是 `file_path`（不是 `path`）；检查 `systemctl status kavhttpd` |
| `500` 且超时 | KSE 扫描超时 | 调大 `KSE_TIMEOUT` / 请求中的 `timeout` |

手动测试：

```bash
curl -X POST http://127.0.0.1:8000/scan/file \
  -H "Content-Type: application/json" -d '{"file_path":"/path/to/file"}'
```

### 4.4 Upload Gateway 异常

| 现象 | 原因 | 解决方案 |
| --- | --- | --- |
| `No module named 'multipart'` | 缺少 python-multipart | `pip install python-multipart` |
| `address already in use` | 端口被占用（8001 被 ClickHouse 占） | 改用 8002 |
| 入库失败 | AnythingLLM API Key / slug 错误 | 重新生成 API Key |

### 4.5 端口冲突

```bash
ss -tlnp | grep -E "8443|8000|8001|8002|3001"
```

已知占用：**8001** ClickHouse（KUMA 组件）→ Upload Gateway 改用 8002；**443** KSE Web UI；**5432** PostgreSQL。

---

## 5. 病毒库更新

### 5.1 手动更新

**方式一：通过 KSE HTTP API（推荐）**

```bash
# 启动更新
curl -k -X POST "https://127.0.0.1:8443/api/v3.0/update/start" \
  -H "Authorization: Bearer 你的明文Token" \
  -H "Content-Type: application/octet-stream" -d "{}"

# 查看更新状态
curl -k -X POST "https://127.0.0.1:8443/api/v3.0/update/start" \
  -H "Authorization: Bearer 你的明文Token" \
  -H "Content-Type: application/octet-stream" -d '{"action":"status"}'
```

**方式二：KSE 自带客户端**

```bash
cd /opt/kaspersky/ScanEngine/bin
./kavhttp_client -s https://127.0.0.1:8443 \
  --access-token "你的明文Token" --add-bearer-prefix --insecure -d -j
```

**方式三：Web UI** — Dashboard → Update 按钮（自签证书时可能失败，用 API 方式更可靠）。

### 5.2 自动更新

KSE 默认每 60 分钟自动检查更新。可在 Web UI → `Settings → Update` 配置周期与更新源。

强制每日更新：

```bash
sudo crontab -e
0 3 * * * curl -k -X POST "https://127.0.0.1:8443/api/v3.0/update/start" \
  -H "Authorization: Bearer 你的明文Token" \
  -H "Content-Type: application/octet-stream" -d "{}" > /dev/null 2>&1
```

### 5.3 更新状态查看

```bash
ls -lh /opt/kaspersky/ScanEngine/bin/bases/
journalctl -u kavhttpd --no-pager | grep -i update
```

---

## 6. 备份恢复

### 6.1 需要备份的文件

| 类别 | 路径 | 说明 |
| --- | --- | --- |
| KSE 配置 | `/opt/kaspersky/ScanEngine/etc/kavhttpd.xml` | KSE 主配置 |
| KSE 许可证 | `/opt/kaspersky/ScanEngine/bin/*.key` | 许可证 key 文件 |
| KSE 证书 | `/opt/kaspersky/ScanEngine/etc/kavhttpd_*.pem` | HTTPS 证书和私钥 |
| KSE 病毒库 | `/opt/kaspersky/ScanEngine/bin/bases/` | 可选，恢复后可重新更新 |
| Scan Gateway | `/opt/ai-stack/scan-gateway/` | 程序代码 + `.env` |
| Upload Gateway | `/opt/ai-stack/upload-gateway/` | 程序代码和页面模板 |
| systemd 服务 | `/etc/systemd/system/*.service` | 服务配置文件 |
| Python 环境 | `/opt/ai-stack/venv/` | 可选备份，可重建 |

### 6.2 备份脚本

见本仓库 [`scripts/backup_kse.sh`](../scripts/backup_kse.sh)：

```bash
sudo ./scripts/backup_kse.sh /opt/backups/kse-$(date +%Y%m%d)
```

### 6.3 恢复步骤

1. 恢复 KSE 配置与许可证：

```bash
sudo cp 备份目录/kavhttpd.xml /opt/kaspersky/ScanEngine/etc/
sudo cp 备份目录/*.key /opt/kaspersky/ScanEngine/bin/
sudo cp 备份目录/kavhttpd_*.pem /opt/kaspersky/ScanEngine/etc/
sudo systemctl restart kavhttpd
```

2. 恢复 Python 环境：

```bash
python3 -m venv /opt/ai-stack/venv
source /opt/ai-stack/venv/bin/activate
pip install -r 备份目录/requirements.txt
deactivate
```

3. 恢复 Gateway 程序：

```bash
sudo cp -a 备份目录/scan-gateway /opt/ai-stack/
sudo cp -a 备份目录/upload-gateway /opt/ai-stack/
sudo cp -a 备份目录/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart scan-gateway upload-gateway
```

4. 验证：

```bash
systemctl is-active kavhttpd scan-gateway upload-gateway
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8002/health
```

> ⚠️ 恢复配置后如果 KSE 启动失败，可能是配置里的 Token 加密值与当前系统不匹配。
> 请通过 Web UI 重新配置 Token（Generate token → Save），不要直接恢复旧的 `kavhttpd.xml`。

---

## 7. 附录：关键信息速查

| 项目 | 值 |
| --- | --- |
| 服务器 | kumadb (`10.254.205.89`) |
| 操作系统 | Ubuntu 22.04 LTS |
| KSE API | `https://10.254.205.89:8443` |
| KSE Web UI | `https://10.254.205.89` |
| Scan Gateway | `http://10.254.205.89:8000` |
| Upload Gateway | `http://10.254.205.89:8002` |
| AnythingLLM | `http://10.254.205.89:3001` |
| 扫描队列目录 | `/opt/kaspersky/scanqueue` |
| 隔离区目录 | `/opt/kaspersky/quarantine` |
| KSE 配置文件 | `/etc/kavhttpd.xml` |
| Python 虚拟环境 | `/opt/ai-stack/venv` |

---

## 8. OpenClaw Plugin 管理

### 8.1 插件状态

```bash
openclaw plugins list --enabled
openclaw plugins inspect kse-security-gate --runtime --json
```

正常状态：`Status: loaded`，`Origin: config`。

### 8.2 插件日志

```powershell
Get-Content "$env:USERPROFILE\.openclaw\plugins\kse-gate\debug.log" -Encoding utf8 -Tail 20
Get-Content "$env:LOCALAPPDATA\Temp\openclaw\openclaw-$(Get-Date -Format yyyy-MM-dd).log" -Tail 50
```

### 8.3 插件重启

```powershell
openclaw gateway stop
openclaw gateway run
```

> Gateway 前台运行时 `Ctrl+C` 可能无法结束，直接关闭窗口即可。

### 8.4 常见故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 插件 enabled 但 Gateway 只加载 2 个插件 | 插件在 agent runtime 预热时才加载 | 发起一次对话后查看 `debug.log` |
| `register` 未被调用 | 模块未加载 | `node -e "require('./index.js')"` 验证；重新 `plugins install --link` |
| 拦截不生效 | hook 未触发 / 参数名不符 | `write` 参数是 `path` + `content`；确认 Scan Gateway 可访问 |
| 扫描异常时仍放行 | 设计为 fail-open | 查看日志「扫描异常」记录 |
| 中文乱码 | PowerShell 默认 GBK 读取 | `Get-Content` 加 `-Encoding utf8` |

---

## 9. Ollama 模型监控管理

### 9.1 服务管理

```bash
systemctl status ollama-watcher
systemctl start|stop|restart ollama-watcher
systemctl enable|disable ollama-watcher
```

### 9.2 日志查看

```bash
tail -f /var/log/ollama-watcher.log
tail -50 /var/log/ollama-watcher.log
grep "检出威胁" /var/log/ollama-watcher.log
journalctl -u ollama-watcher -f --no-pager
```

### 9.3 隔离区管理

```bash
ls -la /opt/kaspersky/quarantine/

# 恢复误隔离文件
mv /opt/kaspersky/quarantine/{文件名} /root/ai-stack/ollama/models/blobs/

# 删除隔离文件
rm /opt/kaspersky/quarantine/{文件名}
```

命名格式：`{SHA256}_{时间戳}_{原文件名}`

### 9.4 故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 新模型文件未触发扫描 | inotifywait 未运行 / 目录不对 | `ps aux \| grep inotifywait`；`grep WATCH_DIR /opt/ai-stack/ollama-watcher.sh` |
| 路径不在允许的扫描目录内 | Scan Gateway 白名单缺 Ollama 目录 | 在 `.env` 的 `ALLOWED_SCAN_DIRS` 添加后重启 |
| 大文件扫描超时 | 模型文件数 GB | 调大 `ollama-watcher.sh` 的 `MAX_TIME`（默认 600） |
| EICAR 未检出 | EICAR 字符串不在文件开头 | 用 `echo -n` 写入开头 |

---

## 10. Windows 端文件监控管理

### 10.1 服务管理

服务以计划任务（`KSE-FileWatcher`）方式运行，SYSTEM 权限，开机自启，失败自动重启 3 次。

```powershell
Start-ScheduledTask -TaskName "KSE-FileWatcher"
Stop-ScheduledTask  -TaskName "KSE-FileWatcher"

# 重启（PowerShell 5.1 无 Restart-ScheduledTask）
Stop-ScheduledTask -TaskName "KSE-FileWatcher"
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName "KSE-FileWatcher"

Get-ScheduledTask -TaskName "KSE-FileWatcher" | Select-Object TaskName, State
```

注册计划任务：

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$env:USERPROFILE\.openclaw\kse-file-watcher.ps1`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName "KSE-FileWatcher" -Action $action -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force
```

### 10.2 日志查看

```powershell
Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" -Tail 20
Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" -Wait -Tail 20
Get-Content "$env:USERPROFILE\.openclaw\kse-watcher.log" | Select-String "DETECTED"
```

### 10.3 隔离区管理

```powershell
Get-ChildItem "$env:USERPROFILE\.openclaw\quarantine\"
Move-Item "$env:USERPROFILE\.openclaw\quarantine\<SHA256>_<文件名>" -Destination "<原路径>"
Remove-Item "$env:USERPROFILE\.openclaw\quarantine\*" -Force
```

命名格式：`{SHA256}_{文件名}`

### 10.4 监控目录说明

每 5 秒轮询一次：

- `%USERPROFILE%\.openclaw\workspace` — OpenClaw 工作区（含 skills 安装目录）
- `%USERPROFILE%\.openclaw\plugins` — 插件目录
- `%USERPROFILE%\.openclaw\npm\projects` — npm 项目目录
- `%APPDATA%\npm\node_modules` — 全局 npm 包目录

**排除目录**：`\out\`、`\state\`、`\.clawhub\`、`\logs\`、`\tmp\`
**排除扩展名**：`.log`、`.tmp`、`.lock`、`.pid`、`.sqlite-wal`、`.sqlite-shm`
**超过 100MB 的文件自动跳过**。

### 10.5 常见故障排查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 服务启动后无日志文件 | 脚本编码导致解析失败 | 确认 UTF-8 with BOM；前台运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ...` 看报错 |
| 新文件未被扫描 | 不在监控目录/排除列表 | 检查日志是否有 `SCAN:` 记录 |
| `找不到与参数名称 Form 匹配` | PS 5.1 不支持 `-Form` | 用 `curl.exe` 而非 `Invoke-RestMethod -Form` |
| 日志频繁「Cleaned known files cache」 | 缓存阈值过低 | 确认 `CacheLimit` 为 500000 |
