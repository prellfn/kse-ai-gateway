# Kaspersky AI Protect（KAIP）平台

基于 **Kaspersky Scan Engine 2.2** 的 AI 安全平台：AI Agent 运行时防护 + AI 供应链入口扫描 + 集中管控。
支持 **Codex / OpenCode / WorkBuddy(CodeBuddy)**，终端支持 **Windows 与 Linux**（macOS 亦可）。

```
 ┌───────────── 终端（Windows / Linux）─────────────┐          ┌──────────── KAIP 服务器（Linux）────────────┐
 │ Codex ──hooks.json──┐                            │          │  KAIP 平台 (FastAPI :8080)                   │
 │ WorkBuddy ─settings─┼─► kaip-hook ─┐             │  HTTPS   │   ├ Agent 判定 API  /api/v1/agent/*          │
 │ OpenCode ──插件─────┘              ├─ kaip 核心 ─┼────────► │   ├ 供应链网关     /api/v1/supply/*          │
 │ kaip watch（Skills/插件/模型目录监控）┘           │          │   ├ 管理控制台     /  /api/v1/console/*      │
 │ 本地隔离区 ~/.kaip/quarantine                     │          │   ├ KAIP 补充规则（pickle/脚本/命令）        │
 └──────────────────────────────────────────────────┘          │   ├ 隔离区 · 策略 · 事件 · SIEM(CEF/Syslog)  │
 业务系统 / CI / RAG 上传 ── API Key ──────────────────────────►│   └ Syslog 接收（KSE ICAP 日志）:5514/udp    │
 终端下载 ── Squid(SSL Bump) ── ICAP ──────────────────────────►│  KSE 2.2 (HTTP :8443 / ICAP :1344, KL_SCAN_LLM)│
                                                                └──────────────────────────────────────────────┘
```

## 功能清单

| 模块 | 能力 |
|---|---|
| **Agent 运行时拦截** | 写文件 / 编辑 / apply_patch 前扫描内容（编辑会还原为完整文件再扫描）；执行命令前扫描引用的脚本与模型文件；高危命令识别（下载即执行、反弹 shell、编码 PowerShell、凭据访问、持久化、关闭防护等）；命令中 URL 信誉检查；安装/下载类命令（git clone、pip/npm install、hf download、ollama pull、skills install…）可禁止或执行后立即扫描新增文件；会话启动时增量扫描 Skills/插件目录 |
| **供应链入口扫描** | 模型文件（PKL/PT/PTH/CKPT/KERAS/H5/GGUF/safetensors…，含 pickle 反序列化危险调用识别）、Skill 包（嵌套压缩）、RAG 文档、训练/微调数据集；数十 GB 流式上传，大文件走 KSE scanfile；平台安全代下载；放行区；RAG 扫描通过后转发 AnythingLLM / Webhook |
| **管理控制台** | 安全概览、事件日志（筛选/导出 CSV）、终端与 Agent 清单（吊销）、供应链扫描、隔离区（误报放行→哈希白名单）、防护策略（集中下发）、接入部署（一键安装命令）、PoC 自检、系统设置 |
| **代理 / ICAP / SIEM** | Squid + SSL Bump → KSE ICAP 配置模板；KSE 日志经 Syslog 汇入平台；平台事件以 CEF/JSON 经 UDP/TCP 转发 SIEM（如 KUMA） |
| **判定规则** | KSE `DETECT` → 阻断；KAIP 规则命中 `RISK` → 按策略阻断/告警；`NON_SCANNED`（加密/损坏/跳过）→ 默认按未放行处理；平台不可达 → 按策略 fail-open / fail-closed |

## 目录结构

```
kaip-platform/
├─ server/                 平台服务端（Python FastAPI，零前端依赖，适合隔离网络）
│  ├─ app/  kse.py(KSE客户端+模拟引擎) analyzers.py(KAIP规则) scanner.py(扫描编排) policy.py
│  │        api_agent.py api_supply.py api_console.py siem.py auth.py db.py(SQLite) main.py
│  └─ web/  控制台（原生 JS）
├─ client/                 终端客户端（Node.js 18+，零依赖）
│  ├─ bin/kaip.js          CLI：enroll / install / uninstall / status / scan / test / watch
│  ├─ bin/kaip-hook.js     Codex & WorkBuddy 命令型 Hook 入口
│  ├─ adapters/opencode/   OpenCode 插件模板
│  ├─ lib/                 common / hook(归一化与判定) / scanfs / install / watch
│  └─ scripts/             install.ps1（Windows） install.sh（Linux/macOS）
├─ deploy/                 docker-compose / kaip.env / install-server.sh / nginx / squid
└─ Dockerfile
```

