#!/bin/bash
# ---------------------------------------------------------------------------
# KSE + AI 安全扫描平台 — 备份脚本
# 用法: sudo ./backup_kse.sh [备份目录]
# ---------------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${1:-/opt/backups/kse-$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$BACKUP_DIR"

echo "备份到: $BACKUP_DIR"

# KSE 配置、许可证与证书
cp -a /opt/kaspersky/ScanEngine/etc/kavhttpd.xml "$BACKUP_DIR/" 2>/dev/null || true
cp -a /opt/kaspersky/ScanEngine/etc/kavhttpd_*.pem "$BACKUP_DIR/" 2>/dev/null || true
cp -a /opt/kaspersky/ScanEngine/bin/*.key "$BACKUP_DIR/" 2>/dev/null || true

# Gateway 程序
cp -a /opt/ai-stack/scan-gateway "$BACKUP_DIR/" 2>/dev/null || true
cp -a /opt/ai-stack/upload-gateway "$BACKUP_DIR/" 2>/dev/null || true

# systemd 服务
cp -a /etc/systemd/system/scan-gateway.service "$BACKUP_DIR/" 2>/dev/null || true
cp -a /etc/systemd/system/upload-gateway.service "$BACKUP_DIR/" 2>/dev/null || true
cp -a /etc/systemd/system/ollama-watcher.service "$BACKUP_DIR/" 2>/dev/null || true

# Python 依赖清单
if [ -x /opt/ai-stack/venv/bin/pip ]; then
    /opt/ai-stack/venv/bin/pip freeze > "$BACKUP_DIR/requirements.txt"
fi

# 版本信息
{
    echo "备份时间: $(date)"
    echo "KSE 版本: $(/opt/kaspersky/ScanEngine/bin/kavhttpd --version 2>&1 || echo N/A)"
    echo "系统: $(lsb_release -d 2>/dev/null | cut -f2 || echo unknown)"
} > "$BACKUP_DIR/backup-info.txt"

echo "备份完成: $BACKUP_DIR"
ls -lh "$BACKUP_DIR/"

cat <<'EOF'

恢复步骤:
  1. sudo cp 备份目录/kavhttpd.xml /opt/kaspersky/ScanEngine/etc/
     sudo cp 备份目录/*.key /opt/kaspersky/ScanEngine/bin/
     sudo cp 备份目录/kavhttpd_*.pem /opt/kaspersky/ScanEngine/etc/
     sudo systemctl restart kavhttpd
  2. python3 -m venv /opt/ai-stack/venv
     source /opt/ai-stack/venv/bin/activate
     pip install -r 备份目录/requirements.txt
     deactivate
  3. sudo cp -a 备份目录/scan-gateway /opt/ai-stack/
     sudo cp -a 备份目录/upload-gateway /opt/ai-stack/
     sudo cp -a 备份目录/*.service /etc/systemd/system/
     sudo systemctl daemon-reload
     sudo systemctl restart scan-gateway upload-gateway
  4. 验证: systemctl is-active kavhttpd scan-gateway upload-gateway

注意: 恢复配置后若 KSE 启动失败, 通常是 Token 加密值与当前系统不匹配。
      请通过 Web UI 重新生成 Token (Generate token -> Save), 不要直接恢复旧的 kavhttpd.xml。
EOF