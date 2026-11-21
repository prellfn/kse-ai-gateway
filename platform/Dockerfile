# KAIP 平台镜像（docker compose 见 deploy/docker-compose.yml）
# 构建上下文为离线包根目录（或源码根目录）：有 wheels/py3.12 时离线安装依赖，否则从 PyPI 安装
#   docker build -t kaip-platform:1.0.0 .
# 无法访问 Docker Hub 时：--build-arg BASE_IMAGE=docker.m.daocloud.io/library/python:3.12-slim
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

RUN --mount=type=bind,target=/ctx \
    if [ -d /ctx/wheels/py3.12 ]; then \
      pip install --no-cache-dir --no-index --find-links /ctx/wheels/py3.12 fastapi uvicorn httpx python-multipart; \
    else \
      pip install --no-cache-dir -r /ctx/server/requirements.txt; \
    fi

WORKDIR /opt/kaip
COPY server server
COPY client client

# 非 root 运行；数据目录（数据库、令牌、隔离区）仅服务账号可读
RUN useradd --system --uid 10001 --home /var/lib/kaip --shell /usr/sbin/nologin kaip \
 && mkdir -p /var/lib/kaip /opt/kaip/runtime /opt/kaspersky/scanqueue \
 && chown kaip:kaip /var/lib/kaip /opt/kaspersky/scanqueue && chmod 700 /var/lib/kaip

ENV KAIP_DATA_DIR=/var/lib/kaip \
    KAIP_RUNTIME_DIR=/opt/kaip/runtime \
    KAIP_PORT=8080 \
    PYTHONDONTWRITEBYTECODE=1
USER kaip
WORKDIR /opt/kaip/server
EXPOSE 8080 5514/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('KAIP_PORT','8080'),timeout=4)"
# umask 077：新建的数据库、隔离文件仅服务账号可读（送检临时文件由程序单独设为 644）
CMD ["sh", "-c", "umask 077 && exec python -m uvicorn app.main:app --host 0.0.0.0 --port ${KAIP_PORT} --proxy-headers"]
