# 真实环境落地记录（Field Notes）

本文记录在**真实生产环境**部署 kse-ai-gateway 时，遇到的与文档假设不一致的地方，
以及最终采用的解决方案。全部内容来自实测，不是推测。

环境：

| 角色 | 主机 | 说明 |
| --- | --- | --- |
| AI 网关机 | `192.168.1.121` (kuma2.prell.cn) | Ubuntu 24.04.3，16C/31G，ClickHouse 已占 8001 |
| KSE 主机 | `192.168.1.122` (kuma3.prell.cn) | Ubuntu 24.04.3，KSE 2.2 原生安装 |
| 网络 | 两者**均无外网**（pypi / github 均不可达） | 典型离线内网 |

---

## 1. KSE 实际配置与文档假设的差异

| 项 | 文档假设 | **实测实际** |
| --- | --- | --- |
| 协议 | HTTPS | **HTTP**（`http://0.0.0.0:1234`） |
| 端口 | 8443 | **1234** |
| Token 认证 | 开启，明文 Token | **关闭**（`UseAccessToken=0`，`AccessTokens` 为空） |
| TLS 证书 | 必需（`kavhttpd_cert.pem`） | 未配置，`etc/` 下无证书 |
| 扫描路径白名单 | `/opt/kaspersky/scanqueue` | **`ScanningPaths` 为空** |
| 压缩包解包深度 | 默认 | **`MaxArchivesScanningDepth=0`（KSE 不解包）** |
| 压缩包炸弹防护 | 开启 | **`DiskUsageLimit=0`（关闭）** |
| Web UI / PostgreSQL | 有 | 有（`klScanEngineUI` + PostgreSQL 5432） |

> **结论**：手册里的「必须用 Web UI 配置 HTTPS + Token」在本环境**不适用**（KSE 是用 XML 手工配置的）。
> 网关因此必须支持 **HTTP + 无 Token**，并且不能依赖 KSE 自身的压缩包解包能力。

### 落地调整

- `KSE_VERIFY_TLS=false`、`KSE_TOKEN=` 留空即可
- **压缩包逐文件扫描由网关自己做**（`/scan/package` 自己解包 + 逐文件送检），
  不依赖 KSE 的 `MaxArchivesScanningDepth`
- 压缩包炸弹防护在网关侧实现（成员数 / 解压体积 / 压缩比 三重阈值）

---

## 2. 关键发现：路径扫描只能本机调用

实测：

```bash
# 在 KSE 主机 (.122) 上 —— 成功
curl -X POST http://127.0.0.1:1234/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
# → {"scanResult":"DETECT","detectionName":"EICAR-Test-File"}

# 从 AI 网关机 (.121) 远程调 —— 被拒
curl -X POST http://192.168.1.122:1234/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
# → {"error":"Scan file via remote request is rejected"}
```

但 **`scanmemory` 跨机可用**：

```bash
# 跨机内存扫描 —— 成功
B64=$(base64 -w0 eicar.txt)
curl -X POST http://192.168.1.122:1234/api/v3.0/scanmemory \
  -H "Content-Type: application/octet-stream" \
  -d "{\"timeout\":\"60000\",\"object\":\"$B64\"}"
# → {"object":"Memory","scanResult":"DETECT","detectionName":"EICAR-Test-File"}
```

### 解决方案：`KSE_MODE`

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `auto`（默认） | 先试 `scanfile`；遇到跨机拒绝自动回退 `scanmemory` | 通用 |
| `file` | 仅 `scanfile` | 网关与 KSE 同机 |
| `memory` | 仅 `scanmemory` | 分离部署（显式） |

实测 `auto` 模式在分离环境下的 `/health` 输出：

```json
{ "kse_mode": "auto", "kse_mode_used": "memory", "kse_auth": "none" }
```

---

## 3. `checkurl` 的 JSON 键不是 `object`

这是最容易踩的坑。KSE 三个 API 的请求体字段名**不一致**：

| 端点 | 请求体字段 | 正确示例 |
| --- | --- | --- |
| `POST /api/v3.0/scanfile` | `object` | `{"timeout":"60000","object":"/path/to/file"}` |
| `POST /api/v3.0/scanmemory` | `object` | `{"timeout":"60000","object":"<base64>"}` |
| `POST /api/v3.0/checkurl` | **`url`** | `{"timeout":"20000","url":"https://example.com/"}` |

用 `object` 调 `checkurl` 会返回：

```json
{ "error": "SERVER_ERROR 0x80070057" }
```

> 该错误码看起来像参数错误，但含义是"字段名不对"，很容易被误判为「URL 扫描功能不可用」。
> 用官方客户端 `kavhttp_client -s http://127.0.0.1:1234 -u "http://example.com/" -j` 可确认功能本身是好的。