## 快速开始

### 1. 服务端（Ubuntu 22.04/24.04，与 KSE 同机）

1. 安装 KSE 2.2（HTTP 或 Multi 模式），在 KSE Web UI 中：
   - Settings → Authorization：开启 Token 认证（Bearer），生成 Token；
   - Settings → Scanning：把 `/opt/kaspersky/scanqueue` 加入允许扫描目录；
   - 启用 LLM 模型详细扫描：`ppl/kave.ini` 的 `[Environment]` 段加入 `KL_SCAN_LLM=1`，重启 KSE；
   - 大模型：调大 `ScanMaxFileSize`、`SessionTimeout`（参考 PoC 方案附录 A）。
2. 安装平台（二选一）：
   ```bash
   sudo bash deploy/install-server.sh          # 原生 systemd
   # 或
   cd deploy && cp compose.env.example .env && docker compose up -d    # 容器（host 网络；离线包可先 docker load images/ 中的镜像）
   ```
3. 编辑 `/etc/kaip/kaip.env`（或 `deploy/kaip.env`）填写 `KAIP_KSE_TOKEN`，重启。
4. 浏览器访问 `http://<服务器>:8080`，初始密码见 `/var/lib/kaip/initial_admin_password.txt`，登录后立即修改。
5. 「PoC 自检」一键运行内置无害样本测试。
6. 生产环境用 `deploy/nginx-kaip.conf` 提供 HTTPS。

> 没有 KSE 时可用 `KAIP_KSE_MODE=mock` 启动演示（只识别 EICAR、测试 URL 与 KAIP 规则）。

### 离线环境（内网无 Docker Hub / GitHub / PyPI / npm）

在可联网机器上执行 `python deploy/offline/build_bundle.py` 生成 `dist/kaip-offline-<版本>-<日期>.tar.gz`（约 137 MB：程序、Python 3.10/3.11/3.12 依赖、Windows/Linux Node 运行时、KSE 安装包、校验文件）。内网服务器解压后 `sudo bash install-offline.sh`，无需 pip / venv / apt。终端没有 Node.js 时，一键安装脚本自动从平台下载私有运行时。详见包内 `README-OFFLINE.md`。

### 2. 终端（开发机）

控制台「接入部署」页复制命令，自动识别本机的 Codex / OpenCode / WorkBuddy 并接入：

```bat
:: Windows（cmd）
curl.exe -fsSLk -o "%TEMP%\kaip-install.ps1" https://<平台>/dl/install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\kaip-install.ps1" -Server https://<平台> -Token <注册令牌>
```
```bash
# Linux / macOS
curl -fsSLk https://<平台>/dl/install.sh | bash -s -- --server https://<平台> --token <注册令牌>
```

安装后：
- **Codex**：首次启动在 “Hooks need review” 中信任 KAIP hook（`~/.codex/hooks.json`，并在 config.toml 打开 `codex_hooks`）。未信任的 hook 会被 Codex 直接跳过（`codex exec` 同样如此）。
- **WorkBuddy**：完全退出再启动（hooks 写入 `~/.workbuddy/settings.json` 与 `~/.codebuddy/settings.json`）。企业版可通过后台统一下发同样的 hooks 配置，防止成员自行移除。
- **OpenCode**：插件位于 `~/.config/opencode/plugins/kaip.js`，安装器按版本自动选择 1.x / 2.x 插件写法（可用环境变量 `KAIP_OPENCODE_API=1|2` 强制），重启 OpenCode（含其后台 `opencode-cli` 服务进程）生效。
- **升级任何 AI Agent 后执行 `kaip verify`**：探测各 Agent 的 KAIP 接入是否真正生效（OpenCode 会实际启动一次确认插件已加载、Codex 检查 hook 是否已被信任）。终端也会在后台定期探测并随心跳上报，失效时控制台「终端与 Agent」显示「未生效」，概览出现告警卡片，并产生 `KAIP:Protection.Inactive` 事件。
- `kaip test` 验证拦截链路，`kaip status` 查看状态，`kaip scan <目录>` 手动扫描，`kaip uninstall` 移除 Agent 接入与监控服务（保留 `~/.kaip`，可重新 `kaip install`）；`kaip uninstall --purge` 彻底卸载：另外结束监控进程、移除 PATH、删除安装时的配置备份 `*.kaip.bak` 与 `~/.kaip`（含终端凭据）。卸载时向平台上报 `KAIP:Client.Uninstalled`；须由用户本人执行，Agent 执行会被防篡改阻断。

