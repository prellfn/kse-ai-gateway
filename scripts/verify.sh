#!/bin/bash
# ---------------------------------------------------------------------------
# kse-ai-gateway — 分层验证脚本 (Linux)
#
# 用法:
#   sudo ./scripts/verify.sh                    # 跑全部可测层
#   sudo ./scripts/verify.sh --layer gateway    # 只跑某一层
#   sudo ./scripts/verify.sh --keep             # 保留测试文件（默认自动清理）
#
# 可选环境变量:
#   KSE_URL           KSE API 地址        (默认 https://127.0.0.1:8443)
#   KSE_TOKEN         KSE 明文 Token      (不设则跳过 L0 直连测试)
#   SCAN_GATEWAY      Scan Gateway 地址   (默认 http://127.0.0.1:8000)
#   UPLOAD_GATEWAY    Upload Gateway      (默认 http://127.0.0.1:8002)
#   CONSOLE_URL       复核台              (默认 http://127.0.0.1:8004)
#   MCP_PYTHON        MCP Server 解释器   (默认 /opt/ai-stack/mcp-venv/bin/python)
#   MCP_SERVER        MCP Server 脚本     (默认 /opt/ai-stack/mcp-server/server.py)
# ---------------------------------------------------------------------------
set -uo pipefail

KSE_URL_EXPLICIT="${KSE_URL:-}"          # 用户是否显式指定 (在套默认值前记录)
KSE_TOKEN_EXPLICIT="${KSE_TOKEN:-}"
KSE_URL="${KSE_URL:-https://127.0.0.1:8443}"
SCAN_GATEWAY="${SCAN_GATEWAY:-http://127.0.0.1:8000}"
UPLOAD_GATEWAY="${UPLOAD_GATEWAY:-http://127.0.0.1:8002}"
CONSOLE_URL="${CONSOLE_URL:-http://127.0.0.1:8004}"
MCP_PYTHON="${MCP_PYTHON:-/usr/bin/python3}"
MCP_SERVER="${MCP_SERVER:-/opt/ai-stack/mcp-server/server.py}"

# 自动读取已部署的配置 (KSE_URL / KSE_TOKEN), 避免与实际环境不一致
DEPLOY_ENV="/opt/ai-stack/scan-gateway/.env"
if [ -f "$DEPLOY_ENV" ]; then
    # 用户未显式指定时, 优先使用部署配置
    if [ -z "$KSE_URL_EXPLICIT" ]; then
        _u=$(grep -E "^KSE_URL=" "$DEPLOY_ENV" | tail -1 | cut -d= -f2-)
        [ -n "$_u" ] && KSE_URL="$_u"
    fi
    if [ -z "$KSE_TOKEN_EXPLICIT" ]; then
        _t=$(grep -E "^KSE_TOKEN=" "$DEPLOY_ENV" | tail -1 | cut -d= -f2-)
        [ -n "$_t" ] && KSE_TOKEN="$_t"
    fi
    echo "已加载部署配置: $DEPLOY_ENV"
    echo "  KSE_URL=$KSE_URL  KSE_TOKEN=${KSE_TOKEN:+<已配置>}${KSE_TOKEN:-<未配置>}"
fi

WORKDIR="$(mktemp -d /tmp/kse-verify-XXXXXX)"
KEEP=0
LAYER="all"

while [ $# -gt 0 ]; do
    case "$1" in
        --layer) LAYER="$2"; shift 2 ;;
        --keep)  KEEP=1; shift ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done

PASS=0; FAIL=0; SKIP=0; WARN=0
RESULTS=()

cleanup() {
    if [ "$KEEP" -eq 1 ]; then
        echo "测试文件保留在: $WORKDIR"
    else
        rm -rf "$WORKDIR"
    fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 输出helpers
# ---------------------------------------------------------------------------
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; RESET=$'\033[0m'
if [ ! -t 1 ]; then GREEN=""; RED=""; YELLOW=""; BLUE=""; RESET=""; fi

ok()   { PASS=$((PASS+1)); RESULTS+=("PASS|$1|$2"); printf "  ${GREEN}✓ PASS${RESET}  %-46s %s\n" "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL|$1|$2"); printf "  ${RED}✗ FAIL${RESET}  %-46s %s\n" "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); RESULTS+=("SKIP|$1|$2"); printf "  ${YELLOW}○ SKIP${RESET}  %-46s %s\n" "$1" "$2"; }
warn() { WARN=$((WARN+1)); RESULTS+=("WARN|$1|$2"); printf "  ${YELLOW}! WARN${RESET}  %-46s %s\n" "$1" "$2"; }
head_() { printf "\n${BLUE}── %s ─────────────────────────────────────────${RESET}\n" "$1"; }

# 从 JSON 中取字段
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))" 2>/dev/null; }