另外注意：**KSE 会用 HTTP 200 返回业务错误**，客户端必须检查响应体里的 `error` 字段，
不能只看 HTTP 状态码。例如路径扫描被拒时返回的是 `200 + {"error":"Scan file via remote request is rejected"}`。

---

## 4. 离线环境：零依赖是刚需，不是优化

两台机器 `pip install` 与 `apt install` 均不可达，Python 环境里没有任何第三方包。

因此本项目在 v1.4 起**全部改为标准库实现**：

| 组件 | 原方案 | 现方案 |
| --- | --- | --- |
| Web 框架 | FastAPI + uvicorn | 自研 `gateway/common/kserver.py`（约 320 行，仅用 `http.server`） |
| HTTP 客户端 | httpx | `urllib.request`（`gateway/common/kse.py`） |
| MCP Server | 官方 `mcp` SDK | 直接实现 JSON-RPC 2.0 over stdio |
| 部署 | 需要 venv + pip | 只需 `python3 app.py` |

部署命令从「装依赖 + 建 venv」变成：

```bash
sudo ./scripts/install_ubuntu.sh
```

---

## 5. 实施过程中踩到的具体坑

### 5.1 PowerShell 的 multipart 不带引号

`Invoke-RestMethod -Form` 发出的头部是：

```
Content-Disposition: form-data; name=file; filename=e.txt; filename*=utf-8''e.txt
```

注意 `name=file` **没有引号**，而且带 RFC 5987 的 `filename*`。
只按 `name="([^"]*)"` 匹配会导致解析不到文件，接口报「缺少上传文件」。

解析器需同时兼容：`name="x"` / `name=x` / `filename*=utf-8''x`。

> 这也是官方手册要求 Windows 端用 `curl.exe` 而非 `Invoke-RestMethod -Form` 的根本原因
> （PS 5.1 干脆没有 `-Form`）。

### 5.2 `tempfile.mkdtemp` 在 Windows 上会锁死子目录

`tempfile.mkdtemp` 使用 `mode=0o700`，在 Windows 上会给目录设置受保护 ACL，
导致**无法在其中创建子目录**（Linux 无此问题）。

表现为解包压缩包时 `PermissionError: [Errno 13]`。

解法：显式 `mkdir` + `os.chmod`，不用 `mkdtemp`：

```python
workdir = SCAN_QUEUE / f"pkgscan_{uuid.uuid4().hex[:12]}"
workdir.mkdir(parents=True, exist_ok=True)
os.chmod(workdir, 0o700)
```

### 5.3 多个服务共用一份 `.env` 会撞端口

`install_ubuntu.sh` 把同一份 `.env.example` 复制给三个服务，
若其中含 `LISTEN_PORT=8000`，三个服务会抢同一个端口，日志里只有一句
`OSError: [Errno 98] Address already in use`。

解法：安装脚本按服务强制写入各自端口（8000 / 8002 / 8004），
并在 `kserver.run()` 里给出「端口已被占用」的友好提示。

### 5.4 CRLF 会让 shell 脚本无法执行

用 Python 的 `io.open(path, "w")` 改 `.sh` 文件时，Windows 上 `\n` 会被转成 `\r\n`，
上传到 Linux 后报 `cannot execute: required file not found`（其实是 shebang 后面多了 `\r`）。

批量修正：

```python
with open(p, "rb") as f: data = f.read()
data = data.replace(b"\r\n", b"\n")
with open(p, "wb") as f: f.write(data)
```

---

## 6. 本环境实测结果

```
── L0  KSE 引擎直连 ─────────────────────────────────
  ✓ PASS  KSE 直扫 EICAR (无 Token 认证)            scanResult=DETECT (scanmemory 跨机)

── L1  Scan Gateway (:8000) ─────────────────────────
  ✓ PASS  健康检查 /health                           status=ok
  ✓ PASS  scan/file 干净文件放行                     verdict=CLEAN
  ✓ PASS  scan/file EICAR 检出                       verdict=DETECT, detection=EICAR-Test-File
  ✓ PASS  威胁文件自动隔离                           quarantined=true
  ✓ PASS  scan/upload 内容扫描                       verdict=CLEAN
  ✓ PASS  scan/package 干净包                        verdict=CLEAN
  ✓ PASS  scan/package 内藏 EICAR 检出                verdict=DETECT, threats=1
  ✓ PASS  scan/url URL 扫描                          verdict=CLEAN

── L2  Upload Gateway (:8002) ───────────────────────
  ✓ PASS  健康检查 /health                           status=ok
  ✓ PASS  上传干净文件                               HTTP 200
  ✓ PASS  上传 EICAR 被拒绝                          HTTP 403 (Fail-Closed)

── L3  隔离区复核台 (:8004) ─────────────────────────
  ✓ PASS  健康检查 /health                           status=ok
  ✓ PASS  隔离文件列表 API                           共 N 项
  ✓ PASS  威胁统计 API                               by_threat 字段存在
  ✓ PASS  复扫隔离文件                               verdict=DETECT

── L4  MCP Server (stdio) ───────────────────────────
  ✓ PASS  MCP initialize + tools/list                返回工具含 scan_file
  ✓ PASS  MCP 工具 scan_text / scan_url / scan_skill_pkg / kse_status  已注册

── L5  systemd 服务与监控 ───────────────────────────
  ✓ PASS  服务 scan-gateway                          active
  ✓ PASS  服务 upload-gateway                        active
  ✓ PASS  服务 quarantine-console                    active
  ✓ PASS  KSE 远程可达                               http://192.168.1.122:1234 (部署在独立主机)
  ✓ PASS  审计日志有记录                              N 条

 汇总:  PASS 26  FAIL 0  WARN 0  SKIP 1
```

