# KSE + AI 安全扫描平台 — 安装手册

> 从零开始搭建基于卡巴斯基扫描引擎（KSE）的 AI 安全扫描平台，实现对 AI Agent 下载的 Skill、
> 生成的脚本、加载的模型文件以及知识库文档的安全检测。

## 1. 概述

### 1.1 适用范围

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Ubuntu 22.04 LTS 64 位 |
| KSE 版本 | 2.2.x（原生安装，非 Docker） |
| 适用人员 | 系统管理员、运维工程师 |

### 1.2 系统要求

| 项目 | 最低 | 推荐 |
| --- | --- | --- |
| CPU | 4 核 | 8 核以上 |
| 内存 | 4GB（空闲时约 600MB） | 8GB 以上 |
| 磁盘 | 10GB（不含病毒库和日志） | 50GB 以上 |
| 网络 | 能访问卡巴斯基更新服务器 | 能访问卡巴斯基更新服务器（离线环境需手动更新病毒库） |

### 1.3 架构说明

| 组件 | 部署方式 | 端口 | 作用 |
| --- | --- | --- | --- |
| KSE | 原生 systemd | 8443 (HTTPS) | 卡巴斯基扫描引擎核心 |
| KSE Web UI | 原生 systemd | 443 (HTTPS) | Web 管理界面 |
| Scan Gateway | Python + systemd | 8000 | KSE 封装层：路径校验 + 威胁隔离 + 结果缓存 |
| Upload Gateway | Python + systemd | 8002 | 安全上传页面，先扫再入库 |
| AnythingLLM | Docker | 3001 | 知识库前端（需提前部署好） |

**数据流**：用户上传文件 → Upload Gateway 保存到扫描队列 → Scan Gateway 调用 KSE 扫描 →
CLEAN 则上传 AnythingLLM 入库，DETECT 则移到隔离区并拒绝。

---

## 2. 第一步：系统准备

### 2.1 安装系统依赖

```bash
sudo apt update
sudo apt install -y libc6 libcurl4 libxml2 libssl3 zlib1g libgcc-s1 libstdc++6 \
                    python3-pip python3-venv
```

验证：无报错即完成。

### 2.2 创建工作目录

```bash
# KSE 扫描队列和隔离区
sudo mkdir -p /opt/kaspersky/scanqueue
sudo mkdir -p /opt/kaspersky/quarantine
sudo chown -R $USER:$USER /opt/kaspersky/scanqueue
sudo chown -R $USER:$USER /opt/kaspersky/quarantine

# Gateway 程序目录
sudo mkdir -p /opt/ai-stack/scan-gateway
sudo mkdir -p /opt/ai-stack/upload-gateway/templates

# Python 虚拟环境
python3 -m venv /opt/ai-stack/venv
source /opt/ai-stack/venv/bin/activate
pip install fastapi uvicorn httpx python-multipart
deactivate
```

验证：

```bash
ls -ld /opt/kaspersky/scanqueue /opt/kaspersky/quarantine \
      /opt/ai-stack/scan-gateway /opt/ai-stack/upload-gateway
/opt/ai-stack/venv/bin/python3 --version
```

应看到 4 个目录和 Python 版本号。

---

## 3. 第二步：KSE 安装

### 3.1 安装 DEB 包

将 KSE 安装包（`.deb`）和许可证文件（`.key`）上传到服务器，执行：

```bash
sudo dpkg -i kavscanengine_2.2.0.xxxx_amd64.deb
sudo apt -f install -y
```

验证：

```bash
ls -lh /opt/kaspersky/ScanEngine/bin/kavhttpd
ls -lh /opt/kaspersky/ScanEngine/etc/kavhttpd.xml
```

### 3.2 安装许可证

```bash
sudo cp 你的许可证.key /opt/kaspersky/ScanEngine/bin/
sudo chmod 644 /opt/kaspersky/ScanEngine/bin/*.key
```

验证：`ls -lh /opt/kaspersky/ScanEngine/bin/*.key` 应看到 key 文件。

### 3.3 准备 TLS 证书

复用 KSE Web UI 自带的自签证书：

```bash
sudo cp /opt/kaspersky/ScanEngine/httpsrv/kl_scanengine_cert.pem \
        /opt/kaspersky/ScanEngine/etc/kavhttpd_cert.pem
sudo cp /opt/kaspersky/ScanEngine/httpsrv/kl_scanengine_private.pem \
        /opt/kaspersky/ScanEngine/etc/kavhttpd_key.pem
ls -lh /opt/kaspersky/ScanEngine/etc/kavhttpd_*.pem
```

---

## 4. 第三步：KSE 配置（Web UI 方式）

> ⚠️ **必须使用 Web UI 配置，不要手动改 XML。** Web UI 会自动加密 Token、验证配置、重启服务；
> 手动改 XML 容易踩字段名错误。

