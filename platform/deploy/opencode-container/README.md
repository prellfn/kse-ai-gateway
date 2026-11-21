# 容器化 OpenCode + Kaspersky AI Protect

镜像 = `node:22-slim` + `opencode-ai@<版本>`（npm）+ KAIP 终端客户端。容器启动时自动：注册到 KAIP 平台（首次）→ 按 OpenCode 版本安装 1.x / 2.x 插件 → 后台目录监控 → 启动 OpenCode。

## 构建

构建上下文为离线包 / 源码根目录（与平台使用同一份客户端）。推荐经平台的 compose 构建与运行（`deploy/docker-compose.yml`，profile `agent`）：

```bash
cd deploy && docker compose --profile agent build opencode
# 或：docker build -f deploy/opencode-container/Dockerfile -t kaip-opencode:1.15.13 --build-arg OPENCODE_VERSION=1.15.13 .
```

在无法访问 Docker Hub 的网络中，先经国内镜像拉取基础镜像并改名：
```bash
docker pull docker.m.daocloud.io/library/node:22-slim && docker tag docker.m.daocloud.io/library/node:22-slim node:22-slim
```
（官方镜像 `ghcr.io/anomalyco/opencode` 的层文件托管在 GitHub CDN，部分网络下载不稳定，因此改为 npm 安装。）

## 运行

```bash
# 首次：配置模型（交互式，密钥只保存在 opencode-data 卷中）
docker run -it --rm -v opencode-data:/root/.local/share/opencode kaip-opencode:1.15.13 opencode auth login

# 使用
docker run -it --rm \
  -e KAIP_SERVER=http://<KAIP 平台>:8080 \
  -e KAIP_ENROLL_TOKEN=<控制台「接入部署」中的注册令牌，仅首次需要> \
  -v kaip-state:/root/.kaip \
  -v opencode-data:/root/.local/share/opencode \
  -v "$PWD":/workspace \
  kaip-opencode:1.15.13
```

| 环境变量 | 说明 |
|---|---|
| `KAIP_SERVER` | KAIP 平台地址；不设置则以无防护状态运行并告警 |
| `KAIP_ENROLL_TOKEN` | 首次注册令牌；注册结果保存在 `kaip-state` 卷 |
| `KAIP_WATCH` | `1`（默认）启动目录监控，`0` 关闭 |

建议加 `--hostname <固定名称>`（如 `--hostname oc-zhangsan`）：容器默认主机名每次都不同，平台事件里的终端名会变成随机容器 ID。

## 升级 OpenCode

```bash
docker build -t kaip-opencode:<新版本> --build-arg OPENCODE_VERSION=<新版本> ctx
docker run --rm -e KAIP_SERVER=... -v kaip-state:/root/.kaip -v opencode-data:/root/.local/share/opencode kaip-opencode:<新版本>   node /opt/kaip-client/bin/kaip.js verify      # 必须看到「OpenCode ✔ 生效」
```
容器每次启动都会按 OpenCode 版本重装对应的 1.x / 2.x 插件；后台目录监控进程会定期探测并随心跳上报，插件未生效时平台自动产生 `KAIP:Protection.Inactive` 告警（同步转发 SIEM）。已实测 1.15.13 → 1.19.5 升级后防护持续生效。

注意：
- OpenCode 内置免费模型要求 1.18.0+，1.15.13 需要自行配置模型提供商。
- OpenCode 1.15.13 在存在任意插件时会在线刷新模型目录，可用模型可能与无插件时不同（实测 `minimax-cn` 由 M2.x 变为 M3 / M3.1-Flash）。请在**带 KAIP 插件启动**的容器里执行 `opencode models` 选择模型：
  `docker run --rm -e KAIP_SERVER=... -v kaip-state:/root/.kaip -v opencode-data:/root/.local/share/opencode kaip-opencode:1.15.13 opencode models`

## 客户已有的 OpenCode compose 接入 KAIP（推荐，不换镜像、不重建镜像）

把 [docker-compose.kaip.yml](docker-compose.kaip.yml) 中的配置加入客户的 compose（或 `-f` 合并）：入口换成 KAIP 的 `container-entrypoint.sh`，它在容器每次启动时完成注册（首次）、插件安装、后台监控，再执行原来的 OpenCode 命令。

