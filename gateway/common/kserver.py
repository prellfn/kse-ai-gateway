"""kserver — 零依赖的微型 HTTP 框架 (仅使用 Python 标准库).

为什么不用 FastAPI?
  KSE 所在的内网环境通常是**离线**的 (无 pypi / 无外网),
  无法 pip install。本模块让所有网关服务只依赖 Python 3.9+ 标准库,
  部署时不再需要虚拟环境与联网安装。

提供 FastAPI 中本项目实际用到的最小子集:
  @app.get(path) / @app.post(path) / @app.delete(path)
  request.json() / request.query / request.form / request.files
  JSONResponse / HTMLResponse / PlainTextResponse
  HTTPException(status, detail)
  自动解析 multipart/form-data
"""
from __future__ import annotations

import json
import mimetypes
import re
import traceback
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
import urllib.parse
from urllib.parse import parse_qs, unquote, urlparse

__all__ = [
    "App",
    "Request",
    "Response",
    "JSONResponse",
    "HTMLResponse",
    "PlainTextResponse",
    "FileResponse",
    "HTTPException",
    "run",
]


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: Any = ""):
        super().__init__(f"{status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------
class Response:
    media_type = "text/plain; charset=utf-8"
    status_code = 200

    def __init__(self, content: bytes = b"", status_code: int | None = None, headers: dict | None = None):
        self.body = content if isinstance(content, bytes) else str(content).encode()
        if status_code is not None:
            self.status_code = status_code
        self.headers = headers or {}

    def render(self) -> bytes:
        return self.body


class JSONResponse(Response):
    media_type = "application/json; charset=utf-8"

    def __init__(self, content: Any, status_code: int = 200, headers: dict | None = None):
        super().__init__(
            json.dumps(content, ensure_ascii=False, default=str).encode(),
            status_code,
            headers,
        )


class HTMLResponse(Response):
    media_type = "text/html; charset=utf-8"


class PlainTextResponse(Response):
    media_type = "text/plain; charset=utf-8"


class FileResponse(Response):
    def __init__(self, path: str, filename: str | None = None, media_type: str | None = None):
        with open(path, "rb") as f:
            data = f.read()
        guessed = media_type or mimetypes.guess_type(filename or path)[0] or "application/octet-stream"
        headers = {"Content-Disposition": f'attachment; filename="{filename or path.split("/")[-1]}"'}
        super().__init__(data, 200, headers)
        self.media_type = guessed


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------
class UploadFile:
    def __init__(self, filename: str, content: bytes, content_type: str = ""):
        self.filename = filename
        self.file = content
        self.content_type = content_type

    async def read(self) -> bytes:
        return self.file


class Request:
    def __init__(self, method: str, path: str, query: str, headers, body: bytes):
        self.method = method
        self.path = path
        self.query = parse_qs(query)
        self.headers = headers
        self.body = body
        self._form: dict[str, str] | None = None
        self._files: dict[str, UploadFile] | None = None

    # -- query ------------------------------------------------------------
    def q(self, name: str, default: Any = None) -> Any:
        values = self.query.get(name)
        return values[0] if values else default

    # -- body -------------------------------------------------------------
    def json(self) -> dict:
        if not self.body:
            return {}
        try:
            return json.loads(self.body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(400, f"JSON 解析失败: {exc}") from exc

    def _parse_multipart(self) -> tuple[dict[str, str], dict[str, UploadFile]]:
        ctype = self.headers.get("Content-Type", "")
        if "boundary=" not in ctype:
            return {}, {}
        boundary = ctype.split("boundary=")[-1].strip().strip('"')
        sep = b"--" + boundary.encode()
        form: dict[str, str] = {}
        files: dict[str, UploadFile] = {}

        for part in self.body.split(sep):
            if part in (b"", b"--", b"--\r\n", b"\r\n"):
                continue
            part = part.lstrip(b"\r\n")
            if part.startswith(b"--"):
                continue
            head, sep2, payload = part.partition(b"\r\n\r\n")
            if not sep2:
                continue
            payload = payload.rstrip(b"\r\n")
            if payload.endswith(b"--"):
                payload = payload[:-2].rstrip(b"\r\n")

            name = filename = None
            part_ctype = ""
            for line in head.decode("utf-8", "replace").splitlines():
                low = line.lower()
                if low.startswith("content-disposition:"):
                    # 兼容三种写法: name="x" / name=x / filename*=utf-8''x
                    m_name = re.search(r'\bname="([^"]*)"', line) or re.search(r"\bname=([^\s;]+)", line)
                    m_file = re.search(r'\bfilename="([^"]*)"', line) or re.search(r"\bfilename=([^\s;]+)", line)
                    m_star = re.search(r"\bfilename\*=([^']*)'([^']*)'([^;\s]+)", line)
                    if m_name:
                        name = m_name.group(1)
                    if m_file:
                        filename = m_file.group(1)
                    if m_star:
                        # RFC 5987: charset'lang'percent-encoded-value
                        charset = m_star.group(1) or "utf-8"
                        try:
                            filename = urllib.parse.unquote(m_star.group(3), encoding=charset, errors="replace")
                        except Exception:
                            filename = m_star.group(3)
                elif low.startswith("content-type:"):
                    part_ctype = line.split(":", 1)[1].strip()
            if name is None:
                continue
            if filename is not None:
                files[name] = UploadFile(filename, payload, part_ctype)
            else:
                form[name] = payload.decode("utf-8", "replace")
        return form, files

    @property
    def form(self) -> dict[str, str]:
        if self._form is None:
            self._form, self._files = self._parse_multipart()
        return self._form

    @property
    def files(self) -> dict[str, UploadFile]:
        if self._files is None:
            self._form, self._files = self._parse_multipart()
        return self._files


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
Handler = Callable[[Request], Response]


class App:
    def __init__(self, title: str = "App", version: str = "1.0.0"):
        self.title = title
        self.version = version
        self.routes: list[tuple[str, re.Pattern[str], Handler]] = []
        self.on_startup: list[Callable[[], None]] = []

    # -- routing ----------------------------------------------------------
    def _add(self, method: str, path: str, handler: Handler) -> None:
        pattern = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", path)
        self.routes.append((method, re.compile(f"^{pattern}/?$"), handler))

    def get(self, path: str):
        def deco(fn: Handler) -> Handler:
            self._add("GET", path, fn)
            return fn

        return deco

    def post(self, path: str):
        def deco(fn: Handler) -> Handler:
            self._add("POST", path, fn)
            return fn

        return deco

    def delete(self, path: str):
        def deco(fn: Handler) -> Handler:
            self._add("DELETE", path, fn)
            return fn

        return deco

    def startup(self, fn: Callable[[], None]) -> Callable[[], None]:
        self.on_startup.append(fn)
        return fn

    # -- dispatch ---------------------------------------------------------
    def handle(self, method: str, raw_path: str, headers, body: bytes) -> Response:
        parsed = urlparse(raw_path)
        path = unquote(parsed.path)
        req = Request(method, path, parsed.query, headers, body)

        allowed: set[str] = set()
        for m, pattern, fn in self.routes:
            match = pattern.match(path)
            if not match:
                continue
            if m != method:
                allowed.add(m)
                continue
            req.params = match.groupdict()  # type: ignore[attr-defined]
            try:
                result = fn(req)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, exc.status_code)
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                return JSONResponse({"detail": f"内部错误: {exc}"}, 500)
            if isinstance(result, Response):
                return result
            if isinstance(result, tuple) and len(result) == 2:
                return JSONResponse(result[0], result[1])
            return JSONResponse(result)

        if allowed:
            return JSONResponse({"detail": "方法不允许: " + method + " (允许: " + str(sorted(allowed)) + ")"}, 405)
        return JSONResponse({"detail": f"未找到路由: {path}"}, 404)


# ---------------------------------------------------------------------------
# 运行
# ---------------------------------------------------------------------------
class _RequestHandler(BaseHTTPRequestHandler):
    app: App = None  # type: ignore[assignment]
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # 静音访问日志

    def _dispatch(self, method: str) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        resp = self.app.handle(method, self.path, self.headers, body)
        payload = resp.render()
        self.send_response(resp.status_code)
        self.send_header("Content-Type", resp.media_type)
        self.send_header("Content-Length", str(len(payload)))
        for k, v in resp.headers.items():
            self.send_header(k, v)
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_PUT(self):
        self._dispatch("POST")

    def do_HEAD(self):
        self._dispatch("GET")


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run(app: App, host: str = "0.0.0.0", port: int = 8000) -> None:
    """启动服务 (阻塞)."""
    for fn in app.on_startup:
        fn()
    handler = type("_BoundHandler", (_RequestHandler,), {"app": app})
    try:
        server = _Server((host, port), handler)
    except OSError as exc:
        if getattr(exc, "errno", None) in (98, 48):
            raise SystemExit(
                f"[{app.title}] 端口 {port} 已被占用。"
                f"请检查 LISTEN_PORT 配置, 或停止占用该端口的服务。"
            ) from exc
        raise
    print(f"[{app.title}] 监听 http://{host}:{port}  (零依赖标准库实现)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n[{app.title}] 已停止")
    finally:
        server.server_close()