### 3. 业务系统 / CI / 知识库对接

```bash
curl -sk -H "X-API-Key: <API_KEY>" -F category=model -F file=@model.pt https://<平台>/api/v1/supply/upload
# 返回 {"verdict":"CLEAN|DETECT|RISK|NON_SCANNED", "action":"allow|block", "download": "..."}，仅 action=allow 时入库
```
完整接口见 `https://<平台>/docs`。

## PoC 用例对照

| 用例 | 平台对应 |
|---|---|
| A1/A2 文件与内存扫描 | 供应链上传（scanfile/scanmemory 自动选择）、Agent Hook（scanmemory） |
| B1/B2 模型文件 | 供应链·模型 + KSE KL_SCAN_LLM + pickle 规则 |
| B3 大文件性能 | 流式上传 + scanfile，事件记录耗时 |
| B4 Skill 包 | 供应链·Skill、Agent 安装后扫描、目录监控、会话启动扫描 |
| B5 下载代理 | `deploy/squid/install-squid.sh`（Squid HTTPS 解密 → KSE ICAP，装在 KSE 服务器）；终端 `client-proxy.sh` / `client-proxy.ps1`；检出日志经 Syslog 汇入 |
| B6 企业版管控 | WorkBuddy 企业版下发 hooks 配置 + 策略「禁止 Agent 自行安装」 |
| B7 RAG 文档 | 供应链·RAG + AnythingLLM/Webhook 转发 |
| B8 训练数据集 | 供应链·数据集 |
| C1 URL 信誉 | URL 查询 / 命令中 URL 自动检查 |
| C2 误报 | 隔离区误报放行 → 哈希白名单 |
| C3 日志告警 | 事件日志 + CEF/Syslog → SIEM |
| C4 隔离网段 | KSE 本地镜像更新；平台代下载 |
| C5 共存 | 终端仅 Node 脚本 + Agent 配置，无驻留杀毒组件 |

## 判定与处置原则

- **KSE 检出（DETECT）**：阻断，并自动隔离（平台侧与终端侧）。
- **KAIP 启发式规则（RISK）**：只在**执行时**（Agent 调用工具）按策略阻断；后台/会话启动扫描只告警；**永不自动移动用户文件**。
- 文档/配置文件中的命中、`persistence` / `cred-access` 单独命中：中危，只告警。
- `trusted_paths`（默认含 WorkBuddy / Codex 官方插件市场目录）：启发式只告警，KSE 检出仍阻断。
- 规则回归：`python tests/test_rules.py`；集成测试记录见 [tests/integration/REPORT.md](tests/integration/REPORT.md)。

## 判定缓存（按病毒库版本失效）

同一文件（按内容 SHA-256）在病毒库未更新时不重复扫描：

| 层级 | 位置 | 失效条件 |
|---|---|---|
| 终端 | `~/.kaip/cache.json`、`pathidx.json`（目录增量） | 平台通知新病毒库版本（心跳每 60 秒 / 每次判定响应）即全部失效 |
| 平台 | `verdict_cache` 表 | KSE 病毒库版本（`/api/v3.0/basesdate`，每 60 秒查询）变化即失效，并清理旧版本条目 |

- 兜底有效期 7 天（KSN 云信誉会在病毒库不更新时变化）；查不到病毒库版本（KSE 不可达）时退回 24 小时。
- 只缓存 KSE 确认的「干净 / 检出」；启发式规则的「风险」与无法扫描的结果每次重新判定。
- 病毒库更新后，终端的下一轮定期全量扫描（15 分钟）会按新病毒库重新判定监控目录中的文件。
- 控制台首页「扫描引擎状态」显示缓存命中率与当前病毒库下的有效条目数。

