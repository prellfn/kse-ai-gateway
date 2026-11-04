#!/bin/bash
# ---------------------------------------------------------------------------
# Ollama Model Download Watcher
#
# 监控 Ollama 模型下载目录 (models/blobs), 新文件出现时自动调用 Scan Gateway
# 扫描; 检出威胁自动移入隔离区, 使 Ollama 加载该模型失败。
#
# 设计要点:
#   - 零侵入: 不修改 Ollama 代码, 只旁路监听文件系统
#   - fail-open: 扫描异常不隔离, 只记录日志
#   - 大文件友好: 低于 10MB 跳过, 超时 600 秒适配数 GB 模型
# ---------------------------------------------------------------------------
set -u

WATCH_DIR="${WATCH_DIR:-/root/ai-stack/ollama/models/blobs}"
SCAN_URL="${SCAN_URL:-http://127.0.0.1:8000/scan/file}"
QUARANTINE_DIR="${QUARANTINE_DIR:-/opt/kaspersky/quarantine}"
LOG_FILE="${LOG_FILE:-/var/log/ollama-watcher.log}"
MIN_SIZE="${MIN_SIZE:-10485760}"      # 10MB
MAX_TIME="${MAX_TIME:-600}"            # seconds

mkdir -p "$QUARANTINE_DIR" "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

log "Ollama 模型监控启动, 目录: $WATCH_DIR, 自动隔离: 已启用"

if ! command -v inotifywait >/dev/null 2>&1; then
    log "错误: 未找到 inotifywait, 请先执行 apt install -y inotify-tools"
    exit 1
fi

inotifywait -m -e close_write -e moved_to --format '%w%f' "$WATCH_DIR" 2>>"$LOG_FILE" | while read -r FILE; do
    [ -z "$FILE" ] && continue
    [ -f "$FILE" ] || continue

    SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -lt "$MIN_SIZE" ]; then
        continue
    fi

    BASENAME=$(basename "$FILE")
    log "检测到新模型文件: $BASENAME ($(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE")), 开始扫描..."

    RESULT=$(curl -s --max-time "$MAX_TIME" -X POST "$SCAN_URL" \
        -H "Content-Type: application/json" \
        -d "{\"file_path\":\"$FILE\",\"timeout\":$MAX_TIME}" 2>>"$LOG_FILE")

    if [ -z "$RESULT" ]; then
        log "扫描请求失败 (fail-open, 不隔离): $BASENAME"
        continue
    fi

    VERDICT=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict',''))" 2>/dev/null)
    DETECTION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('detection_name',''))" 2>/dev/null)
    SHA256=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sha256',''))" 2>/dev/null)

    if [ "$VERDICT" = "DETECT" ]; then
        TIMESTAMP=$(date +%s)
        QUARANTINE_NAME="${SHA256}_${TIMESTAMP}_${BASENAME}"
        log "检出威胁! 文件: $BASENAME, 威胁: $DETECTION, SHA256: $SHA256"
        if mv "$FILE" "$QUARANTINE_DIR/$QUARANTINE_NAME" 2>>"$LOG_FILE"; then
            log "已隔离到: $QUARANTINE_DIR/$QUARANTINE_NAME"
            log "Ollama 加载该模型会失败 (文件已移走)"
        else
            log "隔离失败 (fail-open): $BASENAME"
        fi
    else
        log "扫描通过: $BASENAME (verdict=$VERDICT)"
    fi
done