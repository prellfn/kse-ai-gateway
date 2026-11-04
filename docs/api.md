# API 参考

kse-ai-gateway 共对外暴露 4 个服务：

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| Scan Gateway | 8000 | 核心扫描服务，所有扫描能力入口 |
| Upload Gateway | 8002 | 安全上传页面 → AnythingLLM |
| Quarantine Console | 8004 | 隔离区人工复核台 |
| MCP Server | stdio | Model Context Protocol 服务（供 Codex / Claude Code 等客户端接入） |

---

## 1. Scan Gateway（:8000）

Base URL：`http://<host>:8000`

### 1.1 `GET /health`

健康检查。

```bash
curl http://127.0.0.1:8000/health
```

```json
{
  "status": "ok",
  "kse_url": "https://127.0.0.1:8443",
  "scan_queue": "/opt/kaspersky/scanqueue",
  "quarantine": "/opt/kaspersky/quarantine",
  "allowed_dirs": ["/opt/kaspersky/scanqueue", "/opt/kaspersky/quarantine"],
  "cache_size": 12,
  "time": "2026-11-04T00:30:00+00:00"
}
```

### 1.2 `POST /scan/file` — 路径扫描

扫描本机文件。**文件必须位于 `ALLOWED_SCAN_DIRS` 之内**，否则返回 403。

**请求**

```json
{ "file_path": "/opt/kaspersky/scanqueue/sample.pdf", "timeout": 120 }
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `file_path` | string | 必填 | 绝对路径 |
| `timeout` | int | 120 | 扫描超时（秒） |

**响应（DETECT）**

```json
{
  "request_id": "req_01j9x8k2m4",
  "file_path": "/opt/kaspersky/scanqueue/eicar.txt",
  "sha256": "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
  "size": 68,
  "verdict": "DETECT",
  "detection_name": "EICAR-Test-File",
  "quarantined": true,
  "quarantine_path": "/opt/kaspersky/quarantine/275a021b..._1700000000_eicar.txt",
  "scanned_at": "2026-11-04T00:30:00+00:00"
}
```

**响应（CLEAN）** — 同上，但 `verdict: "CLEAN"`、`quarantined: false`。

**错误码**

| 状态码 | 原因 |
| --- | --- |
| 403 | 路径不在允许的扫描目录内 |
| 404 | 文件不存在 |
| 413 | 超过 `MAX_FILE_SIZE` |
| 502 | KSE 返回错误或不可达 |

### 1.3 `POST /scan/upload` — 内容上传扫描

跨机器调用的统一入口（Windows Plugin / File Watcher 使用）。

```bash
curl -X POST http://127.0.0.1:8000/scan/upload \
  -F "file=@./sample.pdf" \
  -F "filename=sample.pdf" \
  -F "timeout=300"
```

文件会先落盘到扫描队列，扫描后由调用方决定是否删除（DETECT 时已被移入隔离区）。

### 1.4 `POST /scan/package` — 压缩包深度扫描

解包后**逐文件扫描**，任一文件命中威胁即判定整包为 `DETECT` 并整包隔离。
用于拦截「压缩包内单个文件带毒」的场景 —— 单纯的整包扫描容易被免杀。

```bash
curl -X POST http://127.0.0.1:8000/scan/package \
  -F "file=@./my-skill.zip"
```

**响应**

```json
{
  "request_id": "req_abc123",
  "package_name": "my-skill.zip",
  "sha256": "…",
  "size": 24576,
  "members_total": 12,
  "members_scanned": 12,
  "verdict": "DETECT",
  "threats_count": 1,
  "threats": [
    { "file_path": "/opt/kaspersky/scanqueue/pkgscan_x/install.sh",
      "verdict": "DETECT", "detection_name": "HEUR:Trojan.Script.Agent" }
  ],
  "quarantined": true,
  "quarantine_path": "/opt/kaspersky/quarantine/…_my-skill.zip"
}
```

**安全防护**

| 防护项 | 配置项 | 默认 |
| --- | --- | --- |
| 成员数量上限 | `MAX_ARCHIVE_MEMBERS` | 5000 |
| 解压后总体积上限 | `MAX_ARCHIVE_UNPACKED` | 500MB |
| 压缩比上限 | `MAX_COMPRESSION_RATIO` | 100 |
| 路径穿越（Zip Slip） | 内置 | 拦截并返回 400 |

### 1.5 `POST /scan/url` — URL 扫描

检测钓鱼站点与恶意跳转链接。

```bash
curl -X POST http://127.0.0.1:8000/scan/url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/login"}'
```

**响应**

```json
{
  "request_id": "req_url01",
  "url": "https://example.com/login",
  "verdict": "DETECT",
  "detection_name": "HEUR:Phishing.URL",
  "raw": { "scanResult": "DETECT", "urlInfo": { "ThreatName": "HEUR:Phishing.URL" } },
  "scanned_at": "2026-11-04T00:30:00+00:00"
}
```

> ⚠️ **前置条件**：KSE 的 URL 扫描需要在 Web UI `Settings → Service` →
> **Locations where remote scanning is allowed** 中添加相关 URL / 规则，
> 否则 KSE 会拒绝远程 URL 扫描请求。

### 1.6 `POST /scan/directory` — 目录批量扫描

```json
{ "dir_path": "/opt/kaspersky/scanqueue", "recursive": true, "timeout": 120 }
```

```json
{ "total": 42, "threats_count": 1, "threats": [ … ], "all_clean": false }
```

---

## 2. Upload Gateway（:8002）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 安全上传页面 |
| `POST` | `/upload` | 上传 → 扫描 → CLEAN 才入库 AnythingLLM |
| `GET` | `/health` | 健康检查 |

**请求**

```bash
curl -X POST http://127.0.0.1:8002/upload \
  -F "file=@./report.pdf" \
  -F "add_to_workspace=true"
