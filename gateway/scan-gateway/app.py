"""KSE Scan Gateway — Kaspersky Scan Engine 封装层.

职责:
  1. 路径白名单校验, 拒绝任意路径扫描 (防止越权读取)
  2. SHA-256 结果缓存, 避免同一文件重复消耗扫描时间
  3. 检出威胁 (DETECT) 自动移入隔离区, 并写入元数据 sidecar
  4. 全链路审计日志 (JSON Lines)

端点:
  POST /scan/file       扫描本机文件 (路径扫描)
  POST /scan/upload     上传文件内容扫描 (跨机器调用的统一入口)
  POST /scan/package    压缩包解包逐文件深度扫描 (Skill / 插件包)
  POST /scan/url        URL 扫描 (钓鱼 / 恶意链接)
  POST /scan/directory  批量扫描目录
  GET  /health          健康检查
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tarfile
import tempfile
import time
import uuid
import zipfile
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

# 压缩包解包保护
MAX_ARCHIVE_MEMBERS: int = int(os.getenv("MAX_ARCHIVE_MEMBERS", "5000"))
MAX_ARCHIVE_UNPACKED: int = int(os.getenv("MAX_ARCHIVE_UNPACKED", str(500 * 1024 * 1024)))
MAX_COMPRESSION_RATIO: int = int(os.getenv("MAX_COMPRESSION_RATIO", "100"))


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

app = FastAPI(title="KSE Scan Gateway", version="1.1.0")


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
    if value in ("DETECT", "INFECTED", "INFECTED_ERROR", "VIRUS", "MALWARE", "PHISHING"):
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


def quarantine_file(path: Path, sha: str, detection_name: str = "") -> Path | None:
    """把检出威胁的文件移入隔离区, 并写入元数据 sidecar.

    命名: {sha256}_{时间戳}_{原文件名}
    元数据: {sha256}_{时间戳}_{原文件名}.meta.json
    """
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
    except Exception as exc:  # pragma: no cover
        audit("quarantine_failed", file_path=str(path), error=str(exc))
        return None


def kse_scan_file(path: Path, timeout: int) -> dict[str, Any]:
    """调用 KSE 路径扫描 API."""
    with httpx.Client(verify=KSE_VERIFY_TLS, timeout=timeout + 30) as client:
        resp = client.post(
            f"{KSE_URL}/api/v3.0/scanfile",
            headers=kse_headers(),
            json={"timeout": str(timeout * 1000), "object": str(path)},
        )
        resp.raise_for_status()
        return resp.json()


def kse_check_url(url: str, timeout: int) -> dict[str, Any]:
    """调用 KSE URL 扫描 API (checkurl)."""
    with httpx.Client(verify=KSE_VERIFY_TLS, timeout=timeout + 30) as client:
        resp = client.post(
            f"{KSE_URL}/api/v3.0/checkurl",
            headers=kse_headers(),
            json={"timeout": str(timeout * 1000), "object": url},
        )
        resp.raise_for_status()
        return resp.json()


def parse_url_scan(data: dict[str, Any]) -> tuple[str, str]:
    """从 KSE checkurl 响应中提取判定与检测名."""
    verdict = normalize_verdict(data.get("scanResult") or data.get("ScanResult"))
    detection = (
        data.get("detectionName")
        or data.get("DetectionName")
        or data.get("threatName")
        or ""
    )
    # checkurl 可能返回 urlInfo 结构
    url_info = data.get("urlInfo") or data.get("UrlInfo") or {}
    if isinstance(url_info, dict):
        detection = detection or url_info.get("ThreatName") or url_info.get("detectionName") or ""
    return verdict, detection


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
class ScanFileRequest(BaseModel):
    file_path: str
    timeout: int = 120


class ScanUrlRequest(BaseModel):
    url: str
    timeout: int = 60


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
    try:
        data = kse_scan_file(path, timeout)
    except httpx.HTTPStatusError as exc:
        detail = f"KSE 返回错误 {exc.response.status_code}: {exc.response.text[:200]}"
        audit("scan_error", request_id=request_id, file_path=str(path), error=detail)
        raise HTTPException(502, detail) from exc

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
        file_path=result.get("file_path"),
        sha256=result.get("sha256"),
        verdict=result.get("verdict"),
        detection_name=result.get("detection_name"),
        quarantined=result.get("quarantined"),
    )
    return result


# --------------------------------------------------------------------------
# 压缩包深度扫描 (Skill / 插件包)
# --------------------------------------------------------------------------
def _is_within(base: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def safe_extract(archive: Path, dest: Path) -> list[Path]:
    """安全解压, 防 Zip Slip / Zip Bomb. 返回解压出的文件列表."""
    members: list[Path] = []
    total_unpacked = 0

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ARCHIVE_MEMBERS:
                raise HTTPException(
                    413, f"压缩包成员过多 ({len(infos)} > {MAX_ARCHIVE_MEMBERS})，疑似压缩包炸弹"
                )
            compressed_total = sum(i.compress_size for i in infos) or 1
            unpacked_total = sum(i.file_size for i in infos)
            if unpacked_total > MAX_ARCHIVE_UNPACKED:
                raise HTTPException(
                    413, f"压缩包解压后体积过大 ({unpacked_total} > {MAX_ARCHIVE_UNPACKED})"
                )
            if unpacked_total / compressed_total > MAX_COMPRESSION_RATIO:
                raise HTTPException(
                    413,
                    f"压缩比异常 ({unpacked_total / compressed_total:.1f} > {MAX_COMPRESSION_RATIO})，疑似压缩包炸弹",
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
                total_unpacked += info.file_size
    elif tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            infos = tf.getmembers()
            if len(infos) > MAX_ARCHIVE_MEMBERS:
                raise HTTPException(413, f"压缩包成员过多 ({len(infos)})，疑似压缩包炸弹")
            for info in infos:
                out = dest / info.name
                if not _is_within(dest, out):
                    raise HTTPException(400, f"压缩包包含非法路径: {info.name}")
                if info.isdir():
                    continue
                if info.issym() or info.islnk():
                    continue
                out.parent.mkdir(parents=True, exist_ok=True)
                extracted = tf.extractfile(info)
                if extracted is None:
                    continue
                with extracted, open(out, "wb") as dst_f:
                    shutil.copyfileobj(extracted, dst_f)
                members.append(out)
                total_unpacked += info.size
                if total_unpacked > MAX_ARCHIVE_UNPACKED:
                    raise HTTPException(413, "压缩包解压后体积过大，疑似压缩包炸弹")
    else:
        raise HTTPException(400, "不支持的压缩格式 (仅支持 zip / tar 系列)")

    return members


@app.post("/scan/package")
async def scan_package(
    file: UploadFile = File(...),
    filename: str | None = None,
    timeout: int = 300,
) -> dict[str, Any]:
    """Skill / 插件包深度扫描: 解包后逐文件扫描, 任一命中则整包隔离.

    用于拦截 "压缩包内单个文件带毒" 的场景 —— 单纯的整包扫描容易被免杀。
    """
    request_id = uuid.uuid4().hex[:12]
    original_name = Path(filename or file.filename or "package.zip").name
    contents = await file.read()
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(413, f"压缩包超过大小上限 ({MAX_FILE_SIZE} bytes)")

    SCAN_QUEUE.mkdir(parents=True, exist_ok=True)
    archive_path = SCAN_QUEUE / f"{int(time.time())}_{original_name}"
    with open(archive_path, "wb") as f:
        f.write(contents)

    workdir = Path(tempfile.mkdtemp(prefix="pkgscan_", dir=str(SCAN_QUEUE)))
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
                r = await scan_file(ScanFileRequest(file_path=str(member), timeout=timeout))
            except HTTPException as exc:
                results.append(
                    {
                        "file_path": str(member),
                        "verdict": "SKIPPED",
                        "error": str(exc.detail),
                    }
                )
                continue
            results.append(r)
            if r.get("verdict") == "DETECT":
                threats.append(r)

        overall = "DETECT" if threats else "CLEAN"
        sha = sha256_file(archive_path)
        response: dict[str, Any] = {
            "request_id": request_id,
            "package_name": original_name,
            "sha256": sha,
            "size": len(contents),
            "members_total": len(members),
            "members_scanned": len(results),
            "verdict": overall,
            "threats_count": len(threats),
            "threats": threats,
            "quarantined": False,
            "scanned_at": utcnow(),
        }

        if overall == "DETECT":
            # 整包隔离 (解包出来的成员已被逐个隔离, 这里再隔离原始包)
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
        return response
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


@app.post("/scan/url")
async def scan_url(req: ScanUrlRequest) -> dict[str, Any]:
    """URL 扫描: 钓鱼站点、恶意跳转链接."""
    request_id = uuid.uuid4().hex[:12]
    url = req.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https URL")

    timeout = req.timeout or 60
    try:
        data = kse_check_url(url, timeout)
    except httpx.HTTPStatusError as exc:
        detail = f"KSE 返回错误 {exc.response.status_code}: {exc.response.text[:200]}"
        audit("scan_url_error", request_id=request_id, url=url, error=detail)
        raise HTTPException(502, detail) from exc
    except httpx.HTTPError as exc:
        detail = f"KSE 连接失败: {exc}"
        audit("scan_url_error", request_id=request_id, url=url, error=detail)
        raise HTTPException(502, detail) from exc

    verdict, detection = parse_url_scan(data)
    result = {
        "request_id": request_id,
        "url": url,
        "verdict": verdict,
        "detection_name": detection,
        "raw": data,
        "scanned_at": utcnow(),
    }
    audit(
        "scan_url",
        request_id=request_id,
        url=url,
        verdict=verdict,
        detection_name=detection,
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
    audit(
        "scan_directory",
        dir_path=str(p),
        total=summary["total"],
        threats_count=summary["threats_count"],
    )
    return summary
