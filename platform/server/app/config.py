"""KAIP 平台配置：全部来自环境变量，便于 Docker / systemd 部署。"""
import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    # 数据目录（SQLite、隔离区、暂存区）
    data_dir = Path(os.environ.get("KAIP_DATA_DIR", "./data")).resolve()

    # KSE 连接
    # kse_mode: "kse" = 调用真实 Kaspersky Scan Engine；"mock" = 内置模拟引擎（演示/开发用）
    kse_mode = os.environ.get("KAIP_KSE_MODE", "mock")
    kse_url = os.environ.get("KAIP_KSE_URL", "https://127.0.0.1:8443")
    kse_token = os.environ.get("KAIP_KSE_TOKEN", "")
    kse_bearer = _bool("KAIP_KSE_BEARER", True)
    kse_verify_tls = _bool("KAIP_KSE_VERIFY_TLS", False)
    kse_timeout_ms = int(os.environ.get("KAIP_KSE_TIMEOUT_MS", "60000"))
    # scanfile 只能扫描 KSE 本机允许目录内的文件：平台把大文件写入 kse_scan_dir 后让 KSE 按路径扫描
    kse_scan_dir = Path(os.environ.get("KAIP_KSE_SCAN_DIR", "/opt/kaspersky/scanqueue"))
    # KSE 在另一台服务器时：kse_scan_dir 经 NFS 共享并挂载到 KSE 主机，这里填 KSE 主机上看到的挂载路径（同机留空）
    kse_scan_dir_remote = os.environ.get("KAIP_KSE_SCAN_DIR_REMOTE", "").rstrip("/")
    # 达到该大小（字节）改用 scanfile（避免 base64 膨胀）；0 = 永远用 scanmemory
    kse_scanfile_threshold = int(os.environ.get("KAIP_KSE_SCANFILE_THRESHOLD", str(25 * 1024 * 1024)))

    # 管理员
    admin_user = os.environ.get("KAIP_ADMIN_USER", "admin")
    admin_password = os.environ.get("KAIP_ADMIN_PASSWORD", "")  # 为空时首次启动随机生成并打印
    secret_key = os.environ.get("KAIP_SECRET_KEY", "")

    # 内置 syslog 接收（接收 KSE ICAP/HTTP 扫描事件，CEF/RAW）
    syslog_listen = _bool("KAIP_SYSLOG_LISTEN", True)
    syslog_port = int(os.environ.get("KAIP_SYSLOG_PORT", "5514"))

    max_upload_mb = int(os.environ.get("KAIP_MAX_UPLOAD_MB", "20480"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "kaip.db"

    @property
    def quarantine_dir(self) -> Path:
        return self.data_dir / "quarantine"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def released_dir(self) -> Path:
        return self.data_dir / "released"


settings = Settings()
for d in (settings.data_dir, settings.quarantine_dir, settings.staging_dir, settings.released_dir):
    d.mkdir(parents=True, exist_ok=True)
