# AI Agent 接入层

kse-ai-gateway 为不同 AI Agent 提供了各自最合适的接入方式。三种 Agent 共用**同一个** Scan Gateway
与 KSE，威胁统一隔离、审计统一留痕。

| Agent | 主接入方式 | 拦截时机 | 安装脚本 |
| --- | --- | --- | --- |
| **Codex** | MCP Server + Skill | Agent 主动调用（工具触发） | `codex/install.ps1` |
| **OpenCode** | 插件 `tool.execute.before` + MCP | **事前自动拦截** | `opencode/install.sh` |
| **WorkBuddy** | Skill 包 + 下载代理脚本 + MCP | 代理层 + Agent 主动调用 | `workbuddy/install.sh` |

> 所有 Agent 都可以直接使用 `gateway/mcp-server`（stdio），这份接入只是在此基础上做了体验增强。

---

## 0. 前置：先部署网关

在网关机（运行 KSE 的 Ubuntu 主机）执行：

```bash
git clone https://github.com/prellfn/kse-ai-gateway.git
cd kse-ai-gateway
sudo ./scripts/install_ubuntu.sh
```

完成后 Scan Gateway 应在 `http://<网关>:8000` 可用。验证：

```bash
curl http://127.0.0.1:8000/health
```

---

## 1. Codex

### 方式 A：MCP Server（推荐）

Codex 原生支持 MCP，配置写入 `~/.codex/config.toml`：

```toml
[mcp_servers.kse-ai-gateway]
command = "/opt/ai-stack/mcp-venv/bin/python"
args = ["/opt/ai-stack/mcp-server/server.py"]
env = { KSE_SCAN_GATEWAY = "http://127.0.0.1:8000", KSE_SCAN_TIMEOUT = "300" }
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 180
```

一键安装（Windows / PowerShell）：

```powershell
cd integrations/codex
.\install.ps1 -ScanGateway "http://10.0.0.1:8000" `
               -PythonPath "/opt/ai-stack/mcp-venv/bin/python" `
               -ServerPath "/opt/ai-stack/mcp-server/server.py"
```

### 方式 B：Skill（让 Codex 主动调用）

`install.ps1` 同时把 `kse-scan` Skill 安装到 `~/.codex/skills/kse-scan/SKILL.md`。
Skill 描述了**何时该扫描**，Codex 在遇到下载 Skill / 运行脚本 / 加载模型 / 访问链接时会主动调用。

**验证**

```bash
codex mcp list
```

新开会话后输入「用 kse_status 查看网关状态」即可确认连通。

---

## 2. OpenCode

### 方式 A：插件（事前自动拦截）✅ 最强

OpenCode 插件挂载 `tool.execute.before` 钩子，在工具执行**之前**扫描，检出威胁直接抛错阻断。

拦截范围：

| 工具 | 扫描对象 |
| --- | --- |
| `write` / `edit` / `patch` / `multiedit` | 写入 / 编辑的内容 |
| `bash` / `shell` / `exec` | 待执行脚本、待加载模型、命令中的 URL |
| `webfetch` / `fetch` / `browse` | 待访问的 URL |

安装：

```bash
cd integrations/opencode
./install.sh                       # 默认 ~/.config/opencode
./install.sh /path/to/opencode-config
```

会安装：

```
<config>/plugin/kse-gate.js      # 插件
<config>/plugin/kse-client.js    # 共用客户端库
<config>/opencode.json           # MCP + plugin 配置
```

**验证**：让 OpenCode 用 `write` 工具写入 EICAR 字符串，应被阻止；插件日志在
`<config>/plugin/debug.log`。

### 方式 B：MCP Server

`opencode.json` 中已包含 MCP 配置，Agent 也可主动调用 `scan_file` / `scan_url` 等工具。

---

## 3. WorkBuddy

### 方式 A：Skill 下载代理（最高优先级）

`download-and-scan.sh` 实现「先扫后装」：下载到临时目录 → 解包逐文件扫描 →
CLEAN 才落到目标目录，DETECT 直接删除并拒绝安装（**Fail-Closed**）。

```bash
./integrations/workbuddy/skill/scripts/download-and-scan.sh \
    https://example.com/some-skill.zip ~/workbuddy/skills/
```

把它挂到 WorkBuddy 的 Skill 下载入口，即可做到「下载即扫描」。

### 方式 B：知识库上传端点

直接把 WorkBuddy 的知识库上传地址指向本仓库的 Upload Gateway（`:8002`），
「先扫后入库」是它的默认行为，无需额外配置。

### 方式 C：MCP Server

```bash
cd integrations/workbuddy
./install.sh                       # 默认 ~/.workbuddy/skills
```

会安装 Skill（`SKILL.md` + 脚本）并生成 MCP 配置片段。

---

## 4. 共用组件

| 文件 | 说明 |
| --- | --- |
| `common/kse-client.js` | Node.js 客户端库，被 OpenCode 插件与 Hook 脚本复用 |
| `../gateway/mcp-server/` | MCP Server（stdio），三种 Agent 通吃 |

---

## 5. 兜底：文件监控

无论用哪种 Agent 接入，都建议同时部署兜底监控（事后扫描 + 自动隔离）：

- **Linux（模型下载）**：`sudo systemctl enable --now ollama-watcher`
- **Windows（skills / plugins / npm）**：`agent/windows-watcher/kse-file-watcher.ps1`

接入层负责「事前拦截」，兜底监控负责「事后隔离」，两者互补。
