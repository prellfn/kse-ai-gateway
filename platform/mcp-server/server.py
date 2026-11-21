"""KAIP MCP Server — 让原生支持 MCP 的 AI Agent (Codex / Claude Code / Claude Desktop)
复用 KAIP 平台的策略引擎、卡巴斯基扫描与审计台账.

传输方式: stdio (标准 MCP 客户端配置方式)
依赖:     无 (仅 Python 3.9+ 标准库)

这是 KAIP 平台缺失的一环: 平台原本只有 hook / watcher / CLI 三种接入方式,
需要安装 Node 客户端与 hook; 通过本 MCP Server, 支持 MCP 的 Agent 可以直接
调用平台能力, 判定结果同样进入平台审计与策略体系。

提供的工具:
  kaip_scan_file     扫描文件 (平台 -> KSE), 返回 verdict / detection / action
  kaip_scan_text     扫描文本内容
  kaip_check_url     URL 信誉检查
  kaip_evaluate      提交一次工具调用决策 (与 hook 同路径), 返回 allow/block 与理由
  kaip_policy        拉取当前策略
  kaip_status        平台与终端状态
  kaip_report        上报本地事件

环境变量:
  KAIP_URL            平台地址 (默认 http://127.0.0.1:8080)
  KAIP_ENROLL_TOKEN   终端注册令牌 (首次注册用; 注册后缓存在状态文件中)
  KAIP_AGENT_ID       已注册的终端 ID (可选, 与 KAIP_AGENT_TOKEN 一起用)
  KAIP_AGENT_TOKEN    已注册的终端令牌 (可选)
  KAIP_AGENT_TYPE     终端类型 (codex / opencode / workbuddy), 默认 codex
  KAIP_STATE_DIR      本工具的本地状态目录 (默认 ~/.cache/kaip-mcp)
                     —— 存放本工具自己的注册凭据, 与 KAIP 客户端自身目录相互独立
"""
from __future__ import annotations

import json
import os
import platform as _platform
import socket
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

KAIP_URL: str = os.getenv("KAIP_URL", "http://127.0.0.1:8080").rstrip("/")
KAIP_ENROLL_TOKEN: str = os.getenv("KAIP_ENROLL_TOKEN", "")
KAIP_AGENT_ID: str = os.getenv("KAIP_AGENT_ID", "")
KAIP_AGENT_TOKEN: str = os.getenv("KAIP_AGENT_TOKEN", "")
KAIP_AGENT_TYPE: str = os.getenv("KAIP_AGENT_TYPE", "codex")
KAIP_TIMEOUT: int = int(os.getenv("KAIP_TIMEOUT", "300"))
STATE_DIR = Path(os.path.expanduser(os.getenv("KAIP_STATE_DIR", "~/.cache/kaip-mcp")))
STATE_FILE = STATE_DIR / "agent.json"

PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2024-11-05")
SERVER_NAME = "kaip-platform"
SERVER_VERSION = "1.0.0"

AGENT_ID = KAIP_AGENT_ID
AGENT_TOKEN = KAIP_AGENT_TOKEN


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# HTTP 客户端 (仅标准库)
# ---------------------------------------------------------------------------
def _headers(extra: dict | None = None) -> dict[str, str]:
    h = dict(extra or {})
    if AGENT_TOKEN:
        h["Authorization"] = f"Bearer {AGENT_TOKEN}"
        h["X-KAIP-Agent"] = AGENT_ID
    return h


def _request(method: str, path: str, payload: dict | None = None, headers: dict | None = None) -> Any:
    url = f"{KAIP_URL}{path}"
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(headers), method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=KAIP_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        raise RuntimeError(f"KAIP 平台返回 {exc.code}: {str(detail)[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 KAIP 平台 ({KAIP_URL}): {exc.reason}") from exc


def _upload(path: str, filename: str, content: bytes, content_type: str = "application/octet-stream",
            fields: dict | None = None) -> Any:
    """multipart/form-data 上传."""
    boundary = "----KAIPBoundary" + uuid.uuid4().hex[:12]
    parts: list[bytes] = []
    for k, v in (fields or {}).items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n".encode()
    )
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{KAIP_URL}{path}",
        data=body,
        headers=_headers({"Content-Type": f"multipart/form-data; boundary={boundary}"}),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=KAIP_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        raise RuntimeError(f"KAIP 平台返回 {exc.code}: {str(detail)[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 KAIP 平台 ({KAIP_URL}): {exc.reason}") from exc


