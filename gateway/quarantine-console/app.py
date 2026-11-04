"""隔离区 Web 复核台 — 人工复核被 KSE 隔离的文件.

功能:
  - 列出隔离区文件 (读取 Scan Gateway 写入的 .meta.json sidecar)
  - 查看威胁名称、SHA-256、原始路径、大小、时间
  - 重新扫描 (验证误报)
  - 恢复到原始路径 (人工确认安全后)
  - 永久删除
  - 查看网关审计流水与威胁统计

端口: 8004
⚠️  本服务默认无鉴权, 请仅部署在内网, 或置于反向代理 (Nginx + Basic Auth / mTLS) 之后。
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse

SCAN_GATEWAY: str = os.getenv("SCAN_GATEWAY", "http://127.0.0.1:8000").rstrip("/")
QUARANTINE: Path = Path(os.getenv("QUARANTINE", "/opt/kaspersky/quarantine"))
AUDIT_LOG: Path = Path(os.getenv("AUDIT_LOG", "/opt/ai-stack/scan-gateway/logs/audit.jsonl"))
TEMPLATE_DIR: Path = Path(os.getenv("TEMPLATE_DIR", "templates"))
MAX_AUDIT_LINES: int = int(os.getenv("MAX_AUDIT_LINES", "2000"))
RESTORE_MAX_AGE_DAYS: int = int(os.getenv("RESTORE_MAX_AGE_DAYS", "30"))

app = FastAPI(title="KSE 隔离区复核台", version="1.0.0")


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------
def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _meta_path(item: Path) -> Path:
    return item.with_name(item.name + ".meta.json")


def _safe_name(name: str) -> str:
    """防止路径穿越: 只允许纯文件名."""
    if "/" in name or "\\" in name or ".." in name or not name:
        raise HTTPException(400, f"非法文件名: {name}")
    return name


def _load_meta(item: Path) -> dict[str, Any]:
    meta_path = _meta_path(item)
    if meta_path.is_file():
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    # 无 sidecar 时从文件名推断: {sha256}_{时间戳}_{原名}
    parts = item.name.split("_", 2)
    return {
        "quarantine_id": item.name,
        "original_name": parts[2] if len(parts) > 2 else item.name,
        "original_path": "",
        "sha256": parts[0] if parts else "",
        "size": item.stat().st_size if item.exists() else 0,
        "detection_name": "未知威胁",
        "quarantined_at": datetime.fromtimestamp(item.stat().st_mtime, timezone.utc).isoformat(
            timespec="seconds"
        ),
        "status": "pending_review",
    }


def _list_items() -> list[dict[str, Any]]:
    if not QUARANTINE.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for entry in sorted(QUARANTINE.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if entry.is_dir() or entry.name.endswith(".meta.json"):
            continue
        meta = _load_meta(entry)
        meta["size"] = entry.stat().st_size
        meta["mtime"] = datetime.fromtimestamp(entry.stat().st_mtime, timezone.utc).isoformat(
            timespec="seconds"
        )
        meta["exists"] = True
        items.append(meta)
    return items


def _find_item(quarantine_id: str) -> Path:
    name = _safe_name(quarantine_id)
    path = QUARANTINE / name
    if not path.is_file():
        raise HTTPException(404, f"隔离文件不存在: {name}")
    return path


def _audit(event: str, **fields: Any) -> None:
    record = {"ts": utcnow(), "event": event, "source": "quarantine-console", **fields}
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "scan_gateway": SCAN_GATEWAY,
        "quarantine": str(QUARANTINE),
        "items": len(_list_items()),
    }


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/api/quarantine")
async def list_quarantine(
    status: str | None = Query(None, description="按状态过滤: pending_review / restored / deleted / false_positive"),
    q: str | None = Query(None, description="按文件名或威胁名称模糊搜索"),
) -> dict[str, Any]:
    items = _list_items()
    if status:
        items = [i for i in items if i.get("status") == status]
    if q:
        needle = q.lower()
        items = [
            i
            for i in items
            if needle in i.get("original_name", "").lower()
            or needle in i.get("detection_name", "").lower()
            or needle in i.get("sha256", "").lower()
        ]
    return {"total": len(items), "items": items}


@app.get("/api/quarantine/{quarantine_id}")
async def get_item(quarantine_id: str) -> dict[str, Any]:
    path = _find_item(quarantine_id)
    meta = _load_meta(path)
    meta["mtime"] = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(
        timespec="seconds"
    )
    return meta


@app.post("/api/quarantine/{quarantine_id}/rescan")
async def rescan(quarantine_id: str) -> dict[str, Any]:
    """重新扫描隔离文件, 用于验证误报."""
    path = _find_item(quarantine_id)
    try:
        async with httpx.AsyncClient(timeout=600) as client:
            resp = await client.post(
                f"{SCAN_GATEWAY}/scan/file",
                json={"file_path": str(path), "timeout": 300},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 Scan Gateway: {exc}") from exc
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Scan Gateway 返回 {resp.status_code}: {resp.text[:300]}")
    result = resp.json()
    _audit("quarantine_rescan", quarantine_id=quarantine_id, verdict=result.get("verdict"))
    return result


@app.post("/api/quarantine/{quarantine_id}/restore")
async def restore(quarantine_id: str, target_path: str | None = Query(None)) -> dict[str, Any]:
    """恢复到原始路径 (或指定路径). 仅在人工确认安全后调用."""
    path = _find_item(quarantine_id)
    meta = _load_meta(path)

    dest_str = target_path or meta.get("original_path") or ""
    if not dest_str:
        raise HTTPException(400, "缺少原始路径，请通过 target_path 指定恢复目标")

    dest = Path(dest_str).expanduser()
    # 允许恢复到任意绝对路径, 但拒绝相对路径与路径穿越
    if not dest.is_absolute():
        raise HTTPException(400, "恢复目标必须是绝对路径")
    if ".." in dest.parts:
        raise HTTPException(400, "恢复目标包含非法路径")

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(dest))
    except OSError as exc:
        raise HTTPException(500, f"恢复失败: {exc}") from exc

    meta_path = _meta_path(path)
    if meta_path.is_file():
        meta_path.unlink(missing_ok=True)

    _audit("quarantine_restored", quarantine_id=quarantine_id, restored_to=str(dest))
    return {"status": "restored", "quarantine_id": quarantine_id, "restored_to": str(dest)}


@app.post("/api/quarantine/{quarantine_id}/mark")
async def mark(quarantine_id: str, status: str = Query("false_positive")) -> dict[str, Any]:
    """标记复核结论: false_positive / confirmed_threat / pending_review"""
    if status not in ("false_positive", "confirmed_threat", "pending_review"):
        raise HTTPException(400, f"非法状态: {status}")
    path = _find_item(quarantine_id)
    meta = _load_meta(path)
    meta["status"] = status
    meta["reviewed_at"] = utcnow()
    _meta_path(path).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    _audit("quarantine_marked", quarantine_id=quarantine_id, status=status)
    return meta


@app.delete("/api/quarantine/{quarantine_id}")
async def delete(quarantine_id: str) -> dict[str, Any]:
    """永久删除隔离文件."""
    path = _find_item(quarantine_id)
    size = path.stat().st_size
    try:
        path.unlink()
    except OSError as exc:
        raise HTTPException(500, f"删除失败: {exc}") from exc
    _meta_path(path).unlink(missing_ok=True)
    _audit("quarantine_deleted", quarantine_id=quarantine_id, size=size)
    return {"status": "deleted", "quarantine_id": quarantine_id, "size": size}


@app.get("/api/audit")
async def audit(limit: int = Query(100, ge=1, le=5000)) -> dict[str, Any]:
    """网关审计流水 (JSON Lines 尾部)."""
    if not AUDIT_LOG.is_file():
        return {"total": 0, "records": []}
    try:
        lines = AUDIT_LOG.read_text(encoding="utf-8").splitlines()
    except Exception as exc:
        raise HTTPException(500, f"读取审计日志失败: {exc}") from exc

    records: list[dict[str, Any]] = []
    for line in reversed(lines[-MAX_AUDIT_LINES:]):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue
        if len(records) >= limit:
            break
    return {"total": len(records), "records": records}


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    """威胁统计."""
    items = _list_items()
    by_threat: dict[str, int] = {}
    by_status: dict[str, int] = {}
    total_size = 0
    for i in items:
        by_threat[i.get("detection_name") or "未知"] = (
            by_threat.get(i.get("detection_name") or "未知", 0) + 1
        )
        st = i.get("status", "pending_review")
        by_status[st] = by_status.get(st, 0) + 1
        total_size += int(i.get("size") or 0)
    return {
        "total_items": len(items),
        "total_size": total_size,
        "by_threat": by_threat,
        "by_status": by_status,
        "quarantine_dir": str(QUARANTINE),
        "generated_at": utcnow(),
    }