```bash
sudo mkdir -p /opt/kaip-client && curl -fsSL http://<平台>:8080/dl/kaip-client.tar.gz | sudo tar -xz -C /opt/kaip-client
echo <注册令牌> > kaip_enroll_token.txt && chmod 600 kaip_enroll_token.txt     # compose secrets，不进入容器环境变量
docker compose -f docker-compose.yml -f docker-compose.kaip.yml up -d
: > kaip_enroll_token.txt                                                       # 注册成功后清空（文件保留）
docker compose exec opencode node /root/.kaip/client/bin/kaip.js verify          # 必须看到「OpenCode ✔ 生效」
```

已用未装 KAIP 的 `node:22-slim` + `opencode-ai@1.15.13` 客户镜像实测：自动注册、插件生效、恶意脚本与 EICAR 写入被阻断；`docker restart` 与 `down/up` 重建后监控自动恢复，无需重新注册。

## 给已经在运行、未用 compose 管理的 OpenCode 容器加装 KAIP（docker exec）

适用于客户已有的 OpenCode 容器（非本镜像）。以下命令都在**宿主机**执行，容器内不需要 curl，也不需要访问平台以外的网络。已用不含 curl 的 `node:22-slim` + `opencode-ai@1.15.13` 容器实测通过。

```bash
S=http://<平台>:8080        # KAIP 平台地址
C=<容器名>                  # docker ps 查看

# 1. 宿主机下载客户端，拷进容器
curl -fsSL $S/dl/kaip-client.tar.gz -o /tmp/kaip-client.tar.gz
docker exec $C mkdir -p /root/.kaip/client
docker cp /tmp/kaip-client.tar.gz $C:/tmp/
docker exec $C tar -xzf /tmp/kaip-client.tar.gz -C /root/.kaip/client

# 2. 注册（令牌从文件经标准输入传入，不出现在命令行和 docker inspect 中）
docker exec -i $C sh -c "node /root/.kaip/client/bin/kaip.js enroll --server $S --token \"\$(cat)\"" < token.txt

# 3. 安装 OpenCode 插件（自动按 1.x / 2.x 选择），启动后台监控
docker exec $C node /root/.kaip/client/bin/kaip.js install --agents opencode --no-watch
docker exec -d $C sh -c "nohup node /root/.kaip/client/bin/kaip.js watch >/dev/null 2>&1"

# 4. 重启容器内的 OpenCode（插件只在 OpenCode 启动时加载，已打开的会话不受保护），然后验证
docker exec $C node /root/.kaip/client/bin/kaip.js verify     # 必须看到「OpenCode ✔ 生效」
```

注意：
- 容器里没有 Node.js 18+ 时，在步骤 1 一并拷入运行时：宿主机执行 `curl -fsSL $S/dl/runtime/node-linux-x64.tar.gz -o /tmp/node.tgz`，`docker cp` 后解压到容器的 `/root/.kaip/node`（`tar -xzf … --strip-components=1`），之后把命令里的 `node` 换成 `/root/.kaip/node/bin/node`。该运行时基于 glibc，Alpine（musl）容器不适用。
- 容器以非 root 用户运行时，把 `/root` 换成该用户的 HOME，并给 `docker exec` 加 `-u <用户>`。
- **`docker restart` 后**：插件和注册信息仍在，防护持续生效，但后台监控进程不会自动启动，需要重新执行步骤 3 的第二条命令；否则终端没有心跳，控制台约 10 分钟后显示「离线」（Hook 拦截不受影响）。建议在宿主机安装本目录的 `kaip-container-watch.sh`，每分钟检查一次，监控不在时自动拉起（对所有加装了 KAIP 的运行中容器生效）：
  ```bash
  install -m 755 kaip-container-watch.sh /usr/local/bin/kaip-container-watch.sh
  echo '* * * * * root /usr/local/bin/kaip-container-watch.sh' > /etc/cron.d/kaip-container-watch
  ```
- **容器被删除重建**（`docker rm` / `docker compose up --force-recreate`）后，加装的内容全部丢失。长期使用建议换成本镜像，或在启动时挂载 `/root/.kaip` 和 `/root/.config/opencode` 两个卷。
