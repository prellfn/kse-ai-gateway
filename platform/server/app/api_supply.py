"""AI 供应链入口扫描网关：模型文件 / Skill 包 / RAG 文档 / 训练数据集。

- 上传扫描：POST /api/v1/supply/upload       (multipart，支持数十 GB 流式落盘)
- 代下载扫描：POST /api/v1/supply/fetch      (平台代为下载 URL → 信誉检查 → 扫描 → 放行区)
- 放行区下载：GET  /api/v1/supply/released/{sha256}
- RAG 入库对接：扫描通过后转发 AnythingLLM 或通用 Webhook
"""
from __future__ import annotations

import shutil
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import db, scanner
from .auth import require_api
from .config import settings

router = APIRouter(prefix="/api/v1/supply", tags=["supply-chain"])
CATEGORIES = {"model", "skill", "rag", "dataset", "file"}


def _ctx(who: dict, obj: str) -> dict:
    a = who.get("agent") or {}
    return {"agent_type": "-", "agent_id": a.get("id"), "host": a.get("hostname") or who["name"],
            "username": a.get("username") or who["name"], "object": obj}


def _release(path: Path, sha: str, name: str) -> str:
    dst = settings.released_dir / f"{sha}_{Path(name).name}"
    if not dst.exists():
        shutil.move(str(path), str(dst))
    else:
        path.unlink(missing_ok=True)
    return dst.name


def _forward_rag(dst: Path, name: str) -> dict:
    cfg = db.kv_get("rag", {}) or {}
    if not cfg.get("enabled") or not cfg.get("url"):
        return {"forwarded": False, "msg": "未配置知识库对接"}
    try:
        with httpx.Client(timeout=120, verify=False) as c:
            headers = {"Authorization": f"Bearer {cfg.get('api_key','')}"} if cfg.get("api_key") else {}
            with open(dst, "rb") as f:
                if cfg.get("type", "anythingllm") == "anythingllm":
                    base = cfg["url"].rstrip("/")
                    r = c.post(f"{base}/api/v1/document/upload", headers=headers, files={"file": (name, f)})
                    r.raise_for_status()
                    docs = r.json().get("documents", [])
                    if cfg.get("workspace") and docs:
                        c.post(f"{base}/api/v1/workspace/{cfg['workspace']}/update-embeddings", headers=headers,
                               json={"adds": [d["location"] for d in docs if d.get("location")]}).raise_for_status()
                    return {"forwarded": True, "msg": f"已入库 AnythingLLM（{len(docs)} 个文档）"}
                r = c.post(cfg["url"], headers=headers, files={"file": (name, f)})
                r.raise_for_status()
                return {"forwarded": True, "msg": f"已转发 Webhook HTTP {r.status_code}"}
    except Exception as e:
        return {"forwarded": False, "msg": f"知识库转发失败：{e}"}


def _finish(staged: Path, name: str, category: str, who: dict, url: str = "", forward_rag: bool = False) -> dict:
    size = staged.stat().st_size
    if size <= 256 * 1024 * 1024:
        data = staged.read_bytes()
        r = scanner.scan(data=data, name=name, category=category, source="supply-chain", ctx=_ctx(who, name), url=url)
    else:
        r = scanner.scan(path=staged, name=name, category=category, source="supply-chain", ctx=_ctx(who, name), url=url)
    if r["action"] == "allow" and staged.exists():
        rel = _release(staged, r["sha256"], name)
        r["released"] = rel
        r["download"] = f"/api/v1/supply/released/{r['sha256']}"
        if category == "rag" and forward_rag:
            r["rag"] = _forward_rag(settings.released_dir / rel, name)
    else:
        staged.unlink(missing_ok=True)
    return r


@router.post("/upload")
async def upload(file: UploadFile = File(...), category: str = Form("file"), forward_rag: bool = Form(False),
                 who=Depends(require_api)):
    if category not in CATEGORIES:
        raise HTTPException(400, f"category 取值: {sorted(CATEGORIES)}")
    staged = settings.staging_dir / uuid.uuid4().hex
    total, limit = 0, settings.max_upload_mb * 1024 * 1024
    with open(staged, "wb") as out:
        while chunk := await file.read(8 * 1024 * 1024):
            total += len(chunk)
            if total > limit:
                out.close()
                staged.unlink(missing_ok=True)
                raise HTTPException(413, "文件超过平台上限")
            out.write(chunk)
    return _finish(staged, file.filename or "upload", category, who, forward_rag=forward_rag)


class FetchReq(BaseModel):
    url: str
    category: str = "model"
    filename: str = ""


@router.post("/fetch")
def fetch(req: FetchReq, who=Depends(require_api)):
    """安全代下载：适用于隔离网段终端无法直连外网、模型/Skill 统一经平台引入的场景。"""
    if not req.url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https")
    u = scanner.check_url(req.url, "supply-chain", _ctx(who, req.url))
    if u["action"] == "block":
        return {"verdict": u["verdict"], "detection": u["detection"], "action": "block", "url": req.url,
                "reason": "下载地址信誉检出"}
    name = req.filename or req.url.split("?")[0].rstrip("/").split("/")[-1] or "download"
    staged = settings.staging_dir / uuid.uuid4().hex
    t0 = time.time()
    try:
        with httpx.stream("GET", req.url, follow_redirects=True, timeout=httpx.Timeout(60, read=600)) as r:
            r.raise_for_status()
            with open(staged, "wb") as out:
                for chunk in r.iter_bytes(8 * 1024 * 1024):
                    out.write(chunk)
    except Exception as e:
        staged.unlink(missing_ok=True)
        raise HTTPException(502, f"下载失败：{e}")
    res = _finish(staged, name, req.category, who, url=req.url)
    res["download_ms"] = int((time.time() - t0) * 1000)
    return res


@router.get("/released/{sha}")
def released(sha: str, who=Depends(require_api)):
    if not all(c in "0123456789abcdef" for c in sha) or len(sha) != 64:
        raise HTTPException(400, "bad sha256")
    for p in settings.released_dir.glob(f"{sha}_*"):
        return FileResponse(p, filename=p.name[65:])
    raise HTTPException(404, "未找到放行文件")


@router.get("/released")
def released_list(who=Depends(require_api)):
    out = []
    for p in sorted(settings.released_dir.iterdir(), key=lambda x: -x.stat().st_mtime)[:500]:
        st = p.stat()
        out.append({"sha256": p.name[:64], "name": p.name[65:], "size": st.st_size, "ts": st.st_mtime})
    return out
