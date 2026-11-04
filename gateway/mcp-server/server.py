"""kse-ai-gateway MCP Server — 零依赖标准库实现 (JSON-RPC over stdio).

为什么不用官方 mcp SDK?
  KSE 所在的内网环境通常是离线的, 无法 pip install。
  MCP 协议本身就是 JSON-RPC 2.0 over stdio, 用标准库实现只需 ~200 行,
  部署时不需要任何第三方包。

提供的工具:
  scan_file        扫描本机文件 (路径白名单内)
  scan_text        扫描文本内容 (内存, 不落盘)
  scan_url         扫描 URL (钓鱼 / 恶意链接)
  scan_skill_pkg   深度扫描 Skill / 插件压缩包 (解包逐文件)
  kse_status       查看 KSE 与网关状态

用法:
  python3 server.py              # stdio 传输 (标准 MCP 客户端配置方式)
  KSE_SCAN_GATEWAY=http://10.0.0.1:8000 python3 server.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

SCAN_GATEWAY: str = os.getenv("KSE_SCAN_GATEWAY", "http://127.0.0.1:8000").rstrip("/")
TIMEOUT: int = int(os.getenv("KSE_SCAN_TIMEOUT", "300"))
MAX_TEXT_BYTES: int = int(os.getenv("KSE_MAX_TEXT_BYTES", str(50 * 1024 * 1024)))
PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2024-11-05")
SERVER_NAME = "kse-ai-gateway"
SERVER_VERSION = "1.2.0"

ALLOWED_SUFFIXES = (".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".tar.gz", ".tar.bz2", ".tar.xz")


# ---------------------------------------------------------------------------
# HTTP 客户端 (仅用标准库)
# ---------------------------------------------------------------------------
def _post_json(path: str, payload: dict, timeout: int = TIMEOUT) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{SCAN_GATEWAY}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        raise RuntimeError(f"Scan Gateway 返回 {exc.code}: {str(detail)[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc.reason}") from exc


def _post_multipart(path: str, filename: str, content: bytes, content_type: str = "application/octet-stream") -> dict[str, Any]:
    boundary = "----KSEBoundary" + uuid.uuid4().hex[:12]
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    body = head + content + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{SCAN_GATEWAY}{path}",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(raw).get("detail", raw)
        except json.JSONDecodeError:
            detail = raw
        raise RuntimeError(f"Scan Gateway 返回 {exc.code}: {str(detail)[:300]}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc.reason}") from exc


def _get_json(path: str, timeout: int = 30) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(f"{SCAN_GATEWAY}{path}", timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Scan Gateway 返回 {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc.reason}") from exc


def _format(result: dict[str, Any]) -> str:
    verdict = result.get("verdict", "UNKNOWN")
    detection = result.get("detection_name") or "-"
    lines = [f"verdict: {verdict}", f"detection_name: {detection}"]
    if result.get("sha256"):
        lines.append(f"sha256: {result['sha256']}")
    if result.get("quarantined"):
        lines.append(f"quarantine_path: {result.get('quarantine_path', '-')}")
    if result.get("threats_count"):
        lines.append(f"threats_count: {result['threats_count']}")
        for t in result.get("threats", [])[:10]:
            lines.append(f"  - {t.get('file_path', t.get('url', '?'))}: {t.get('detection_name', '-')}")
    if verdict == "DETECT":
        lines.append("⛔ 检出威胁，禁止继续使用该内容。")
    elif verdict == "CLEAN":
        lines.append("✅ 扫描通过，可以继续。")
    else:
        lines.append("⚠️ 扫描未得出确定结论，请谨慎处理。")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------
def tool_scan_file(args: dict[str, Any]) -> str:
    file_path = str(args.get("file_path") or "")
    if not file_path:
        raise ValueError("缺少 file_path 参数")
    timeout = int(args.get("timeout") or 120)
    return _format(_post_json("/scan/file", {"file_path": file_path, "timeout": timeout}))


def tool_scan_text(args: dict[str, Any]) -> str:
    filename = str(args.get("filename") or "content.txt")
    content = str(args.get("content") or "")
    raw = content.encode("utf-8")
    if len(raw) > MAX_TEXT_BYTES:
        raise ValueError(f"内容过大 ({len(raw)} bytes > {MAX_TEXT_BYTES})")
    timeout = int(args.get("timeout") or 120)
    result = _post_multipart("/scan/upload", filename, raw)
    return _format(result)


def tool_scan_url(args: dict[str, Any]) -> str:
    url = str(args.get("url") or "")
    if not url:
        raise ValueError("缺少 url 参数")
    timeout = int(args.get("timeout") or 60)
    return _format(_post_json("/scan/url", {"url": url, "timeout": timeout}))


def tool_scan_skill_pkg(args: dict[str, Any]) -> str:
    package_path = str(args.get("package_path") or "")
    if not package_path:
        raise ValueError("缺少 package_path 参数")
    p = Path(package_path)
    if not p.is_file():
        raise ValueError(f"文件不存在: {package_path}")
    if not p.name.lower().endswith(ALLOWED_SUFFIXES):
        raise ValueError(f"不支持的压缩格式: {p.name} (仅支持 zip / tar 系列)")
    result = _post_multipart("/scan/package", p.name, p.read_bytes())
    return _format(result)


def tool_kse_status(_args: dict[str, Any]) -> str:
    data = _get_json("/health")
    return "\n".join(
        [
            f"status: {data.get('status')}",
            f"kse_url: {data.get('kse_url')}",
            f"kse_mode: {data.get('kse_mode')} (实际使用: {data.get('kse_mode_used')})",
            f"kse_auth: {data.get('kse_auth')}",
            f"scan_queue: {data.get('scan_queue')}",
            f"quarantine: {data.get('quarantine')}",
            f"allowed_dirs: {', '.join(data.get('allowed_dirs', []))}",
            f"cache_size: {data.get('cache_size')}",
        ]
    )


TOOLS = [
    {
        "name": "scan_file",
        "description": "扫描本机文件。file_path 必须位于网关允许的扫描目录内。返回 verdict (CLEAN/DETECT) 与威胁名称。",
        "handler": tool_scan_file,
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "待扫描文件的绝对路径"},
                "timeout": {"type": "integer", "description": "扫描超时(秒), 默认 120"},
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "scan_text",
        "description": "扫描一段文本内容 (内存中上传, 不落盘)。用于检查脚本、配置、提示词等。filename 用于让 KSE 判断文件类型。",
        "handler": tool_scan_text,
        "inputSchema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "虚拟文件名, 例如 install.sh / SKILL.md"},
                "content": {"type": "string", "description": "待扫描的文本内容"},
                "timeout": {"type": "integer", "description": "扫描超时(秒), 默认 120"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "scan_url",
        "description": "扫描 URL，检测钓鱼站点与恶意跳转链接。下载任何外部链接前建议先调用。",
        "handler": tool_scan_url,
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "待扫描的 URL"},
                "timeout": {"type": "integer", "description": "扫描超时(秒), 默认 60"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "scan_skill_pkg",
        "description": "深度扫描 Skill / 插件压缩包 (zip / tar 系列)。解包后逐文件扫描, 任一命中即整包 DETECT。",
        "handler": tool_scan_skill_pkg,
        "inputSchema": {
            "type": "object",
            "properties": {
                "package_path": {"type": "string", "description": "压缩包绝对路径"},
                "timeout": {"type": "integer", "description": "扫描超时(秒), 默认 300"},
            },
            "required": ["package_path"],
        },
    },
    {
        "name": "kse_status",
        "description": "查看 KSE / Scan Gateway 的连通性与配置状态。",
        "handler": tool_kse_status,
        "inputSchema": {"type": "object", "properties": {}},
    },
]

TOOL_INDEX = {t["name"]: t for t in TOOLS}


# ---------------------------------------------------------------------------
# JSON-RPC 处理
# ---------------------------------------------------------------------------
def handle_message(msg: dict[str, Any]) -> dict[str, Any] | None:
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
                    "Kaspersky Scan Engine 安全网关。在下载 Skill、读取外部文件、"
                    "拉取 URL 或执行不可信内容之前调用对应工具做安全检查。"
                    "若返回 verdict=DETECT，必须停止后续操作并向用户报告威胁名称。"
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
                    {
                        "name": t["name"],
                        "description": t["description"],
                        "inputSchema": t["inputSchema"],
                    }
                    for t in TOOLS
                ]
            },
        }

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = TOOL_INDEX.get(name)
        if not tool:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32602, "message": f"未知工具: {name}"},
            }
        try:
            text = tool["handler"](arguments)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {"content": [{"type": "text", "text": text}], "isError": False},
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"❌ 扫描失败: {exc}"}],
                    "isError": True,
                },
            }

    if msg_id is None:
        return None  # 未知通知, 忽略
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"不支持的方法: {method}"},
    }


def main() -> None:
    # 日志必须走 stderr —— stdout 是 MCP 协议通道
    print(f"[{SERVER_NAME}] MCP Server 启动, Scan Gateway: {SCAN_GATEWAY}", file=sys.stderr)
    stdin = sys.stdin
    stdout = sys.stdout
    while True:
        line = stdin.readline()
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
            response = {
                "jsonrpc": "2.0",
                "id": msg.get("id"),
                "error": {"code": -32603, "message": str(exc)},
            }
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            stdout.flush()


if __name__ == "__main__":
    main()
