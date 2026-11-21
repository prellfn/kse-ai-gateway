# KAIP / kse-ai-gateway 离线安装包使用说明

适用于客户内网无法访问 Docker Hub、GitHub、PyPI、npm 的环境。整个 PoC 只需把本包拷入内网。

## 包内容

| 目录 / 文件 | 说明 |
|---|---|
| `README.md` | **统一入口**（平台形态 + Lite 网关形态、选型建议、架构图） |
| `README-PLATFORM.md` | KAIP 平台形态完整说明（功能清单、PoC 用例、判定原则、能力边界） |
| `install-offline.sh` | 平台服务端一键离线安装（无需 pip / venv / apt） |
| `server/` `client/` `deploy/` `tests/` | 平台、终端客户端、部署模板、测试脚本 |
| `mcp-server/` | **MCP Server**：让 Codex / Claude Code 等原生 MCP 客户端复用平台策略与审计 |
| `lite/` | **Lite 网关形态**：零依赖轻量网关（仅 Python 标准库，无需 pip / venv / 外网） |
| `docs/` | PoC 实施手册 + 培训材料 |
| `docs/unified/` | 统一文档：分层验证指南、真实环境落地记录、API 参考、架构图 |
| `wheels/py3.10` `py3.11` `py3.12` | Python 依赖（Linux x86_64），按服务器 Python 版本自动选用 |
| `python/` | 便携 Python 3.12（服务器自带 Python 低于 3.10 时自动使用，如 Ubuntu 20.04、CentOS 7） |
| `images/` | 平台 Docker 镜像（`docker load` 后 `docker compose up -d`，见下文） |
| `Dockerfile` `.dockerignore` | 平台镜像构建文件（无镜像包时 `docker compose build`，使用 `wheels/py3.12` 离线安装依赖） |
| `runtime/` | Node.js 运行时（Windows x64 / Linux x64），平台自动分发给无 Node 的终端 |
| `kse/` | KSE 2.2 安装包（许可证另行提供） |
| `SHA256SUMS` | 完整性校验（安装时自动校验） |

## 两种形态

| | 平台形态（本包 `server/` + `client/`） | Lite 网关形态（本包 `lite/`） |
|---|---|---|
| 定位 | 集中管控：策略下发、多终端、审计台账、SIEM、自愈 | 单机轻量：扫描网关 + 上传 + 复核台 |
| 依赖 | FastAPI / httpx（wheels 已内置） | **无**，纯 Python 标准库 |
| 终端接入 | Hook / OpenCode 插件 / watcher / CLI / **MCP** | MCP / 插件 / watcher |
| 部署 | 一键脚本或 docker compose | 一条安装脚本 |

边缘节点可用 Lite 网关就近扫描，并委托中心平台判定（`KSE_BACKEND=kaip`），
**策略与审计台账与中心平台统一**。

---

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

然后在 KSE 控制台 Settings → Service「Locations where remote scanning is allowed」添加 `/mnt/kaip-scanqueue`。安装平台时带 `--kse-share /mnt/kaip-scanqueue`（已安装的改 `/etc/kaip/kaip.env` 中 `KAIP_KSE_SCAN_DIR_REMOTE` 后重启 kaip-platform）。

> **未配置共享时也不会漏扫**：平台已内置自动回退 —— scanfile 被 KSE 拒绝远程路径扫描时，
> 自动改用内存扫描（scanmemory），判定能力等价。

### Lite 网关形态（零依赖）

```bash
cd lite
sudo bash scripts/install_ubuntu.sh          # 只需 python3，无需 pip / venv
sudo vi /opt/ai-stack/scan-gateway/.env     # 填写 KSE_URL / KSE_MODE（或 KAIP_* 委托平台）
sudo systemctl restart scan-gateway upload-gateway quarantine-console
```

**委托中心平台模式**（边缘网关 + 中心平台，统一策略与审计）：

```bash
KSE_BACKEND=kaip
KAIP_URL=http://kaip-center:8080
KAIP_ENROLL_TOKEN=<控制台 → 接入部署 → 注册令牌>
```

## 终端

与在线环境相同：控制台「接入部署」页复制一键安装命令。终端没有 Node.js 18+ 时，安装脚本会自动从平台下载私有运行时到本地缓存目录，不需要终端联网。

- Windows：私有运行时下的 hook 命令使用绝对路径；安装后请**重启 Codex / WorkBuddy / OpenCode**。
- Linux：同上。

### MCP 客户端（Codex / Claude Code / Claude Desktop）

无需安装 Node 客户端，直接把 MCP Server 注册到客户端：

```bash
sudo mkdir -p /opt/kaip/mcp-server && sudo cp mcp-server/server.py /opt/kaip/mcp-server/
```

客户端配置模板见 `mcp-server/README.md`（平台侧 `integrations/codex/config.toml.example` 也有同款示例）。

## 离线环境的已知限制

- **病毒库更新**：需通过 KSE 的本地镜像 / 本地目录方式更新（Updater SDK，参见 KSE 文档与 PoC 用例 C4）。
- **KSN 云信誉 / URL 信誉**：隔离网络中不可用，仅使用本地病毒库。
- **AI Agent 本身**（Codex、OpenCode、WorkBuddy）及其使用的模型不在本包内，由客户环境提供。

## 校验

```bash
sha256sum -c SHA256SUMS
```
