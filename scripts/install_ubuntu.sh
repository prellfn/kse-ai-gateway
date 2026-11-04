#!/bin/bash
# ---------------------------------------------------------------------------
# kse-ai-gateway — Linux 网关一键部署脚本 (Ubuntu 22.04)
#
# 前提: KSE 2.2.x 已安装并通过 Web UI 完成了 HTTPS + Token + 扫描目录配置
#       (见 docs/install.md 第三、四章)
#
# 用法: sudo ./scripts/install_ubuntu.sh [仓库根目录]
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
STACK_DIR="/opt/ai-stack"
VENV_DIR="$STACK_DIR/venv"

echo "=============================================="
echo " kse-ai-gateway 网关部署"
echo " 仓库根目录: $REPO_ROOT"
echo "=============================================="

if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 请使用 root 运行 (sudo ./scripts/install_ubuntu.sh)"
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. 系统依赖
# ---------------------------------------------------------------------------
echo "[1/6] 安装系统依赖..."
apt update -qq
apt install -y -qq python3-pip python3-venv curl >/dev/null

# ---------------------------------------------------------------------------
# 2. 目录
# ---------------------------------------------------------------------------
echo "[2/6] 创建工作目录..."
mkdir -p /opt/kaspersky/scanqueue
mkdir -p /opt/kaspersky/quarantine
mkdir -p "$STACK_DIR/scan-gateway" "$STACK_DIR/upload-gateway/templates"
mkdir -p "$STACK_DIR/scan-gateway/logs"

# ---------------------------------------------------------------------------
# 3. Python 虚拟环境
# ---------------------------------------------------------------------------
if [ ! -x "$VENV_DIR/bin/python3" ]; then
    echo "[3/6] 创建 Python 虚拟环境..."
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install -q --upgrade pip
"$VENV_DIR/bin/pip" install -q -r "$REPO_ROOT/gateway/requirements.txt"

# ---------------------------------------------------------------------------
# 4. 部署程序
# ---------------------------------------------------------------------------
echo "[4/6] 部署 Gateway 程序..."
cp "$REPO_ROOT/gateway/scan-gateway/app.py" "$STACK_DIR/scan-gateway/app.py"
cp "$REPO_ROOT/gateway/upload-gateway/app.py" "$STACK_DIR/upload-gateway/app.py"
cp "$REPO_ROOT/gateway/upload-gateway/templates/index.html" "$STACK_DIR/upload-gateway/templates/index.html"
cp "$REPO_ROOT/watchers/ollama-watcher.sh" "$STACK_DIR/ollama-watcher.sh"
chmod +x "$STACK_DIR/ollama-watcher.sh"

for svc in scan-gateway upload-gateway; do
    if [ ! -f "$STACK_DIR/$svc/.env" ]; then
        cp "$REPO_ROOT/.env.example" "$STACK_DIR/$svc/.env"
        chmod 600 "$STACK_DIR/$svc/.env"
        echo "    -> 已生成 $STACK_DIR/$svc/.env，请填写 KSE_TOKEN 等配置"
    fi
done

# ---------------------------------------------------------------------------
# 5. systemd 服务
# ---------------------------------------------------------------------------
echo "[5/6] 注册 systemd 服务..."
cp "$REPO_ROOT/gateway/systemd/scan-gateway.service" /etc/systemd/system/scan-gateway.service
cp "$REPO_ROOT/gateway/systemd/upload-gateway.service" /etc/systemd/system/upload-gateway.service
cp "$REPO_ROOT/gateway/systemd/ollama-watcher.service" /etc/systemd/system/ollama-watcher.service
systemctl daemon-reload
systemctl enable scan-gateway upload-gateway >/dev/null 2>&1 || true
systemctl restart scan-gateway upload-gateway

# ---------------------------------------------------------------------------
# 6. 验证
# ---------------------------------------------------------------------------
echo "[6/6] 验证服务状态..."
sleep 3
for svc in kavhttpd scan-gateway upload-gateway; do
    printf "  %-18s %s\n" "$svc" "$(systemctl is-active $svc 2>/dev/null || echo 'not-installed')"
done

echo
echo "=============================================="
echo " 部署完成"
echo " 下一步:"
echo "   1) 编辑 /opt/ai-stack/scan-gateway/.env 填写 KSE_TOKEN"
echo "   2) 编辑 /opt/ai-stack/upload-gateway/.env 填写 AnythingLLM 配置"
echo "   3) sudo systemctl restart scan-gateway upload-gateway"
echo "   4) curl http://127.0.0.1:8000/health"
echo "   5) curl http://127.0.0.1:8002/health"
echo "=============================================="