# ---------------------------------------------------------------------------
# 终端注册 (enroll)
# ---------------------------------------------------------------------------
def _load_state() -> dict:
    if STATE_FILE.is_file():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_state(d: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        STATE_FILE.chmod(0o600)
    except OSError:
        pass


def ensure_enrolled() -> tuple[str, str]:
    """返回 (agent_id, agent_token); 必要时用注册令牌自动注册."""
    global AGENT_ID, AGENT_TOKEN
    if AGENT_ID and AGENT_TOKEN:
        return AGENT_ID, AGENT_TOKEN

    state = _load_state()
    if state.get("agent_id") and state.get("agent_token"):
        AGENT_ID, AGENT_TOKEN = state["agent_id"], state["agent_token"]
        return AGENT_ID, AGENT_TOKEN

    if not KAIP_ENROLL_TOKEN:
        raise RuntimeError(
            "未注册终端。请设置环境变量 KAIP_ENROLL_TOKEN (控制台 -> 接入部署 -> 注册令牌), "
            "或直接提供 KAIP_AGENT_ID / KAIP_AGENT_TOKEN。"
        )

    r = _request(
        "POST",
        "/api/v1/agent/enroll",
        {
            "enroll_token": KAIP_ENROLL_TOKEN,
            "hostname": socket.gethostname(),
            "os": _platform.system(),
            "username": os.environ.get("USER") or os.environ.get("USERNAME") or "",
            "client_version": f"kaip-mcp/{SERVER_VERSION}",
            "agents": [KAIP_AGENT_TYPE],
        },
        headers={"Content-Type": "application/json"},
    )
    AGENT_ID = r.get("agent_id", "")
    AGENT_TOKEN = r.get("agent_token", "")
    if not AGENT_ID or not AGENT_TOKEN:
        raise RuntimeError(f"终端注册失败: {r}")
    _save_state({"agent_id": AGENT_ID, "agent_token": AGENT_TOKEN, "url": KAIP_URL,
                 "agent_type": KAIP_AGENT_TYPE, "enrolled_at": utcnow()})
    return AGENT_ID, AGENT_TOKEN


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------
def _fmt_scan(r: dict) -> str:
    verdict = r.get("verdict", "UNKNOWN")
    action = r.get("action", "-")
    detection = r.get("detection") or "-"
    lines = [f"verdict: {verdict}", f"action: {action}", f"detection: {detection}"]
    if r.get("sha256"):
        lines.append(f"sha256: {r['sha256']}")
    if r.get("reason"):
        lines.append(f"reason: {r['reason']}")
    findings = r.get("findings") or []
    if findings:
        lines.append("findings:")
        for f in findings[:10]:
            lines.append(f"  - [{f.get('severity', '?')}] {f.get('rule', '?')}: {f.get('desc', '')}")
    subs = r.get("sub_results") or []
    if subs:
        lines.append("sub_results:")
        for s in subs[:10]:
            lines.append(f"  - {s.get('object', '?')}: {s.get('verdict', '?')} {s.get('detection', '')}")
    if action == "block" or verdict == "DETECT":
        lines.append("⛔ 检出威胁或命中策略，禁止继续使用该内容。")
    elif action == "alert":
        lines.append("⚠️  命中 KAIP 规则，已记录告警。")
    elif verdict == "CLEAN":
        lines.append("✅ 扫描通过，可以继续。")
    else:
        lines.append("⚠️  扫描未得出确定结论，请谨慎处理。")
    return "\n".join(lines)


def tool_scan_file(args: dict) -> str:
    ensure_enrolled()
    path = str(args.get("file_path") or "")
    if not path:
        raise ValueError("缺少 file_path 参数")
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"文件不存在: {path}")
    category = str(args.get("category") or "file")
    r = _upload(
        "/api/v1/agent/scan",
        p.name,
        p.read_bytes(),
        fields={"path": str(p), "category": category, "agent_type": KAIP_AGENT_TYPE, "source": "cli"},
    )
    return _fmt_scan(r)


