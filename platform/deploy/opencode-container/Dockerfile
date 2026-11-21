# 容器化 OpenCode（默认 1.15.13）+ Kaspersky AI Protect 防护
# 构建（上下文为离线包 / 源码根目录，与平台使用同一份客户端）：
#   docker build -f deploy/opencode-container/Dockerfile -t kaip-opencode:1.15.13 --build-arg OPENCODE_VERSION=1.15.13 .
#   或 docker compose --profile agent build（见 deploy/docker-compose.yml）
# 运行：docker run -it --rm -e KAIP_SERVER=http://<平台>:8080 -e KAIP_ENROLL_TOKEN=<注册令牌> \
#         -v kaip-state:/root/.kaip -v $PWD:/workspace kaip-opencode:1.15.13
ARG BASE_IMAGE=node:22-slim
FROM ${BASE_IMAGE}

ARG OPENCODE_VERSION=1.15.13
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APT_MIRROR=mirrors.aliyun.com

# 基础工具（git/curl 供 Agent 使用；python3 供测试脚本）
RUN sed -i "s#deb.debian.org#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
 && apt-get update -q && apt-get install -y -q --no-install-recommends git curl ca-certificates python3 procps \
 && rm -rf /var/lib/apt/lists/*

# OpenCode（npm 包会按平台拉取对应的二进制包 opencode-linux-x64）
RUN npm config set registry ${NPM_REGISTRY} \
 && npm install -g opencode-ai@${OPENCODE_VERSION} \
 && opencode --version

# KAIP 终端客户端（零依赖）
COPY client /opt/kaip-client
RUN chmod +x /opt/kaip-client/scripts/container-entrypoint.sh

ENV KAIP_HOME=/root/.kaip \
    OPENCODE_VERSION=${OPENCODE_VERSION}
WORKDIR /workspace
VOLUME ["/root/.kaip", "/root/.local/share/opencode"]
# 入口与客户自有镜像接入共用同一脚本（client/scripts/container-entrypoint.sh）
ENTRYPOINT ["/opt/kaip-client/scripts/container-entrypoint.sh"]
CMD ["opencode"]
