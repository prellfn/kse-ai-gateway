#!/usr/bin/env python3
"""Mock KSE — 模拟卡巴斯基扫描引擎的 HTTP API (仅供开发 / CI 测试).

实现三个端点:
  POST /api/v3.0/scanfile    路径扫描   {"timeout":"60000","object":"/path"}
  POST /api/v3.0/scanmemory  内容扫描   {"timeout":"60000","object":"<base64>"}
  POST /api/v3.0/checkurl    URL 扫描   {"timeout":"20000","object":"https://..."}

判定规则 (仅特征串匹配, 不做真实恶意软件检测):
  含 EICAR 串            -> DETECT / EICAR-Test-File
  含 MALWARE-SIGNATURE   -> DETECT / HEUR:Trojan.Test.MOCK
  URL 含 malicious/phish -> DETECT / HEUR:Phishing.URL.MOCK
  其余                    -> CLEAN

可选: --reject-remote 让 scanfile 模拟 KSE 的 "拒绝远程路径扫描" 行为,
      用于验证网关的 scanmemory 自动回退逻辑。

用法: python3 scripts/mock_kse.py [--port 1234] [--reject-remote]
"""
from __future__ import annotations

import argparse
import base64
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

EICAR = r"X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
MOCK_SIGNATURE = b"MALWARE-SIGNATURE"
REJECT_REMOTE = False


def detect(data: bytes) -> tuple[str, str]:
    if EICAR.encode() in data:
        return "DETECT", "EICAR-Test-File"
    if MOCK_SIGNATURE in data:
        return "DETECT", "HEUR:Trojan.Test.MOCK"
    return "CLEAN", ""


class Handler(BaseHTTPRequestHandler):
    server_version = "MockKavHttpd/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        path = self.path.split("?")[0].rstrip("/")

        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send(500, {"error": "expected value"})
            return

        if path == "/api/v3.0/scanfile":
            obj = str(payload.get("object", ""))
            if REJECT_REMOTE:
                self._send(200, {"error": "Scan file via remote request is rejected"})
                return
            p = Path(obj)
            if not p.is_file():
                self._send(404, {"error": f"File not found: {obj}"})
                return
            verdict, name = detect(p.read_bytes())
            self._send(
                200,
                {
                    "object": obj,
                    "scanResult": verdict,
                    "containsOfficeMacro": "false",
                    "detectionName": name,
                },
            )
            return

        if path == "/api/v3.0/scanmemory":
            b64 = str(payload.get("object", ""))
            try:
                data = base64.b64decode(b64)
            except Exception:
                self._send(500, {"error": "expected value"})
                return
            verdict, name = detect(data)
            self._send(
                200,
                {
                    "object": "Memory",
                    "scanResult": verdict,
                    "containsOfficeMacro": "false",
                    "detectionName": name,
                },
            )
            return

        if path == "/api/v3.0/checkurl":
            # 真实 KSE 的 checkurl 用 "url" 字段 (不是 "object"), 这里两者都兼容
            url = str(payload.get("url") or payload.get("object") or "")
            low = url.lower()
            if "malicious" in low or "phish" in low:
                self._send(
                    200,
                    {
                        "object": url,
                        "scanResult": "DETECT",
                        "detectionName": "HEUR:Phishing.URL.MOCK",
                        "urlInfo": {"ThreatName": "HEUR:Phishing.URL.MOCK"},
                    },
                )
            else:
                self._send(
                    200,
                    {"object": url, "scanResult": "CLEAN", "detectionName": ""},
                )
            return

        self._send(404, {"error": f"unknown path: {path}"})

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"status": "ok", "mode": "MOCK-KSE"})
        else:
            self._send(404, {"error": "not found"})


def main() -> None:
    global REJECT_REMOTE
    parser = argparse.ArgumentParser(description="Mock KSE (仅供测试)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1234)
    parser.add_argument("--reject-remote", action="store_true", help="模拟拒绝远程路径扫描")
    args = parser.parse_args()
    REJECT_REMOTE = args.reject_remote

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[MOCK-KSE] 监听 http://{args.host}:{args.port}  reject_remote={REJECT_REMOTE}")
    print("[MOCK-KSE] 仅做特征串匹配, 不执行真实恶意软件检测 —— 请勿用于生产")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[MOCK-KSE] 已停止")


if __name__ == "__main__":
    main()