want_layer() { [ "$LAYER" = "all" ] || [ "$LAYER" = "$1" ]; }

# 生成 EICAR 文件 (EICAR 字符串必须在文件开头才能被标准检出)
make_eicar() {
    printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$1"
}
make_clean() {
    printf 'harmless content %s\n' "$(date +%s%N)" > "$1"
}

echo "=============================================="
echo " kse-ai-gateway 分层验证"
echo " 工作目录: $WORKDIR"
echo "=============================================="

# ===========================================================================
# L0 — KSE 引擎直连
# ===========================================================================
if want_layer l0; then
head_ "L0  KSE 引擎直连 (绕过网关)"
make_eicar "$WORKDIR/eicar.txt"
if [ -n "${KSE_TOKEN:-}" ]; then
    RESP=$(curl -sk --max-time 60 -X POST "$KSE_URL/api/v3.0/scanfile" \
        -H "Content-Type: application/octet-stream" \
        -H "Authorization: Bearer $KSE_TOKEN" \
        -d "{\"timeout\":\"60000\",\"object\":\"$WORKDIR/eicar.txt\"}")
    V=$(printf '%s' "$RESP" | jget scanResult)
    if [ "$V" = "DETECT" ]; then
        ok "KSE 直扫 EICAR (带 Token)" "scanResult=DETECT"
    else
        bad "KSE 直扫 EICAR (带 Token)" "期望 DETECT, 实际 '${V:-空}'  -> 检查 Token 与扫描目录白名单"
    fi

    # 不带 Token 应被拒绝
    CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 30 -X POST "$KSE_URL/api/v3.0/scanfile" \
        -H "Content-Type: application/octet-stream" \
        -d "{\"timeout\":\"60000\",\"object\":\"$WORKDIR/eicar.txt\"}")
    if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
        ok "KSE 无 Token 拒绝访问" "HTTP $CODE"
    else
        warn "KSE 无 Token 拒绝访问" "HTTP $CODE (期望 401/403)"
    fi
else
    # KSE 未开启 Token 认证。
    # 注意: 路径扫描 (scanfile) 只允许在 KSE 本机调用, 跨机会被拒绝,
    # 因此网关与 KSE 分离部署时, L0 改用内存扫描 (scanmemory) 直测引擎。
    B64=$(base64 -w0 "$WORKDIR/eicar.txt" 2>/dev/null || base64 "$WORKDIR/eicar.txt" | tr -d '\n')
    RESP=$(curl -sk --max-time 60 -X POST "$KSE_URL/api/v3.0/scanmemory" \
        -H "Content-Type: application/octet-stream" \
        -d "{\"timeout\":\"60000\",\"object\":\"$B64\"}")
    V=$(printf '%s' "$RESP" | jget scanResult)
    if [ "$V" = "DETECT" ]; then
        ok "KSE 直扫 EICAR (无 Token 认证)" "scanResult=DETECT (scanmemory 跨机)"
    elif printf '%s' "$RESP" | grep -qi "token\|authoriz"; then
        skip "KSE 直扫 EICAR" "KSE 开启了 Token 认证, 需提供 KSE_TOKEN"
    else
        bad "KSE 直扫 EICAR (无 Token 认证)" "期望 DETECT, 实际 '${V:-空}' -> ${RESP:0:150}"
    fi
fi
fi

# ===========================================================================
# L1 — Scan Gateway
# ===========================================================================
if want_layer l1; then
head_ "L1  Scan Gateway (:8000)"

RESP=$(curl -s --max-time 10 "$SCAN_GATEWAY/health")
if printf '%s' "$RESP" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ok "健康检查 /health" "status=ok"
else
    bad "健康检查 /health" "无响应 -> systemctl status scan-gateway"
    echo "    响应: ${RESP:0:200}"
fi

