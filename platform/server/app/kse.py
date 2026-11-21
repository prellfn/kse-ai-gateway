"""Kaspersky Scan Engine (KAIP 引擎) 客户端。

真实模式调用 KSE HTTP 模式 REST API（KAV protocol v3）：
  POST /api/v3.0/scanmemory  {"timeout": "...", "object": "<base64>"}
  POST /api/v3.0/scanfile    {"timeout": "...", "object": "/abs/path"}   # 仅限 KSE 本机允许目录
  POST /api/v3.0/checkurl    {"timeout": "...", "url": "..."}
  GET  /api/v3.0/basesdate | version | licenseinfo

模拟模式（mock）用于没有 KSE 的演示/开发环境：识别 EICAR、KSN/URL 测试样本、递归 zip。
"""
from __future__ import annotations

import base64
import io
import shutil
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .config import settings

EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


@dataclass
class ScanResult:
    verdict: str                       # CLEAN / DETECT / NON_SCANNED / ERROR
    detection: str = ""
    reason: str = ""                   # NON_SCANNED 原因 / 错误描述
    sub_results: list = field(default_factory=list)
    macro: bool = False
    raw: dict | None = None

    def to_dict(self):
        return {
            "verdict": self.verdict, "detection": self.detection, "reason": self.reason,
            "sub_results": self.sub_results, "macro": self.macro,
        }


def _is_remote_rejected(reason: str) -> bool:
    """判断 KSE 是否因「远程路径扫描被拒绝」而失败."""
    return "remote request is rejected" in (reason or "").lower()


def normalize(resp: dict) -> ScanResult:
    if "error" in resp:
        return ScanResult("ERROR", reason=str(resp["error"]), raw=resp)
    sr = str(resp.get("scanResult", "")).strip()
    reason = ""
    verdict = sr
    if sr.startswith("NON_SCANNED"):
        verdict = "NON_SCANNED"
        if "(" in sr:
            reason = sr[sr.index("(") + 1: sr.rindex(")")]
        reason = resp.get("reason", reason)
    elif sr in ("DISINFECTED", "DELETED"):
        verdict = "DETECT"
    elif sr == "SERVER_ERROR":
        verdict = "ERROR"
    subs = [
        {"object": s.get("object"), "verdict": s.get("scanResult"), "detection": s.get("detectionName", "")}
        for s in resp.get("subObjectsScanResults", []) or []
    ]
    return ScanResult(
        verdict=verdict or "ERROR",
        detection=resp.get("detectionName", "") or "",
        reason=reason,
        sub_results=subs,
        macro=str(resp.get("containsOfficeMacro", "false")).lower() == "true",
        raw=resp,
    )


