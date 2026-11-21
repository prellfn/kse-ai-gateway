# KAIP MCP Server

让**原生支持 MCP 的 AI Agent**（Codex / Claude Code / Claude Desktop）直接复用 KAIP 平台的
策略引擎、卡巴斯基扫描与审计台账 —— 无需在终端安装 KAIP 的 Node 客户端与 hook。

- 传输方式：stdio（标准 MCP 客户端配置方式）
- 依赖：**无**（仅 Python 3.9+ 标准库；MCP 协议即 JSON-RPC 2.0 over stdio）

## 为什么需要它

KAIP 平台原本只有三种接入方式，都需要安装 Node 终端客户端：

| 方式 | 需要 | 适合 |
| --- | --- | --- |
| Hook（Codex / WorkBuddy） | Node 客户端 + hook 注入 | 已安装 KAIP client 的终端 |
| OpenCode 插件 | Node 客户端 + 插件 | OpenCode |
| watcher / CLI | Node 客户端 | 事后扫描 |

而 **Codex CLI、Claude Code、Claude Desktop 原生支持 MCP**，终端无需安装任何东西。
本 MCP Server 把这些客户端直接接到平台 —— 判定结果同样进入平台的事件库与审计台账，
受同一套策略管控。

## 提供的工具

| 工具 | 对应平台接口 | 用途 |
| --- | --- | --- |
| `kaip_scan_file` | `POST /api/v1/agent/scan` | 扫描文件（KSE + 平台规则） |
| `kaip_scan_text` | `POST /api/v1/agent/scan` | 扫描文本内容 |
| `kaip_check_url` | `POST /api/v1/agent/checkurl` | URL 信誉检查 |
| `kaip_evaluate` | `POST /api/v1/agent/evaluate` | 与 hook 同路径的决策入口，返回 allow/block |
| `kaip_policy` | `GET /api/v1/agent/policy` | 拉取当前生效策略 |
| `kaip_status` | `GET /api/v1/agent/policy` | 平台连通性与策略开关 |
| `kaip_report` | `POST /api/v1/agent/report` | 上报本地事件 |

## 安装

```bash
# 1. 放到平台服务器（或任意能访问平台的机器）
sudo mkdir -p /opt/kaip/mcp-server
sudo cp server.py /opt/kaip/mcp-server/server.py
```

### 客户端配置

Codex 的 MCP 配置模板见 [`integrations/codex/config.toml.example`](../../integrations/codex/config.toml.example)，
把其中的 server 段指向本 MCP Server 即可：

```toml
[mcp_servers.kaip]
command = "/usr/bin/python3"
args = ["/opt/kaip/mcp-server/server.py"]
env = { KAIP_URL = "http://kaip-server:8080", KAIP_ENROLL_TOKEN = "<注册令牌>", KAIP_AGENT_TYPE = "codex" }
enabled = true
```

Claude Code / Claude Desktop 等客户端使用等价的 `mcpServers` JSON：

```json
{
  "mcpServers": {
    "kaip": {
      "command": "/usr/bin/python3",
      "args": ["/opt/kaip/mcp-server/server.py"],
      "env": {
        "KAIP_URL": "http://kaip-server:8080",
        "KAIP_ENROLL_TOKEN": "<注册令牌>",
        "KAIP_AGENT_TYPE": "claude"
      }
    }
  }
}
```

## 终端注册

首次调用时用 `KAIP_ENROLL_TOKEN` 自动向平台注册终端，拿到 `agent_id` / `agent_token`
后缓存在本地状态文件（默认 `~/.cache/kaip-mcp/agent.json`，权限 600）。

> 本工具的状态文件放在自己的缓存目录，与 KAIP 客户端自身的目录完全独立，互不干扰。

注册令牌在控制台「接入部署」页获取。也可直接用 `KAIP_AGENT_ID` / `KAIP_AGENT_TOKEN`
跳过注册流程。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KAIP_URL` | `http://127.0.0.1:8080` | 平台地址 |
| `KAIP_ENROLL_TOKEN` | 空 | 终端注册令牌（首次注册用） |
| `KAIP_AGENT_ID` | 空 | 已注册的终端 ID |
| `KAIP_AGENT_TOKEN` | 空 | 已注册的终端令牌 |
| `KAIP_AGENT_TYPE` | `codex` | 终端类型（codex / opencode / workbuddy） |
| `KAIP_STATE_DIR` | `~/.cache/kaip-mcp` | 本工具的本地状态目录 |
| `KAIP_TIMEOUT` | `300` | HTTP 超时（秒） |

## 验证

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | KAIP_URL=http://127.0.0.1:8080 /usr/bin/python3 server.py
```

应返回 7 个工具。调用示例：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"kaip_scan_text","arguments":{"filename":"install.sh","content":"..."}}}
```

返回文本形如：

```
verdict: DETECT
action: block
detection: EICAR-Test-File
sha256: 275a021b...
⛔ 检出威胁或命中策略，禁止继续使用该内容。
```
