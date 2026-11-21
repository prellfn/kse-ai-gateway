# KAIP 离线安装包使用说明

适用于客户内网无法访问 Docker Hub、GitHub、PyPI、npm 的环境。整个 PoC 只需把本包拷入内网。

## 包内容

| 目录 / 文件 | 说明 |
|---|---|
| `install-offline.sh` | 服务端一键离线安装（无需 pip / venv / apt） |
| `server/` `client/` `deploy/` `tests/` | 平台、终端客户端、部署模板、测试脚本 |
| `wheels/py3.10` `py3.11` `py3.12` | Python 依赖（Linux x86_64），按服务器 Python 版本自动选用 |
| `python/` | 便携 Python 3.12（服务器自带 Python 低于 3.10 时自动使用，如 Ubuntu 20.04、CentOS 7） |
| `images/` | 平台 Docker 镜像（`docker load` 后 `docker compose up -d`，见下文） |
| `Dockerfile` `.dockerignore` | 平台镜像构建文件（无镜像包时 `docker compose build`，使用 `wheels/py3.12` 离线安装依赖） |
| `runtime/` | Node.js 运行时（Windows x64 / Linux x64），平台自动分发给无 Node 的终端 |
| `kse/` | KSE 2.2 安装包（许可证另行提供） |
| `docs/KAIP_PoC实施手册.docx` | PoC 实施手册 |
| `SHA256SUMS` | 完整性校验（安装时自动校验） |

## 服务端

```bash
tar -xzf kaip-offline-*.tar.gz && cd kaip-offline-*/
# 1. 先按《PoC 实施手册》第 4.1 节安装 KSE（kse/ 目录），离线环境使用离线许可证与本地病毒库更新
# 2. 安装 KAIP 平台
sudo bash install-offline.sh            # KSE 装在本机
sudo bash install-offline.sh --kse-url http://<KSE 主机>:1234 --kse-share /mnt/kaip-scanqueue   # KSE 在另一台服务器
sudo bash install-offline.sh --mock     # 未装 KSE，仅演示
```

支持 x86_64 Linux（glibc 2.17+）：Ubuntu 20.04 / 22.04 / 24.04、Debian 11 / 12、CentOS 7+ / RHEL 8+ 等。系统自带 Python 3.10–3.12 时直接使用，否则自动使用包内便携 Python。

### Docker 方式（docker compose）

```bash
docker load -i images/kaip-platform-image-1.0.0.tar.gz
cd deploy && cp compose.env.example .env && vi .env              # KAIP_KSE_URL、端口
sudo install -d -o 10001 -g 10001 -m 0775 /opt/kaspersky/scanqueue
docker compose up -d && docker compose exec kaip cat /var/lib/kaip/initial_admin_password.txt
```

容器化 OpenCode（profile `agent`）与客户已有 OpenCode compose 的接入方法见 `deploy/opencode-container/README.md`。

### KSE 在另一台服务器

KSE 需监听平台可访问的地址（Settings → Service）。≥25MB 的文件走 KSE scanfile（按路径扫描），而 scanfile 只能读取 KSE 本机路径，因此把平台扫描目录 `/opt/kaspersky/scanqueue` 经 NFS 只读共享给 KSE：

```bash
sudo bash deploy/kse-share.sh kaip-host <KSE IP>        # 在 KAIP 平台服务器
sudo bash deploy/kse-share.sh kse-host  <KAIP 平台 IP>   # 在 KSE 服务器（挂载到 /mnt/kaip-scanqueue）
```

然后在 KSE 控制台 Settings → Service「Locations where remote scanning is allowed」添加 `/mnt/kaip-scanqueue`。安装平台时带 `--kse-share /mnt/kaip-scanqueue`（已安装的改 `/etc/kaip/kaip.env` 中 `KAIP_KSE_SCAN_DIR_REMOTE` 后重启 kaip-platform）。未配置共享时，所有文件以 scanmemory 送检。NFS 软件包在离线环境需从内网源准备。安装后控制台为 `http://<服务器>:8080`，初始密码见 `/var/lib/kaip/initial_admin_password.txt`。

## 终端

与在线环境相同：控制台「接入部署」页复制一键安装命令。终端没有 Node.js 18+ 时，安装脚本会自动从平台下载私有运行时到 `~/.kaip/node`，不需要终端联网。

- Windows：私有运行时下的 hook 命令使用绝对路径；安装后请**重启 Codex / WorkBuddy / OpenCode**。
- Linux：同上。

## 离线环境的已知限制

- **病毒库更新**：需通过 KSE 的本地镜像 / 本地目录方式更新（Updater SDK，参见 KSE 文档与 PoC 用例 C4）。
- **KSN 云信誉 / URL 信誉**：隔离网络中不可用，仅使用本地病毒库。
- **AI Agent 本身**（Codex、OpenCode、WorkBuddy）及其使用的模型不在本包内，由客户环境提供。