MCP 工具真实调用结果：

```
id=2  scan_text(EICAR)  → verdict: DETECT / EICAR-Test-File / 已隔离
id=3  scan_text(正常)   → verdict: CLEAN
id=4  kse_status        → kse_mode: auto (实际使用: memory)
```

---

## 7. ⚠️ 安全发现（待处理）

### 7.1 KSE API 无认证且暴露在局域网

```xml
<ConnectionString>http://0.0.0.0:1234</ConnectionString>
<UseAccessToken>0</UseAccessToken>
<AccessTokens/>
```

KSE 的扫描 API 在 `192.168.1.122:1234` 上**不做任何认证**，同网段任意主机都能直接调用它扫描文件。

**建议**（需要管理员在 KSE Web UI 操作，不要手改 XML）：

1. `Settings → Service`：Protocol 改为 **HTTPS**，填写
   Private key path = `/opt/kaspersky/ScanEngine/etc/kavhttpd_key.pem`、
   Certificate = `/opt/kaspersky/ScanEngine/etc/kavhttpd_cert.pem`
   （证书可从 `httpsrv/kl_scanengine_cert.pem` 与 `kl_scanengine_private.pem` 复制）
2. `Settings → Authorization`：打开 **Enable authorization for HTTP clients**，
   添加 Token（勾选 Add bearer prefix），打开 **Enable token**
3. `Settings → Scanning`：把 `ScanningPaths` 配置为实际需要的目录
4. 防火墙只允许 AI 网关机访问 1234

改造完成后，网关侧只需同步更新：

```bash
KSE_URL=https://192.168.1.122:8443
KSE_TOKEN=<新生成的明文 Token>
KSE_VERIFY_TLS=false      # 自签证书
```

### 7.2 KSE 不解包压缩包

`MaxArchivesScanningDepth=0` 意味着 KSE 自身不解包，
**依赖 KSE 直接扫压缩包会漏检包内文件**。本项目的 `/scan/package` 在网关侧自行解包逐文件扫描，
不受此影响；但如果还有其他系统直接调用 KSE 扫压缩包，需要注意这一点。

### 7.3 SSH 主机密钥重复

`.121` 与 `.122` 的 SSH ed25519 主机密钥指纹完全相同：

```
ssh-ed25519 255 SHA256:ScBYEoD4ItN7+5hB1L2BLopOEl6Jc6382GStsJ4PEOA
```

说明两台机器是从同一镜像克隆的（或曾复制过 `/etc/ssh`）。
建议为每台机器重新生成独立主机密钥：

```bash
ssh-keygen -A          # 删除旧密钥
systemctl restart ssh
```

---

## 8. 本环境的最终配置

`/opt/ai-stack/scan-gateway/.env`：

```bash
KSE_URL=http://192.168.1.122:1234
KSE_MODE=auto
KSE_TOKEN=
KSE_TIMEOUT=120
KSE_VERIFY_TLS=false

SCAN_QUEUE=/opt/kaspersky/scanqueue
QUARANTINE=/opt/kaspersky/quarantine
ALLOWED_SCAN_DIRS=/opt/kaspersky/scanqueue,/opt/kaspersky/quarantine
AUDIT_LOG=/opt/ai-stack/scan-gateway/logs/audit.jsonl

LISTEN_HOST=0.0.0.0
LISTEN_PORT=8000
```

服务端口占用情况（`192.168.1.121`）：

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 8000 | Scan Gateway | 本项目 |
| 8001 | ClickHouse | **已被占用**（KUMA 组件）→ Upload Gateway 避开此端口 |
| 8002 | Upload Gateway | 本项目 |
| 8004 | Quarantine Console | 本项目 |

> 注意 `192.168.1.121` 上没有 Docker，因此 AnythingLLM 未部署，
> Upload Gateway 设为 `FORWARD_ENABLED=false`（只验证扫描链路，不转发入库）。