### 4.1 访问 Web UI

浏览器打开 `https://<服务器IP>`（如 `https://10.254.205.89`），接受自签证书警告，使用管理员账号登录。

### 4.2 配置 Service

进入 `Settings → Service`：

| 配置项 | 值 | 说明 |
| --- | --- | --- |
| Protocol | HTTPS | Token 认证必须用 HTTPS |
| IP address | 0.0.0.0 | 允许所有网卡访问（仅本机用 127.0.0.1） |
| Port | 8443 | KSE API 端口 |
| Private key path | `/opt/kaspersky/ScanEngine/etc/kavhttpd_key.pem` | TLS 私钥 |
| Certificate | `/opt/kaspersky/ScanEngine/etc/kavhttpd_cert.pem` | TLS 证书 |

### 4.3 配置 Authorization

进入 `Settings → Authorization`：

1. 打开 **Enable authorization for HTTP clients**（On）
2. **Authorization header field** 保持默认 `Authorization`
3. 打开 **Add bearer prefix**（On）
4. 点 **Add token** 按钮
5. **Name** 填 `scan-gateway`
6. 点 **Generate token** 自动生成 Token
7. **立刻复制生成的明文 Token**，保存到安全位置（Save 后 Web UI 不再显示）
8. 打开 **Enable token**（On）
9. 点 **Save**

> Token 要求：4–100 个 ASCII 字符，必须包含大小写字母、数字、特殊字符（`-._~+/).`）。
> Web UI 自动生成的 Token 自动符合要求。**调用 API 时使用明文 Token，不是 XML 里的 88 字节加密值。**

### 4.4 配置扫描目录

进入 `Settings → Scanning`，添加允许扫描的目录：`/opt/kaspersky/scanqueue`

### 4.5 保存并重启

点右下角 **Save**，KSE 会自动重启。等待约 30 秒。

验证：

```bash
systemctl status kavhttpd --no-pager
ss -tlnp | grep 8443
```

应看到 `active (running)` 和 `0.0.0.0:8443` 监听。

---

## 5. 第四步：KSE 验证

### 5.1 EICAR 测试（带 Token）

```bash
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /opt/kaspersky/scanqueue/eicar.txt

curl -k -X POST https://127.0.0.1:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer 你的明文Token" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
```

预期返回：

```json
{
    "object": "/opt/kaspersky/scanqueue/eicar.txt",
    "scanResult": "DETECT",
    "detectionName": "EICAR-Test-File"
}
```

### 5.2 不带 Token 测试（应被拒绝）

```bash
curl -k -X POST https://127.0.0.1:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
```

预期：返回 401 或认证错误，说明 Token 认证生效。

### 5.3 远程调用测试（应被拒绝）

从另一台机器执行：

```bash
curl -k -X POST https://<KSE服务器IP>:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer 你的明文Token" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
```

预期：返回 `Scan file via remote request is rejected`。

> 这是 KSE 的安全机制——**路径扫描只允许本机调用**，远程调用必须走 Scan Gateway。

---

## 6. 第五步：Scan Gateway 安装

代码见本仓库 [`gateway/scan-gateway/app.py`](../gateway/scan-gateway/app.py)。

```bash
cd /opt/ai-stack/scan-gateway
# 放置 app.py 与 .env（复制 .env.example 并填写 KSE_TOKEN）
sudo cp /path/to/kse-ai-gateway/gateway/scan-gateway/app.py .
sudo cp /path/to/kse-ai-gateway/.env.example .env
sudo chmod 600 .env
sudo vi .env      # 至少填写 KSE_TOKEN
```

### 6.1 配置 systemd 服务

```bash
sudo tee /etc/systemd/system/scan-gateway.service > /dev/null << 'EOF'
[Unit]
Description=KSE Scan Gateway
After=network.target kavhttpd.service
Wants=kavhttpd.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-stack/scan-gateway
EnvironmentFile=-/opt/ai-stack/scan-gateway/.env
ExecStart=/opt/ai-stack/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable scan-gateway
sudo systemctl start scan-gateway
```

### 6.2 验证

```bash
systemctl status scan-gateway --no-pager
curl http://127.0.0.1:8000/health
```

### 6.3 扫描测试

```bash
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /opt/kaspersky/scanqueue/eicar.txt

curl -X POST http://127.0.0.1:8000/scan/file \
  -H "Content-Type: application/json" \
  -d '{"file_path":"/opt/kaspersky/scanqueue/eicar.txt","timeout":60}'
```

预期：返回 `verdict: DETECT`，文件被移到隔离区。

---

## 7. 第六步：Upload Gateway 安装

代码见本仓库 [`gateway/upload-gateway/app.py`](../gateway/upload-gateway/app.py)。

