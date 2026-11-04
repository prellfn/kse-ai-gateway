"""AnythingLLM 安全上传网关 — 先扫描, 后入库.

数据流:
    浏览器上传 -> 落盘扫描队列 -> Scan Gateway 扫描 -> CLEAN 才转发到 AnythingLLM

安全策略 (Fail-Closed):
    - 检出威胁 (DETECT): 拒绝入库, 文件由 Scan Gateway 移入隔离区
    - 扫描异常 / 非 CLEAN: 拒绝入库 (不向知识库传递未扫描内容)
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse

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

app = FastAPI(title="AnythingLLM 安全上传门卫", version="1.0.0")


def anythingllm_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {ANYTHINGLLM_API_KEY}"}


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "scan_gateway": SCAN_GATEWAY,
        "anythingllm": ANYTHINGLLM_URL,
        "workspace": WORKSPACE_SLUG or "(未配置)",
    }


@app.post("/upload")
async def safe_upload(
    file: UploadFile = File(...),
    add_to_workspace: bool = Form(True),
) -> dict[str, Any]:
    original_name = file.filename or "unnamed"
    ext = Path(original_name).suffix.lower()

    if ext and ext not in ALLOWED_EXT:
        raise HTTPException(400, f"不支持的文件类型: {ext}（允许: {', '.join(sorted(ALLOWED_EXT))}）")

    contents = await file.read()
    if not contents:
        raise HTTPException(400, "空文件")
    if len(contents) > MAX_UPLOAD_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_UPLOAD_SIZE} bytes)")

    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    safe_filename = f"{int(time.time())}_{Path(original_name).name}"
    file_path = SCAN_QUEUE / safe_filename
    with open(file_path, "wb") as f:
        f.write(contents)

    # 1) 扫描
    async with httpx.AsyncClient(timeout=600) as client:
        scan_resp = await client.post(
            f"{SCAN_GATEWAY}/scan/file",
            json={"file_path": str(file_path), "timeout": 300},
        )
    if scan_resp.status_code != 200:
        raise HTTPException(502, f"扫描网关异常 ({scan_resp.status_code}): {scan_resp.text[:300]}")
    scan_result = scan_resp.json()

    verdict = scan_result.get("verdict")
    if verdict == "DETECT":
        raise HTTPException(
            403,
            f"文件检出威胁: {scan_result.get('detection_name') or '未知'}，已拒绝入库并隔离",
        )
    if verdict != "CLEAN":
        raise HTTPException(500, f"扫描失败({verdict})，文件未入库")

    # 2) CLEAN -> 转发到 AnythingLLM
    headers = anythingllm_headers()
    async with httpx.AsyncClient(timeout=600) as client:
        upload_resp = await client.post(
            f"{ANYTHINGLLM_URL}/api/v1/document/upload",
            files={"file": (original_name, contents, file.content_type or "application/octet-stream")},
            headers=headers,
        )
    if upload_resp.status_code != 200:
        raise HTTPException(upload_resp.status_code, f"上传到文档存储失败: {upload_resp.text[:300]}")

    upload_data = upload_resp.json()
    documents = upload_data.get("documents", [])
    if not documents:
        raise HTTPException(500, "文档存储未返回文档信息")

    doc_location = documents[0]["location"]
    added_to_workspace = False
    if add_to_workspace:
        if not WORKSPACE_SLUG:
            raise HTTPException(500, "未配置 WORKSPACE_SLOG，无法添加到工作区")
        async with httpx.AsyncClient(timeout=600) as client:
            embed_resp = await client.post(
                f"{ANYTHINGLLM_URL}/api/v1/workspace/{WORKSPACE_SLUG}/update-embeddings",
                headers={**headers, "Content-Type": "application/json"},
                json={"adds": [doc_location]},
            )
        if embed_resp.status_code != 200:
            raise HTTPException(embed_resp.status_code, f"添加到工作区失败: {embed_resp.text[:300]}")
        added_to_workspace = True

    # 3) 清理扫描队列中的临时文件 (威胁文件已由 Scan Gateway 隔离)
    file_path.unlink(missing_ok=True)

    msg = f"文件 {original_name} 已通过安全扫描并上传到我的文档"
    if added_to_workspace:
        msg += "，并添加到工作区"
    return {
        "status": "success",
        "message": msg,
        "sha256": scan_result.get("sha256"),
        "detection_name": "",
        "added_to_workspace": added_to_workspace,
    }