```

**响应（成功）**

```json
{
  "status": "success",
  "message": "文件 report.pdf 已通过安全扫描并上传到我的文档，并添加到工作区",
  "sha256": "…",
  "detection_name": "",
  "added_to_workspace": true
}
```

**错误**

| 状态码 | 原因 |
| --- | --- |
| 400 | 不支持的文件类型 / 空文件 |
| 403 | 检出威胁，拒绝入库（文件已隔离） |
| 413 | 超过 `MAX_UPLOAD_SIZE` |
| 500 | 扫描结果非 CLEAN（Fail-Closed） |
| 502 | Scan Gateway 不可达 |

---

## 3. Quarantine Console（:8004）

> ⚠️ 默认**无鉴权**，请仅部署在内网，或置于反向代理（Nginx + Basic Auth / mTLS）之后。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 复核台页面（隔离文件 / 审计流水 / 威胁统计） |
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/quarantine` | 列出隔离文件，支持 `?status=` `?q=` 过滤 |
| `GET` | `/api/quarantine/{id}` | 单个文件详情 |
| `POST` | `/api/quarantine/{id}/rescan` | 重新扫描（验证误报） |
| `POST` | `/api/quarantine/{id}/restore` | 恢复；`?target_path=` 可指定绝对路径 |
| `POST` | `/api/quarantine/{id}/mark?status=` | 标记结论：`false_positive` / `confirmed_threat` / `pending_review` |
| `DELETE` | `/api/quarantine/{id}` | 永久删除 |
| `GET` | `/api/audit?limit=100` | 网关审计流水尾部 |
| `GET` | `/api/stats` | 威胁统计（按名称 / 按状态） |

**示例**

```bash
# 列出待复核
curl "http://127.0.0.1:8004/api/quarantine?status=pending_review"

# 复扫
curl -X POST http://127.0.0.1:8004/api/quarantine/<quarantine_id>/rescan

# 恢复
curl -X POST "http://127.0.0.1:8004/api/quarantine/<quarantine_id>/restore"

# 标记为误报
curl -X POST "http://127.0.0.1:8004/api/quarantine/<quarantine_id>/mark?status=false_positive"

# 删除
curl -X DELETE http://127.0.0.1:8004/api/quarantine/<quarantine_id>
```

---

## 4. MCP Server（stdio）

传输方式：`stdio`。配置见 [`gateway/mcp-server/README.md`](../gateway/mcp-server/README.md)。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `scan_file` | `file_path: str`, `timeout: int = 120` | 扫描结论文本 |
| `scan_text` | `filename: str`, `content: str`, `timeout: int = 120` | 扫描结论文本 |
| `scan_url` | `url: str`, `timeout: int = 60` | 扫描结论文本 |
| `scan_skill_pkg` | `package_path: str`, `timeout: int = 300` | 扫描结论文本 |
| `kse_status` | — | 网关状态文本 |

返回文本格式：

```
verdict: DETECT
detection_name: EICAR-Test-File
sha256: 275a021bbfb6489e…
quarantined: true
⛔ 检出威胁，禁止继续使用该内容。
```

**客户端配置**

```json
{
  "mcpServers": {
    "kse-ai-gateway": {
      "command": "/opt/ai-stack/mcp-venv/bin/python",
      "args": ["/opt/ai-stack/mcp-server/server.py"],
      "env": {
        "KSE_SCAN_GATEWAY": "http://127.0.0.1:8000",
        "KSE_SCAN_TIMEOUT": "300"
      }
    }
  }
}
```

---

## 5. 审计日志

Scan Gateway 与复核台都会写入 JSON Lines 审计日志：

```
/opt/ai-stack/scan-gateway/logs/audit.jsonl
```

每行一条 JSON：

```json
{"ts":"2026-11-04T00:30:00+00:00","event":"scan_file","request_id":"req_01j9x8k2m4","file_path":"/opt/kaspersky/scanqueue/eicar.txt","sha256":"275a021b…","verdict":"DETECT","detection_name":"EICAR-Test-File","quarantined":true}
```

**事件类型**

| event | 触发时机 |
| --- | --- |
| `scan_file` | 路径扫描完成 |
| `scan_upload` | 上传扫描完成 |
| `scan_package` | 压缩包深度扫描完成 |
| `scan_url` | URL 扫描完成 |
| `scan_directory` | 目录批量扫描完成 |
| `scan_cached` | 命中 SHA256 缓存，未重复扫描 |
| `scan_error` / `scan_url_error` | 扫描失败 |
| `quarantine_failed` | 隔离动作失败 |
| `quarantine_rescan` | 复核台发起复扫 |
| `quarantine_restored` | 复核台恢复文件 |
| `quarantine_marked` | 复核台标记结论 |
| `quarantine_deleted` | 复核台删除文件 |
