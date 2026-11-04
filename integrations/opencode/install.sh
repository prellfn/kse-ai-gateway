#!/bin/bash
# ---------------------------------------------------------------------------
# OpenCode — kse-ai-gateway 接入安装脚本 (Linux / macOS)
#
# 用法: ./install.sh [OpenCode 配置目录]
#   默认 ~/.config/opencode (可用 OPENCODE_CONFIG_DIR 覆盖)
# ---------------------------------------------------------------------------
set -euo pipefail

CONFIG_DIR="${1:-${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}}"
PLUGIN_DIR="$CONFIG_DIR/plugin"
GATEWAY="${KSE_SCAN_GATEWAY:-http://127.0.0.1:8000}"
MCP_PYTHON="${KSE_MCP_PYTHON:-/opt/ai-stack/mcp-venv/bin/python}"
MCP_SERVER="${KSE_MCP_SERVER:-/opt/ai-stack/mcp-server/server.py}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================================="
echo " OpenCode — kse-ai-gateway 接入安装"
echo " 配置目录: $CONFIG_DIR"
echo "=============================================="

mkdir -p "$PLUGIN_DIR"

# ---------------------------------------------------------------------------
# 1. 插件 + 客户端库
# ---------------------------------------------------------------------------
echo "[1/3] 安装插件..."
cp "$SRC_DIR/plugin/kse-gate.js" "$PLUGIN_DIR/kse-gate.js"
cp "$SRC_DIR/../common/kse-client.js" "$PLUGIN_DIR/kse-client.js"
echo "    -> $PLUGIN_DIR/kse-gate.js"

# ---------------------------------------------------------------------------
# 2. opencode.json
# ---------------------------------------------------------------------------
echo "[2/3] 配置 opencode.json..."
CONFIG_FILE="$CONFIG_DIR/opencode.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "    已存在 $CONFIG_FILE, 保留原文件；请手工合并以下内容:"
    cat <<EOF
  "mcp": {
    "kse-ai-gateway": {
      "type": "local",
      "command": ["$MCP_PYTHON", "$MCP_SERVER"],
      "environment": { "KSE_SCAN_GATEWAY": "$GATEWAY", "KSE_SCAN_TIMEOUT": "300" },
      "enabled": true
    }
  },
  "plugin": [".opencode/plugin/kse-gate.js"]
EOF
else
    cat > "$CONFIG_FILE" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "mcp": {
    "kse-ai-gateway": {
      "type": "local",
      "command": ["$MCP_PYTHON", "$MCP_SERVER"],
      "environment": {
        "KSE_SCAN_GATEWAY": "$GATEWAY",
        "KSE_SCAN_TIMEOUT": "300"
      },
      "enabled": true
    }
  },
  "plugin": [".opencode/plugin/kse-gate.js"]
}
EOF
    echo "    -> 已创建 $CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# 3. 验证
# ---------------------------------------------------------------------------
echo "[3/3] 验证..."
if [ -x "$MCP_PYTHON" ] && [ -f "$MCP_SERVER" ]; then
    echo "    MCP Server 就绪: $MCP_PYTHON $MCP_SERVER"
else
    echo "    ⚠️  未找到 MCP Server ($MCP_PYTHON / $MCP_SERVER)"
    echo "       请先在网关机执行: sudo ./scripts/install_ubuntu.sh"
fi

echo
echo "完成。重启 OpenCode 后生效。"
echo "  - 插件日志: $PLUGIN_DIR/debug.log"
echo "  - 验证拦截: 让 OpenCode 用 write 工具写入 EICAR 字符串，应被阻止"