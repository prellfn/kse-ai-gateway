# kse-ai-gateway MCP Server

把 KSE 扫描能力以 **MCP (Model Context Protocol)** 形式暴露给任意支持 MCP 的 AI Agent
（Codex、Claude Code、Claude Desktop、OpenCode …），无需为每个 Agent 单独开发插件。

## 提供的工具

| 工具 | 用途 |
| --- | --- |
| `scan_file(file_path)` | 扫描本机文件（需在网关允许目录内） |
| `scan_text(filename, content)` | 扫描文本内容（内存，不落盘） |
| `scan_url(url)` | 扫描 URL，检测钓鱼站点 |
| `scan_skill_pkg(package_path)` | 深度扫描 Skill / 插件压缩包（解包逐文件） |
| `kse_status()` | 查看网关连通性与配置 |

## 安装

```bash
python3 -m venv /opt/ai-stack/mcp-venv
/opt/ai-stack/mcp-venv/bin/pip install -r gateway/mcp-server/requirements.txt

cp gateway/mcp-server/server.py /opt/ai-stack/mcp-server.py
```

## 客户端配置

以 stdio 方式接入（MCP 客户端的标准方式）：

```json
{
  "mcpServers": {
    "kse-ai-gateway": {
      "command": "/opt/ai-stack/mcp-venv/bin/python",
      "args": ["/opt/ai-stack/mcp-server.py"],
      "env": {
        "KSE_SCAN_GATEWAY": "http://127.0.0.1:8000",
        "KSE_SCAN_TIMEOUT": "300"
      }
    }
  }
}
```

> ⚠️ MCP Server 默认走 stdio，必须通过 `env` 显式指定 `KSE_SCAN_GATEWAY`，
> 否则会回落到 `http://127.0.0.1:8000`（仅当 MCP Server 与网关同机时才正确）。

## 验证

```bash
# 手工跑一次（stdio 模式下会等待输入，可用 echo 触发一次 initialize）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | /opt/ai-stack/mcp-venv/bin/python /opt/ai-stack/mcp-server.py
```

也可以直接用 `codex mcp add` 之类的命令注册（以对应客户端文档为准）。

## 设计取舍

- **只做协议适配**：实际扫描全部由远端 Scan Gateway 执行，避免重复实现路径白名单与隔离逻辑。
- **Fail-Closed 报错而非静默放行**：网关不可达时抛出明确错误，由 Agent 决定是否阻断；
  Agent 侧是否 Fail-Open 由各客户端策略决定。
- **文本扫描不落盘**：`scan_text` 走 multipart 内存上传到网关的扫描队列，扫描后即清理。
