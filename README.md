# Codex-KAIP (`kse-ai-gateway`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-WIP-orange)](https://github.com/prellfn/Codex-KAIP)
[![Kaspersky Scan Engine](https://img.shields.io/badge/Powered%20by-Kaspersky%20Scan%20Engine-006D5B)](https://support.kaspersky.com/ScanEngine)

**Codex-KAIP（Kaspersky AI Inspection Proxy / `kse-ai-gateway`）** 是一个面向 AI Agent 的安全网关：在卡巴斯基扫描引擎（Kaspersky Scan Engine，KSE）所在机器上部署，让 AI Agent 的所有高危操作——**工具调用、Skill 下载、脚本执行、知识库文档上传**——统一经过网关转发给 KSE 扫描判定，实现 **「Agent 不裸跑，恶意内容不过网」**。

---

## 为什么需要它

AI Agent（如 WorkBuddy、OpenCode、Codex 等）在执行任务时会下载第三方 Skill、运行脚本、调用外部工具、写入知识库。这些动作意味着**不受信任的内容会直接进入执行环境或数据资产**，典型风险包括：

- **供应链投毒**：恶意或被篡改的 Skill / Plugin 包（夹带木马、后门脚本、危险二进制文件）
- **高危脚本落地**：Agent 生成或拉取的脚本中夹带恶意载荷，落地后被直接执行
- **知识库污染与宏病毒**：上传到 RAG / 知识库的文档（PDF、Office、压缩包）携带恶意负载或宏代码
- **外部工具返回投毒**：MCP / 工具调用返回的附件或载荷被污染，进而危害宿主机或下游系统

`Codex-KAIP` 在 Agent 与这些高危操作之间插入一道**强制安全检查点（PEP）**：**所有内容先经 KSE 扫描，判定通过才放行**。

---

## 架构概览

```text
┌─────────────┐   ┌─────────────┐   ┌─────────┐
│  WorkBuddy  │   │   OpenCode  │   │  Codex  │  ... AI Agents
└──────┬──────┘   └──────┬──────┘   └────┬────┘
       │                 │               │
       └────────┬────────┴───────────────┘
                ▼  (HTTP / MCP / Proxy)
       ┌──────────────────────┐        ┌──────────────────────────┐
       │     Codex-KAIP       │───────▶│  Kaspersky Scan Engine   │
       │  (kse-ai-gateway)    │  扫描   │  (KSE 2.x HTTP / ICAP)   │
       │  - 路由与载荷提取      │◀───────│  - 内存/文件流/URL 扫描    │
       │  - 策略引擎 (Fail-Closed) │ 判定 │  - 威胁名称与分类返回      │
       │  - 拦截 / 隔离 / 审计  │        └──────────────────────────┘
       └──────────┬───────────┘
                  │ 仅 Clean 放行
   ┌──────────────┼──────────────┬────────────────┐
   ▼              ▼              ▼                ▼
 工具调用       Skill 下载     脚本执行       知识库文档上传
```

**部署形态**：AI Gateway 与 KSE 部署在同一台内网机器（或同一安全域）上，网关通过本地回环（Loopback）高速调用 KSE，对外向各 AI Agent 提供统一的 HTTP/API 检查与代理入口，无需侵入式改造 Agent 本体。

---

## 核心功能

| 场景 | 拦截点 | 网关行为 |
| --- | --- | --- |
| **工具调用 (`tool-call`)** | Agent ↔ 工具的请求与返回内容 | 提取调用参数/返回文件与载荷送检 KSE，命中检测则阻断并回传结构化安全告警 |
| **Skill 下载 (`skill-download`)** | Skill / 插件包下载通道 | 下载入库前整包扫描（支持归档解包逐文件深度扫描），未通过严禁落盘 |
| **脚本执行 (`script-run`)** | Agent 请求运行脚本/命令 | 脚本与临时产物执行前先过 KSE 内存扫描 (`scanmemory`)，恶意/可疑则阻断执行并记录审计 |
| **知识库上传 (`kb-upload`)** | 文档写入 RAG / 知识库入口 | 文档入库前扫描，可疑文件自动移入隔离区（Quarantine）而非写入知识库 |

### 统一判定策略（Verdict Policy）

| KSE 扫描结果 | 网关标准状态 | 默认处置动作 | 说明 |
| --- | --- | --- | --- |
| `CLEAN` | `clean` | **Allow（放行）** | 未发现威胁，正常转发或返回放行凭证 |
| `SUSPICIOUS` / 启发式告警 | `suspicious` | **Quarantine（隔离）** | 可配置为 `allow` / `quarantine` / `block`，默认隔离待审 |
| `INFECTED` / `PHISHING` | `malicious` | **Block（拦截）** | 立即阻断，返回检测威胁名称（如 `HEUR:Trojan...`）与审计 ID |
| 超时 / 扫描异常 | `error` | **Block（默认拒绝）** | 遵循 Fail-Closed 原则，KSE 不可达或扫描超时默认不放行 |

---

## 工作流程

1. **流量接入**：Agent 将原本直连工具源、Skill 仓库、执行器或知识库的请求发往 `Codex-KAIP`。
2. **载荷提取**：网关按路由规则识别请求类别（`tool-call` / `skill-download` / `script-run` / `kb-upload`），计算 SHA-256 指纹并提取待检内容。
3. **KSE 引擎扫描**：网关调用 KSE HTTP API（`/api/v3.0/scanmemory`、`/api/v3.0/scanfile` 或 `/api/v3.0/checkurl`）执行实时病毒、木马、恶意脚本及钓鱼 URL 检测。
4. **策略裁决**：根据 KSE 返回的判定结果与本地策略配置，执行放行、阻断或隔离。
5. **全链路审计**：请求方标识、载荷 SHA-256、KSE 检测名、耗时与处置动作实时写入 JSON Lines 审计日志。

---

## 快速开始

### 前置要求

- **Kaspersky Scan Engine (KSE) 2.x**（已启用 `kavhttpd` HTTP 模式服务）
- **Docker 20.10+**（推荐）或 **Python 3.10+**
- 一台可被各 AI Agent 访问的内网主机

### 启动网关

```bash
# 1. 克隆仓库
git clone https://github.com/prellfn/Codex-KAIP.git
cd Codex-KAIP

# 2. 配置 KSE 地址与策略
cp config/gateway.example.yaml config/gateway.yaml
# 编辑 config/gateway.yaml，填入 KSE HTTP API 地址、凭证与判定策略

# 3. 启动服务
docker compose up -d
# 默认监听 http://<gateway-host>:8080
```

### 手动测试扫描与上传链路

```bash
# 1. 通用内容扫描接口测试
curl -X POST http://127.0.0.1:8080/v1/scan \
  -F "file=@./sample.pdf" \
  -F "agent=codex"

# 2. 知识库文档安全上传测试（扫描通过后自动转发至下游知识库）
curl -X POST http://127.0.0.1:8080/v1/kb/upload \
  -F "file=@./report.docx"

# 3. 查询最近 10 条安全审计记录
curl http://127.0.0.1:8080/v1/audit?limit=10
```

**拦截响应示例（HTTP 403 Forbidden）**：

```json
{
  "request_id": "req_01j9x8k2m4",
  "verdict": "malicious",
  "action": "block",
  "kse_result": {
    "scan_result": "INFECTED",
    "detection_name": "EICAR-Test-File",
    "engine_version": "2.1.0"
  },
  "sha256": "275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f",
  "timestamp": "2026-11-04T00:30:00Z"
}
```

---

## 配置示例 (`config/gateway.example.yaml`)

```yaml
server:
  listen: "0.0.0.0:8080"

kse:
  endpoint: "http://127.0.0.1:9999/api/v3.0"   # KSE kavhttpd 服务地址
  mode: "scanmemory"                            # scanmemory | scanfile
  timeout: 30s
  verify_tls: false

policy:
  fail_closed: true                             # KSE 异常时默认阻断
  on_suspicious: quarantine                     # allow | quarantine | block
  on_malicious: block
  max_file_size: 100MB

routes:
  tool_call:
    enabled: true
    check_url: true
  skill_download:
    enabled: true
    unpack_scan: true
  script_run:
    enabled: true
  kb_upload:
    enabled: true
    quarantine_dir: "./quarantine"

audit:
  log_path: "./logs/audit.jsonl"
  retain_days: 90
```

---

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/scan` | 通用扫描：直接提交文件/文本/URL，返回 KSE 判定结果 |
| `POST` | `/v1/kb/upload` | 知识库上传链路：扫描通过后转发至目标知识库 |
| `POST` | `/v1/tool/call` | 工具调用链路：扫描请求/响应载荷后放行或阻断 |
| `POST` | `/v1/skill/download` | Skill 下载链路：代理拉取并深度扫描 Skill 包 |
| `POST` | `/v1/script/run` | 脚本执行链路：扫描脚本内容后返回执行许可或阻断 |
| `GET` | `/v1/audit` | 分页查询安全审计日志 |
| `GET` | `/healthz` | 健康检查（含网关状态与 KSE 引擎连通性、病毒库版本） |

> 详细接口定义将逐步完善于 `docs/api.md`。

---

## 支持的 AI Agent

| Agent | 典型接入方式 |
| --- | --- |
| **WorkBuddy** | 通过 Skill 下载代理 + 知识库上传安全端点接入 |
| **OpenCode** | 通过工具端点代理 + 脚本执行前置扫描 Hook 接入 |
| **Codex** | 通过本地命令执行前检查 Hook / MCP 安全代理接入 |

---

## 安全设计原则

- **默认拒绝（Fail-Closed）**：未知路由、超限大文件、KSE 不可达或超时一律不放行。
- **内存优先（In-Memory First）**：优先使用 KSE `scanmemory` 接口在内存中完成流式扫描，避免恶意文件在网关宿主机落盘。
- **最小暴露（Least Privilege）**：网关与 KSE 之间仅走本机回环（`127.0.0.1`），Agent 与网关之间走内网并支持 TLS / Token 鉴权。
- **全量审计（Full Auditability）**：所有请求来源、文件哈希、KSE 判定、处置动作全链路留痕，支持事后溯源。
- **隔离优先（Quarantine First）**：可疑文档自动加密移入隔离区，由管理员复核后再行处置。

---

## Roadmap

- [ ] KSE HTTP API（`scanmemory` / `scanfile` / `checkurl`）客户端封装与判定解析
- [ ] 通用扫描端点（`/v1/scan`）与健康检查（`/healthz`）
- [ ] 工具调用 / 脚本执行拦截链路
- [ ] Skill 下载链路（含压缩包解包逐文件扫描与炸弹防护）
- [ ] 知识库上传链路与隔离区管理
- [ ] JSONL 结构化审计日志与查询 API（`/v1/audit`）
- [ ] 各 AI Agent（WorkBuddy / OpenCode / Codex）接入配置模板与 Hook 脚本
- [ ] 双向 TLS（mTLS）与多租户策略支持
- [ ] Web 轻量级安全监控与隔离复核台

---

## 许可证

本项目采用 [MIT License](LICENSE) 开源许可证。
