#!/usr/bin/env python3
"""Mock Scan Gateway — 无需 KSE 许可证即可跑通全链路验证.

仅供开发 / 测试使用, 不做任何真实恶意软件检测: 只按特征串 (EICAR 等) 做简单匹配。
绝不要部署到生产环境。

用法:
    python3 scripts/mock_scan_gateway.py [--port 8000] [--host 127.0.0.1]

模拟的判定:
    - 内容包含 EICAR 测试串            -> DETECT / EICAR-Test-File
    - 内容包含 "MALWARE-SIGNATURE"    -> DETECT / HEUR:Trojan.Test.MOCK
    - URL 包含 "malicious" 或 "phish"  -> DETECT / HEUR:Phishing.URL.MOCK
    - 其余                              -> CLEAN
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import tarfile
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EICAR = r"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
MOCK_SIGNATURE = b"MALWARE-SIGNATURE"

SCAN_QUEUE = Path(tempfile.gettempdir()) / "kse-mock-scanqueue"
QUARANTINE = Path(tempfile.gettempdir()) / "kse-mock-quarantine"
SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
QUARANTINE.mkdir(parents=True, exist_ok=True)

_cache: dict[str, dict] = {}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def detect_bytes(data: bytes) -> tuple[str, str]:
    if EICAR.encode() in data:
        return "DETECT", "EICAR-Test-File"
    if MOCK_SIGNATURE in data:
        return "DETECT", "HEUR:Trojan.Test.MOCK"
    return "CLEAN", ""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def quarantine(name: str, data: bytes, sha: str, detection: str) -> dict:
    stamp = int(datetime.now(timezone.utc).timestamp())
    dst = QUARANTINE / f"{sha}_{stamp}_{name}"
    dst.write_bytes(data)
    (QUARANTINE / f"{dst.name}.meta.json").write_text(
        json.dumps(
            {
                "quarantine_id": dst.name,
                "original_name": name,
                "sha256": sha,
                "size": len(data),
                "detection_name": detection,
                "quarantined_at": utcnow(),
                "status": "pending_review",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return {"quarantine_path": str(dst), "quarantined": True}


def scan_bytes(name: str, data: bytes) -> dict:
    sha = sha256_bytes(data)
    if sha in _cache:
        return {**_cache[sha], "cached": True}
    verdict, detection = detect_bytes(data)
    result = {
        "request_id": uuid.uuid4().hex[:12],
        "file_path": str(SCAN_QUEUE / name),
        "sha256": sha,
        "size": len(data),
        "verdict": verdict,
        "detection_name": detection,
        "quarantined": False,
        "scanned_at": utcnow(),
    }
    if verdict == "DETECT":
        result.update(quarantine(name, data, sha, detection))
    _cache[sha] = result
    return result


def scan_package_bytes(name: str, data: bytes) -> dict:
    """解包后逐文件检测, 任一命中即整包 DETECT."""
    threats = []
    members = 0
    tmp = Path(tempfile.mkdtemp(prefix="mockpkg_"))
    try:
        extracted: list[tuple[str, bytes]] = []
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    extracted.append((info.filename, zf.read(info)))
        except zipfile.BadZipFile:
            try:
                with tarfile.open(fileobj=io.BytesIO(data)) as tf:
                    for info in tf.getmembers():
                        if not info.isfile():
                            continue
                        fh = tf.extractfile(info)
                        if fh:
                            extracted.append((info.name, fh.read()))
            except tarfile.TarError:
                extracted = [(name, data)]

        members = len(extracted)
        for member_name, member_data in extracted:
            verdict, detection = detect_bytes(member_data)
            if verdict == "DETECT":
                threats.append(
                    {
                        "file_path": str(tmp / member_name),
                        "verdict": verdict,
                        "detection_name": detection,
                    }
                )

        verdict = "DETECT" if threats else "CLEAN"
        sha = sha256_bytes(data)
        result = {
            "request_id": uuid.uuid4().hex[:12],
            "package_name": name,
            "sha256": sha,
            "size": len(data),
            "members_total": members,
            "members_scanned": members,
            "verdict": verdict,
            "threats_count": len(threats),
            "threats": threats,
            "quarantined": False,
            "scanned_at": utcnow(),
        }
        if verdict == "DETECT":
            result.update(quarantine(name, data, sha, threats[0]["detection_name"]))
        return result
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "MockKseScanGateway/1.0"

    def log_message(self, fmt, *args):  # 静音访问日志
        pass

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(
                200,
                {
                    "status": "ok",
                    "mode": "MOCK",
                    "kse_url": "mock://no-real-scanning",
                    "scan_queue": str(SCAN_QUEUE),
                    "quarantine": str(QUARANTINE),
                    "allowed_dirs": [str(SCAN_QUEUE)],
                    "cache_size": len(_cache),
                    "time": utcnow(),
                },
            )
        else:
            self._send(404, {"detail": f"未知路径: {self.path}"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        path = self.path.split("?")[0].rstrip("/")

        if path == "/scan/url":
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                self._send(400, {"detail": "JSON 解析失败"})
                return
            url = str(payload.get("url", ""))
            lower = url.lower()
            if "malicious" in lower or "phish" in lower:
                self._send(
                    200,
                    {
                        "request_id": uuid.uuid4().hex[:12],
                        "url": url,
                        "verdict": "DETECT",
                        "detection_name": "HEUR:Phishing.URL.MOCK",
                        "raw": {"scanResult": "DETECT"},
                        "scanned_at": utcnow(),
                    },
                )
            else:
                self._send(
                    200,
                    {
                        "request_id": uuid.uuid4().hex[:12],
                        "url": url,
                        "verdict": "CLEAN",
                        "detection_name": "",
                        "raw": {"scanResult": "CLEAN"},
                        "scanned_at": utcnow(),
                    },
                )
            return

        if path in ("/scan/file", "/scan/upload", "/scan/package"):
            data = b""
            filename = "upload.bin"
            content_type = self.headers.get("Content-Type", "")

            if content_type.startswith("application/json"):
                try:
                    payload = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    self._send(400, {"detail": "JSON 解析失败"})
                    return
                file_path = payload.get("file_path", "")
                if not file_path or not Path(file_path).is_file():
                    self._send(404, {"detail": f"文件不存在: {file_path}"})
                    return
                filename = Path(file_path).name
                data = Path(file_path).read_bytes()
            else:
                # multipart/form-data 解析
                filename_m = re.search(rb'filename="([^"]*)"', content_type.encode())
                if filename_m:
                    filename = filename_m.group(1).decode("utf-8", "replace")
                if b"boundary=" in content_type.encode():
                    boundary = content_type.split("boundary=")[-1].strip()
                    sep = b"--" + boundary.encode()
                    for part in raw.split(sep):
                        if b"\r\n\r\n" not in part:
                            continue
                        header, _, payload = part.partition(b"\r\n\r\n")
                        if b'name="file"' in header or b'name="file_path"' in header:
                            data = payload.rstrip(b"\r\n-")
                            break
                else:
                    data = raw

            if path == "/scan/package":
                self._send(200, scan_package_bytes(filename, data))
            else:
                self._send(200, scan_bytes(filename, data))
            return

        self._send(404, {"detail": f"未知路径: {self.path}"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Mock Scan Gateway (仅供测试)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[MOCK] Scan Gateway 运行于 http://{args.host}:{args.port}")
    print(f"[MOCK] 扫描队列: {SCAN_QUEUE}")
    print(f"[MOCK] 隔离区  : {QUARANTINE}")
    print("[MOCK] 仅做特征串匹配, 不执行真实恶意软件检测 —— 请勿用于生产")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[MOCK] 已停止")


if __name__ == "__main__":
    main()
