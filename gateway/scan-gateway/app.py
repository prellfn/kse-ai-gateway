"""KSE Scan Gateway — Kaspersky Scan Engine 封装层.

职责:
  1. 路径白名单校验, 拒绝任意路径扫描 (防止越权读取)
  2. SHA-256 结果缓存, 避免同一文件重复消耗扫描时间
  3. 检出威胁 (DETECT) 自动移入隔离区
  4. 全链路审计日志 (JSON Lines)

环境变量见 .env.example / config/gateway.example.yaml
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------
KSE_URL: str = os.getenv("KSE_URL", "https://127.0.0.1:8443").rstrip("/")
KSE_TOKEN: str = os.getenv("KSE_TOKEN", "")
KSE_TIMEOUT: int = int(os.getenv("KSE_TIMEOUT", "120"))
KSE_VERIFY_TLS: bool = os.getenv("KSE_VERIFY_TLS", "false").lower() in ("1", "true", "yes")

SCAN_QUEUE: Path = Path(os.getenv("SCAN_QUEUE", "/opt/kaspersky/scanqueue"))
QUARANTINE: Path = Path(os.getenv("QUARANTINE", "/opt/kaspersky/quarantine"))
MAX_FILE_SIZE: int = int(os.getenv("MAX_FILE_SIZE", str(100 * 1024 * 1024)))
AUDIT_LOG: Path = Path(os.getenv("AUDIT_LOG", "/opt/ai-stack/scan-gateway/logs/audit.jsonl"))


def _allowed_dirs() -> list[Path]:
    """允许被扫描的目录列表; 默认为扫描队列目录."""
    raw = os.getenv("ALLOWED_SCAN_DIRS", "").strip()
    dirs = [SCAN_QUEUE.resolve()]
    if raw:
        for item in raw.split(","):
            item = item.strip()
            if item:
                dirs.append(Path(item).resolve())
    return dirs


ALLOWED_SCAN_DIRS = _allowed_dirs()

# 结果缓存: sha256 -> result dict
scan_cache: dict[str, dict[str, Any]] = {}

app = FastAPI(title="KSE Scan Gateway", version="1.0.0")


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------
def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def audit(event: str, **fields: Any) -> None:
    """写入 JSON Lines 审计日志. 审计失败不影响主流程."""
    record = {"ts": utcnow(), "event": event, **fields}
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:  # pragma: no cover
        pass


def normalize_verdict(raw: str | None) -> str:
    """把 KSE 的 scanResult 归一化为 CLEAN / DETECT / SCAN_ERROR."""
    value = (raw or "").upper()
    if value in ("CLEAN", "OK", "NOT_FOUND_FILE"):
        return "CLEAN"
    if value in ("DETECT", "INFECTED", "INFECTED_ERROR", "VIRUS", "MALWARE"):
        return "DETECT"
    if value in ("SKIPPED", "NOT_FOUND"):
        return "SCAN_ERROR"
    return "SCAN_ERROR" if value in ("", "SCAN_ERROR", "ERROR") else value


def assert_allowed(path: Path) -> Path:
    """校验路径位于允许的扫描目录内, 否则拒绝."""
    resolved = path.resolve()
    for allowed in ALLOWED_SCAN_DIRS:
        try:
            resolved.relative_to(allowed)
            return resolved
        except ValueError:
            continue
    raise HTTPException(403, f"路径不在允许的扫描目录内: {path}")


def kse_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/octet-stream",
        "Authorization": f"Bearer {KSE_TOKEN}",
    }


def quarantine_file(path: Path, sha: str) -> Path | None:
    """把检出威胁的文件移入隔离区, 返回隔离后的路径."""
    try:
        QUARANTINE.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time())
        dst = QUARANTINE / f"{sha}_{stamp}_{path.name}"
        shutil.move(str(path), str(dst))
        return dst
    except Exception as exc:  # pragma: no cover
        audit("quarantine_failed", file_path=str(path), error=str(exc))
        return None


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
class ScanFileRequest(BaseModel):
    file_path: str
    timeout: int = 120


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "kse_url": KSE_URL,
        "scan_queue": str(SCAN_QUEUE),
        "quarantine": str(QUARANTINE),
        "allowed_dirs": [str(d) for d in ALLOWED_SCAN_DIRS],
        "cache_size": len(scan_cache),
        "time": utcnow(),
    }


@app.post("/scan/file")
async def scan_file(req: ScanFileRequest) -> dict[str, Any]:
    """扫描本机文件 (路径扫描). 仅限白名单目录内的文件."""
    request_id = uuid.uuid4().hex[:12]
    path = Path(req.file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(404, f"文件不存在: {req.file_path}")
    if path.stat().st_size > MAX_FILE_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_FILE_SIZE} bytes)")

    path = assert_allowed(path)
    sha = sha256_file(path)

    if sha in scan_cache:
        audit("scan_cached", request_id=request_id, file_path=str(path), sha256=sha)
        return {**scan_cache[sha], "cached": True, "file_path": str(path)}

    timeout = req.timeout or KSE_TIMEOUT
    async with httpx.AsyncClient(verify=KSE_VERIFY_TLS, timeout=timeout + 30) as client:
        resp = await client.post(
            f"{KSE_URL}/api/v3.0/scanfile",
            headers=kse_headers(),
            json={"timeout": str(timeout * 1000), "object": str(path)},
        )
        resp.raise_for_status()
        data = resp.json()

    verdict = normalize_verdict(data.get("scanResult"))
    result: dict[str, Any] = {
        "request_id": request_id,
        "file_path": str(path),
        "sha256": sha,
        "size": path.stat().st_size,
        "verdict": verdict,
        "detection_name": data.get("detectionName", "") or "",
        "quarantined": False,
        "scanned_at": utcnow(),
    }

    if verdict == "DETECT":
        dst = quarantine_file(path, sha)
        if dst is not None:
            result["quarantine_path"] = str(dst)
            result["quarantined"] = True

    scan_cache[sha] = result
    audit(
        "scan_file",
        request_id=request_id,
        file_path=str(path),
        sha256=sha,
        verdict=verdict,
        detection_name=result["detection_name"],
        quarantined=result["quarantined"],
    )
    return result


@app.post("/scan/upload")
async def scan_upload(
    file: UploadFile = File(...),
    filename: str | None = None,
    timeout: int = 300,
) -> dict[str, Any]:
    """扫描上传的文件内容. 先落盘到扫描队列, 再走路径扫描.

    这是 Windows 端 Plugin / File Watcher 的统一入口:
    跨机器调用无法使用 KSE 的路径扫描 (KSE 会拒绝远程路径请求),
    因此必须由本机网关落盘后再扫描.
    """
    request_id = uuid.uuid4().hex[:12]
    safe_name = Path(filename or file.filename or "upload.bin").name
    safe_name = f"{int(time.time())}_{safe_name}"
    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    target = SCAN_QUEUE / safe_name

    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_FILE_SIZE} bytes)")
    with open(target, "wb") as f:
        f.write(contents)

    result = await scan_file(ScanFileRequest(file_path=str(target), timeout=timeout))
    audit(
        "scan_upload",
        request_id=request_id,
        original_name=file.filename,
        **{
            k: result[k]
            for k in ("file_path", "sha256", "verdict", "detection_name", "quarantined")
            if k in result
        },
    )
    return result


@app.post("/scan/directory")
async def scan_directory(
    dir_path: str,
    recursive: bool = True,
    timeout: int = 120,
) -> dict[str, Any]:
    """批量扫描目录下的所有文件."""
    p = Path(dir_path)
    if not p.is_dir():
        raise HTTPException(404, f"目录不存在: {dir_path}")
    p = assert_allowed(p)

    results: list[dict[str, Any]] = []
    files = p.rglob("*") if recursive else p.glob("*")
    for f in files:
        if not f.is_file():
            continue
        try:
            results.append(await scan_file(ScanFileRequest(file_path=str(f), timeout=timeout)))
        except HTTPException as exc:
            results.append(
                {"file_path": str(f), "verdict": "SKIPPED", "error": str(exc.detail)}
            )

    threats = [r for r in results if r.get("verdict") == "DETECT"]
    summary = {
        "total": len(results),
        "threats_count": len(threats),
        "threats": threats,
        "all_clean": len(threats) == 0,
    }
    audit("scan_directory", dir_path=str(p), **{
        "total": summary["total"],
        "threats_count": summary["threats_count"],
    })
    return summary