class KSEClient:
    def __init__(self):
        self._client = None

    def _headers(self):
        h = {"Content-Type": "application/octet-stream"}
        if settings.kse_token:
            h["Authorization"] = ("Bearer " if settings.kse_bearer else "") + settings.kse_token
        return h

    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=settings.kse_url.rstrip("/"),
                verify=settings.kse_verify_tls,
                timeout=settings.kse_timeout_ms / 1000 + 30,
            )
        return self._client

    def _post(self, path: str, body: dict) -> dict:
        r = self.client().post(path, json=body, headers=self._headers())
        if r.status_code == 401:
            return {"error": "KSE 认证失败(401)，请检查 KAIP_KSE_TOKEN"}
        try:
            return r.json()
        except Exception:
            return {"error": f"KSE 返回非 JSON 响应 HTTP {r.status_code}: {r.text[:200]}"}

    def scan_bytes(self, data: bytes, name: str = "", url: str = "") -> ScanResult:
        try:
            if settings.kse_scanfile_threshold and len(data) >= settings.kse_scanfile_threshold:
                return self._scan_via_file(data, name, url)
            body = {"timeout": str(settings.kse_timeout_ms), "object": base64.b64encode(data).decode()}
            if url:
                body["url"] = url
            if name:
                body["name"] = name[:300]
                return normalize(self._post("/api/v3.1/scanmemory", body))
            return normalize(self._post("/api/v3.0/scanmemory", body))
        except httpx.HTTPError as e:
            return ScanResult("ERROR", reason=f"无法连接 KSE: {e}")

    def _scan_via_file(self, data: bytes, name: str, url: str) -> ScanResult:
        d = settings.kse_scan_dir
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{uuid.uuid4().hex}_{Path(name or 'object').name}"
        p.write_bytes(data)
        p.chmod(0o644)   # KSE 经 NFS 读取时以 nobody 身份访问（root_squash）
        try:
            return self.scan_path(p, url)
        finally:
            p.unlink(missing_ok=True)

    def scan_path(self, path: Path, url: str = "") -> ScanResult:
        """path 必须位于 KSE 允许扫描的目录中（Settings → Service）。

        KSE 的路径扫描只允许在 KSE 本机调用：平台与 KSE 分离部署且未配置
        NFS 共享时，KSE 会返回 "Scan file via remote request is rejected"。
        此时自动回退到内存扫描（scanmemory），能力等价，仅多一次 base64 传输。
        """
        try:
            body = {"timeout": str(settings.kse_timeout_ms), "object": self.remote_path(path)}
            if url:
                body["url"] = url
            r = normalize(self._post("/api/v3.1/scanfile", body))
        except httpx.HTTPError as e:
            return ScanResult("ERROR", reason=f"无法连接 KSE: {e}")

        if r.verdict == "ERROR" and _is_remote_rejected(r.reason):
            try:
                return self.scan_bytes(path.read_bytes(), path.name, url)
            except OSError as e:
                return ScanResult("ERROR", reason=f"路径扫描被 KSE 拒绝且回退内存扫描失败: {e}")
        return r

    @staticmethod
    def remote_path(path: Path) -> str:
        """本机扫描目录下的文件在 KSE 主机上的路径（KSE 在另一台服务器、经 NFS 挂载扫描目录时）。"""
        p = Path(path).as_posix()
        if settings.kse_scan_dir_remote:
            local = Path(settings.kse_scan_dir).as_posix().rstrip("/")
            if p == local or p.startswith(local + "/"):
                return settings.kse_scan_dir_remote + p[len(local):]
        return p

    def scan_large_file(self, src: Path, name: str, url: str = "") -> ScanResult:
        """平台已落盘的大文件：复制/硬链接到 KSE 扫描目录后 scanfile。"""
        if not settings.kse_scanfile_threshold:   # KSE 不在本机（阈值 0）：scanfile 看不到本机文件，改走 scanmemory
            return self.scan_bytes(src.read_bytes(), name, url)
        d = settings.kse_scan_dir
        d.mkdir(parents=True, exist_ok=True)
        p = d / f"{uuid.uuid4().hex}_{Path(name).name}"
        try:
            try:
                if settings.kse_scan_dir_remote:
                    raise OSError("NFS 共享目录：复制，不改动原文件权限")
                p.hardlink_to(src)
            except Exception:
                shutil.copyfile(src, p)
                p.chmod(0o644)
            return self.scan_path(p, url)
        finally:
            p.unlink(missing_ok=True)

    def check_url(self, url: str) -> ScanResult:
        try:
            return normalize(self._post("/api/v3.0/checkurl", {"timeout": "10000", "url": url}))
        except httpx.HTTPError as e:
            return ScanResult("ERROR", reason=f"无法连接 KSE: {e}")

    def status(self) -> dict:
        out = {"mode": "kse", "url": settings.kse_url, "online": False}
        try:
            c = self.client()
            h = self._headers()
            out["basesdate"] = c.get("/api/v3.0/basesdate", headers=h, timeout=10).json().get("databaseVersion")
            out["version"] = c.get("/api/v3.0/version", headers=h, timeout=10).json().get("KAVSDKVersion")
            out["license"] = c.get("/api/v3.0/licenseinfo", headers=h, timeout=10).json()
            out["online"] = True
        except Exception as e:
            out["error"] = str(e)
        return out


