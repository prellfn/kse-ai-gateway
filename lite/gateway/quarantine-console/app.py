"""隔离区 Web 复核台 — 人工复核被 KSE 隔离的文件 (零依赖标准库实现).

功能:
  - 列出隔离区文件 (读取 Scan Gateway 写入的 .meta.json sidecar)
  - 查看威胁名称、SHA-256、原始路径、大小、时间
  - 重新扫描 (验证误报)
  - 恢复到原始路径 (人工确认安全后)
  - 永久删除 / 标记结论
  - 查看网关审计流水与威胁统计

端口: 8004
⚠️  本服务默认无鉴权, 请仅部署在内网, 或置于反向代理 (Nginx + Basic Auth / mTLS) 之后。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.kserver import App, HTTPException, HTMLResponse, JSONResponse, Request, run  # noqa: E402

SCAN_GATEWAY: str = os.getenv("SCAN_GATEWAY", "http://127.0.0.1:8000").rstrip("/")
QUARANTINE: Path = Path(os.getenv("QUARANTINE", "/opt/kaspersky/quarantine"))
AUDIT_LOG: Path = Path(os.getenv("AUDIT_LOG", "/opt/ai-stack/scan-gateway/logs/audit.jsonl"))
TEMPLATE_DIR: Path = Path(os.getenv("TEMPLATE_DIR", "templates"))
MAX_AUDIT_LINES: int = int(os.getenv("MAX_AUDIT_LINES", "2000"))

app = App(title="KSE 隔离区复核台", version="1.2.0")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _meta_path(item: Path) -> Path:
    return item.with_name(item.name + ".meta.json")


def _safe_name(name: str) -> str:
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


def _post_scan(file_path: str, timeout: int = 300) -> dict:
    body = json.dumps({"file_path": file_path, "timeout": timeout}).encode()
    req = urllib.request.Request(
        f"{SCAN_GATEWAY}/scan/file",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout + 60) as resp:
            return json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        raise HTTPException(exc.code, f"Scan Gateway 返回 {exc.code}: {str(detail)[:300]}") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(502, f"无法连接 Scan Gateway: {exc.reason}") from exc


@app.get("/")
def index(req: Request) -> HTMLResponse:
    return HTMLResponse((TEMPLATE_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/health")
def health(req: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "scan_gateway": SCAN_GATEWAY,
            "quarantine": str(QUARANTINE),
            "items": len(_list_items()),
        }
    )


@app.get("/api/quarantine")
def list_quarantine(req: Request) -> JSONResponse:
    items = _list_items()
    status = req.q("status")
    keyword = (req.q("q") or "").lower()
    if status:
        items = [i for i in items if i.get("status") == status]
    if keyword:
        items = [
            i
            for i in items
            if keyword in i.get("original_name", "").lower()
            or keyword in i.get("detection_name", "").lower()
            or keyword in i.get("sha256", "").lower()
        ]
    return JSONResponse({"total": len(items), "items": items})


@app.get("/api/quarantine/{quarantine_id}")
def get_item(req: Request) -> JSONResponse:
    path = _find_item(req.params["quarantine_id"])
    meta = _load_meta(path)
    meta["mtime"] = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    return JSONResponse(meta)


@app.post("/api/quarantine/{quarantine_id}/rescan")
def rescan(req: Request) -> JSONResponse:
    path = _find_item(req.params["quarantine_id"])
    result = _post_scan(str(path))
    _audit("quarantine_rescan", quarantine_id=path.name, verdict=result.get("verdict"))
    return JSONResponse(result)


@app.post("/api/quarantine/{quarantine_id}/restore")
def restore(req: Request) -> JSONResponse:
    path = _find_item(req.params["quarantine_id"])
    meta = _load_meta(path)
    dest_str = req.q("target_path") or meta.get("original_path") or ""
    if not dest_str:
        raise HTTPException(400, "缺少原始路径, 请通过 target_path 指定恢复目标")

    dest = Path(dest_str).expanduser()
    if not dest.is_absolute():
        raise HTTPException(400, "恢复目标必须是绝对路径")
    if ".." in dest.parts:
        raise HTTPException(400, "恢复目标包含非法路径")

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(dest))
    except OSError as exc:
        raise HTTPException(500, f"恢复失败: {exc}") from exc

    _meta_path(path).unlink(missing_ok=True)
    _audit("quarantine_restored", quarantine_id=path.name, restored_to=str(dest))
    return JSONResponse({"status": "restored", "quarantine_id": path.name, "restored_to": str(dest)})


@app.post("/api/quarantine/{quarantine_id}/mark")
def mark(req: Request) -> JSONResponse:
    status = req.q("status", "false_positive")
    if status not in ("false_positive", "confirmed_threat", "pending_review"):
        raise HTTPException(400, f"非法状态: {status}")
    path = _find_item(req.params["quarantine_id"])
    meta = _load_meta(path)
    meta["status"] = status
    meta["reviewed_at"] = utcnow()
    _meta_path(path).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    _audit("quarantine_marked", quarantine_id=path.name, status=status)
    return JSONResponse(meta)


@app.delete("/api/quarantine/{quarantine_id}")
def delete(req: Request) -> JSONResponse:
    path = _find_item(req.params["quarantine_id"])
    size = path.stat().st_size
    try:
        path.unlink()
    except OSError as exc:
        raise HTTPException(500, f"删除失败: {exc}") from exc
    _meta_path(path).unlink(missing_ok=True)
    _audit("quarantine_deleted", quarantine_id=path.name, size=size)
    return JSONResponse({"status": "deleted", "quarantine_id": path.name, "size": size})


@app.get("/api/audit")
def audit(req: Request) -> JSONResponse:
    limit = int(req.q("limit", 100) or 100)
    limit = max(1, min(limit, 5000))
    if not AUDIT_LOG.is_file():
        return JSONResponse({"total": 0, "records": []})
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
    return JSONResponse({"total": len(records), "records": records})


@app.get("/api/stats")
def stats(req: Request) -> JSONResponse:
    items = _list_items()
    by_threat: dict[str, int] = {}
    by_status: dict[str, int] = {}
    total_size = 0
    for i in items:
        name = i.get("detection_name") or "未知"
        by_threat[name] = by_threat.get(name, 0) + 1
        st = i.get("status", "pending_review")
        by_status[st] = by_status.get(st, 0) + 1
        total_size += int(i.get("size") or 0)
    return JSONResponse(
        {
            "total_items": len(items),
            "total_size": total_size,
            "by_threat": by_threat,
            "by_status": by_status,
            "quarantine_dir": str(QUARANTINE),
            "generated_at": utcnow(),
        }
    )


if __name__ == "__main__":
    run(app, os.getenv("LISTEN_HOST", "0.0.0.0"), int(os.getenv("LISTEN_PORT", "8004")))
