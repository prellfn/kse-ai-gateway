#!/usr/bin/env bash
# Kaspersky AI Protect 终端一键安装（Linux / macOS）
# 用法: curl -fsSLk https://kaip:8080/dl/install.sh | bash -s -- --server https://kaip:8080 --token <注册令牌> [--agents codex,opencode,workbuddy] [--no-watch] [--secure]
set -euo pipefail
SERVER=""; TOKEN=""; AGENTS=""; NOWATCH=""; SECURE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2%/}"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --agents) AGENTS="$2"; shift 2;;
    --no-watch) NOWATCH=1; shift;;
    --secure) SECURE=1; shift;;
    *) echo "未知参数 $1"; exit 1;;
  esac
done
[ -n "$SERVER" ] && [ -n "$TOKEN" ] || { echo "需要 --server 与 --token"; exit 1; }

echo "== Kaspersky AI Protect 终端安装 =="
KAIP_HOME="${KAIP_HOME:-$HOME/.kaip}"
K0=""; [ -z "$SECURE" ] && K0="-k"
NODE="$(command -v node 2>/dev/null || true)"
if [ -n "$NODE" ] && [ "$("$NODE" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt 18 ]; then NODE=""; fi
if [ -z "$NODE" ]; then
  # 离线 / 无 Node 终端：从 KAIP 平台下载私有运行时
  echo "未找到 Node.js 18+，从平台下载 KAIP 私有运行时……"
  mkdir -p "$KAIP_HOME/node"
  curl -fsSL $K0 "$SERVER/dl/runtime/node-linux-x64.tar.gz" -o /tmp/kaip-node.tar.gz || { echo "平台未提供 Node 运行时，请先安装 Node.js 18+"; exit 1; }
  tar -xzf /tmp/kaip-node.tar.gz -C "$KAIP_HOME/node" --strip-components=1 && rm -f /tmp/kaip-node.tar.gz
  NODE="$KAIP_HOME/node/bin/node"
  "$NODE" --version >/dev/null || { echo "私有运行时无法运行"; exit 1; }
  echo "已安装私有运行时：$("$NODE" --version)（$NODE）"
fi
CLIENT_DIR="$KAIP_HOME/client"
mkdir -p "$KAIP_HOME"
K=""; [ -z "$SECURE" ] && K="-k"
TMP=$(mktemp -d)
echo "下载客户端：$SERVER/dl/kaip-client.tar.gz"
curl -fsSL $K "$SERVER/dl/kaip-client.tar.gz" -o "$TMP/c.tgz"
rm -rf "$CLIENT_DIR"; mkdir -p "$CLIENT_DIR"
tar -xzf "$TMP/c.tgz" -C "$CLIENT_DIR"
rm -rf "$TMP"
chmod +x "$CLIENT_DIR"/bin/*.js || true
# ~/.kaip/bin 下的 kaip 包装脚本使用的是安装时的 node 绝对路径，PATH 中无 node 也可用

ENROLL=("$NODE" "$CLIENT_DIR/bin/kaip.js" enroll --server "$SERVER" --token "$TOKEN")
[ -z "$SECURE" ] && ENROLL+=(--insecure)
"${ENROLL[@]}"

INST=("$NODE" "$CLIENT_DIR/bin/kaip.js" install)
[ -n "$AGENTS" ] && INST+=(--agents "$AGENTS")
[ -n "$NOWATCH" ] && INST+=(--no-watch)
"${INST[@]}"

# PATH
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] && ! grep -q '.kaip/bin' "$rc" && echo 'export PATH="$HOME/.kaip/bin:$PATH"' >> "$rc"
done
"$NODE" "$CLIENT_DIR/bin/kaip.js" test || true
echo
echo "安装完成。重新打开终端后可使用 kaip status / kaip scan <路径>。"