def tool_scan_text(args: dict) -> str:
    ensure_enrolled()
    filename = str(args.get("filename") or "content.txt")
    content = str(args.get("content") or "")
    category = str(args.get("category") or "file")
    r = _upload(
        "/api/v1/agent/scan",
        filename,
        content.encode(),
        fields={"path": filename, "category": category, "agent_type": KAIP_AGENT_TYPE, "source": "cli"},
    )
    return _fmt_scan(r)


def tool_check_url(args: dict) -> str:
    ensure_enrolled()
    url = str(args.get("url") or "")
    if not url:
        raise ValueError("缺少 url 参数")
    r = _request("POST", "/api/v1/agent/checkurl", {"url": url, "agent_type": KAIP_AGENT_TYPE})
    return _fmt_scan(r)


def tool_evaluate(args: dict) -> str:
    """与 hook 同路径的决策入口: 返回 allow / block 及理由."""
    ensure_enrolled()
    payload = {
        "agent_type": str(args.get("agent_type") or KAIP_AGENT_TYPE),
        "event": str(args.get("event") or "PreToolUse"),
        "tool": str(args.get("tool") or ""),
        "command": args.get("command"),
        "cwd": str(args.get("cwd") or ""),
        "urls": [str(u) for u in (args.get("urls") or [])],
        "files": [],
    }
    for f in (args.get("files") or []):
        payload["files"].append({
            "path": str(f.get("path", "")),
            "content_b64": f.get("content_b64"),
            "size": f.get("size"),
            "kind": str(f.get("kind") or "file"),
        })
    r = _request("POST", "/api/v1/agent/evaluate", payload)
    lines = [f"decision: {r.get('decision', 'unknown')}"]
    for reason in r.get("reasons") or []:
        lines.append(f"  - {reason}")
    if r.get("post_scan"):
        lines.append("(post_scan=true: 该命令执行后需扫描新增文件)")
    if r.get("policy_version") is not None:
        lines.append(f"policy_version: {r.get('policy_version')}")
    if r.get("bases_version"):
        lines.append(f"bases_version: {r.get('bases_version')}")
    return "\n".join(lines)


def tool_policy(args: dict) -> str:
    ensure_enrolled()
    return json.dumps(_request("GET", "/api/v1/agent/policy"), ensure_ascii=False, indent=2)


def tool_status(args: dict) -> str:
    lines = [f"kaip_url: {KAIP_URL}", f"agent_id: {AGENT_ID or '(未注册)'}",
             f"agent_type: {KAIP_AGENT_TYPE}"]
    try:
        ensure_enrolled()
        p = _request("GET", "/api/v1/agent/policy")
        lines.append(f"platform: 在线 (策略版本 {p.get('version', '?')})")
        lines.append(f"policy.mode: {p.get('mode')}")
        lines.append(f"policy.fail_open: {p.get('fail_open')}")
        lines.append(f"policy.install_action: {p.get('install_action')}")
    except Exception as exc:
        lines.append(f"platform: 不可用 ({exc})")
    return "\n".join(lines)


def tool_report(args: dict) -> str:
    ensure_enrolled()
    ev = {
        "agent_type": KAIP_AGENT_TYPE,
        "category": str(args.get("category") or "file"),
        "action": str(args.get("action") or "alert"),
        "object": str(args.get("object") or ""),
        "verdict": str(args.get("verdict") or "ERROR"),
        "detection": str(args.get("detection") or ""),
        "details": args.get("details") or {},
    }
    r = _request("POST", "/api/v1/agent/report", ev)
    return f"已上报: event_id={r.get('event_id')}"