class MockKSE:
    """演示用模拟引擎：仅识别公开的无害测试样本。"""

    TEST_URLS = {
        "https://www.kaspersky.com/test/wmuf": "MALICIOUS_URL",
        "https://www.kaspersky.com/test/aphish_h": "PHISHING_URL",
        "http://bug.qainfo.ru/test/aphish_w": "PHISHING_URL",
        "http://bug.qainfo.ru/test/wmuf_w": "MALICIOUS_URL",
    }

    def scan_bytes(self, data: bytes, name: str = "", url: str = "", _depth: int = 0) -> ScanResult:
        if EICAR in data:
            return ScanResult("DETECT", detection="EICAR-Test-File")
        if data[:4] == b"PK\x03\x04" and _depth < 5:
            try:
                zf = zipfile.ZipFile(io.BytesIO(data))
                subs = []
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    if info.flag_bits & 0x1:
                        return ScanResult("NON_SCANNED", reason="PASSWORD PROTECTED")
                    r = self.scan_bytes(zf.read(info), info.filename, _depth=_depth + 1)
                    if r.verdict == "DETECT":
                        subs.append({"object": f"{name}//{info.filename}", "verdict": "DETECT", "detection": r.detection})
                    elif r.verdict == "NON_SCANNED":
                        return r
                if subs:
                    det = subs[0]["detection"] if len(subs) == 1 else "multiple"
                    return ScanResult("DETECT", detection=det, sub_results=subs)
            except zipfile.BadZipFile:
                return ScanResult("NON_SCANNED", reason="CORRUPTED")
        return ScanResult("CLEAN")

    def scan_large_file(self, src: Path, name: str, url: str = "") -> ScanResult:
        # 流式查找 EICAR（演示用）
        tail = b""
        with open(src, "rb") as f:
            head = f.read(4)
            f.seek(0)
            if head == b"PK\x03\x04" and src.stat().st_size < 512 * 1024 * 1024:
                return self.scan_bytes(f.read(), name)
            while chunk := f.read(4 * 1024 * 1024):
                if EICAR in tail + chunk:
                    return ScanResult("DETECT", detection="EICAR-Test-File")
                tail = chunk[-len(EICAR):]
        return ScanResult("CLEAN")

    def check_url(self, url: str) -> ScanResult:
        key = url.strip().lower().rstrip("/")
        if key in self.TEST_URLS:
            return ScanResult("DETECT", detection=self.TEST_URLS[key])
        return ScanResult("CLEAN")

    def status(self) -> dict:
        return {"mode": "mock", "online": True, "basesdate": "模拟引擎（无病毒库）", "version": "mock",
                "license": {"licenseName": "demo", "licenseExpirationDate": "-"}}


_engine = None
_bases = {"v": None, "t": 0.0}
BASES_REFRESH = 60        # 秒：病毒库版本查询间隔（KSE 更新后最迟 1 分钟生效）


def bases_version() -> str | None:
    """当前病毒库版本，作为判定缓存的失效依据。KSE 不可达时返回最近一次成功值（无则 None）。"""
    now = time.time()
    if now - _bases["t"] < BASES_REFRESH and _bases["v"]:
        return _bases["v"]
    if settings.kse_mode != "kse":
        v = "mock"
    else:
        try:
            eng = engine()
            r = eng.client().get("/api/v3.0/basesdate", headers=eng._headers(), timeout=5)
            v = str(r.json().get("databaseVersion") or "") or None
        except Exception:
            v = None
    if v:
        _bases.update(v=v, t=now)
    else:
        _bases["t"] = now - BASES_REFRESH + 10      # 失败 10 秒后重试，期间沿用旧值
    return _bases["v"]


def engine():
    global _engine
    if _engine is None:
        _engine = KSEClient() if settings.kse_mode == "kse" else MockKSE()
    return _engine
