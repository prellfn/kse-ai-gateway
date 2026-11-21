#!/usr/bin/env bash
# 终端（Linux）接入 KAIP 下载代理：信任代理 CA + 设置代理环境变量（当前用户，无需 root）
# 用法：
#   bash client-proxy.sh http://<代理>:3128 kaip-proxy-ca.crt [不走代理的地址，逗号分隔，如 KAIP 平台、模型 API]
#   bash client-proxy.sh --remove
#   加 --system（需 root）：同时把 CA 加入系统信任库（update-ca-certificates / update-ca-trust）
# 生效范围：curl、wget、git、pip / Python、npm / Node.js、Bun（OpenCode）、Codex 等读取 HTTP(S)_PROXY 的程序。
# 新开终端或执行  source ~/.kaip/proxy.env  后生效；已在运行的 AI Agent 需重启。
set -euo pipefail
D="$HOME/.kaip"; ENVF="$D/proxy.env"; MARK="# kaip-proxy"
RCS=("$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc")

unhook() { for rc in "${RCS[@]}"; do [ -f "$rc" ] && sed -i "/$MARK/d" "$rc"; done; return 0; }

if [ "${1:-}" = "--remove" ]; then
  unhook; rm -f "$ENVF" "$D/proxy-ca.crt" "$D/ca-bundle.pem"
  echo "✔ 已移除代理设置（新开终端生效；已加入系统信任库的 CA 需手动删除）"; exit 0
fi
SYSTEM=0; ARGS=()
for a in "$@"; do [ "$a" = "--system" ] && SYSTEM=1 || ARGS+=("$a"); done
PROXY="${ARGS[0]:?用法：client-proxy.sh http://<代理>:3128 kaip-proxy-ca.crt [NO_PROXY]}"
CA="${ARGS[1]:?缺少代理 CA 证书文件}"
EXTRA_NO="${ARGS[2]:-}"
grep -q "BEGIN CERTIFICATE" "$CA" || { echo "✘ $CA 不是 PEM 证书"; exit 1; }

mkdir -p "$D"; cp "$CA" "$D/proxy-ca.crt"; chmod 644 "$D/proxy-ca.crt"
# 组合信任库（系统 CA + 代理 CA）：SSL_CERT_FILE / REQUESTS_CA_BUNDLE 等会替换而不是追加信任库
SYS=""; for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem; do [ -f "$f" ] && { SYS="$f"; break; }; done
{ [ -n "$SYS" ] && cat "$SYS"; cat "$D/proxy-ca.crt"; } > "$D/ca-bundle.pem"

NO="localhost,127.0.0.1,::1"; [ -n "$EXTRA_NO" ] && NO="$NO,$EXTRA_NO"
cat >"$ENVF" <<EOF
# KAIP 下载代理（由 client-proxy.sh 生成；移除：bash client-proxy.sh --remove）
export HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY http_proxy=$PROXY https_proxy=$PROXY
export NO_PROXY=$NO no_proxy=$NO
export NODE_EXTRA_CA_CERTS=$D/proxy-ca.crt
export SSL_CERT_FILE=$D/ca-bundle.pem REQUESTS_CA_BUNDLE=$D/ca-bundle.pem CURL_CA_BUNDLE=$D/ca-bundle.pem
export PIP_CERT=$D/ca-bundle.pem GIT_SSL_CAINFO=$D/ca-bundle.pem
EOF
unhook
for rc in "$HOME/.bashrc" "$HOME/.profile"; do echo "[ -f \"$ENVF\" ] && . \"$ENVF\"  $MARK" >> "$rc"; done
[ -f "$HOME/.zshrc" ] && echo "[ -f \"$ENVF\" ] && . \"$ENVF\"  $MARK" >> "$HOME/.zshrc"
echo "✔ 代理 $PROXY；不走代理：$NO"
echo "✔ 已信任代理 CA（当前用户）：$D/proxy-ca.crt"

if [ "$SYSTEM" = 1 ]; then
  [ "$(id -u)" = 0 ] || { echo "✘ --system 需要 root"; exit 1; }
  if command -v update-ca-certificates >/dev/null; then cp "$D/proxy-ca.crt" /usr/local/share/ca-certificates/kaip-proxy-ca.crt && update-ca-certificates >/dev/null
  elif command -v update-ca-trust >/dev/null; then cp "$D/proxy-ca.crt" /etc/pki/ca-trust/source/anchors/kaip-proxy-ca.crt && update-ca-trust; fi
  echo "✔ 已加入系统信任库"
fi
echo "新开终端或执行：source $ENVF ；然后重启 AI Agent"
