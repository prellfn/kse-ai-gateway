#!/bin/bash
# ---------------------------------------------------------------------------
# kse-ai-gateway — 防火墙加固脚本 (Ubuntu, ufw)
#
# 设计原则: **外科式加固** —— 不翻转默认策略 (default allow), 只对高危端口
# 增加"先放行具体来源、再拒绝其他"的规则。这样既能收紧暴露面, 又不会
# 误伤机器上原有的其它业务端口 (ClickHouse / nginx / squid / ICAP ...)。
#
# 用法:
#   # KSE 主机: 限制 KSE API (:1234) 仅平台/网关可达
#   sudo ./harden-firewall.sh --role kse --allow 192.168.1.121
#
#   # 网关主机: 限制隔离区复核台 (:8004, 无鉴权且可恢复/删除文件)
#   sudo ./harden-firewall.sh --role gateway --allow 192.168.1.122,192.168.1.14
#
#   --dry-run  只打印将要执行的规则, 不实际改动
#   --list     打印当前规则
#
# 幂等: 可重复执行。
# ---------------------------------------------------------------------------
set -euo pipefail

ROLE=""
ALLOW=""
DRY_RUN=0
LIST=0

usage() {
    sed -n '2,26p' "$0"
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --role) ROLE="$2"; shift 2 ;;
        --allow) ALLOW="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --list) LIST=1; shift ;;
        -h|--help) usage ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }
[ -n "$ROLE" ] || usage

case "$ROLE" in
    kse)     PROT=1234; DESC="KSE API (无认证, 可触发扫描与病毒库更新)" ;;
    gateway) PROT=8004; DESC="隔离区复核台 (无鉴权, 可恢复/删除隔离文件)" ;;
    console) PROT=8004; DESC="隔离区复核台" ;;
    *) echo "未知 role: $ROLE (支持 kse / gateway)" >&2; exit 2 ;;
esac

if [ "$LIST" = "1" ]; then
    ufw status numbered
    exit 0
fi

if ! command -v ufw >/dev/null 2>&1; then
    echo "安装 ufw..."
    apt-get update -qq && apt-get install -y -qq ufw
fi

echo "=============================================="
echo " 防火墙加固: role=$ROLE  端口=$PROT ($DESC)"
echo " 放行来源: ${ALLOW:-<仅本机>}"
echo "=============================================="

run() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "  [dry-run] $*"
    else
        "$@" >/dev/null
        echo "  + $*"
    fi
}

# 保持默认放行, 只做端口级精准限制 (不影响机器上其它业务端口)
run ufw default allow incoming
run ufw default allow outgoing
run ufw allow 22/tcp comment "SSH"

# 先放行具体来源
run ufw allow from 127.0.0.1 to any port "$PROT" proto tcp comment "$DESC local"
if [ -n "$ALLOW" ]; then
    OLDIFS=$IFS; IFS=,
    for ip in $ALLOW; do
        [ -z "$ip" ] && continue
        run ufw allow from "$ip" to any port "$PROT" proto tcp comment "$DESC from $ip"
    done
    IFS=$OLDIFS
fi
# 容器网段 (平台/网关以 docker 方式部署时需要)
run ufw allow from 172.16.0.0/12 to any port "$PROT" proto tcp comment "$DESC from docker net"
# 最后拒绝其他所有来源 (ufw 按插入顺序先匹配先生效)
run ufw deny "$PROT/tcp" comment "$DESC deny others"

if [ "$DRY_RUN" = "1" ]; then
    echo "dry-run 结束, 未做任何改动"
    exit 0
fi

run ufw --force enable
echo ""
ufw status numbered
echo ""
echo "验证:"
echo "  本机     : curl -s -m 5 http://127.0.0.1:$PROT/healthz"
echo "  允许来源 : 从 $ALLOW 访问应正常"
echo "  其他来源 : 应无响应 (已阻断)"