```bash
cd /opt/ai-stack/upload-gateway
sudo cp /path/to/kse-ai-gateway/gateway/upload-gateway/app.py .
sudo cp -r /path/to/kse-ai-gateway/gateway/upload-gateway/templates .
sudo cp /path/to/kse-ai-gateway/.env.example .env
sudo chmod 600 .env
sudo vi .env   # 填写 ANYTHINGLLM_URL / ANYTHINGLLM_API_KEY / WORKSPACE_SLUG
```

### 7.1 配置 systemd 服务

> 端口用 **8002** 而非 8001，因为 8001 通常被 ClickHouse（KUMA 组件）占用。

```bash
sudo tee /etc/systemd/system/upload-gateway.service > /dev/null << 'EOF'
[Unit]
Description=AnythingLLM Secure Upload Gateway
After=network.target scan-gateway.service
Wants=scan-gateway.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ai-stack/upload-gateway
EnvironmentFile=-/opt/ai-stack/upload-gateway/.env
ExecStart=/opt/ai-stack/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8002
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable upload-gateway
sudo systemctl start upload-gateway
```

### 7.2 验证

```bash
systemctl status upload-gateway --no-pager
curl http://127.0.0.1:8002/health
```

浏览器打开 `http://<服务器IP>:8002` 能看到上传页面。

---

## 8. 第七步：AnythingLLM 对接

### 8.1 获取 API Key

打开 AnythingLLM 网页（`http://<服务器IP>:3001`）→ 左下角头像 → 设置（Settings）→ 左侧菜单 →
**开发者 API（Developer API）** → 点 **生成 API Key（Generate API Key）** → 复制 Key（形如 `G0xxx-xxxx-xxxx`）。

### 8.2 获取工作区 slug

```bash
curl -s -H "Authorization: Bearer <你的API_Key>" \
  http://<服务器IP>:3001/api/v1/workspaces | python3 -m json.tool
```

在输出中找到目标工作区的 `slug` 字段（形如 UUID：`1606d3aa-xxxx-xxxx`）。

### 8.3 更新 Upload Gateway 配置

编辑 `/opt/ai-stack/upload-gateway/.env`：

```bash
ANYTHINGLLM_API_KEY=<7.1 步获取的 API Key>
WORKSPACE_SLUG=<7.2 步获取的 slug>
```

```bash
sudo systemctl restart upload-gateway
systemctl status upload-gateway --no-pager
```

---

## 9. 第八步：端到端验证

1. **上传正常文件** — 浏览器打开 `http://<服务器IP>:8002`，选择正常 PDF/TXT，保持「同时添加到工作区」勾选，
   点「上传并扫描」。预期：显示「上传成功」，文件出现在 AnythingLLM 工作区。
2. **上传威胁文件（应被拒绝）** — 把 EICAR 字符串写入文件开头后上传，预期显示「文件检出威胁，已拒绝入库」。
3. **测试「只上传到我的文档」** — 取消勾选，预期上传成功但提示「未添加到工作区」。
4. **查看隔离区** — `ls -lh /opt/kaspersky/quarantine/` 应看到被隔离的 EICAR 测试文件。

---

## 10. 第九步：防火墙配置

```bash
# 对外开放的端口
sudo ufw allow 3001/tcp   # AnythingLLM
sudo ufw allow 8002/tcp   # 安全上传页面
sudo ufw allow 443/tcp    # KSE Web UI

# 仅内网访问的端口（根据实际网络调整）
sudo ufw allow from 10.0.0.0/8 to any port 8443   # KSE API
sudo ufw allow from 10.0.0.0/8 to any port 8000   # Scan Gateway

sudo ufw reload
sudo ufw status
```

> **安全建议**：KSE API（8443）和 Scan Gateway（8000）不要对公网开放，只允许内网或特定 IP 访问。
> 对外只开放 AnythingLLM（3001）和安全上传页面（8002）。

---

## 11. 第十步：OpenClaw Plugin 安装与配置

见 [`agent/openclaw-plugin/README.md`](../agent/openclaw-plugin/README.md)。

### 11.1 环境要求

| 项目 | 要求 |
| --- | --- |
| OpenClaw 版本 | 2026.7.1 或以上 |
| 操作系统 | Windows Server（OpenClaw 运行端） |
| Node.js | v20 或以上（OpenClaw 自带运行时） |
| 网络 | OpenClaw 机器需能访问 Scan Gateway |

### 11.2 三个拦截点

| 拦截点 | 工具 | 扫描范围 | 拦截行为 |
| --- | --- | --- | --- |
| 一 | `write` | 所有写入的文件内容，不限扩展名 | 阻止文件写入 |
| 二 | `exec` | 待执行脚本 / 待加载模型 / Skill 下载命令 | 阻止命令执行 |
| 三 | `edit` | 编辑的新内容（`new_string`） | 阻止文件编辑 |

