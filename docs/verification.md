# 新环境验证指南

本文回答一个问题：**在一台全新的机器上，怎么确认这套东西真的通了？**

核心思路是**分层验证** —— 从最底层（KSE 引擎本身）逐层往上，每层单独确认，
这样出问题时能立刻定位到是哪一环，而不是对着现象猜。

---

## 0. 前置条件

| 项目 | 要求 |
| --- | --- |
| 网关机 | Ubuntu 22.04 LTS，KSE 2.2.x 原生安装（**KSE 只支持 Linux**） |
| Agent 机 | Windows Server 或 Linux，按需 |
| 网络 | 网关机 8443/8000/8002/8004 可达 |
| KSE 许可 | 已用 Web UI 配置 HTTPS + Token + 扫描目录白名单 |

> ⚠️ 若暂时**没有 KSE 许可证**，可以用仓库自带的 `scripts/mock_scan_gateway.py` 做全链路联调，
> 见 [§6 无许可证联调](#6-无许可证联调mock-模式)。Mock 只做特征串匹配，不做真实检测，**仅供开发测试**。

---

## 1. 验证分层总览

| 层 | 验证对象 | 脚本 | 期望结论 |
| --- | --- | --- | --- |
| **L0** | KSE 引擎直连 | `verify.sh --layer l0` | EICAR 直扫 DETECT；无 Token 被拒 |
| **L1** | Scan Gateway (:8000) | `verify.sh --layer l1` | 5 个端点行为正确 |
| **L2** | Upload Gateway (:8002) | `verify.sh --layer l2` | 干净文件入库；EICAR 403 |
| **L3** | 隔离区复核台 (:8004) | `verify.sh --layer l3` | 列表/统计/复扫可用 |
| **L4** | MCP Server | `verify.sh --layer l4` | initialize + 5 个工具注册 |
| **L5** | systemd 服务与审计 | `verify.sh --layer l5` | 4 服务 active；审计有记录 |
| **W1–W6** | Windows 侧（插件 + File Watcher） | `verify-windows.ps1` | 插件拦截 + 监控隔离 |
| **E2E** | 端到端真实场景 | [§7](#7-端到端真实场景验证) | Agent 装 Skill 被拦 |

---

## 2. Linux 网关侧：一条命令跑完

```bash
cd kse-ai-gateway
sudo ./scripts/verify.sh
```

输出示例：

```
── L1  Scan Gateway (:8000) ─────────────────────
  ✓ PASS  健康检查 /health                        status=ok
  ✓ PASS  scan/file 干净文件放行                   verdict=CLEAN
  ✓ PASS  scan/file EICAR 检出                     verdict=DETECT, detection=EICAR-Test-File
  ✓ PASS  威胁文件自动隔离                         quarantined=true
  ✓ PASS  scan/upload 内容扫描                     verdict=CLEAN
  ✓ PASS  scan/package 干净包                      verdict=CLEAN
  ✓ PASS  scan/package 内藏 EICAR 检出              verdict=DETECT, threats=1
  ✓ PASS  scan/url URL 扫描                        verdict=CLEAN

==============================================
 汇总:  PASS 18  FAIL 0  WARN 1  SKIP 1
==============================================
```

**只跑某一层**：

```bash
sudo ./scripts/verify.sh --layer l1
sudo ./scripts/verify.sh --layer l4
sudo ./scripts/verify.sh --keep     # 保留测试文件便于排查
```

**设置 KSE Token 后才能跑 L0**（可选，用于确认引擎本身与 Token 认证）：

```bash
sudo KSE_TOKEN=<你的明文Token> ./scripts/verify.sh --layer l0
```

### 各层覆盖的具体断言

| 层 | 断言 | 说明 |
| --- | --- | --- |
| L0 | KSE 直扫 EICAR → DETECT | 排除「网关逻辑对但引擎没工作」的可能 |
| L0 | 无 Token → 401/403 | 确认 Token 认证真的开着 |
| L1 | 干净文件 → CLEAN | 排除「永远返回 DETECT」的假阳性 |
| L1 | EICAR → DETECT + quarantined | 核心能力 |
| L1 | `/scan/package` 干净包 → CLEAN | 解包逻辑不误报 |
| L1 | `/scan/package` **内藏 EICAR 的包** → DETECT | **关键**：整包扫描易被免杀，逐文件扫描才能抓住 |
| L1 | `/scan/url` → CLEAN/DETECT | 提示：需在 KSE Web UI 放行 URL 扫描位置 |
| L2 | 上传 EICAR → HTTP 403 | Fail-Closed |
| L3 | 隔离文件列表 / 威胁统计 / 复扫 | 运营闭环可用 |
| L4 | MCP `tools/list` 含 5 个工具 | 协议层通 |
| L5 | 4 个 systemd 服务 active | 开机自启正常 |
| L5 | `audit.jsonl` 有记录 | 审计链路通 |

---

## 3. Windows Agent 侧

```powershell
cd kse-ai-gateway
powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 `
    -ScanGateway "http://10.0.0.1:8000" `
    -PluginPath "$env:USERPROFILE\.openclaw\plugins\kse-gate\index.js" `
    -WatchDir  "$env:USERPROFILE\.openclaw\workspace"
```

覆盖：

| 项 | 验证内容 |
| --- | --- |
| W1 | Scan Gateway 从 Windows 可达 |
| W2 | `/scan/upload` 干净内容 → CLEAN |
| W3 | `/scan/upload` EICAR → DETECT |
| W4 | **插件单元验证**：直接调 `handleBeforeToolCall`，确认 write 恶意被拦、正常放行、恶意 URL 被拦 |
| W5 | File Watcher 写入 EICAR 后文件被移走、隔离区增加 |
| W6 | Watcher 日志有 `SCAN:` 记录；Windows 隔离区存在 |

> W4 使用仓库内的 `integrations/common/plugin-probe.js`。它会先探测网关连通性，
> **网关不可达时报 `GATEWAY-UNREACHABLE` 而不是误判为通过** —— 因为插件是 Fail-Open，
> 网关挂了本来就放行，不加这个判断就会出现「假绿」。

---

## 4. Agent 接入验证

### Codex

```bash
codex mcp list          # 应看到 kse-ai-gateway
```

新会话里输入：`用 kse_status 查看网关状态` → 应返回网关配置。

### OpenCode

```bash
# 让 OpenCode 用 write 工具写入 EICAR 字符串, 应被拒绝
cat ~/.config/opencode/plugin/debug.log | tail -20
```

日志应出现 `扫描写入内容:` 与 `检出威胁，阻止写入:`。

### WorkBuddy

```bash
# 用下载代理测试 (应被拒绝安装)
./integrations/workbuddy/skill/scripts/download-and-scan.sh \
    https://example.com/some-skill.zip /tmp/test-install/
```

退出码 `1` = 检出威胁并拒绝；`0` = 通过。

---

## 5. 逐层手工验证（脚本失败时的排查路径）

### L0 — KSE 引擎本身

```bash
echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  > /opt/kaspersky/scanqueue/eicar.txt

curl -k -X POST https://127.0.0.1:8443/api/v3.0/scanfile \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer <明文Token>" \
  -d '{"timeout":"60000","object":"/opt/kaspersky/scanqueue/eicar.txt"}'
```

**必须返回 `"scanResult": "DETECT"`。** 若返回 CLEAN，按序排查：

1. **EICAR 字符串必须在文件开头** —— 这是最常见的误判来源。中间/末尾放会漏检
2. Token 是否为**明文**（不是 XML 里的 88 字节加密值）
3. `Settings → Scanning` 是否已添加 `/opt/kaspersky/scanqueue`
4. 病毒库是否更新（`journalctl -u kavhttpd | grep -i update`）

### L1 — Scan Gateway

```bash
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/scan/file \
  -H "Content-Type: application/json" \
  -d '{"file_path":"/opt/kaspersky/scanqueue/eicar.txt","timeout":60}'
```

**若报 403「路径不在允许的扫描目录内」** → `.env` 的 `ALLOWED_SCAN_DIRS` 没包含目标目录。

### L2 — Upload Gateway

```bash
curl http://127.0.0.1:8002/health
curl -i -X POST http://127.0.0.1:8002/upload -F "file=@/tmp/eicar.txt"
```

**若干净文件也失败** → 多半是 AnythingLLM 未配置（API Key / slug / 网络），
用 `add_to_workspace=false` 单独测试入库环节。

### L3 — 复核台

```bash
curl http://127.0.0.1:8004/health
curl http://127.0.0.1:8004/api/quarantine
curl http://127.0.0.1:8004/api/stats
```

**若复扫报 403** → 隔离区不在白名单。`.env` 加一行后重启：

```bash
ALLOWED_SCAN_DIRS=/opt/kaspersky/scanqueue,/opt/kaspersky/quarantine
sudo systemctl restart scan-gateway
```

### L4 — MCP Server

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | /opt/ai-stack/mcp-venv/bin/python /opt/ai-stack/mcp-server/server.py
```

应能看到 `scan_file` / `scan_text` / `scan_url` / `scan_skill_pkg` / `kse_status`。

**若报 `ModuleNotFoundError: mcp`** → `pip install -r gateway/mcp-server/requirements.txt`。

---

## 6. 无许可证联调（MOCK 模式）

用 Mock 网关跑通**除真实恶意软件检测外的全部链路**（插件、MCP、上传代理、审计）：

```bash
# 终端 A —— 启动模拟网关
python3 scripts/mock_scan_gateway.py --port 8000

# 终端 B —— 跑验证脚本
sudo ./scripts/verify.sh --layer l1
```

Mock 的判定规则：

| 输入 | 判定 |
| --- | --- |
| 内容含 EICAR 串 | `DETECT` / `EICAR-Test-File` |
| 内容含 `MALWARE-SIGNATURE` | `DETECT` / `HEUR:Trojan.Test.MOCK` |
| URL 含 `malicious` 或 `phish` | `DETECT` / `HEUR:Phishing.URL.MOCK` |
| 其他 | `CLEAN` |

**插件探针单测（不需要任何服务器）**：

```bash
node integrations/common/plugin-probe.js agent/openclaw-plugin/index.js http://127.0.0.1:8000
```

```json
{
  "gatewayReachable": true,
  "writeBlocked": true,
  "writeReason": "[Kaspersky] 检出威胁: EICAR-Test-File，文件已被阻止写入: C:/temp/eicar.txt",
  "writeCleanAllowed": true,
  "urlBlocked": true,
  "verdict": "PASS"
}
```

> ⚠️ Mock 模式**不能**验证真实恶意软件检出能力。上生产前必须用真 KSE 跑一遍 L0 + L1。

---

## 7. 端到端真实场景验证

分层都过了之后，最后做一次真实业务验证：

### 场景 A：Agent 安装被投毒的 Skill（最关键）

1. 在 Agent 里让它下载一个含 EICAR 的 zip
2. **期望**：Agent 被阻断 / 报「检出威胁」；或（事后兜底）文件被移入隔离区
3. 检查：`curl http://127.0.0.1:8004/api/quarantine` 出现该文件

### 场景 B：知识库上传投毒文档

1. 浏览器打开 `http://<host>:8002`，上传含 EICAR 的文件
2. **期望**：页面显示「上传被拒绝」；文件出现在隔离区

### 场景 C：正常业务不受影响（回归测试）

1. 让 Agent 正常写一个 `.py` 文件、读一个网页、上传一个正常 PDF
2. **期望**：全部成功，审计日志里对应记录 `verdict: CLEAN`

### 场景 D：大文件与压缩包

```bash
# 12MB 的 EICAR（大模型场景）
echo -n 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/big.bin
dd if=/dev/zero bs=1M count=11 | tr '\0' 'X' >> /tmp/big.bin
cp /tmp/big.bin /opt/kaspersky/scanqueue/
curl -X POST http://127.0.0.1:8000/scan/file \
  -H "Content-Type: application/json" \
  -d '{"file_path":"/opt/kaspersky/scanqueue/big.bin","timeout":300}'
```

---

## 8. 验收清单

部署完成请逐项打勾：

**Linux 网关侧**

- [ ] `systemctl is-active kavhttpd scan-gateway upload-gateway quarantine-console` 全为 `active`
- [ ] `verify.sh --layer l0` 通过（KSE 直扫 EICAR = DETECT）
- [ ] `verify.sh --layer l1` 通过（5 个端点全绿）
- [ ] `verify.sh --layer l2` 通过（干净入库 + EICAR 403）
- [ ] `verify.sh --layer l3` 通过（列表/统计/复扫）
- [ ] `verify.sh --layer l4` 通过（MCP 5 个工具）
- [ ] `verify.sh --layer l5` 通过（服务 active + 审计有记录）
- [ ] `curl /api/stats` 能看到威胁统计

**Windows / Agent 侧**

- [ ] `verify-windows.ps1` 全绿
- [ ] 插件 debug.log 出现「检出威胁，阻止写入」
- [ ] File Watcher 把 EICAR 文件移入 `.openclaw\quarantine\`

**端到端**

- [ ] 场景 A：Agent 装被投毒 Skill 被拦
- [ ] 场景 B：知识库上传投毒文档被拒
- [ ] 场景 C：正常业务全部成功
- [ ] 场景 D：12MB 大文件与压缩包正确处理

**运维就绪**

- [ ] 复核台 (:8004) 已置于反向代理或限制内网访问
- [ ] `.env` 权限为 600，KSE Token / API Key 未提交到仓库
- [ ] 病毒库自动更新已配置（`crontab -l` 可见）
- [ ] 备份脚本已跑通一次（`sudo ./scripts/backup_kse.sh`）
- [ ] `ollama-watcher` 已启用（若使用 Ollama）

---

## 9. 常见失败速查

| 现象 | 最可能原因 | 处理 |
| --- | --- | --- |
| EICAR 不检出 | EICAR 字符串不在文件开头 | 用 `echo -n` 写在开头 |
| KSE 报 Token 无效 | 用了 XML 里的加密值 | 用 Web UI 重新 Generate 并复制明文 |
| Scan Gateway 403 | 文件不在白名单目录 | 改 `ALLOWED_SCAN_DIRS` |
| Scan Gateway 502 | KSE 不可达 / Token 错 | `systemctl status kavhttpd` + 查 `journalctl` |
| 端口 8001 冲突 | ClickHouse（KUMA）占用 | Upload Gateway 用 8002 |
| 复核台打不开 | 端口未放行 | `ufw allow 8004/tcp`（建议限内网） |
| 插件不拦截 | 网关不可达（Fail-Open） | 看 `plugin/debug.log` 与 `plugin-probe.js` 的 `gatewayReachable` |
| Watcher 无反应 | 计划任务没跑 / 目录被排除 | `Get-ScheduledTask KSE-FileWatcher` + 看日志有无 `SCAN:` |
| 压缩包扫描超时 | 大包 | 调大 `timeout`（默认 300s） |
