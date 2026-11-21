#!/bin/sh
# KAIP 容器入口：注册到 KAIP 平台（首次）→ 安装 / 更新 OpenCode 插件 → 后台目录监控 → 执行原命令
# 用于 kaip-opencode 镜像，也可在客户自己的 OpenCode compose 中作为 entrypoint（无需重建镜像）：
#   entrypoint: ["/opt/kaip-client/scripts/container-entrypoint.sh"]
#   command:    ["opencode"]            # 原镜像的 ENTRYPOINT + CMD（docker image inspect 查看）
# 环境变量：
#   KAIP_SERVER        平台地址（必填，否则以无防护状态运行并告警）
#   KAIP_ENROLL_TOKEN  注册令牌（仅首次；注册结果保存在 KAIP_HOME，需挂载数据卷）。推荐用 compose secrets 挂载为
#                      /run/secrets/kaip_enroll_token（或 KAIP_ENROLL_TOKEN_FILE 指定），令牌不出现在 docker inspect 中
#   KAIP_HOME          默认 $HOME/.kaip
#   KAIP_NODE          node 路径（镜像没有 Node.js 18+ 时挂载平台私有运行时，如 /opt/kaip-node/bin/node）
#   KAIP_WATCH         1（默认）启动后台目录监控
#   KAIP_AGENTS        默认 opencode
DIR="$(cd "$(dirname "$0")/.." && pwd)"
KAIP="$DIR/bin/kaip.js"
export KAIP_HOME="${KAIP_HOME:-$HOME/.kaip}"
CFG="$KAIP_HOME/config.json"
# 注册令牌优先从文件读取（compose secrets 挂载，令牌不进入容器环境变量 / docker inspect）
TF="${KAIP_ENROLL_TOKEN_FILE:-/run/secrets/kaip_enroll_token}"
[ -z "${KAIP_ENROLL_TOKEN:-}" ] && [ -s "$TF" ] && KAIP_ENROLL_TOKEN="$(tr -d '\r\n' < "$TF")"
NODE="${KAIP_NODE:-}"
[ -z "$NODE" ] && for n in node /opt/kaip-node/bin/node "$KAIP_HOME/node/bin/node"; do command -v "$n" >/dev/null 2>&1 && { NODE="$n"; break; }; done

if [ -z "$KAIP_SERVER" ]; then
  echo "[KAIP] 未设置 KAIP_SERVER，将在无防护状态下运行" >&2
elif [ -z "$NODE" ]; then
  echo "[KAIP] 容器内没有 Node.js（可挂载平台私有运行时并设置 KAIP_NODE），将在无防护状态下运行" >&2
else
  mkdir -p "$KAIP_HOME"
  if ! grep -q '"agent_id"' "$CFG" 2>/dev/null || ! grep -q "\"server\": \"${KAIP_SERVER%/}\"" "$CFG" 2>/dev/null; then
    if [ -z "$KAIP_ENROLL_TOKEN" ]; then
      echo "[KAIP] 未注册且缺少 KAIP_ENROLL_TOKEN，将在无防护状态下运行" >&2
    else
      "$NODE" "$KAIP" enroll --server "$KAIP_SERVER" --token "$KAIP_ENROLL_TOKEN" ${KAIP_INSECURE:+--insecure} >&2
    fi
  fi
  if grep -q '"agent_id"' "$CFG" 2>/dev/null; then
    # 每次启动都重装插件（OpenCode 升级后按 1.x / 2.x 重新选择）。已安装过时用 KAIP_HOME 中的客户端：
    # 它会随平台自动升级，不能被镜像 / 挂载中的旧版本覆盖；首次才从本脚本所在的客户端安装
    INST="$KAIP_HOME/client/bin/kaip.js"; [ -f "$INST" ] || INST="$KAIP"
    "$NODE" "$INST" install --agents "${KAIP_AGENTS:-opencode}" --no-watch >&2 || echo "[KAIP] 插件安装失败" >&2
    if [ "${KAIP_WATCH:-1}" = "1" ]; then
      nohup "$NODE" "$KAIP_HOME/client/bin/kaip.js" watch >/dev/null 2>&1 &
    fi
  fi
fi
unset KAIP_ENROLL_TOKEN
exec "$@"