# 干净文件 -> CLEAN
make_clean "$WORKDIR/clean.txt"
cp "$WORKDIR/clean.txt" /opt/kaspersky/scanqueue/verify_clean.txt 2>/dev/null || true
QFILE="/opt/kaspersky/scanqueue/verify_clean.txt"
[ -f "$QFILE" ] || { QFILE="$WORKDIR/clean.txt"; }

RESP=$(curl -s --max-time 120 -X POST "$SCAN_GATEWAY/scan/file" \
    -H "Content-Type: application/json" \
    -d "{\"file_path\":\"$QFILE\",\"timeout\":60}")
V=$(printf '%s' "$RESP" | jget verdict)
if [ "$V" = "CLEAN" ]; then
    ok "scan/file 干净文件放行" "verdict=CLEAN"
else
    bad "scan/file 干净文件放行" "期望 CLEAN, 实际 '${V:-空}' -> 响应: ${RESP:0:200}"
fi

# EICAR -> DETECT + 隔离
make_eicar "$WORKDIR/eicar.txt"
cp "$WORKDIR/eicar.txt" /opt/kaspersky/scanqueue/verify_eicar.txt 2>/dev/null || true
QFILE="/opt/kaspersky/scanqueue/verify_eicar.txt"
[ -f "$QFILE" ] || { QFILE="$WORKDIR/eicar.txt"; }

RESP=$(curl -s --max-time 120 -X POST "$SCAN_GATEWAY/scan/file" \
    -H "Content-Type: application/json" \
    -d "{\"file_path\":\"$QFILE\",\"timeout\":60}")
V=$(printf '%s' "$RESP" | jget verdict)
DET=$(printf '%s' "$RESP" | jget detection_name)
if [ "$V" = "DETECT" ]; then
    ok "scan/file EICAR 检出" "verdict=DETECT, detection=$DET"
else
    bad "scan/file EICAR 检出" "期望 DETECT, 实际 '${V:-空}' -> ${RESP:0:200}"
fi
QN=$(printf '%s' "$RESP" | jget quarantined)
if [ "$QN" = "True" ] || [ "$QN" = "true" ]; then
    ok "威胁文件自动隔离" "quarantined=true"
else
    bad "威胁文件自动隔离" "quarantined=$QN"
fi

# scan/upload
make_clean "$WORKDIR/upload.txt"
RESP=$(curl -s --max-time 120 -X POST "$SCAN_GATEWAY/scan/upload" -F "file=@$WORKDIR/upload.txt")
V=$(printf '%s' "$RESP" | jget verdict)
if [ "$V" = "CLEAN" ]; then
    ok "scan/upload 内容扫描" "verdict=CLEAN"
else
    bad "scan/upload 内容扫描" "期望 CLEAN, 实际 '${V:-空}' -> ${RESP:0:200}"
fi

# scan/package: 干净包
mkdir -p "$WORKDIR/pkgclean/sub" && make_clean "$WORKDIR/pkgclean/sub/a.txt" && make_clean "$WORKDIR/pkgclean/b.txt"
(cd "$WORKDIR/pkgclean" && zip -qr "$WORKDIR/clean.zip" . 2>/dev/null) || tar -czf "$WORKDIR/clean.tar.gz" -C "$WORKDIR/pkgclean" .
PKG="$WORKDIR/clean.zip"; [ -f "$PKG" ] || PKG="$WORKDIR/clean.tar.gz"
RESP=$(curl -s --max-time 180 -X POST "$SCAN_GATEWAY/scan/package" -F "file=@$PKG")
V=$(printf '%s' "$RESP" | jget verdict)
if [ "$V" = "CLEAN" ]; then
    ok "scan/package 干净包" "verdict=CLEAN"
else
    bad "scan/package 干净包" "期望 CLEAN, 实际 '${V:-空}' -> ${RESP:0:200}"
fi

# scan/package: 内藏 EICAR 的包 (关键测试 —— 整包扫描易被免杀)
mkdir -p "$WORKDIR/pkgbad/sub" && make_eicar "$WORKDIR/pkgbad/sub/payload.sh" && make_clean "$WORKDIR/pkgbad/readme.txt"
(cd "$WORKDIR/pkgbad" && zip -qr "$WORKDIR/bad.zip" . 2>/dev/null) || tar -czf "$WORKDIR/bad.tar.gz" -C "$WORKDIR/pkgbad" .
PKG="$WORKDIR/bad.zip"; [ -f "$PKG" ] || PKG="$WORKDIR/bad.tar.gz"
RESP=$(curl -s --max-time 180 -X POST "$SCAN_GATEWAY/scan/package" -F "file=@$PKG")
V=$(printf '%s' "$RESP" | jget verdict)
TC=$(printf '%s' "$RESP" | jget threats_count)
if [ "$V" = "DETECT" ]; then
    ok "scan/package 内藏 EICAR 检出" "verdict=DETECT, threats=$TC"
