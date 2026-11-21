"""扫描编排：黑白名单 → 判定缓存 → KSE 引擎 → KAIP 补充规则 → 策略决策 → 隔离/事件/SIEM。"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
from pathlib import Path

from . import analyzers, db, siem
from .config import settings
from .kse import ScanResult, bases_version, engine
from .policy import get_policy

# 判定缓存：病毒库版本不变即有效；版本变化立即失效。
# 另设兜底有效期：KSN 云信誉会在病毒库不更新时变化；查不到病毒库版本时退回较短的有效期。
CACHE_MAX_TTL = 7 * 24 * 3600
CACHE_TTL_NO_BASES = 24 * 3600
cache_stats = {"hits": 0, "misses": 0, "bases": None, "since": time.time()}
_XOR = 0xAA  # 隔离文件简单混淆，避免被宿主机杀软二次处理或误执行


def _xor_copy(src_bytes: bytes) -> bytes:
    return bytes(b ^ _XOR for b in src_bytes)


def in_trusted_path(p: str, policy: dict) -> bool:
    norm = (p or "").replace("\\", "/").lower()
    for pat in policy.get("trusted_paths", []) or []:
        pat = (pat or "").replace("\\", "/").lower().strip()
        if not pat:
            continue
        rx = ".*".join(re.escape(x) for x in pat.split("*"))
        if re.search(rx, norm):
            return True
    return False


def decide(verdict: str, findings: list, policy: dict) -> str:
    enforce = policy.get("mode") == "enforce"
    if verdict == "DETECT":
        return "block" if enforce else "alert"
    if verdict == "RISK":
        if policy.get("rules_action") == "block" and enforce:
            return "block"
        return "alert"
    if verdict == "NON_SCANNED":
        return "block" if (policy.get("block_non_scanned") and enforce) else "alert"
    if verdict == "ERROR":
        return "allow" if policy.get("fail_open", True) else "block"
    return "allow"


def _bases_changed(bv: str | None):
    """病毒库版本变化：清掉旧版本的判定（已全部失效），避免缓存表无限增长。"""
    if bv and cache_stats["bases"] != bv:
        if cache_stats["bases"] is not None:
            db.execute("DELETE FROM verdict_cache WHERE bases IS NOT ?", (bv,))
        cache_stats["bases"] = bv


def cache_valid(c: dict | None, bv: str | None, now: float | None = None) -> bool:
    if not c or c["verdict"] not in ("CLEAN", "DETECT"):
        return False
    age = (now or time.time()) - c["ts"]
    if bv:
        return c.get("bases") == bv and age < CACHE_MAX_TTL
    return age < CACHE_TTL_NO_BASES


def _engine_scan(data: bytes | None, path: Path | None, name: str, url: str, sha: str) -> ScanResult:
    bv = bases_version()
    _bases_changed(bv)
    c = db.query_one("SELECT * FROM verdict_cache WHERE sha256=?", (sha,))
    if cache_valid(c, bv):
        cache_stats["hits"] += 1
        r = ScanResult(c["verdict"], detection=c["detection"] or "")
        r.raw = {"cached": True}
        return r
    cache_stats["misses"] += 1
    eng = engine()
    r = eng.scan_bytes(data, name, url) if data is not None else eng.scan_large_file(path, name, url)
    if r.verdict in ("CLEAN", "DETECT"):
        db.execute(
            "INSERT INTO verdict_cache(sha256,verdict,detection,details,ts,bases) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(sha256) DO UPDATE SET verdict=excluded.verdict, detection=excluded.detection, "
            "details=excluded.details, ts=excluded.ts, bases=excluded.bases",
            (sha, r.verdict, r.detection, json.dumps(r.sub_results, ensure_ascii=False), time.time(), bv))
    return r


def cache_info() -> dict:
    bv = bases_version()
    _bases_changed(bv)
    total = (db.query_one("SELECT COUNT(*) AS n FROM verdict_cache") or {}).get("n", 0)
    valid = (db.query_one("SELECT COUNT(*) AS n FROM verdict_cache WHERE bases IS ? AND ts > ?",
                          (bv, time.time() - CACHE_MAX_TTL)) or {}).get("n", 0) if bv else 0
    h, m = cache_stats["hits"], cache_stats["misses"]
    return {"bases": bv, "entries": total, "valid": valid, "hits": h, "misses": m,
            "hit_rate": round(h / (h + m), 3) if h + m else None, "since": cache_stats["since"],
            "max_ttl_days": CACHE_MAX_TTL // 86400}


def scan(
    *, data: bytes | None = None, path: Path | None = None, name: str = "", category: str = "file",
    source: str = "api", ctx: dict | None = None, url: str = "", record_clean: bool = True,
) -> dict:
    """data（内存）或 path（平台已落盘的大文件）二选一。"""
    ctx = ctx or {}
    policy = get_policy()
    t0 = time.time()
    if data is not None:
        sha = hashlib.sha256(data).hexdigest()
        size = len(data)
    else:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(8 * 1024 * 1024):
                h.update(chunk)
        sha = h.hexdigest()
        size = path.stat().st_size

    findings: list = []
    if sha in set(policy.get("block_hashes", [])):
        r = ScanResult("DETECT", detection="KAIP:Blocklist.Hash")
    elif sha in set(policy.get("allow_hashes", [])):
        r = ScanResult("CLEAN", reason="allowlisted")
    else:
        r = _engine_scan(data, path, name, url, sha)
        if policy.get("rules_action") != "off":
            sample = data if data is not None else (path.read_bytes() if size <= 512 * 1024 * 1024 else b"")
            if sample:
                findings = analyzers.analyze_content(sample, name, category)
                if findings and in_trusted_path(ctx.get("object") or name, policy):
                    analyzers.downgrade(findings)

    verdict, detection = r.verdict, r.detection
    # KAIP 规则不依赖 KSE：引擎不可用（ERROR）时规则命中仍按 RISK 处置，不能被 fail_open 放行
    if verdict in ("CLEAN", "ERROR") and findings:
        verdict = "RISK"
        findings.sort(key=lambda f: 0 if f.get("severity") == "high" else 1)
        detection = "KAIP:" + findings[0]["rule"]
    action = decide(verdict, findings, policy)
    # 启发式规则（RISK）的处置边界：
    #   · 仅中危命中（如文档中的安装命令）→ 只告警；
    #   · 后台/会话启动扫描（文件静置，尚未执行）→ 只告警，执行时由 Hook 再判；
    #   · 永不自动隔离 —— 隔离只针对 KSE 确认的 DETECT 与哈希黑名单。
    if verdict == "RISK" and action == "block":
        if not any(f.get("severity") == "high" for f in findings) or source == "watcher":
            action = "alert"

    quarantined = False
    if action == "block" and verdict == "DETECT" and policy.get("quarantine_on_detect"):
        qpath = settings.quarantine_dir / f"{sha}.q"
        if not qpath.exists():
            if data is not None:
                qpath.write_bytes(_xor_copy(data))
            elif size <= 2 * 1024 * 1024 * 1024:
                qpath.write_bytes(_xor_copy(path.read_bytes()))
            else:
                shutil.move(str(path), str(qpath.with_suffix(".raw")))
        quarantined = True

    result = {
        "verdict": verdict, "detection": detection, "action": action, "sha256": sha, "size": size,
        "name": name, "reason": r.reason, "sub_results": r.sub_results, "findings": findings,
        "engine": settings.kse_mode, "cached": bool(r.raw and r.raw.get("cached")),
        "elapsed_ms": int((time.time() - t0) * 1000), "quarantined": quarantined,
        "bases_version": cache_stats["bases"],
    }
    if verdict != "CLEAN" or record_clean:
        ev = dict(
            source=source, category=category, agent_type=ctx.get("agent_type", "-"), agent_id=ctx.get("agent_id"),
            host=ctx.get("host", ""), username=ctx.get("username", ""), action=action,
            object=ctx.get("object") or name, verdict=verdict, detection=detection, sha256=sha, size=size,
            details={k: result[k] for k in ("reason", "sub_results", "findings", "elapsed_ms", "engine", "cached")}
            | ({"tool": ctx.get("tool")} if ctx.get("tool") else {}),
        )
        eid = db.add_event(**ev)
        result["event_id"] = eid
        siem.forward(ev | {"id": eid, "ts": time.time()})
        if quarantined:
            db.execute(
                "INSERT INTO quarantine(ts,sha256,name,stored_path,size,detection,source,host,event_id) VALUES(?,?,?,?,?,?,?,?,?)",
                (time.time(), sha, name, str(settings.quarantine_dir / f"{sha}.q"), size, detection, source,
                 ctx.get("host", ""), eid))
    return result


def check_url(url: str, source: str, ctx: dict | None = None) -> dict:
    ctx = ctx or {}
    policy = get_policy()
    r = engine().check_url(url)
    verdict = r.verdict
    for pat in policy.get("block_url_patterns", []):
        if pat and pat.lower() in url.lower():
            verdict, r.detection = "DETECT", "KAIP:Blocklist.URL"
    if any(url.startswith(p) for p in policy.get("allow_url_prefixes", []) if p):
        verdict = "CLEAN"
    action = decide(verdict, [], policy) if verdict != "NON_SCANNED" else "allow"
    res = {"url": url, "verdict": verdict, "detection": r.detection, "action": action, "reason": r.reason}
    if verdict != "CLEAN":
        ev = dict(source=source, category="url", agent_type=ctx.get("agent_type", "-"), agent_id=ctx.get("agent_id"),
                  host=ctx.get("host", ""), username=ctx.get("username", ""), action=action, object=url,
                  verdict=verdict, detection=r.detection, details={"reason": r.reason})
        eid = db.add_event(**ev)
        siem.forward(ev | {"id": eid, "ts": time.time()})
    return res