平台发布新版客户端后，终端经心跳自动升级（平台记录历次官方客户端指纹，与旧官方版本一致的终端按「待升级」处理，不产生篡改告警）。

## AI Agent 升级后的防护保障

| 机制 | 说明 |
|---|---|
| 版本跟踪 | 终端检测 Codex（含桌面版自带程序）、WorkBuddy（应用 + CLI 引擎）、OpenCode 的版本，随心跳上报，控制台显示 |
| 升级自测 | 发现升级后自动以该 Agent 的调用格式自测 KAIP 拦截（高危命令、病毒测试文件、防篡改、正常命令），平台产生 `KAIP:Agent.Upgraded` 提醒；状态为「升级待复核」，直到观察到真实的执行前检查才恢复「生效」。手动：`kaip selftest` |
| 行为对账 | 统计 Agent 会话记录中的工具调用次数（只计数、不读取内容），与 KAIP **执行前检查**（PreToolUse）的调用对比：Agent 在调用工具而 KAIP 没被调用 → `KAIP:Protection.Inactive`。可发现宿主改了 hook 契约、hook 未被信任/未加载等静默失效（含「事后检查仍在、执行前拦截已失效」的半失效） |
| 新工具发现 | WorkBuddy 改为全部工具调用经过 KAIP（Codex / OpenCode 本就全量）；未识别的工具名上报，平台对每个新工具产生一次 `KAIP:Agent.NewTool` 提醒。评估后在策略「已确认的工具」中登记即不再提醒 |

## 自我保护（防篡改）

AI Agent 拥有 shell 权限，理论上可以读取、修改或停用 KAIP 本身。平台提供四层保护（策略「自我保护」「自动修复」默认开启）：

| 层 | 机制 |
|---|---|
| 执行前拦截 | Agent 读取 `~/.kaip`（含终端凭据与检测规则）、修改/删除 KAIP 文件、改写 Codex/WorkBuddy hook 配置或 `[features] hooks`、停止 kaip-watch、结束 KAIP 进程、`kaip uninstall`、`--dangerously-bypass-hook-trust` 等，在执行前阻断并上报 `KAIP:Tamper.*`。本地判定，平台不可达也生效；`kaip status/scan/verify/test` 等只读命令放行 |
| 客户端完整性 | 心跳上报客户端程序逐文件 SHA256 指纹，平台与其分发的官方包比对，不一致产生 `KAIP:Tamper.ClientModified`（列出被改文件） |
| 策略不可本地改写 | 心跳上报本地策略指纹，与平台不一致时强制下发平台策略；同版本不同内容记为 `KAIP:Tamper.Policy` |
| 自动修复 | 客户端文件被改/删、hook 配置被移除时，后台监控从平台重新下载客户端并重装接入（Codex `hooks.json` 内容不变，信任记录保持有效），记录 `KAIP:Tamper.Repaired`；KAIP 模块损坏导致 hook 无法加载时，hook 入口以内置兜底逻辑**阻断**而非放行 |

## 能力边界（请在 PoC 中如实说明）

- Hook 只覆盖**经过 Agent 工具调用**的操作；用户在 Agent 之外手动安装的组件由 `kaip watch` 目录监控和会话启动扫描补充，但这些是**事后**检测。
- Codex 的 PreToolUse 对非 shell 工具的覆盖随版本变化；OpenCode 已知子 agent（task 工具）发起的调用可能不触发插件 hook（上游 issue #5894）。
- KAIP 补充规则是静态特征，用于补强 AI 场景；最终恶意代码判定以 KSE 为准。提示词注入等语义层攻击不在文件扫描范围内。
- 终端到平台会传输文件内容，生产环境必须启用 HTTPS（`install --secure` 校验证书）。
- 防篡改运行在用户态、与 Agent 同一账号：能阻断经过 Agent 工具调用的篡改并在事后检测/修复，但无法防御同账号下绕开 Agent 的人工操作或拥有 root 的恶意进程；更强的隔离需让 Agent 以独立低权限账号或容器运行、KAIP 以高权限账号安装。
