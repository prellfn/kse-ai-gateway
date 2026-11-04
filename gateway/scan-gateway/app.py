"""KSE Scan Gateway — Kaspersky Scan Engine 封装层 (零依赖标准库实现).

职责:
  1. 路径白名单校验, 拒绝任意路径扫描 (防止越权读取)
  2. SHA-256 结果缓存, 避免同一文件重复消耗扫描时间
  3. 检出威胁 (DETECT) 自动移入隔离区, 并写入元数据 sidecar
  4. 全链路审计日志 (JSON Lines)

端点:
  POST /scan/file       扫描本机文件
  POST /scan/upload     上传文件内容扫描 (跨机器调用的统一入口)
  POST /scan/package    压缩包解包逐文件深度扫描 (Skill / 插件包)
  POST /scan/url        URL 扫描 (钓鱼 / 恶意链接)
  POST /scan/directory  批量扫描目录
  GET  /health          健康检查
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import sys
import tarfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.kse import KseClient, KseError  # noqa: E402
from common.kserver import App, HTTPException, JSONResponse, Request, run  # noqa: E402

# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------
KSE_URL: str = os.getenv("KSE_URL", "http://127.0.0.1:8443")
KSE_TOKEN: str = os.getenv("KSE_TOKEN", "")
KSE_MODE: str = os.getenv("KSE_MODE", "auto")          # auto | file | memory
KSE_TIMEOUT: int = int(os.getenv("KSE_TIMEOUT", "120"))
KSE_VERIFY_TLS: bool = os.getenv("KSE_VERIFY_TLS", "false").lower() in ("1", "true", "yes")

SCAN_QUEUE: Path = Path(os.getenv("SCAN_QUEUE", "/opt/kaspersky/scanqueue"))
QUARANTINE: Path = Path(os.getenv("QUARANTINE", "/opt/kaspersky/quarantine"))
MAX_FILE_SIZE: int = int(os.getenv("MAX_FILE_SIZE", str(100 * 1024 * 1024)))
AUDIT_LOG: Path = Path(os.getenv("AUDIT_LOG", "/opt/ai-stack/scan-gateway/logs/audit.jsonl"))

MAX_ARCHIVE_MEMBERS: int = int(os.getenv("MAX_ARCHIVE_MEMBERS", "5000"))
MAX_ARCHIVE_UNPACKED: int = int(os.getenv("MAX_ARCHIVE_UNPACKED", str(500 * 1024 * 1024)))
MAX_COMPRESSION_RATIO: int = int(os.getenv("MAX_COMPRESSION_RATIO", "100"))

kse = KseClient(
    url=KSE_URL,
    token=KSE_TOKEN,
    mode=KSE_MODE,
    timeout=KSE_TIMEOUT,
    verify_tls=KSE_VERIFY_TLS,
)

scan_cache: dict[str, dict[str, Any]] = {}
app = App(title="KSE Scan Gateway", version="1.2.0")


# --------------------------------------------------------------------------
# 工具
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
    record = {"ts": utcnow(), "event": event, **fields}
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass


def allowed_dirs() -> list[Path]:
    raw = os.getenv("ALLOWED_SCAN_DIRS", "").strip()
    dirs: list[Path] = []
    for candidate in [SCAN_QUEUE, *[Path(i.strip()) for i in raw.split(",") if i.strip()]]:
        resolved = candidate.resolve()
        if resolved not in dirs:
            dirs.append(resolved)
    return dirs


def assert_allowed(path: Path) -> Path:
    resolved = path.resolve()
    for allowed in allowed_dirs():
        try:
            resolved.relative_to(allowed)
            return resolved
        except ValueError:
            continue
    raise HTTPException(403, f"路径不在允许的扫描目录内: {path}")


def quarantine_file(path: Path, sha: str, detection_name: str = "") -> Path | None:
    """把检出威胁的文件移入隔离区, 并写入元数据 sidecar."""
    try:
        QUARANTINE.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time())
        dst = QUARANTINE / f"{sha}_{stamp}_{path.name}"
        shutil.move(str(path), str(dst))
        meta = {
            "quarantine_id": dst.name,
            "original_name": path.name,
            "original_path": str(path),
            "sha256": sha,
            "size": dst.stat().st_size if dst.exists() else 0,
            "detection_name": detection_name,
            "quarantined_at": utcnow(),
            "status": "pending_review",
        }
        (QUARANTINE / f"{dst.name}.meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return dst
    except Exception as exc:
        audit("quarantine_failed", file_path=str(path), error=str(exc))
        return None


def scan_path(path: Path, timeout: int) -> dict[str, Any]:
    """调用 KSE 扫描一个本机文件, 统一异常."""
    try:
        return kse.scan_path(path, timeout=timeout)
    except KseError as exc:
        raise HTTPException(502, f"KSE 调用失败: {exc}") from exc


def scan_bytes(content: bytes, timeout: int) -> dict[str, Any]:
    try:
        return kse.scan_bytes(content, timeout=timeout)
    except KseError as exc:
        raise HTTPException(502, f"KSE 调用失败: {exc}") from exc


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/health")
def health(req: Request) -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "kse_url": KSE_URL,
            "kse_mode": KSE_MODE,
            "kse_mode_used": kse.last_mode_used,
            "kse_auth": "token" if KSE_TOKEN else "none",
            "scan_queue": str(SCAN_QUEUE),
            "quarantine": str(QUARANTINE),
            "allowed_dirs": [str(d) for d in allowed_dirs()],
            "cache_size": len(scan_cache),
            "time": utcnow(),
        }
    )


@app.post("/scan/file")
def scan_file(req: Request) -> JSONResponse:
    """扫描本机文件 (路径白名单内)."""
    payload = req.json()
    file_path = payload.get("file_path", "")
    timeout = int(payload.get("timeout") or KSE_TIMEOUT)
    if not file_path:
        raise HTTPException(400, "缺少 file_path")

    request_id = uuid.uuid4().hex[:12]
    path = Path(file_path)
    if not path.exists() or not path.is_file():
        raise HTTPException(404, f"文件不存在: {file_path}")
    if path.stat().st_size > MAX_FILE_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_FILE_SIZE} bytes)")

    path = assert_allowed(path)
    sha = sha256_file(path)

    if sha in scan_cache:
        audit("scan_cached", request_id=request_id, file_path=str(path), sha256=sha)
        return JSONResponse({**scan_cache[sha], "cached": True, "file_path": str(path)})

    kse_result = scan_path(path, timeout)
    verdict = kse_result["verdict"]
    result: dict[str, Any] = {
        "request_id": request_id,
        "file_path": str(path),
        "sha256": sha,
        "size": path.stat().st_size,
        "verdict": verdict,
        "detection_name": kse_result["detection_name"],
        "scan_mode": kse_result["mode"],
        "quarantined": False,
        "scanned_at": utcnow(),
    }

    if verdict == "DETECT":
        dst = quarantine_file(path, sha, result["detection_name"])
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
        scan_mode=result["scan_mode"],
        quarantined=result["quarantined"],
    )
    return JSONResponse(result)


@app.post("/scan/upload")
def scan_upload(req: Request) -> JSONResponse:
    """上传文件内容扫描. 跨机器调用的统一入口."""
    request_id = uuid.uuid4().hex[:12]
    files = req.files
    if "file" not in files:
        raise HTTPException(400, "缺少上传文件 (字段名: file)")
    upload = files["file"]
    content = upload.file
    timeout = int(req.form.get("timeout") or 300)

    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(413, f"文件超过大小上限 ({MAX_FILE_SIZE} bytes)")

    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    target = SCAN_QUEUE / f"{int(time.time())}_{Path(upload.filename or 'upload.bin').name}"
    with open(target, "wb") as f:
        f.write(content)

    kse_result = scan_bytes(content, timeout)
    sha = hashlib.sha256(content).hexdigest()
    verdict = kse_result["verdict"]
    result: dict[str, Any] = {
        "request_id": request_id,
        "file_path": str(target),
        "sha256": sha,
        "size": len(content),
        "verdict": verdict,
        "detection_name": kse_result["detection_name"],
        "scan_mode": kse_result["mode"],
        "quarantined": False,
        "scanned_at": utcnow(),
    }

    if verdict == "DETECT":
        dst = quarantine_file(target, sha, result["detection_name"])
        if dst is not None:
            result["quarantine_path"] = str(dst)
            result["quarantined"] = True

    scan_cache[sha] = result
    audit(
        "scan_upload",
        request_id=request_id,
        original_name=upload.filename,
        file_path=str(target),
        sha256=sha,
        verdict=verdict,
        detection_name=result["detection_name"],
        quarantined=result["quarantined"],
    )
    return JSONResponse(result)


# --------------------------------------------------------------------------
# 压缩包深度扫描
# --------------------------------------------------------------------------
def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def safe_extract(archive: Path, dest: Path) -> list[Path]:
    """安全解压, 防 Zip Slip / Zip Bomb."""
    members: list[Path] = []
    total = 0

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ARCHIVE_MEMBERS:
                raise HTTPException(413, f"压缩包成员过多 ({len(infos)}), 疑似压缩包炸弹")
            compressed = sum(i.compress_size for i in infos) or 1
            unpacked = sum(i.file_size for i in infos)
            if unpacked > MAX_ARCHIVE_UNPACKED:
                raise HTTPException(413, f"压缩包解压后体积过大 ({unpacked} > {MAX_ARCHIVE_UNPACKED})")
            if unpacked / compressed > MAX_COMPRESSION_RATIO:
                raise HTTPException(
                    413,
                    f"压缩比异常 ({unpacked / compressed:.1f} > {MAX_COMPRESSION_RATIO}), 疑似压缩包炸弹",
                )
            for info in infos:
                out = dest / info.filename
                if not _is_within(dest, out):
                    raise HTTPException(400, f"压缩包包含非法路径: {info.filename}")
                if info.is_dir():
                    out.mkdir(parents=True, exist_ok=True)
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, open(out, "wb") as dst_f:
                    shutil.copyfileobj(src, dst_f)
                members.append(out)
                total += info.file_size
    elif tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            infos = tf.getmembers()
            if len(infos) > MAX_ARCHIVE_MEMBERS:
                raise HTTPException(413, f"压缩包成员过多 ({len(infos)}), 疑似压缩包炸弹")
            for info in infos:
                out = dest / info.name
                if not _is_within(dest, out):
                    raise HTTPException(400, f"压缩包包含非法路径: {info.name}")
                if info.isdir() or info.issym() or info.islnk():
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                extracted = tf.extractfile(info)
                if extracted is None:
                    continue
                with extracted, open(out, "wb") as dst_f:
                    shutil.copyfileobj(extracted, dst_f)
                members.append(out)
                total += info.size
                if total > MAX_ARCHIVE_UNPACKED:
                    raise HTTPException(413, "压缩包解压后体积过大, 疑似压缩包炸弹")
    else:
        raise HTTPException(400, "不支持的压缩格式 (仅支持 zip / tar 系列)")

    return members


@app.post("/scan/package")
def scan_package(req: Request) -> JSONResponse:
    """Skill / 插件包深度扫描: 解包后逐文件扫描, 任一命中则整包隔离."""
    request_id = uuid.uuid4().hex[:12]
    files = req.files
    if "file" not in files:
        raise HTTPException(400, "缺少上传文件 (字段名: file)")
    upload = files["file"]
    original_name = Path(upload.filename or "package.zip").name
    content = upload.file
    timeout = int(req.form.get("timeout") or 300)

    if len(content) > MAX_ARCHIVE_UNPACKED:
        raise HTTPException(413, f"压缩包超过大小上限 ({MAX_ARCHIVE_UNPACKED} bytes)")

    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    archive_path = SCAN_QUEUE / f"{int(time.time())}_{original_name}"
    with open(archive_path, "wb") as f:
        f.write(content)

    # 注意: 不要用 tempfile.mkdtemp —— 它在 Windows 上会设置受保护 ACL,
    # 导致无法在其中创建子文件 (Linux 无此问题, 但这里保持跨平台一致)
    workdir = SCAN_QUEUE / f"pkgscan_{uuid.uuid4().hex[:12]}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(workdir, 0o700)
    except OSError:
        pass
    try:
        try:
            members = safe_extract(archive_path, workdir)
        except HTTPException:
            archive_path.unlink(missing_ok=True)
            raise

        results: list[dict[str, Any]] = []
        threats: list[dict[str, Any]] = []
        for member in members:
            try:
                kse_result = scan_path(member, timeout)
            except HTTPException as exc:
                results.append({"file_path": str(member), "verdict": "SKIPPED", "error": exc.detail})
                continue
            entry = {
                "file_path": str(member),
                "verdict": kse_result["verdict"],
                "detection_name": kse_result["detection_name"],
            }
            results.append(entry)
            if entry["verdict"] == "DETECT":
                threats.append(entry)

        overall = "DETECT" if threats else "CLEAN"
        sha = sha256_file(archive_path)
        response: dict[str, Any] = {
            "request_id": request_id,
            "package_name": original_name,
            "sha256": sha,
            "size": len(content),
            "members_total": len(members),
            "members_scanned": len(results),
            "verdict": overall,
            "threats_count": len(threats),
            "threats": threats,
            "quarantined": False,
            "scanned_at": utcnow(),
        }

        if overall == "DETECT":
            dst = quarantine_file(archive_path, sha, threats[0].get("detection_name", ""))
            if dst is not None:
                response["quarantine_path"] = str(dst)
                response["quarantined"] = True
        else:
            archive_path.unlink(missing_ok=True)

        audit(
            "scan_package",
            request_id=request_id,
            package_name=original_name,
            sha256=sha,
            verdict=overall,
            members_total=len(members),
            threats_count=len(threats),
            quarantined=response["quarantined"],
        )
        return JSONResponse(response)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/scan/url")
def scan_url(req: Request) -> JSONResponse:
    """URL 扫描: 钓鱼站点、恶意跳转链接."""
    request_id = uuid.uuid4().hex[:12]
    payload = req.json()
    url = str(payload.get("url", "")).strip()
    timeout = int(payload.get("timeout") or 60)
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https URL")

    try:
        result = kse.scan_url(url, timeout=timeout)
    except KseError as exc:
        audit("scan_url_error", request_id=request_id, url=url, error=str(exc))
        raise HTTPException(502, str(exc)) from exc

    payload_out = {
        "request_id": request_id,
        "url": url,
        "verdict": result["verdict"],
        "detection_name": result["detection_name"],
        "raw": result["raw"],
        "scanned_at": utcnow(),
    }
    audit(
        "scan_url",
        request_id=request_id,
        url=url,
        verdict=result["verdict"],
        detection_name=result["detection_name"],
    )
    return JSONResponse(payload_out)


@app.post("/scan/directory")
def scan_directory(req: Request) -> JSONResponse:
    """批量扫描目录下的所有文件."""
    payload = req.json()
    dir_path = payload.get("dir_path", "")
    recursive = bool(payload.get("recursive", True))
    timeout = int(payload.get("timeout") or KSE_TIMEOUT)
    if not dir_path:
        raise HTTPException(400, "缺少 dir_path")

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
            kse_result = scan_path(f, timeout)
        except HTTPException as exc:
            results.append({"file_path": str(f), "verdict": "SKIPPED", "error": exc.detail})
            continue
        results.append(
            {
                "file_path": str(f),
                "verdict": kse_result["verdict"],
                "detection_name": kse_result["detection_name"],
            }
        )

    threats = [r for r in results if r.get("verdict") == "DETECT"]
    summary = {
        "total": len(results),
        "threats_count": len(threats),
        "threats": threats,
        "all_clean": len(threats) == 0,
    }
    audit("scan_directory", dir_path=str(p), total=summary["total"], threats_count=summary["threats_count"])
    return JSONResponse(summary)


if __name__ == "__main__":
    run(app, os.getenv("LISTEN_HOST", "0.0.0.0"), int(os.getenv("LISTEN_PORT", "8000")))
