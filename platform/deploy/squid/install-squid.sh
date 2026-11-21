#!/usr/bin/env bash
# KAIP 下载代理：Squid（HTTPS 解密）→ KSE ICAP 扫描下载内容（PoC 用例 B5）
# 拦截终端 / AI Agent 经代理从技能市场、模型仓库、npm / PyPI / GitHub 下载的恶意文件。
#
# 推荐装在 KSE 服务器上（ICAP 走本机 127.0.0.1:1344，不对外开放）。需 root。
# 用法：
#   sudo bash install-squid.sh [--icap 127.0.0.1:1344] [--allow 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16]
#                              [--kaip-syslog <KAIP 平台 IP>] [--port 3128] [--no-bump-domains a.com,b.com]
#   --icap          KSE ICAP 地址（默认本机）
#   --allow         允许使用代理的终端网段（默认全部私网）
#   --kaip-syslog   KSE 与本代理同机时，把 KSE ICAP 的检出日志以 CEF 发到 KAIP 平台 udp/5514，
#                   拦截记录出现在 KAIP 控制台「事件日志」（来源 kse-syslog）
#   --no-bump-domains  额外不解密的域名（默认已含卡巴斯基更新源、Windows Update、苹果）
# 产物：/etc/squid/certs/kaip-proxy-ca.crt —— 分发给终端信任（见 client-proxy.sh / client-proxy.ps1）
#
# 软件包：Ubuntu 22.04+ / Debian 12 用 squid-openssl（支持 HTTPS 解密）；RHEL 8+ 的 squid 自带 OpenSSL。
# Ubuntu 20.04 / Debian 11 官方源的 squid 不支持 HTTPS 解密，请把代理装在更新的系统上。
set -euo pipefail
ICAP="127.0.0.1:1344"; ALLOW="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"; SYSLOG=""; PORT=3128; NOBUMP_EXTRA=""
while [ $# -gt 0 ]; do case "$1" in
  --icap) ICAP="$2"; shift 2;; --allow) ALLOW="$2"; shift 2;; --kaip-syslog) SYSLOG="$2"; shift 2;;
  --port) PORT="$2"; shift 2;; --no-bump-domains) NOBUMP_EXTRA="$2"; shift 2;;
  *) echo "未知参数 $1"; exit 1;; esac; done
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

# 1. 软件包
if ! command -v squid >/dev/null || ! squid -v | grep -- "--with-openssl" >/dev/null; then
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y squid-openssl || { echo "✘ 安装 squid-openssl 失败（离线环境请先从内网源 / 安装介质准备）"; exit 1; }
  elif command -v dnf >/dev/null; then dnf install -y squid; elif command -v yum >/dev/null; then yum install -y squid
  else echo "✘ 无法自动安装 Squid"; exit 1; fi
fi
squid -v | grep -- "--with-openssl" >/dev/null || { echo "✘ 当前 Squid 不支持 HTTPS 解密（未带 OpenSSL 编译）"; exit 1; }
CERTGEN=""
for f in /usr/lib/squid/security_file_certgen /usr/lib64/squid/security_file_certgen; do [ -x "$f" ] && { CERTGEN="$f"; break; }; done
[ -n "$CERTGEN" ] || { echo "✘ 未找到 security_file_certgen"; exit 1; }
PUSER="$(id -u proxy >/dev/null 2>&1 && echo proxy || echo squid)"
echo "✔ $(squid -v | head -1)（支持 HTTPS 解密）"

# 2. 代理 CA（已存在则沿用，避免终端重新信任）
C=/etc/squid/certs; mkdir -p "$C"
if [ ! -f "$C/kaip-proxy-ca.pem" ]; then
  openssl req -new -newkey rsa:2048 -sha256 -days 825 -nodes -x509 -subj "/CN=KAIP Download Proxy CA/O=Kaspersky AI Protect PoC" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$C/kaip-proxy-ca.key" -out "$C/kaip-proxy-ca.crt" 2>/dev/null
  cat "$C/kaip-proxy-ca.crt" "$C/kaip-proxy-ca.key" > "$C/kaip-proxy-ca.pem"
  echo "✔ 已生成代理 CA：$C/kaip-proxy-ca.crt"
fi
chown -R "$PUSER" "$C"; chmod 700 "$C"; chmod 600 "$C/kaip-proxy-ca.key" "$C/kaip-proxy-ca.pem"; chmod 644 "$C/kaip-proxy-ca.crt"
rm -rf /var/spool/squid/ssl_db && mkdir -p /var/spool/squid && "$CERTGEN" -c -s /var/spool/squid/ssl_db -M 16MB >/dev/null
chown -R "$PUSER" /var/spool/squid/ssl_db

# 3. 配置
[ -f /etc/squid/squid.conf ] && [ ! -f /etc/squid/squid.conf.kaip.bak ] && cp /etc/squid/squid.conf /etc/squid/squid.conf.kaip.bak
NOBUMP=".kaspersky.com .kaspersky-labs.com .windowsupdate.com .update.microsoft.com .apple.com"
[ -n "$NOBUMP_EXTRA" ] && NOBUMP="$NOBUMP $(echo "$NOBUMP_EXTRA" | tr ',' ' ')"
cat >/etc/squid/squid.conf <<EOF
# 由 KAIP install-squid.sh 生成（原配置备份为 squid.conf.kaip.bak）
http_port $PORT ssl-bump tls-cert=$C/kaip-proxy-ca.crt tls-key=$C/kaip-proxy-ca.key generate-host-certificates=on dynamic_cert_mem_cache_size=16MB
sslcrtd_program $CERTGEN -s /var/spool/squid/ssl_db -M 16MB
sslcrtd_children 8 startup=2 idle=1

