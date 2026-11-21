#!/usr/bin/env bash
# KSE 与 KAIP 平台不在同一台服务器时，让 ≥25MB 的文件走 KSE scanfile：
#   KAIP 平台的扫描目录 /opt/kaspersky/scanqueue 经 NFS（只读）共享 → 挂载到 KSE 主机 → 加入 KSE「允许扫描的目录」
#
# 1) 在 KAIP 平台服务器上（root）：  bash kse-share.sh kaip-host <KSE 主机 IP>
# 2) 在 KSE 服务器上（root）：        bash kse-share.sh kse-host  <KAIP 平台 IP> [挂载点，默认 /mnt/kaip-scanqueue]
# 3) KSE 控制台 Settings → Service →「Locations where remote scanning is allowed」添加挂载点
# 4) 平台 /etc/kaip/kaip.env：KAIP_KSE_SCAN_DIR_REMOTE=<挂载点>，然后 systemctl restart kaip-platform
#    （新安装可直接 install-offline.sh --kse-url http://<KSE>:1234 --kse-share <挂载点>）
#
# 离线环境：NFS 软件包（Ubuntu/Debian：nfs-kernel-server、nfs-common；RHEL/CentOS：nfs-utils）需提前从内网源或安装介质准备。
set -euo pipefail
SCAN_DIR=/opt/kaspersky/scanqueue
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

pkg() {   # pkg <deb 包名> <rpm 包名>
  if command -v apt-get >/dev/null; then dpkg -s "$1" >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y "$1"
  elif command -v dnf >/dev/null; then rpm -q "$2" >/dev/null 2>&1 || dnf install -y "$2"
  elif command -v yum >/dev/null; then rpm -q "$2" >/dev/null 2>&1 || yum install -y "$2"
  else echo "无法自动安装 NFS 软件包，请手动安装 $1 / $2"; exit 1; fi
}

case "${1:-}" in
kaip-host)
  KSE="${2:?用法：kse-share.sh kaip-host <KSE 主机 IP>}"
  pkg nfs-kernel-server nfs-utils
  mkdir -p "$SCAN_DIR"
  # 只读 + root_squash：KSE 只能读取待扫描文件；平台写入的文件权限为 644，目录需对其他用户可读可进入
  chmod o+rx "$SCAN_DIR"
  LINE="$SCAN_DIR $KSE(ro,sync,no_subtree_check,root_squash)"
  grep -qF "$LINE" /etc/exports 2>/dev/null || echo "$LINE" >> /etc/exports
  systemctl enable --now nfs-server >/dev/null 2>&1 || systemctl enable --now nfs-kernel-server
  exportfs -ra
  echo "✔ 已共享 $SCAN_DIR 给 $KSE（只读）："; exportfs -v | grep -F "$SCAN_DIR" || true
  command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active" && { ufw allow from "$KSE" to any port nfs; echo "✔ 防火墙已放行 $KSE 访问 NFS"; }
  command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1 && { firewall-cmd --permanent --add-service=nfs --add-service=mountd --add-service=rpc-bind >/dev/null; firewall-cmd --reload >/dev/null; echo "✔ firewalld 已放行 NFS"; }
  echo "下一步：在 KSE 服务器执行  bash kse-share.sh kse-host $(hostname -I | awk '{print $1}')"
  ;;
kse-host)
  KAIP="${2:?用法：kse-share.sh kse-host <KAIP 平台 IP> [挂载点]}"; MNT="${3:-/mnt/kaip-scanqueue}"
  pkg nfs-common nfs-utils
  mkdir -p "$MNT"
  # lookupcache=positive：平台刚写入的文件立即可见；nofail：平台不在线时不影响开机
  # soft,timeo=50,retrans=2：平台不在线时读挂载点约 15 秒后报错返回。不能用 hard：平台宕机时 kavhttpd 会卡死在
  # 挂载点上、不再监听 1234，所有扫描（含与大文件无关的）都失败。只读挂载，soft 不会损坏数据
  OPTS="ro,soft,timeo=50,retrans=2,lookupcache=positive,_netdev,nofail"
  LINE="$KAIP:$SCAN_DIR $MNT nfs $OPTS 0 0"
  if grep -qF "$KAIP:$SCAN_DIR $MNT " /etc/fstab; then
    # 旧版本写入的 hard 挂载：改为 soft，重新挂载后生效
    grep -F "$KAIP:$SCAN_DIR $MNT " /etc/fstab | grep -q "[ ,]hard[, ]" && {
      sed -i "\\#^$KAIP:$SCAN_DIR $MNT #s#.*#$LINE#" /etc/fstab
      mountpoint -q "$MNT" && { umount -f -l "$MNT"; echo "✔ 已把挂载参数从 hard 改为 soft"; }
    }
  else
    echo "$LINE" >> /etc/fstab
  fi
  mountpoint -q "$MNT" || mount "$MNT"
  mountpoint -q "$MNT" && echo "✔ 已挂载 $KAIP:$SCAN_DIR → $MNT（只读，开机自动挂载）"
  echo
  echo "下一步："
  echo "  1. KSE 控制台 Settings → Service →「Locations where remote scanning is allowed」添加 $MNT"
  echo "  2. KAIP 平台 /etc/kaip/kaip.env 设置 KAIP_KSE_SCAN_DIR_REMOTE=$MNT 并 systemctl restart kaip-platform"
  ;;
*)
  sed -n '2,12p' "$0"; exit 1;;
esac
