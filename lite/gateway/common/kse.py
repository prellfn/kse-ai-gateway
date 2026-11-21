"""KSE (Kaspersky Scan Engine) HTTP API 客户端 — 仅依赖标准库.

支持两种扫描模式, 用于适配不同的部署拓扑:

  mode="file"    路径扫描: POST /api/v3.0/scanfile   {"timeout":..,"object":"/path"}
                  ⚠️ KSE 只允许**本机**路径扫描, 跨机调用会返回
                     "Scan file via remote request is rejected"

  mode="memory"  内容扫描: POST /api/v3.0/scanmemory  {"timeout":..,"object":"<base64>"}
                  ✅ 可跨机调用 —— 网关与 KSE 不在同一台机器时必须用这个

  mode="auto"    先试 file, 遇到跨机拒绝自动回退到 memory (默认)

实际 KSE 响应:
  {"object":"...","scanResult":"DETECT","containsOfficeMacro":"false","detectionName":"EICAR-Test-File"}
失败响应:
  {"error":"Scan file via remote request is rejected"}
"""
from __future__ import annotations

import base64
import json
import ssl
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REMOTE_REJECT_MARKER = "remote request is rejected"


class KseError(Exception):
    """KSE 调用失败."""


class KseClient:
    def __init__(
        self,
        url: str = "http://127.0.0.1:8443",
        token: str = "",
        mode: str = "auto",
        timeout: int = 120,
        verify_tls: bool = False,
    ):
        self.url = url.rstrip("/")
        self.token = token
        self.mode = mode if mode in ("auto", "file", "memory") else "auto"
        self.timeout = timeout
        self.verify_tls = verify_tls
        self._ssl_ctx: ssl.SSLContext | None = None
        if self.url.startswith("https://") and not verify_tls:
            self._ssl_ctx = ssl.create_default_context()
            self._ssl_ctx.check_hostname = False
            self._ssl_ctx.verify_mode = ssl.CERT_NONE
        self.last_mode_used: str | None = None
        self.last_mode_fallback: bool = False

    # -- 底层 ------------------------------------------------------------
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/octet-stream"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"{self.url}{path}",
            data=body,
            headers=self._headers(),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout + 30, context=self._ssl_ctx) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                data = json.loads(raw.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                raise KseError(f"KSE HTTP {exc.code}: {raw[:200]!r}") from exc
            raise KseError(str(data.get("error") or data)) from exc
        except urllib.error.URLError as exc:
            raise KseError(f"无法连接 KSE ({self.url}): {exc.reason}") from exc

        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            raise KseError(f"KSE 响应不是合法 JSON: {raw[:200]!r}") from exc

        # KSE 会用 HTTP 200 返回业务错误, 例如:
        #   {"error":"Scan file via remote request is rejected"}
        if isinstance(data, dict) and data.get("error"):
            raise KseError(str(data["error"]))
        return data

    # -- 判定归一化 -------------------------------------------------------
    @staticmethod
    def normalize(raw: str | None) -> str:
        value = (raw or "").upper()
        if value in ("CLEAN", "OK"):
            return "CLEAN"
        if value in ("DETECT", "INFECTED", "INFECTED_ERROR", "VIRUS", "MALWARE", "PHISHING"):
            return "DETECT"
        return "SCAN_ERROR"

    @staticmethod
    def detection_name(data: dict) -> str:
        return (
            data.get("detectionName")
            or data.get("DetectionName")
            or data.get("threatName")
            or ""
        )

    # -- 对外 ------------------------------------------------------------
    def scan_path(self, path: str | Path, timeout: int | None = None) -> dict[str, Any]:
        """扫描文件. 按 mode 选择路径扫描或内存扫描."""
        p = Path(path)
        if not p.is_file():
            raise KseError(f"文件不存在: {path}")
        timeout = timeout or self.timeout
        ms = str(timeout * 1000)

        if self.mode == "memory":
            return self.scan_bytes(p.read_bytes(), timeout=timeout, mode_used="memory")

        try:
            data = self._post("/api/v3.0/scanfile", {"timeout": ms, "object": str(p)})
            self.last_mode_used = "file"
            self.last_mode_fallback = False
            return {
                "verdict": self.normalize(data.get("scanResult")),
                "detection_name": self.detection_name(data),
                "raw": data,
                "mode": "file",
            }
        except KseError as exc:
            msg = str(exc)
            if self.mode == "file" or REMOTE_REJECT_MARKER.lower() not in msg.lower():
                raise
            # 跨机路径扫描被拒 -> 回退到内存扫描
            self.last_mode_fallback = True
            return self.scan_bytes(p.read_bytes(), timeout=timeout, mode_used="memory")

    def scan_bytes(self, content: bytes, timeout: int | None = None, mode_used: str = "memory") -> dict[str, Any]:
        """扫描内存内容 (base64 传输), 可跨机调用."""
        timeout = timeout or self.timeout
        ms = str(timeout * 1000)
        b64 = base64.b64encode(content).decode("ascii")
        data = self._post("/api/v3.0/scanmemory", {"timeout": ms, "object": b64})
        self.last_mode_used = mode_used
        return {
            "verdict": self.normalize(data.get("scanResult")),
            "detection_name": self.detection_name(data),
            "raw": data,
            "mode": mode_used,
        }

    def scan_url(self, url: str, timeout: int | None = None) -> dict[str, Any]:
        """URL 扫描. 需要 KSE 侧 KSN / URL 信誉服务可用."""
        timeout = timeout or 60
        ms = str(timeout * 1000)
        try:
            # 注意: checkurl 的 JSON 键是 "url", 而 scanfile/scanmemory 用 "object"
            data = self._post("/api/v3.0/checkurl", {"timeout": ms, "url": url})
        except KseError as exc:
            raise KseError(f"URL 扫描不可用: {exc}") from exc
        info = data.get("urlInfo") or data.get("UrlInfo") or {}
        detection = self.detection_name(data)
        if isinstance(info, dict):
            detection = detection or info.get("ThreatName") or info.get("detectionName") or ""
        return {
            "verdict": self.normalize(data.get("scanResult")),
            "detection_name": detection,
            "raw": data,
            "mode": "url",
        }
