#!/usr/bin/env bash
# KAIP 平台离线安装（无需外网、无需 pip / venv / apt）
# 支持：x86_64 Linux（glibc 2.17+），需 root。系统 Python 3.10/3.11/3.12 直接使用；更低版本（Ubuntu 20.04、CentOS 7 等）自动使用包内便携 Python 3.12
# 用法：解压离线包后执行  sudo bash install-offline.sh [--port 8080] [--kse-url http://<KSE>:1234 [--kse-share /mnt/kaip-scanqueue]] [--mock]
#   --kse-url    KSE 不在本机时指定其 HTTP 地址（默认 http://127.0.0.1:1234）
#   --kse-share  KSE 不在本机时，平台扫描目录 /opt/kaspersky/scanqueue 经 NFS 挂载到 KSE 主机上的路径；
#                ≥25MB 的文件写入该目录后由 KSE 按路径扫描（scanfile）。共享与挂载见 deploy/kse-share.sh
#   --mock     未安装 KSE 时以模拟引擎启动（仅演示）
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=8080; MOCK=""; KSE_URL="http://127.0.0.1:1234"; KSE_SHARE=""
while [ $# -gt 0 ]; do case "$1" in --port) PORT="$2"; shift 2;; --kse-url) KSE_URL="$2"; shift 2;; --kse-share) KSE_SHARE="$2"; shift 2;; --mock) MOCK=1; shift;; *) echo "未知参数 $1"; exit 1;; esac; done
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "仅支持 x86_64"; exit 1; }

DST=/opt/kaip
# Python：优先用系统自带的 3.10 / 3.11 / 3.12；没有（如 Ubuntu 20.04 的 3.8、CentOS 7）则用离线包内的便携 Python 3.12
PY=""; PV=""
for c in python3.12 python3.11 python3.10 python3; do
  p="$(command -v "$c" || true)"; [ -n "$p" ] || continue
  v="$("$p" -c 'import sys;print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null || true)"
  [ -n "$v" ] && [ -d "$HERE/wheels/py$v" ] && { PY="$p"; PV="$v"; break; }
done
if [ -z "$PY" ]; then
  PT="$(ls "$HERE"/python/cpython-3.12*-x86_64-unknown-linux-gnu-install_only*.tar.gz 2>/dev/null | head -1)"
  [ -n "$PT" ] || { echo "系统没有 Python 3.10+，且离线包缺少便携 Python（python/ 目录）"; exit 1; }
  mkdir -p "$DST" && rm -rf "$DST/python" && tar -xzf "$PT" -C "$DST"   # 解压出 $DST/python
  PY="$DST/python/bin/python3"; PV=3.12
  echo "ℹ 系统 Python 版本低于 3.10，使用离线包内的便携 Python 3.12（$DST/python）"
fi
WHL="$HERE/wheels/py$PV"
echo "== KAIP 离线安装 · Python $PV · 端口 $PORT =="

# 1. 校验离线包完整性
if [ -f "$HERE/SHA256SUMS" ]; then
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) && echo "✔ 离线包校验通过" || { echo "✘ 离线包校验失败（文件损坏或被篡改）"; exit 1; }
fi

# 2. 程序与依赖：wheel 直接解压到私有目录（wheel 即 zip），不依赖 pip / venv
mkdir -p "$DST" /var/lib/kaip /etc/kaip /opt/kaspersky/scanqueue
rm -rf "$DST/server" "$DST/client" "$DST/pylib" "$DST/runtime"
cp -r "$HERE/server" "$HERE/client" "$HERE/runtime" "$DST/"
mkdir -p "$DST/pylib"
for w in "$WHL"/*.whl; do "$PY" -c 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$w" "$DST/pylib"; done
PYTHONPATH="$DST/pylib" "$PY" -c "import fastapi,uvicorn,httpx,multipart;print('✔ 依赖可用：fastapi', fastapi.__version__, '/ uvicorn', uvicorn.__version__)"

# 3. 配置
id kaip >/dev/null 2>&1 || useradd --system --home /var/lib/kaip --shell /usr/sbin/nologin kaip
if [ ! -f /etc/kaip/kaip.env ]; then
  cp "$HERE/deploy/kaip.env" /etc/kaip/kaip.env
  sed -i "s#^KAIP_KSE_URL=.*#KAIP_KSE_URL=$KSE_URL#" /etc/kaip/kaip.env
  # KSE 在其他主机：scanfile 只能扫 KSE 本机路径——有 NFS 共享则映射路径，否则大文件也走 scanmemory
  case "$KSE_URL" in
    *://127.0.0.1*|*://localhost*) ;;
    *) if [ -n "$KSE_SHARE" ]; then sed -i "s#^KAIP_KSE_SCAN_DIR_REMOTE=.*#KAIP_KSE_SCAN_DIR_REMOTE=$KSE_SHARE#" /etc/kaip/kaip.env
       else sed -i "s#^KAIP_KSE_SCANFILE_THRESHOLD=.*#KAIP_KSE_SCANFILE_THRESHOLD=0#" /etc/kaip/kaip.env
            echo "⚠ KSE 在其他主机且未指定 --kse-share：所有文件以 scanmemory 送检。需要大文件走 scanfile 时见 deploy/kse-share.sh"; fi;;
  esac
  [ -n "$MOCK" ] && sed -i "s#^KAIP_KSE_MODE=.*#KAIP_KSE_MODE=mock#" /etc/kaip/kaip.env
  echo "KAIP_RUNTIME_DIR=$DST/runtime" >> /etc/kaip/kaip.env
fi
chmod 600 /etc/kaip/kaip.env
chown -R kaip:kaip /var/lib/kaip
chmod 700 /var/lib/kaip && chmod -R go-rwx /var/lib/kaip   # 数据库含令牌、初始管理员密码，仅服务账号可读
chown kaip:kaip /opt/kaspersky/scanqueue && chmod 0775 /opt/kaspersky/scanqueue

# 4. systemd 服务
cat >/etc/systemd/system/kaip-platform.service <<EOF
[Unit]
Description=Kaspersky AI Protect Platform
After=network-online.target kavhttpd.service

[Service]
User=kaip
UMask=0077
EnvironmentFile=/etc/kaip/kaip.env
Environment=PYTHONPATH=$DST/pylib
WorkingDirectory=$DST/server
ExecStart=$PY -m uvicorn app.main:app --host 0.0.0.0 --port $PORT --proxy-headers
Restart=always
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kaip-platform >/dev/null 2>&1
systemctl restart kaip-platform   # 重复安装 / 升级时让新程序生效
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
echo "✔ 平台已启动：$(curl -s http://127.0.0.1:$PORT/healthz)"
echo
echo "控制台：http://$(hostname -I | awk '{print $1}'):$PORT"
echo "初始管理员密码：/var/lib/kaip/initial_admin_password.txt（首次登录后立即修改）"
echo "终端无 Node.js 时，一键安装脚本会自动从本平台下载私有运行时（runtime/ 已就位）"
[ -n "$MOCK" ] && echo "⚠ 当前为模拟引擎；安装 KSE 后把 /etc/kaip/kaip.env 中 KAIP_KSE_MODE 改为 kse 并重启 kaip-platform"
[ -d "$HERE/kse" ] && echo "KSE 安装包位于 $HERE/kse/（按《PoC 实施手册》第 4.1 节安装，许可证另行提供）"
echo "正式环境请参考 deploy/nginx-kaip.conf 启用 HTTPS"
