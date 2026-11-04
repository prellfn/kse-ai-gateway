#!/bin/bash
# ---------------------------------------------------------------------------
# kse-scan CLI — 通过 Scan Gateway 扫描文件 / 文本 / URL / 压缩包
#
# 用法:
#   ./scan.sh file /path/to/file
#   ./scan.sh text /path/to/content.txt
#   ./scan.sh url  https://example.com/file.zip
#   ./scan.sh pkg  /path/to/skill.zip
#
# 退出码: 0=CLEAN  1=DETECT  2=扫描失败
# ---------------------------------------------------------------------------
set -uo pipefail

GATEWAY="${KSE_SCAN_GATEWAY:-http://127.0.0.1:8000}"
TIMEOUT="${KSE_SCAN_TIMEOUT:-120}"
MODE="${1:-}"
TARGET="${2:-}"

if [ -z "$MODE" ] || [ -z "$TARGET" ]; then
    echo "用法: $0 {file|text|url|pkg} <目标>" >&2
    exit 2
fi

scan_file() {
    curl -s --max-time "$TIMEOUT" -X POST "$GATEWAY/scan/file" \
        -H "Content-Type: application/json" \
        -d "{\"file_path\":\"$1\",\"timeout\":$TIMEOUT}"
}

scan_upload() {
    curl -s --max-time "$TIMEOUT" -X POST "$GATEWAY/scan/upload" \
        -F "file=@$1"
}

scan_package() {
    curl -s --max-time "$TIMEOUT" -X POST "$GATEWAY/scan/package" \
        -F "file=@$1"
}

scan_url() {
    curl -s --max-time "$TIMEOUT" -X POST "$GATEWAY/scan/url" \
        -H "Content-Type: application/json" \
        -d "{\"url\":\"$1\",\"timeout\":$TIMEOUT}"
}

case "$MODE" in
    file) RESP=$(scan_file "$TARGET") ;;
    text) RESP=$(scan_upload "$TARGET") ;;
    pkg)  RESP=$(scan_package "$TARGET") ;;
    url)  RESP=$(scan_url "$TARGET") ;;
    *)    echo "未知模式: $MODE" >&2; exit 2 ;;
esac

if [ -z "$RESP" ]; then
    echo "扫描网关无响应 ($GATEWAY)" >&2
    exit 2
fi

VERDICT=$(printf '%s' "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict',''))" 2>/dev/null)
DETECTION=$(printf '%s' "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('detection_name',''))" 2>/dev/null)

case "$VERDICT" in
    CLEAN)
        echo "✅ CLEAN — 扫描通过"
        exit 0
        ;;
    DETECT)
        echo "⛔ DETECT — 检出威胁: ${DETECTION:-未知}"
        printf '%s' "$RESP" | python3 -m json.tool 2>/dev/null
        exit 1
        ;;
    *)
        echo "⚠️  扫描未得出确定结论 (verdict=${VERDICT:-未知})" >&2
        printf '%s' "$RESP" | python3 -m json.tool 2>/dev/null
        exit 2
        ;;
esac