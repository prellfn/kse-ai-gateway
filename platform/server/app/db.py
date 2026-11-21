"""SQLite 存储（PoC 规模足够；WAL 模式支持并发读）。"""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from .config import settings

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    source TEXT NOT NULL,          -- agent-hook / supply-chain / watcher / kse-syslog / console / url-check
    category TEXT,                 -- write / exec / install / skill / model / rag / dataset / url / file
    agent_type TEXT,               -- codex / opencode / workbuddy / openclaw / -
    agent_id TEXT,
    host TEXT,
    username TEXT,
    action TEXT,                   -- allow / block / alert / quarantine
    object TEXT,                   -- 文件名/路径/命令/URL
    verdict TEXT,                  -- CLEAN / DETECT / NON_SCANNED / RISK / ERROR
    detection TEXT,
    sha256 TEXT,
    size INTEGER,
    details TEXT                   -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_verdict ON events(verdict);

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    os TEXT,
    username TEXT,
    client_version TEXT,
    agents TEXT,                   -- JSON: 已接入的 AI Agent 列表
    ip TEXT,
    token_hash TEXT,
    enrolled_at REAL,
    last_seen REAL,
    status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    sha256 TEXT,
    name TEXT,
    stored_path TEXT,
    size INTEGER,
    detection TEXT,
    source TEXT,
    host TEXT,
    status TEXT DEFAULT 'quarantined',   -- quarantined / released / deleted
    event_id INTEGER
);

CREATE TABLE IF NOT EXISTS verdict_cache (
    sha256 TEXT PRIMARY KEY,
    verdict TEXT,
    detection TEXT,
    details TEXT,
    ts REAL,
    bases TEXT                -- 判定时的病毒库版本；版本变化即失效
);

CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT
);
"""


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(settings.db_path, check_same_thread=False, isolation_level=None)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
        # 升级迁移：旧库补列
        cols = {r[1] for r in _conn.execute("PRAGMA table_info(agents)")}
        if "agent_status" not in cols:
            _conn.execute("ALTER TABLE agents ADD COLUMN agent_status TEXT")
        if "tamper_state" not in cols:
            _conn.execute("ALTER TABLE agents ADD COLUMN tamper_state TEXT")
        if "bases" not in {r[1] for r in _conn.execute("PRAGMA table_info(verdict_cache)")}:
            _conn.execute("ALTER TABLE verdict_cache ADD COLUMN bases TEXT")
    return _conn


@contextmanager
def tx():
    with _lock:
        c = conn()
        c.execute("BEGIN")
        try:
            yield c
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise


def query(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def query_one(sql: str, args=()) -> dict | None:
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql: str, args=()) -> int:
    with _lock:
        cur = conn().execute(sql, args)
        return cur.lastrowid


# ---- KV 配置 ----
def kv_get(k: str, default=None):
    r = query_one("SELECT v FROM kv WHERE k=?", (k,))
    if not r:
        return default
    try:
        return json.loads(r["v"])
    except Exception:
        return default


def kv_set(k: str, v) -> None:
    execute("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v, ensure_ascii=False)))


def add_event(**kw) -> int:
    kw.setdefault("ts", time.time())
    details = kw.get("details")
    if details is not None and not isinstance(details, str):
        kw["details"] = json.dumps(details, ensure_ascii=False)
    cols = ",".join(kw.keys())
    qs = ",".join("?" for _ in kw)
    return execute(f"INSERT INTO events({cols}) VALUES({qs})", tuple(kw.values()))
