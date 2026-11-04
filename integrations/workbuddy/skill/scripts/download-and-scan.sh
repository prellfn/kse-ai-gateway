#!/bin/bash
# ---------------------------------------------------------------------------
# kse-download-proxy — Skill / 插件包「先扫后装」下载代理
#
# 用法:
#   ./download-and-scan.sh <url> <目标目录>
#
# 流程:
#   下载到临时目录 → 调用 Scan Gateway 解包逐文件扫描 →
#   CLEAN 才移动到目标目录; DETECT 则删除临时文件并以非零码退出
# ---------------------------------------------------------------------------
set -uo pipefail

GATEWAY="${KSE_SCAN_GATEWAY:-http://127.0.0.1:8000}"
TIMEOUT="${KSE_SCAN_TIMEOUT:-300}"

URL="${1:-}"
DEST_DIR="${2:-./downloads}"

if [ -z "$URL" ]; then
    echo "用法: $0 <url> [目标目录]" >&2
    exit 2
fi

mkdir -p "$DEST_DIR"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FILENAME=$(basename "${URL%%\?*}")
[ -z "$FILENAME" ] && FILENAME="download.bin"
TMPFILE="$TMPDIR/$FILENAME"

echo "↓ 下载: $URL"
if command -v curl >/dev/null 2>&1; then
    curl -sSL --max-time "$TIMEOUT" -o "$TMPFILE" "$URL" || { echo "下载失败" >&2; exit 2; }
else
    wget -q -O "$TMPFILE" "$URL" || { echo "下载失败" >&2; exit 2; }
fi

echo "🔍 扫描中 (解包逐文件)..."
RESP=$(curl -s --max-time "$TIMEOUT" -X POST "$GATEWAY/scan/package" -F "file=@$TMPFILE")
if [ -z "$RESP" ]; then
    echo "❌ 扫描网关无响应 ($GATEWAY) — 拒绝安装 (Fail-Closed)" >&2
    exit 2
fi

VERDICT=$(printf '%s' "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict',''))" 2>/dev/null)
DETECTION=$(printf '%s' "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('detection_name',''))" 2>/dev/null)

if [ "$VERDICT" = "DETECT" ]; then
    echo "⛔ 检出威胁: ${DETECTION:-未知} — 已拒绝安装" >&2
    printf '%s' "$RESP" | python3 -m json.tool 2>/dev/null
    exit 1
fi

if [ "$VERDICT" != "CLEAN" ]; then
    echo "⚠️  扫描未得出确定结论 (verdict=$VERDICT) — 拒绝安装 (Fail-Closed)" >&2
    exit 2
fi

TARGET="$DEST_DIR/$FILENAME"
mv "$TMPFILE" "$TARGET"
echo "✅ 扫描通过，已保存: $TARGET"