#!/bin/sh
# 宿主机定时任务：确保已加装 KAIP 的容器内后台监控（kaip watch）在运行。
# 背景：给已有容器加装 KAIP 时监控以 docker exec -d 启动，docker restart / docker start 后不会自动恢复；
#       没有监控就没有心跳，控制台会显示「离线」，防篡改自愈与 Agent 状态探测也会停止（Hook 拦截不受影响）。
# 安装（宿主机 root）：
#   install -m 755 kaip-container-watch.sh /usr/local/bin/kaip-container-watch.sh
#   echo '* * * * * root /usr/local/bin/kaip-container-watch.sh' > /etc/cron.d/kaip-container-watch
# 只处理正在运行、且容器内存在 /root/.kaip/client 的容器；使用 KAIP 镜像（entrypoint 自带监控）的容器同样适用。
command -v docker >/dev/null 2>&1 || exit 0
for C in $(docker ps -q); do
  docker exec "$C" sh -c '
    K=/root/.kaip
    [ -f "$K/client/bin/kaip.js" ] || exit 0
    pid=$(cut -d@ -f1 "$K/watch.pid" 2>/dev/null)
    if [ -n "$pid" ] && tr "\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -q "kaip.js watch"; then exit 0; fi
    N=node; [ -x "$K/node/bin/node" ] && N="$K/node/bin/node"
    nohup "$N" "$K/client/bin/kaip.js" watch >/dev/null 2>&1 &
    echo started
  ' 2>/dev/null | grep -q started && logger -t kaip-container-watch "已在容器 $C 内启动 kaip watch"
done
exit 0
