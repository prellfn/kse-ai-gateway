"""AnythingLLM 安全上传网关 — 先扫描, 后入库 (零依赖标准库实现).

数据流:
    浏览器上传 -> 落盘扫描队列 -> Scan Gateway 扫描 -> CLEAN 才转发到 AnythingLLM

安全策略 (Fail-Closed):
    - 检出威胁 (DETECT): 拒绝入库, 文件由 Scan Gateway 移入隔离区
    - 扫描异常 / 非 CLEAN: 拒绝入库 (不向知识库传递未扫描内容)
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.kserver import App, HTTPException, HTMLResponse, JSONResponse, Request, run  # noqa: E402

SCAN_GATEWAY: str = os.getenv("SCAN_GATEWAY", "http://127.0.0.1:8000").rstrip("/")
ANYTHINGLLM_URL: str = os.getenv("ANYTHINGLLM_URL", "http://127.0.0.1:3001").rstrip("/")
ANYTHINGLLM_API_KEY: str = os.getenv("ANYTHINGLLM_API_KEY", "")
WORKSPACE_SLUG: str = os.getenv("WORKSPACE_SLUG", "")
SCAN_QUEUE: Path = Path(os.getenv("SCAN_QUEUE", "/opt/kaspersky/scanqueue"))
TEMPLATE_DIR: Path = Path(os.getenv("TEMPLATE_DIR", "templates"))
ALLOWED_EXT: set[str] = {
    e.strip().lower()
    for e in os.getenv(
        "ALLOWED_EXT",
        ".pdf,.doc,.docx,.txt,.md,.csv,.xlsx,.pptx,.epub,.json,.yaml,.yml",
    ).split(",")
    if e.strip()
}
MAX_UPLOAD_SIZE: int = int(os.getenv("MAX_UPLOAD_SIZE", str(100 * 1024 * 1024)))
# 无 AnythingLLM 时允许仅做扫描验证 (不转发入库), 用于新环境试跑
FORWARD_ENABLED: bool = os.getenv("FORWARD_ENABLED", "true").lower() in ("1", "true", "yes")

app = App(title="AnythingLLM 安全上传门卫", version="1.2.0")


def _post_json(url: str, payload: dict, timeout: int = 600, headers: dict | None = None) -> tuple[int, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return exc.code, {"raw": raw[:300]}
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"无法连接 {url}: {exc.reason}") from exc


def _post_multipart(url: str, field: str, filename: str, content: bytes, content_type: str, timeout: int = 600) -> tuple[int, Any]:
    boundary = "----KSEBoundary" + str(int(time.time() * 1000))
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    body = head + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw.decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return exc.code, {"raw": raw[:300]}
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"无法连接 {url}: {exc.reason}") from exc


@app.get("/")
def index(req: Request) -> HTMLResponse:
    return HTMLResponse((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/health")
def health(req: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "scan_gateway": SCAN_GATEWAY,
            "anythingllm": ANYTHINGLLM_URL if FORWARD_ENABLED else "(未启用转发)",
            "workspace": WORKSPACE_SLUG or "(未配置)",
            "forward_enabled": FORWARD_ENABLED,
        }
    )


@app.post("/upload")
def upload(req: Request) -> JSONResponse:
    files = req.files
    if "file" not in files:
        raise HTTPException(400, "缺少上传文件 (字段名: file)")
    upload_file = files["file"]
    original_name = upload_file.filename or "unnamed"
    ext = Path(original_name).suffix.lower()
    if ext and ext not in ALLOWED_EXT:
        raise HTTPException(400, f"不支持的文件类型: {ext}")

    contents = upload_file.file
    if not contents:
        raise HTTPException(400, "空文件")
    if len(contents) > MAX_UPLOAD_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_UPLOAD_SIZE} bytes)")

    add_to_workspace = str(req.form.get("add_to_workspace", "true")).lower() in ("1", "true", "yes")

    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    safe_filename = f"{int(time.time())}_{Path(original_name).name}"
    file_path = SCAN_QUEUE / safe_filename
    with open(file_path, "wb") as f:
        f.write(contents)

    # 1) 扫描
    status, scan_result = _post_json(
        f"{SCAN_GATEWAY}/scan/file",
        {"file_path": str(file_path), "timeout": 300},
    )
    if status != 200:
        raise HTTPException(502, f"扫描网关异常 ({status}): {scan_result}")

    verdict = scan_result.get("verdict")
    if verdict == "DETECT":
        raise HTTPException(
            403,
            f"文件检出威胁: {scan_result.get('detection_name') or '未知'}，已拒绝入库并隔离",
        )
    if verdict != "CLEAN":
        raise HTTPException(500, f"扫描失败({verdict})，文件未入库")

    # 2) CLEAN -> 转发 AnythingLLM
    added_to_workspace = False
    if FORWARD_ENABLED:
        headers = {"Authorization": f"Bearer {ANYTHINGLLM_API_KEY}"}
        status, upload_data = _post_multipart(
            f"{ANYTHINGLLM_URL}/api/v1/document/upload",
            "file",
            original_name,
            contents,
            upload_file.content_type or "application/octet-stream",
        )
        if status != 200:
            raise HTTPException(status, f"上传到文档存储失败: {str(upload_data)[:300]}")

        documents = upload_data.get("documents", [])
        if not documents:
            raise HTTPException(500, "文档存储未返回文档信息")

        doc_location = documents[0]["location"]
        if add_to_workspace:
            if not WORKSPACE_SLUG:
                raise HTTPException(500, "未配置 WORKSPACE_SLUG，无法添加到工作区")
            status, embed = _post_json(
                f"{ANYTHINGLLM_URL}/api/v1/workspace/{WORKSPACE_SLUG}/update-embeddings",
                {"adds": [doc_location]},
                headers={**headers, "Content-Type": "application/json"},
            )
            if status != 200:
                raise HTTPException(status, f"添加到工作区失败: {str(embed)[:300]}")
            added_to_workspace = True
    else:
        # 未启用转发: 仅验证扫描链路, 清理临时文件
        file_path.unlink(missing_ok=True)

    msg = f"文件 {original_name} 已通过安全扫描"
    if FORWARD_ENABLED:
        msg += "并上传到我的文档"
        if added_to_workspace:
            msg += "，并添加到工作区"
    return JSONResponse(
        {
            "status": "success",
            "message": msg,
            "sha256": scan_result.get("sha256"),
            "detection_name": "",
            "added_to_workspace": added_to_workspace,
            "forwarded": FORWARD_ENABLED,
        }
    )


if __name__ == "__main__":
    run(app, os.getenv("LISTEN_HOST", "0.0.0.0"), int(os.getenv("LISTEN_PORT", "8002")))