else
    bad "scan/package 内藏 EICAR 检出" "期望 DETECT, 实际 '${V:-空}' -> ${RESP:0:200}"
fi

# scan/url
RESP=$(curl -s --max-time 90 -X POST "$SCAN_GATEWAY/scan/url" \
    -H "Content-Type: application/json" -d '{"url":"https://www.kaspersky.com/","timeout":60}')
V=$(printf '%s' "$RESP" | jget verdict)
if [ "$V" = "CLEAN" ] || [ "$V" = "DETECT" ]; then
    ok "scan/url URL 扫描" "verdict=$V"
else
    warn "scan/url URL 扫描" "verdict='${V:-空}' -> 需在 KSE Web UI 放行 URL 扫描位置"
fi
fi

# ===========================================================================
# L2 — Upload Gateway
# ===========================================================================
if want_layer l2; then
head_ "L2  Upload Gateway (:8002)"

RESP=$(curl -s --max-time 10 "$UPLOAD_GATEWAY/health")
if printf '%s' "$RESP" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ok "健康检查 /health" "status=ok"
else
    bad "健康检查 /health" "无响应 -> systemctl status upload-gateway"
fi

make_clean "$WORKDIR/kb-clean.txt"
CODE=$(curl -s -o "$WORKDIR/up.json" -w "%{http_code}" --max-time 300 -X POST "$UPLOAD_GATEWAY/upload" \
    -F "file=@$WORKDIR/kb-clean.txt" -F "add_to_workspace=false")
if [ "$CODE" = "200" ]; then
    ok "上传干净文件" "HTTP 200"
else
    warn "上传干净文件" "HTTP $CODE -> ${RESP:0:150} (AnythingLLM 未配置时会失败, 属预期)"
fi

make_eicar "$WORKDIR/kb-eicar.txt"
CODE=$(curl -s -o "$WORKDIR/up2.json" -w "%{http_code}" --max-time 300 -X POST "$UPLOAD_GATEWAY/upload" \
    -F "file=@$WORKDIR/kb-eicar.txt" -F "add_to_workspace=false")
if [ "$CODE" = "403" ]; then
    ok "上传 EICAR 被拒绝" "HTTP 403 (Fail-Closed)"
else
    bad "上传 EICAR 被拒绝" "期望 403, 实际 HTTP $CODE -> $(cat "$WORKDIR/up2.json" 2>/dev/null | head -c 200)"
fi
fi

# ===========================================================================
# L3 — 隔离区复核台
# ===========================================================================
if want_layer l3; then
head_ "L3  隔离区复核台 (:8004)"

RESP=$(curl -s --max-time 10 "$CONSOLE_URL/health")
if printf '%s' "$RESP" | grep -qE '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ok "健康检查 /health" "status=ok"
else
    bad "健康检查 /health" "无响应 -> systemctl status quarantine-console"
fi

RESP=$(curl -s --max-time 15 "$CONSOLE_URL/api/quarantine")
TOT=$(printf '%s' "$RESP" | jget total)
if [ -n "$TOT" ]; then
    ok "隔离文件列表 API" "共 $TOT 项"
else
    bad "隔离文件列表 API" "无有效响应"
fi

RESP=$(curl -s --max-time 15 "$CONSOLE_URL/api/stats")
if printf '%s' "$RESP" | grep -qE '"by_threat"'; then
    ok "威胁统计 API" "by_threat 字段存在"
else
    bad "威胁统计 API" "无有效响应"
fi