acl localnet src $(echo "$ALLOW" | tr ',' ' ')
acl SSL_ports port 443
acl Safe_ports port 80 443 1025-65535
acl CONNECT method CONNECT
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow localhost
http_access allow localnet
http_access deny all

# HTTPS 解密：卡巴斯基更新源、系统更新等不解密（证书固定 / 无需扫描）
acl nobump ssl::server_name $NOBUMP
acl step1 at_step SslBump1
ssl_bump peek step1
ssl_bump splice nobump
ssl_bump bump all

# ICAP → Kaspersky Scan Engine
icap_enable on
icap_send_client_ip on
icap_preview_enable on
icap_preview_size 1024
icap_persistent_connections on
# 下载内容扫描：ICAP 不可用时拒绝下载（bypass=0，失败即阻断）
icap_service kse_resp respmod_precache bypass=0 icap://$ICAP/resp
# 请求 / URL 检查：ICAP 不可用时放行（bypass=1）
icap_service kse_req  reqmod_precache  bypass=1 icap://$ICAP/req
adaptation_access kse_resp allow all
adaptation_access kse_req allow all

# 大文件（模型）下载：放宽超时；不缓存
icap_io_timeout 600 seconds
read_timeout 30 minutes
cache deny all
access_log daemon:/var/log/squid/access.log squid
EOF
squid -k parse 2>&1 | grep -iE "FATAL|ERROR" && { echo "✘ 配置检查失败"; exit 1; } || true
systemctl enable squid >/dev/null 2>&1; systemctl restart squid
for i in $(seq 20); do ss -ltn | grep -q ":$PORT " && break; sleep 1; done
echo "✔ Squid 已在 :$PORT 运行，ICAP → icap://$ICAP（resp / req）"

# 4. KSE ICAP 服务与检出日志（KSE 与本代理同机时）
if systemctl list-unit-files kavicapd.service >/dev/null 2>&1 && ! systemctl is-active kavicapd >/dev/null 2>&1; then
  # Multi 模式下 kavicapd 可能未启动（只跑了 HTTP 模式的 kavhttpd）；两者独立，启动不影响 KAIP 平台的 HTTP 扫描
  systemctl enable --now kavicapd >/dev/null 2>&1 && for i in $(seq 40); do ss -ltn | grep -q ":1344 " && break; sleep 1; done
fi
systemctl is-active kavicapd >/dev/null 2>&1 && echo "✔ KSE ICAP 服务 kavicapd 运行中" || echo "⚠ 本机 kavicapd 未运行：KSE 需以 ICAP 或 Multi 模式运行"
if [ -n "$SYSLOG" ]; then
  if systemctl is-active klScanEngineUI >/dev/null 2>&1; then
    # KSE 由 Web 控制台管理时，日志设置在控制台中配置（控制台会改写 icapdkavlog.conf），脚本不直接修改
    echo "ℹ KSE 由 Web 控制台管理，请在控制台 Settings → Logging → Syslog 中为 ICAP 模式添加日志目标："
    echo "    事件：Scan result: detect、Scan result: other（可不选 clean）；格式：CEF；目标：remote syslog  udp://$SYSLOG:5514"
  else
    LOGCONF=/opt/kaspersky/ScanEngine/bin/icapdkavlog.conf
    [ -f "$LOGCONF.kaip.bak" ] || cp "$LOGCONF" "$LOGCONF.kaip.bak"
    cat >"$LOGCONF" <<EOF2
<?xml version="1.0" encoding="utf-8"?>
<Logging>
	<DebugLogging>
		<Level>none</Level>
		<File size_limit="0" folder="/opt/kaspersky/ScanEngine/bin/logs"/>
	</DebugLogging>
	<SyslogLogging>
		<SyslogEnabled>true</SyslogEnabled>
		<Syslog destination="udp://$SYSLOG:5514" format="cef">
			<LoggedEvent>init</LoggedEvent>
			<LoggedEvent>deinit</LoggedEvent>
			<LoggedEvent>update</LoggedEvent>
			<LoggedEvent>license</LoggedEvent>
			<LoggedEvent>audit</LoggedEvent>
			<LoggedEvent>scanresultdetect</LoggedEvent>
			<LoggedEvent>scanresultother</LoggedEvent>
		</Syslog>
	</SyslogLogging>
</Logging>
EOF2
    systemctl restart kavicapd
    echo "✔ KSE ICAP 检出日志 → udp://$SYSLOG:5514（CEF；原配置备份为 icapdkavlog.conf.kaip.bak）"
  fi
fi

echo
echo "下一步：把 $C/kaip-proxy-ca.crt 分发到终端并信任，终端设置代理 http://$(hostname -I | awk '{print $1}'):$PORT"
echo "  Linux：  bash client-proxy.sh  http://<代理>:$PORT kaip-proxy-ca.crt [KAIP 平台地址]"
echo "  Windows：powershell -ExecutionPolicy Bypass -File client-proxy.ps1 -Proxy http://<代理>:$PORT -Ca kaip-proxy-ca.crt [-NoProxy <KAIP 平台地址>]"
echo "建议：防火墙只允许本机访问 ICAP 1344（KSE ICAP 默认监听所有地址）"
