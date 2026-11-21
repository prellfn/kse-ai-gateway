"""终端侧 API：注册、心跳/策略下发、Hook 决策、文件扫描。

客户端（Codex / WorkBuddy hook、OpenCode 插件、watcher、CLI）全部走这些接口。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from . import analyzers, db, scanner, siem
from .kse import bases_version
from .auth import require_agent, token_hash
from .policy import get_policy, policy_fingerprint

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])
URL_RX = re.compile(r"https?://[^\s'\"<>|;)`]+", re.I)


class EnrollReq(BaseModel):
    enroll_token: str
    hostname: str
    os: str
    username: str = ""
    client_version: str = ""
    agents: list[str] = []


@router.post("/enroll")
def enroll(req: EnrollReq, request: Request):
    if not hmac.compare_digest(req.enroll_token, db.kv_get("enroll_token", "")):
        raise HTTPException(403, "注册令牌无效")
    aid = uuid.uuid4().hex[:16]
    tok = secrets.token_urlsafe(32)
    now = time.time()
    db.execute(
        "INSERT INTO agents(id,hostname,os,username,client_version,agents,ip,token_hash,enrolled_at,last_seen) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (aid, req.hostname, req.os, req.username, req.client_version, json.dumps(req.agents),
         request.client.host if request.client else "", token_hash(tok), now, now))
    db.add_event(source="console", category="enroll", agent_type="-", agent_id=aid, host=req.hostname,
                 username=req.username, action="allow", object=f"终端注册 {req.hostname} ({req.os})", verdict="CLEAN")
    return {"agent_id": aid, "agent_token": tok, "policy": get_policy()}


class HeartbeatReq(BaseModel):
    client_version: str = ""
    agents: list[str] = []
    policy_version: int = 0
    stats: dict = {}
    agent_status: dict = {}      # {codex|opencode|workbuddy: {state: ok|untrusted|inactive|missing, version, detail, ...}}
    client_hash: str = ""        # 客户端程序指纹（bin/lib/adapters 下脚本）
    client_files: dict = {}      # {相对路径: sha256}
    policy_hash: str = ""        # 本地缓存策略指纹


AGENT_NAME = {"codex": "Codex", "opencode": "OpenCode", "workbuddy": "WorkBuddy"}


def _status_events(a: dict, old: dict, new: dict):
    """防护状态变化 → 事件（失效告警 / 恢复通知），并转发 SIEM。"""
    for agent, st in new.items():
        prev = (old or {}).get(agent, {})
        s, ps = st.get("state"), prev.get("state")
        ver = f" {st['version']}" if st.get("version") else ""
        # 新工具：本次上报的未识别工具名中，之前没出现过的 → 一次性提醒
        old_tools = {t.get("name") for t in prev.get("unknown_tools", []) or []}
        for t in st.get("unknown_tools", []) or []:
            if t.get("name") and t["name"] not in old_tools:
                ev = dict(source="agent-local", category="protection", agent_type=agent, agent_id=a["id"], host=a["hostname"],
                          username=a["username"], action="alert", verdict="RISK", detection="KAIP:Agent.NewTool",
                          object=f"{AGENT_NAME.get(agent, agent)}{' ' + st['version'] if st.get('version') else ''} 出现 KAIP 未识别的工具：{t['name']}（已调用 {t.get('count', 1)} 次），请评估其是否能写文件 / 执行代码并补充拦截规则",
                          details=t)
                eid = db.add_event(**ev)
                siem.forward(ev | {"id": eid, "ts": time.time()})
        if s == ps and (s != "ok" or prev.get("version") == st.get("version")):
            continue
        if s == "review":
            t = st.get("self_test") or {}
            ev = dict(source="agent-local", category="protection", agent_type=agent, agent_id=a["id"], host=a["hostname"],
                      username=a["username"], action="alert", verdict="RISK", detection="KAIP:Agent.Upgraded",
                      object=f"{AGENT_NAME.get(agent, agent)} 已升级 {st.get('prev_version', '?')} → {st.get('version', '?')}，防护待复核"
                             f"（KAIP 自测 {t.get('pass', '?')}/{t.get('total', '?')}{'，未通过：' + '、'.join(t['failed']) if t.get('failed') else ''}）",
                      details=st)
            eid = db.add_event(**ev)
            siem.forward(ev | {"id": eid, "ts": time.time()})
            continue
        if s and s != "ok":
            ev = dict(source="agent-local", category="protection", agent_type=agent, agent_id=a["id"], host=a["hostname"],
                      username=a["username"], action="alert", verdict="ERROR", detection=f"KAIP:Protection.{s.capitalize()}",
                      object=f"{AGENT_NAME.get(agent, agent)}{ver} 防护未生效：{st.get('detail', s)}", details=st)
        elif s == "ok" and ps and ps != "ok":
            ev = dict(source="agent-local", category="protection", agent_type=agent, agent_id=a["id"], host=a["hostname"],
                      username=a["username"], action="log", verdict="CLEAN", detection="KAIP:Protection.Restored",
                      object=f"{AGENT_NAME.get(agent, agent)}{ver} 防护已恢复生效", details=st)
        else:
            continue
        eid = db.add_event(**ev)
        siem.forward(ev | {"id": eid, "ts": time.time()})


_hb_lock = threading.Lock()
CLIENT_DIR = Path(__file__).resolve().parents[2] / "client"
_manifest_cache: dict = {}


def official_manifest() -> dict:
    """平台分发的官方客户端包指纹（按文件 mtime 缓存）。"""
    files = sorted(p for d in ("bin", "lib", "adapters") for p in (CLIENT_DIR / d).rglob("*")
                   if p.is_file() and p.suffix in (".js", ".mjs", ".cjs"))
    key = tuple((str(p), p.stat().st_mtime_ns) for p in files)
    if _manifest_cache.get("key") != key:
        per = {p.relative_to(CLIENT_DIR).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        h = hashlib.sha256("".join(f"{k}:{v}\n" for k, v in sorted(per.items())).encode()).hexdigest()
        _manifest_cache.update(key=key, files=per, hash=h)
        _record_official(h)
    return _manifest_cache


def _record_official(h: str):
    """记录历次官方客户端包指纹：终端与旧官方版本一致 = 待升级，不是被篡改。"""
    cur = db.kv_get("client_hash_current")
    if cur == h:
        return
    hist = db.kv_get("client_hash_history", []) or []
    if cur and cur not in hist:
        hist = (hist + [cur])[-50:]
    db.kv_set("client_hash_history", hist)
    db.kv_set("client_hash_current", h)


def is_old_official(client_hash: str) -> bool:
    return client_hash in (db.kv_get("client_hash_history", []) or [])


def _tamper_check(a: dict, req) -> dict:
    """比对客户端/策略指纹；仅在状态变化时产生事件。返回给客户端的 tamper 信息。"""
    out = {"client": False, "policy": False}
    try:
        prev = json.loads(a.get("tamper_state") or "{}")
    except Exception:
        prev = {}
    state = dict(prev)
    if req.client_hash:
        off = official_manifest()
        if req.client_hash != off["hash"]:
            bad = sorted({k for k in set(off["files"]) | set(req.client_files)
                          if off["files"].get(k) != req.client_files.get(k)})
            out.update(client=True, client_files=bad)
            if is_old_official(req.client_hash):
                out["outdated"] = True          # 平台已发布新客户端：由终端自动升级，不按篡改告警
            elif prev.get("client") != req.client_hash:
                ev = dict(source="agent-local", category="tamper", agent_type="-", agent_id=a["id"], host=a["hostname"],
                          username=a["username"], action="alert", verdict="RISK", detection="KAIP:Tamper.ClientModified",
                          object=f"KAIP 客户端文件被修改或缺失：{', '.join(bad[:6])}{' 等' if len(bad) > 6 else ''}",
                          details={"files": bad, "client_hash": req.client_hash, "official_hash": off["hash"]})
                eid = db.add_event(**ev)
                siem.forward(ev | {"id": eid, "ts": time.time()})
            state["client"] = req.client_hash
        else:
            state.pop("client", None)
    if req.policy_hash:
        if req.policy_hash != policy_fingerprint(get_policy()):
            out["policy"] = True
            if req.policy_version == get_policy()["version"]:   # 版本相同但内容不同 = 本地被改
                ev = dict(source="agent-local", category="tamper", agent_type="-", agent_id=a["id"], host=a["hostname"],
                          username=a["username"], action="alert", verdict="RISK", detection="KAIP:Tamper.Policy",
                          object="终端本地策略与平台不一致（疑似被篡改），已强制下发平台策略", details={"policy_hash": req.policy_hash})
                eid = db.add_event(**ev)
                siem.forward(ev | {"id": eid, "ts": time.time()})
    db.execute("UPDATE agents SET tamper_state=? WHERE id=?", (json.dumps(state), a["id"]))
    return out


@router.post("/heartbeat")
def heartbeat(req: HeartbeatReq, request: Request, a=Depends(require_agent)):
    # 读取旧状态 → 写入新状态 → 产生变化事件 需原子完成：同一终端并发心跳（如 kaip verify 与后台监控同时上报）
    # 否则会对同一次状态变化重复告警
    with _hb_lock:
        row = db.query_one("SELECT agent_status FROM agents WHERE id=?", (a["id"],)) or {}
        try:
            old = json.loads(row.get("agent_status") or "{}")
        except Exception:
            old = {}
        status = req.agent_status or old
        db.execute("UPDATE agents SET client_version=?, agents=?, ip=?, last_seen=?, agent_status=? WHERE id=?",
                   (req.client_version, json.dumps(req.agents), request.client.host if request.client else "", time.time(),
                    json.dumps(status, ensure_ascii=False), a["id"]))
        if req.agent_status:
            _status_events(a, old, req.agent_status)
        a2 = db.query_one("SELECT * FROM agents WHERE id=?", (a["id"],)) or a
        tamper = _tamper_check(a2, req)
    p = get_policy()
    send = p["version"] != req.policy_version or tamper["policy"]
    return {"policy": p if send else None, "tamper": tamper, "server_time": time.time(), "bases_version": bases_version()}


@router.get("/policy")
def policy(a=Depends(require_agent)):
    return get_policy()


class FileItem(BaseModel):
    path: str
    content_b64: str | None = None
    size: int | None = None
    kind: str = "file"          # write / edit / script / model / skill


class EvaluateReq(BaseModel):
    agent_type: str             # codex / opencode / workbuddy / openclaw
    event: str = "PreToolUse"
    tool: str = ""
    command: str | None = None
    files: list[FileItem] = []
    urls: list[str] = []
    cwd: str = ""
    session_id: str = ""


@router.post("/evaluate")
def evaluate(req: EvaluateReq, a=Depends(require_agent)):
    """Hook 决策入口。返回 decision=allow|block 及原因；post_scan=true 表示命令执行后需扫描新增文件。"""
    p = get_policy()
    enforce = p.get("mode") == "enforce"
    ctx = {"agent_type": req.agent_type, "agent_id": a["id"], "host": a["hostname"], "username": a["username"],
           "tool": req.tool}
    reasons, results = [], []
    block = False
    post_scan = False

    if req.command:
        ca = analyzers.analyze_command(req.command)
        if ca["risks"] and p.get("rules_action") != "off":
            act = "block" if (p.get("rules_action") == "block" and enforce) else "alert"
            r0 = ca["risks"][0]
            ev = dict(source="agent-hook", category="exec", action=act, object=req.command[:2000], verdict="RISK",
                      detection="KAIP:" + r0["rule"], details={"findings": ca["risks"], "tool": req.tool, "cwd": req.cwd},
                      agent_type=req.agent_type, agent_id=a["id"], host=a["hostname"], username=a["username"])
            eid = db.add_event(**ev)
            siem.forward(ev | {"id": eid, "ts": time.time()})
            results.append({"object": "command", "verdict": "RISK", "detection": ev["detection"], "action": act})
            if act == "block":
                block = True
                reasons.append(f"高危命令：{r0['desc']}（{r0.get('match','')}）")
        if ca["install"]:
            ia = p.get("install_action", "scan")
            urls = URL_RX.findall(req.command)
            src_blocked = [u for u in urls for pat in p.get("block_url_patterns", []) if pat and pat.lower() in u.lower()]
            act = "block" if ((ia == "block" or src_blocked) and enforce) else "allow"
            db.add_event(source="agent-hook", category="install", action=act, object=req.command[:2000],
                         verdict="DETECT" if src_blocked else "CLEAN",
                         detection="KAIP:Blocklist.Source" if src_blocked else "",
                         details={"tool": req.tool, "cwd": req.cwd, "policy": ia}, agent_type=req.agent_type,
                         agent_id=a["id"], host=a["hostname"], username=a["username"])
            if act == "block":
                block = True
                reasons.append("策略禁止 Agent 自行安装/下载组件" if not src_blocked else f"安装来源被列入黑名单：{src_blocked[0]}")
            elif ia == "scan":
                post_scan = True
        req.urls = list(dict.fromkeys(req.urls + URL_RX.findall(req.command)))

    if p.get("check_urls"):
        for u in req.urls[:10]:
            r = scanner.check_url(u, "agent-hook", ctx)
            results.append({"object": u, **r})
            if r["action"] == "block":
                block = True
                reasons.append(f"URL 信誉检出 {r['detection']}：{u}")

    for f in req.files:
        if not f.content_b64:
            continue
        try:
            data = base64.b64decode(f.content_b64)
        except Exception:
            continue
        cat = {"write": "write", "edit": "write"}.get(f.kind, f.kind)
        r = scanner.scan(data=data, name=f.path, category=cat, source="agent-hook", ctx=ctx | {"object": f.path},
                         record_clean=False)
        results.append({"object": f.path, **{k: r[k] for k in ("verdict", "detection", "action", "sha256", "findings")}})
        if r["action"] == "block":
            block = True
            if r["verdict"] == "DETECT":
                reasons.append(f"卡巴斯基检出威胁 {r['detection']}：{f.path}")
            elif r["verdict"] == "RISK":
                reasons.append(f"KAIP 规则命中 {r['detection']}（{r['findings'][0]['desc']}）：{f.path}")
            else:
                reasons.append(f"文件无法扫描（{r['verdict']} {r['reason']}），按策略不放行：{f.path}")

    return {"decision": "block" if block else "allow", "reasons": reasons, "results": results,
            "post_scan": post_scan, "policy_version": p["version"], "bases_version": bases_version()}


@router.post("/scan")
async def scan_upload(
    file: UploadFile = File(...), path: str = Form(""), category: str = Form("file"),
    agent_type: str = Form("-"), source: str = Form("watcher"), a=Depends(require_agent),
):
    """watcher / CLI 上传文件扫描（multipart）。"""
    data = await file.read()
    ctx = {"agent_type": agent_type, "agent_id": a["id"], "host": a["hostname"], "username": a["username"],
           "object": path or file.filename}
    r = scanner.scan(data=data, name=path or file.filename or "upload", category=category,
                     source=source if source in ("watcher", "cli", "agent-hook") else "watcher", ctx=ctx,
                     record_clean=source == "cli")
    return r


class UrlReq(BaseModel):
    url: str
    agent_type: str = "-"


@router.post("/checkurl")
def checkurl(req: UrlReq, a=Depends(require_agent)):
    return scanner.check_url(req.url, "agent-hook", {"agent_type": req.agent_type, "agent_id": a["id"],
                                                      "host": a["hostname"], "username": a["username"]})


class LocalEvent(BaseModel):
    agent_type: str = "-"
    category: str = "file"
    action: str = "alert"
    object: str = ""
    verdict: str = "ERROR"
    detection: str = ""
    details: dict = {}


@router.post("/report")
def report(ev: LocalEvent, a=Depends(require_agent)):
    """客户端本地事件上报（如离线期间 fail-open 放行、本地隔离成功等）。"""
    e = ev.model_dump()
    eid = db.add_event(source="agent-local", agent_id=a["id"], host=a["hostname"], username=a["username"], **e)
    siem.forward(e | {"id": eid, "ts": time.time(), "host": a["hostname"]})
    return {"ok": True, "event_id": eid}