### 11.3 验证测试

```powershell
openclaw gateway stop
openclaw gateway run

# 发起一次对话触发插件预热，然后查看日志
Get-Content "$env:USERPROFILE\.openclaw\plugins\kse-gate\debug.log" -Encoding utf8 -Tail 20
```

预期出现 `register() called` 和 `before_tool_call hook registered successfully`。

**测试 write 拦截**：

```
用 write 工具写 C:\temp\eicar_test.txt，内容是 X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*
```

预期：文件写入被阻止，`debug.log` 显示 `检出威胁，阻止写入: EICAR-Test-File`。

---

## 12. 第十一步：Ollama 模型下载监控与自动隔离

适用于 Ollama 以 Docker 部署在 kumadb 的场景。自动监控模型下载目录，新模型文件出现时调用 KSE 扫描，
检出威胁后自动隔离。

### 12.1 环境要求

- Ollama：Docker 部署，模型目录挂载到宿主机 `/root/ai-stack/ollama`
- KSE：已配置 HTTPS + Token，正常运行
- Scan Gateway：已部署并正常运行（端口 8000）
- `inotify-tools`：文件系统事件监控

### 12.2 KSE 扫描目录配置

KSE Web UI → `Settings → Service` → **Locations where remote scanning is allowed** → **Add path** →
添加 `/root/ai-stack/ollama/models/blobs` → Save → `systemctl restart kavhttpd`。

### 12.3 Scan Gateway 路径扩展

Scan Gateway 的 `/scan/file` 有独立的路径白名单校验，需把 Ollama 模型目录加入
`.env` 的 `ALLOWED_SCAN_DIRS`：

```bash
ALLOWED_SCAN_DIRS=/opt/kaspersky/scanqueue,/root/ai-stack/ollama/models/blobs
```

```bash
sudo systemctl restart scan-gateway
```

### 12.4 监控脚本部署

```bash
apt install -y inotify-tools
sudo cp /path/to/kse-ai-gateway/watchers/ollama-watcher.sh /opt/ai-stack/
sudo chmod +x /opt/ai-stack/ollama-watcher.sh
sudo cp /path/to/kse-ai-gateway/gateway/systemd/ollama-watcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ollama-watcher
```

### 12.5 验证

```bash
# 创建 12MB 的 EICAR 测试文件（EICAR 必须在开头才能被标准检出）
echo -n 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /root/ai-stack/ollama/models/blobs/test_eicar
dd if=/dev/zero bs=1M count=11 | tr '\0' 'X' >> /root/ai-stack/ollama/models/blobs/test_eicar

sleep 45
tail -10 /var/log/ollama-watcher.log
ls -la /opt/kaspersky/quarantine/ | grep test_eicar
```

预期：日志显示 `检出威胁!`，隔离区存在该文件，原目录文件已被移走，Ollama 加载该模型会失败。

---

## 13. 附录

### 13.1 端口清单

| 端口 | 服务 | 协议 | 对外开放 |
| --- | --- | --- | --- |
| 443 | KSE Web UI | HTTPS | 管理用，建议限内网 |
| 8443 | KSE API | HTTPS | 否，仅本机/内网 |
| 8000 | Scan Gateway | HTTP | 否，仅内网 |
| 8002 | Upload Gateway | HTTP | 是（用户上传用） |
| 3001 | AnythingLLM | HTTP | 是 |
| 5432 | PostgreSQL（KSE Web UI 用） | TCP | 否，仅本机 |

### 13.2 配置文件路径

| 组件 | 配置文件 | 程序目录 |
| --- | --- | --- |
| KSE | `/etc/kavhttpd.xml`（软链接） | `/opt/kaspersky/ScanEngine/` |
| Scan Gateway | `/etc/systemd/system/scan-gateway.service` | `/opt/ai-stack/scan-gateway/` |
| Upload Gateway | `/etc/systemd/system/upload-gateway.service` | `/opt/ai-stack/upload-gateway/` |

### 13.3 常见问题快速排查

| 现象 | 排查命令 |
| --- | --- |
| KSE 启动失败 | `journalctl -u kavhttpd -n 30 --no-pager` |
| Token 认证失败 | 确认 Web UI 里 Token 状态 Enabled，用明文 Token 测试 |
| Scan Gateway 500 | `journalctl -u scan-gateway -n 30 --no-pager`，检查 KSE_URL 和 KSE_TOKEN |
| Upload Gateway 入库失败 | `journalctl -u upload-gateway -n 30 --no-pager`，检查 API Key 和 slug |
| 端口被占用 | `ss -tlnp \| grep 端口号` |
| 远程调用 KSE 被拒 | 正常现象，走 Scan Gateway（8000）调用 |
