"""认证：管理员会话（HMAC 签名令牌）、终端 Agent 令牌、供应链 API Key。"""
import hashlib
import hmac
import logging
import os
import secrets
import time

from fastapi import Header, HTTPException, Request

from . import db
from .config import settings

log = logging.getLogger("kaip.auth")
SESSION_TTL = 12 * 3600


def _secret() -> bytes:
    s = settings.secret_key or db.kv_get("secret_key")
    if not s:
        s = secrets.token_hex(32)
        db.kv_set("secret_key", s)
    return s.encode()


def hash_pw(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(8)
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()


def verify_pw(pw: str, stored: str) -> bool:
    salt = stored.split("$", 1)[0]
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def bootstrap():
    if not db.kv_get("admin_pw"):
        pw = settings.admin_password or secrets.token_urlsafe(12)
        db.kv_set("admin_pw", hash_pw(pw))
        if not settings.admin_password:
            log.warning("=" * 60)
            log.warning("已生成初始管理员密码  用户: %s  密码: %s", settings.admin_user, pw)
            log.warning("请登录控制台后立即修改。")
            log.warning("=" * 60)
            pf = settings.data_dir / "initial_admin_password.txt"
            with open(os.open(pf, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:   # 仅服务账号可读
                f.write(pw)
            try:
                pf.chmod(0o600)
            except OSError:
                pass
    if not db.kv_get("enroll_token"):
        db.kv_set("enroll_token", secrets.token_urlsafe(24))
    if not db.kv_get("api_key"):
        db.kv_set("api_key", "kaip_" + secrets.token_urlsafe(32))


def make_session(user: str) -> str:
    exp = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(_secret(), f"{user}|{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{user}|{exp}|{sig}"


def check_session(tok: str) -> str | None:
    try:
        user, exp, sig = tok.split("|")
        good = hmac.new(_secret(), f"{user}|{exp}".encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(sig, good) and int(exp) > time.time():
            return user
    except Exception:
        pass
    return None


def _bearer(authorization: str | None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


def require_admin(request: Request, authorization: str | None = Header(None)) -> str:
    tok = _bearer(authorization) or request.cookies.get("kaip_session", "")
    user = check_session(tok)
    if not user:
        raise HTTPException(401, "未登录或会话已过期")
    return user


def token_hash(t: str) -> str:
    return hashlib.sha256(t.encode()).hexdigest()


def require_agent(authorization: str | None = Header(None), x_kaip_agent: str | None = Header(None)) -> dict:
    tok = _bearer(authorization)
    if not tok or not x_kaip_agent:
        raise HTTPException(401, "缺少终端凭据")
    a = db.query_one("SELECT * FROM agents WHERE id=?", (x_kaip_agent,))
    if not a or a["status"] != "active" or not hmac.compare_digest(a["token_hash"] or "", token_hash(tok)):
        raise HTTPException(401, "终端凭据无效或已被吊销")
    db.execute("UPDATE agents SET last_seen=? WHERE id=?", (time.time(), a["id"]))
    return a


def require_api(request: Request, authorization: str | None = Header(None), x_api_key: str | None = Header(None),
                x_kaip_agent: str | None = Header(None)) -> dict:
    """供应链接口：管理员会话 / API Key（脚本、CI、业务系统）/ 终端令牌 任一即可。"""
    tok = _bearer(authorization)
    key = x_api_key or tok
    if key and hmac.compare_digest(key, db.kv_get("api_key", "")):
        return {"kind": "api", "name": "api-key"}
    if x_kaip_agent:
        a = require_agent(authorization, x_kaip_agent)
        return {"kind": "agent", "name": a["hostname"], "agent": a}
    user = check_session(tok or request.cookies.get("kaip_session", ""))
    if user:
        return {"kind": "admin", "name": user}
    raise HTTPException(401, "需要 API Key 或登录")
