#!/bin/bash
# ---------------------------------------------------------------------------
# WorkBuddy — kse-ai-gateway 接入安装脚本
#
# 作用:
#   1. 安装 kse-security-gate Skill 到 WorkBuddy 的 Skill 目录
#   2. 输出 MCP 配置片段 (供手工合并到 WorkBuddy 配置)
#   3. 可选: 安装 Windows 端文件监控兜底 (若在 Windows 上运行)
#
# 用法: ./install.sh [Skill 安装目录]
#   默认 ~/.workbuddy/skills
# ---------------------------------------------------------------------------
set -euo pipefail

SKILL_DIR="${1:-${WORKBUDDY_SKILL_DIR:-$HOME/.workbuddy/skills}}"
GATEWAY="${KSE_SCAN_GATEWAY:-http://127.0.0.1:8000}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=============================================="
echo " WorkBuddy — kse-ai-gateway 接入安装"
echo " Skill 目录: $SKILL_DIR"
echo "=============================================="

# ---------------------------------------------------------------------------
# 1. Skill
# ---------------------------------------------------------------------------
echo "[1/3] 安装 Skill..."
mkdir -p "$SKILL_DIR/kse-security-gate/scripts"
cp "$SRC_DIR/skill/SKILL.md" "$SKILL_DIR/kse-security-gate/SKILL.md"
cp "$SRC_DIR/skill/scripts/"*.sh "$SKILL_DIR/kse-security-gate/scripts/"
chmod +x "$SKILL_DIR/kse-security-gate/scripts/"*.sh
echo "    -> $SKILL_DIR/kse-security-gate/"

# ---------------------------------------------------------------------------
# 2. MCP 配置
# ---------------------------------------------------------------------------
echo "[2/3] 生成 MCP 配置..."
MCP_OUT="$SKILL_DIR/kse-security-gate/mcp-config.json"
cat > "$MCP_OUT" <<EOF
{
  "mcpServers": {
    "kse-ai-gateway": {
      "command": "python3",
      "args": ["/opt/ai-stack/mcp-server/server.py"],
      "env": {
        "KSE_SCAN_GATEWAY": "$GATEWAY",
        "KSE_SCAN_TIMEOUT": "300"
      }
    }
  }
}
EOF
echo "    -> $MCP_OUT"
echo "    请把上面的配置合并进 WorkBuddy 的 MCP 配置"

# ---------------------------------------------------------------------------
# 3. 验证
# ---------------------------------------------------------------------------
echo "[3/3] 验证网关连通性..."
if command -v curl >/dev/null 2>&1; then
    if curl -s --max-time 5 "$GATEWAY/health" >/dev/null 2>&1; then
        echo "    ✅ Scan Gateway 可达: $GATEWAY"
    else
        echo "    ⚠️  Scan Gateway 不可达: $GATEWAY"
        echo "       请先在网关机执行: sudo ./scripts/install_ubuntu.sh"
    fi
fi

echo
echo "完成。三个接入点:"
echo "  ① Skill 下载代理  : integrations/workbuddy/skill/scripts/download-and-scan.sh <url> <目录>"
echo "  ② 知识库上传端点  : http://<网关>:8002  (先扫后入库, 已内置)"
echo "  ③ 脚本/模型执行前 : 通过 MCP 工具 scan_file / scan_text / scan_url 主动调用"