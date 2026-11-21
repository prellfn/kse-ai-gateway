#!/usr/bin/env bash
# KAIP 平台服务端原生安装（Ubuntu 22.04/24.04、Debian 12；需 root）
# 前置：KSE 2.2 已安装并在 HTTP/Multi 模式运行（见 docs/部署手册.md 第 2 章）
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST=/opt/kaip
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
# 在离线包内误用本脚本时（需要访问 PyPI），自动转交离线安装脚本
if [ -d "$SRC/wheels" ] && [ -f "$SRC/install-offline.sh" ]; then
  echo "检测到离线安装包，改用 install-offline.sh（无需联网 / pip）"
  exec bash "$SRC/install-offline.sh" "$@"
fi

apt-get update -y && apt-get install -y python3 python3-venv
id kaip >/dev/null 2>&1 || useradd --system --home /var/lib/kaip --shell /usr/sbin/nologin kaip
mkdir -p "$DST" /var/lib/kaip /etc/kaip /opt/kaspersky/scanqueue
cp -r "$SRC/server" "$SRC/client" "$DST/"
python3 -m venv "$DST/venv"
"$DST/venv/bin/pip" install -q -r "$DST/server/requirements.txt"
[ -f /etc/kaip/kaip.env ] || cp "$SRC/deploy/kaip.env" /etc/kaip/kaip.env
chown -R kaip:kaip /var/lib/kaip
chmod 700 /var/lib/kaip && chmod -R go-rwx /var/lib/kaip   # 数据库含令牌、初始管理员密码，仅服务账号可读
# scanqueue：平台写入、KSE 读取
chown kaip:kaip /opt/kaspersky/scanqueue && chmod 0775 /opt/kaspersky/scanqueue
chmod 600 /etc/kaip/kaip.env

cat >/etc/systemd/system/kaip-platform.service <<EOF
[Unit]
Description=Kaspersky AI Protect Platform
After=network-online.target kavhttpd.service

[Service]
User=kaip
UMask=0077
EnvironmentFile=/etc/kaip/kaip.env
WorkingDirectory=$DST/server
ExecStart=$DST/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080 --proxy-headers
Restart=always
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now kaip-platform
sleep 3
systemctl --no-pager status kaip-platform | head -5
echo
echo "控制台：http://$(hostname -I | awk '{print $1}'):8080"
[ -f /var/lib/kaip/initial_admin_password.txt ] && echo "初始管理员密码：$(cat /var/lib/kaip/initial_admin_password.txt)"
echo "请编辑 /etc/kaip/kaip.env 填写 KAIP_KSE_TOKEN 后执行 systemctl restart kaip-platform"
echo "生产环境建议在前面加 Nginx 提供 HTTPS（示例见 deploy/nginx-kaip.conf）"
