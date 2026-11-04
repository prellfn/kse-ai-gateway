#!/bin/bash
# ---------------------------------------------------------------------------
# kse-ai-gateway — Linux 网关一键部署脚本 (Ubuntu 22.04+)
#
# 特点: **零第三方依赖** —— 只用 Python 3.9+ 标准库, 不需要 pip / venv / 外网
#
# 前提: KSE 已安装并可通过 HTTP API 访问 (本机或远程)
#
# 用法: sudo ./scripts/install_ubuntu.sh [仓库根目录]
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
STACK_DIR="/opt/ai-stack"

echo "=============================================="
echo " kse-ai-gateway 网关部署 (零依赖)"
echo " 仓库根目录: $REPO_ROOT"
echo "=============================================="

if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 请使用 root 运行 (sudo ./scripts/install_ubuntu.sh)"
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. 环境检查
# ---------------------------------------------------------------------------
echo "[1/6] 检查环境..."
if ! command -v python3 >/dev/null 2>&1; then
    echo "错误: 未找到 python3, 请先安装 (apt install -y python3)"
    exit 1
fi
PY_VER=$(python3 -c "import sys; print('%d.%d' % sys.version_info[:2])")
echo "    python3: $PY_VER"
python3 - << 'EOF' || { echo "错误: 需要 Python 3.9+"; exit 1; }
import sys
assert sys.version_info >= (3, 9), "need python 3.9+"
EOF

# ---------------------------------------------------------------------------
# 2. 目录
# ---------------------------------------------------------------------------
echo "[2/6] 创建工作目录..."
mkdir -p /opt/kaspersky/scanqueue
mkdir -p /opt/kaspersky/quarantine
mkdir -p "$STACK_DIR/scan-gateway" "$STACK_DIR/upload-gateway/templates"
mkdir -p "$STACK_DIR/quarantine-console/templates" "$STACK_DIR/mcp-server"
mkdir -p "$STACK_DIR/scan-gateway/logs"
mkdir -p /var/log/kse-ai-stack

# ---------------------------------------------------------------------------
# 3. 部署程序
# ---------------------------------------------------------------------------
echo "[3/6] 部署 Gateway 程序..."
cp "$REPO_ROOT/gateway/common/kserver.py" "$STACK_DIR/common_kserver_tmp.py" 2>/dev/null || true
mkdir -p "$STACK_DIR/common"
cp "$REPO_ROOT/gateway/common/kserver.py" "$STACK_DIR/common/kserver.py"
cp "$REPO_ROOT/gateway/common/kse.py" "$STACK_DIR/common/kse.py"
rm -f "$STACK_DIR/common_kserver_tmp.py"

cp "$REPO_ROOT/gateway/scan-gateway/app.py" "$STACK_DIR/scan-gateway/app.py"
cp "$REPO_ROOT/gateway/upload-gateway/app.py" "$STACK_DIR/upload-gateway/app.py"
cp "$REPO_ROOT/gateway/upload-gateway/templates/index.html" "$STACK_DIR/upload-gateway/templates/index.html"
cp "$REPO_ROOT/gateway/quarantine-console/app.py" "$STACK_DIR/quarantine-console/app.py"
cp "$REPO_ROOT/gateway/quarantine-console/templates/index.html" "$STACK_DIR/quarantine-console/templates/index.html"
cp "$REPO_ROOT/gateway/mcp-server/server.py" "$STACK_DIR/mcp-server/server.py"
cp "$REPO_ROOT/watchers/ollama-watcher.sh" "$STACK_DIR/ollama-watcher.sh"
chmod +x "$STACK_DIR/ollama-watcher.sh"

# ---------------------------------------------------------------------------
# 4. 配置文件
# ---------------------------------------------------------------------------
echo "[4/6] 生成配置文件..."
# 每个服务使用各自的监听端口 (共用同一份 .env 会导致端口冲突)
declare -A SVC_PORT=( [scan-gateway]=8000 [upload-gateway]=8002 [quarantine-console]=8004 )
for svc in scan-gateway upload-gateway quarantine-console; do
    if [ ! -f "$STACK_DIR/$svc/.env" ]; then
        cp "$REPO_ROOT/.env.example" "$STACK_DIR/$svc/.env"
        chmod 600 "$STACK_DIR/$svc/.env"
        echo "    -> 已生成 $STACK_DIR/$svc/.env"
    else
        echo "    -> $STACK_DIR/$svc/.env 已存在, 保留"
    fi
    # 强制写入该服务自己的端口
    if grep -q "^LISTEN_PORT=" "$STACK_DIR/$svc/.env"; then
        sed -i "s/^LISTEN_PORT=.*/LISTEN_PORT=${SVC_PORT[$svc]}/" "$STACK_DIR/$svc/.env"
    else
        printf "\nLISTEN_PORT=%s\n" "${SVC_PORT[$svc]}" >> "$STACK_DIR/$svc/.env"
    fi
    # 各服务自己的依赖地址
    case "$svc" in
        upload-gateway|quarantine-console)
            if grep -q "^SCAN_GATEWAY=" "$STACK_DIR/$svc/.env"; then
                sed -i "s#^SCAN_GATEWAY=.*#SCAN_GATEWAY=http://127.0.0.1:8000#" "$STACK_DIR/$svc/.env"
            else
                printf "SCAN_GATEWAY=http://127.0.0.1:8000\n" >> "$STACK_DIR/$svc/.env"
            fi
            ;;
    esac
done

# ---------------------------------------------------------------------------
# 5. systemd 服务
# ---------------------------------------------------------------------------
echo "[5/6] 注册 systemd 服务..."
cp "$REPO_ROOT/gateway/systemd/scan-gateway.service" /etc/systemd/system/scan-gateway.service
cp "$REPO_ROOT/gateway/systemd/upload-gateway.service" /etc/systemd/system/upload-gateway.service
cp "$REPO_ROOT/gateway/systemd/quarantine-console.service" /etc/systemd/system/quarantine-console.service
cp "$REPO_ROOT/gateway/systemd/ollama-watcher.service" /etc/systemd/system/ollama-watcher.service
systemctl daemon-reload
systemctl enable scan-gateway upload-gateway quarantine-console >/dev/null 2>&1 || true
systemctl restart scan-gateway upload-gateway quarantine-console

# ---------------------------------------------------------------------------
# 6. MCP 客户端配置
# ---------------------------------------------------------------------------
echo "[6/6] 生成 MCP 客户端配置..."
cat > "$STACK_DIR/mcp-server/mcp-config.json" << EOF
{
  "mcpServers": {
    "kse-ai-gateway": {
      "command": "/usr/bin/python3",
      "args": ["$STACK_DIR/mcp-server/server.py"],
      "env": {
        "KSE_SCAN_GATEWAY": "http://127.0.0.1:8000",
        "KSE_SCAN_TIMEOUT": "300"
      }
    }
  }
}
EOF
echo "    -> $STACK_DIR/mcp-server/mcp-config.json"

sleep 2
echo ""
echo "=============================================="
echo " 部署完成"
for svc in scan-gateway upload-gateway quarantine-console; do
    printf "  %-20s %s\n" "$svc" "$(systemctl is-active $svc 2>/dev/null || echo failed)"
done
echo ""
echo " 下一步:"
echo "   1) 编辑 /opt/ai-stack/scan-gateway/.env 填写 KSE_URL / KSE_MODE"
echo "   2) sudo systemctl restart scan-gateway upload-gateway quarantine-console"
echo "   3) curl http://127.0.0.1:8000/health"
echo "   4) sudo ./scripts/verify.sh --layer l1"
echo "=============================================="