# 复扫最近一个隔离文件（需要隔离区在 ALLOWED_SCAN_DIRS 内）
FIRST=$(curl -s --max-time 15 "$CONSOLE_URL/api/quarantine" | python3 -c "
import sys,json
d=json.load(sys.stdin)
items=d.get('items',[])
print(items[0]['quarantine_id'] if items else '')
" 2>/dev/null)
if [ -n "$FIRST" ]; then
    RESP=$(curl -s --max-time 300 -X POST "$CONSOLE_URL/api/quarantine/$FIRST/rescan")
    V=$(printf '%s' "$RESP" | jget verdict)
    if [ "$V" = "DETECT" ] || [ "$V" = "CLEAN" ]; then
        ok "复扫隔离文件" "verdict=$V"
    else
        warn "复扫隔离文件" "verdict='${V:-空}' -> 需把隔离区加入 ALLOWED_SCAN_DIRS"
    fi
else
    skip "复扫隔离文件" "隔离区为空"
fi
fi

# ===========================================================================
# L4 — MCP Server
# ===========================================================================
if want_layer l4; then
head_ "L4  MCP Server (stdio)"

if [ ! -x "$MCP_PYTHON" ] || [ ! -f "$MCP_SERVER" ]; then
    skip "MCP Server 初始化" "未找到 $MCP_PYTHON / $MCP_SERVER"
else
    INIT=$(printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
      | timeout 30 "$MCP_PYTHON" "$MCP_SERVER" 2>/dev/null)
    if printf '%s' "$INIT" | grep -q 'scan_file'; then
        ok "MCP initialize + tools/list" "返回工具含 scan_file"
    else
        bad "MCP initialize + tools/list" "无有效响应 -> ${INIT:0:200}"
    fi

    for TOOL in scan_text scan_url scan_skill_pkg kse_status; do
        if printf '%s' "$INIT" | grep -q "\"$TOOL\""; then
            ok "MCP 工具 $TOOL" "已注册"
        else
            bad "MCP 工具 $TOOL" "未在 tools/list 中"
        fi
    done
fi
fi

# ===========================================================================
# L5 — systemd 服务与监控
# ===========================================================================
if want_layer l5; then
head_ "L5  systemd 服务与监控"

for SVC in scan-gateway upload-gateway quarantine-console; do
    STATE=$(systemctl is-active "$SVC" 2>/dev/null)
    if [ "$STATE" = "active" ]; then
        ok "服务 $SVC" "active"
    else
        bad "服务 $SVC" "状态=$STATE"
    fi
done

# KSE 可能与网关同机 (systemd), 也可能部署在另一台机器 (远程 HTTP)
if systemctl list-unit-files 2>/dev/null | grep -q kavhttpd; then
    STATE=$(systemctl is-active kavhttpd 2>/dev/null)
    if [ "$STATE" = "active" ]; then
        ok "服务 kavhttpd (本机)" "active"
    else
        bad "服务 kavhttpd (本机)" "状态=$STATE"
    fi
else
    if curl -s -m 10 -o /dev/null "$KSE_URL/api/v3.0/checkurl" -X POST \
         -H "Content-Type: application/octet-stream" -d '{"url":"http://www.kaspersky.com/"}'; then
        ok "KSE 远程可达" "$KSE_URL (部署在独立主机)"
    else
        bad "KSE 远程可达" "无法连接 $KSE_URL"
    fi
fi

if systemctl is-active --quiet ollama-watcher 2>/dev/null; then
    ok "服务 ollama-watcher" "active"
else
    skip "服务 ollama-watcher" "未启用 (仅在使用 Ollama 时需要)"
fi

# 审计日志
LOG=/opt/ai-stack/scan-gateway/logs/audit.jsonl
if [ -f "$LOG" ]; then
    CNT=$(wc -l < "$LOG")
    if [ "$CNT" -gt 0 ]; then
        ok "审计日志有记录" "$CNT 条 -> $LOG"
    else
        warn "审计日志有记录" "日志为空"
    fi
else
    bad "审计日志有记录" "找不到 $LOG"
fi
fi

# ===========================================================================
# 汇总
# ===========================================================================
echo ""
echo "=============================================="
printf " 汇总:  ${GREEN}PASS %d${RESET}  ${RED}FAIL %d${RESET}  ${YELLOW}WARN %d${RESET}  SKIP %d\n" "$PASS" "$FAIL" "$WARN" "$SKIP"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "失败项:"
    for R in "${RESULTS[@]}"; do
        case "$R" in FAIL\|*) echo "  - ${R#FAIL|}" | sed 's/|/ :: /' ;; esac
    done
    echo ""
    echo "排障参考: docs/operations.md 第四章"
fi

exit $([ "$FAIL" -gt 0 ] && echo 1 || echo 0)