TOOLS = [
    {
        "name": "kaip_scan_file",
        "description": "通过 KAIP 平台扫描文件 (卡巴斯基扫描引擎 + 平台策略)。返回 verdict / detection / action。"
                       "在写文件、运行脚本、加载模型前调用。",
        "handler": tool_scan_file,
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "待扫描文件的绝对路径"},
                "category": {"type": "string", "description": "file / script / model / skill / write", "default": "file"},
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "kaip_scan_text",
        "description": "通过 KAIP 平台扫描一段文本内容 (即将写入文件的内容、生成的脚本源码)。",
        "handler": tool_scan_text,
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "虚拟文件名, 例如 install.sh / SKILL.md"},
                "content": {"type": "string", "description": "待扫描的文本内容"},
                "category": {"type": "string", "description": "file / script / model / skill / write", "default": "file"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "kaip_check_url",
        "description": "通过 KAIP 平台检查 URL 信誉 (钓鱼站点 / 恶意跳转)。访问外部链接前建议调用。",
        "handler": tool_check_url,
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "待检查的 URL"}},
            "required": ["url"],
        },
    },
    {
        "name": "kaip_evaluate",
        "description": "让 KAIP 平台对一次工具调用做决策 (与 Agent hook 同路径), 返回 allow/block 与理由。",
        "handler": tool_evaluate,
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "description": "工具名, 例如 write / edit / exec"},
                "command": {"type": "string", "description": "将要执行的命令"},
                "cwd": {"type": "string", "description": "工作目录"},
                "urls": {"type": "array", "items": {"type": "string"}, "description": "涉及的 URL 列表"},
                "files": {
                    "type": "array",
                    "description": "涉及的文件",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "content_b64": {"type": "string", "description": "base64 编码的文件内容"},
                            "size": {"type": "integer"},
                            "kind": {"type": "string", "description": "write / edit / script / model / skill"},
                        },
                    },
                },
            },
        },
    },
    {
        "name": "kaip_policy",
        "description": "拉取 KAIP 平台当前生效的策略 (模式、Fail-Open、安装动作、监控目录、黑名单等)。",
        "handler": tool_policy,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "kaip_status",
        "description": "查看 KAIP 平台连通性、终端注册状态与关键策略开关。",
        "handler": tool_status,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "kaip_report",
        "description": "向 KAIP 平台上报一条本地事件 (例如离线期间 fail-open 放行、本地隔离成功)。",
        "handler": tool_report,
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {"type": "string"},
                "action": {"type": "string", "description": "allow / block / alert"},
                "object": {"type": "string", "description": "涉及的对象描述"},
                "verdict": {"type": "string"},
                "detection": {"type": "string"},
                "details": {"type": "object"},
            },
        },
    },
]

TOOL_INDEX = {t["name"]: t for t in TOOLS}


# ---------------------------------------------------------------------------
# JSON-RPC 处理
# ---------------------------------------------------------------------------
def handle_message(msg: dict) -> dict | None:
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "KAIP (Kaspersky AI Protect) 平台。执行写文件、运行脚本、加载模型、"
                    "访问链接、安装 Skill 之前, 先用对应工具让平台判定。"
                    "若返回 action=block 或 verdict=DETECT, 必须停止后续操作并向用户报告。"
                ),
            },
        }

    if method in ("notifications/initialized", "initialized"):
        return None

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": [
                    {"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"]}
                    for t in TOOLS
                ]
            },
        }

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = TOOL_INDEX.get(name)
        if not tool:
            return {"jsonrpc": "2.0", "id": msg_id,
                    "error": {"code": -32602, "message": f"未知工具: {name}"}}
        try:
            text = tool["handler"](arguments)
            return {"jsonrpc": "2.0", "id": msg_id,
                    "result": {"content": [{"type": "text", "text": text}], "isError": False}}
        except Exception as exc:  # noqa: BLE001
            return {"jsonrpc": "2.0", "id": msg_id,
                    "result": {"content": [{"type": "text", "text": f"❌ KAIP 调用失败: {exc}"}],
                               "isError": True}}

    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id,
            "error": {"code": -32601, "message": f"不支持的方法: {method}"}}


def main() -> None:
    print(f"[{SERVER_NAME}] MCP Server 启动, 平台地址: {KAIP_URL}", file=sys.stderr)
    stdout = sys.stdout
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            response = handle_message(msg)
        except Exception as exc:  # noqa: BLE001
            response = {"jsonrpc": "2.0", "id": msg.get("id"),
                        "error": {"code": -32603, "message": str(exc)}}
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            stdout.flush()


if __name__ == "__main__":
    main()
