"""kse-ai-gateway MCP Server — 让任意支持 MCP 的 AI Agent 原生接入 KSE 扫描.

传输方式: stdio (标准 MCP 客户端配置方式)
依赖:     pip install "mcp>=1.2"

提供工具:
  scan_file        扫描本机文件 (路径白名单内)
  scan_text        扫描文本内容 (内存, 不落盘)
  scan_url         扫描 URL (钓鱼 / 恶意链接)
  scan_skill_pkg   深度扫描 Skill / 插件压缩包 (解包逐文件)
  kse_status       查看 KSE 与网关状态

设计:
  - 所有实际扫描都由远端 Scan Gateway 执行, 本进程只做协议适配与参数校验
  - Fail-Closed: 网关不可达时返回明确错误, 由 Agent 决定是否阻断
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

SCAN_GATEWAY: str = os.getenv("KSE_SCAN_GATEWAY", "http://127.0.0.1:8000").rstrip("/")
TIMEOUT: int = int(os.getenv("KSE_SCAN_TIMEOUT", "300"))
MAX_TEXT_BYTES: int = int(os.getenv("KSE_MAX_TEXT_BYTES", str(50 * 1024 * 1024)))
ALLOWED_SUFFIXES = {
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".tar.gz", ".tar.bz2", ".tar.xz",
}

mcp = FastMCP(
    "kse-ai-gateway",
    instructions=(
        "Kaspersky Scan Engine 安全网关。在下载 Skill、读取外部文件、"
        "拉取 URL 或执行不可信内容之前调用对应工具做安全检查。"
        "若返回 verdict=DETECT，必须停止后续操作并向用户报告威胁名称。"
    ),
)


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=TIMEOUT)


async def _post_json(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        async with _client() as client:
            resp = await client.post(f"{SCAN_GATEWAY}{path}", json=payload)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc}") from exc
    if resp.status_code >= 400:
        raise RuntimeError(f"Scan Gateway 返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def _post_multipart(path: str, files: dict[str, Any], data: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        async with _client() as client:
            resp = await client.post(f"{SCAN_GATEWAY}{path}", files=files, data=data or {})
    except httpx.HTTPError as exc:
        raise RuntimeError(f"无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc}") from exc
    if resp.status_code >= 400:
        raise RuntimeError(f"Scan Gateway 返回 {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _format(result: dict[str, Any]) -> str:
    """把扫描结果格式化成简洁文本, 便于模型消费."""
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
# 工具
# ---------------------------------------------------------------------------
@mcp.tool()
async def scan_file(file_path: str, timeout: int = 120) -> str:
    """扫描本机文件。file_path 必须位于网关允许的扫描目录内。

    返回 verdict (CLEAN / DETECT) 与威胁名称。
    """
    result = await _post_json("/scan/file", {"file_path": file_path, "timeout": timeout})
    return _format(result)


@mcp.tool()
async def scan_text(filename: str, content: str, timeout: int = 120) -> str:
    """扫描一段文本内容（内存中上传，不落盘）。用于检查脚本、配置、提示词等。

    filename 用于给 KSE 判断文件类型，例如 "install.sh"、"SKILL.md"。
    """
    raw = content.encode("utf-8")
    if len(raw) > MAX_TEXT_BYTES:
        raise ValueError(f"内容过大 ({len(raw)} bytes > {MAX_TEXT_BYTES})")
    result = await _post_multipart(
        "/scan/upload",
        files={"file": (filename or "content.txt", raw, "application/octet-stream")},
    )
    return _format(result)


@mcp.tool()
async def scan_url(url: str, timeout: int = 60) -> str:
    """扫描 URL，检测钓鱼站点与恶意跳转链接。下载任何外部链接前建议先调用。"""
    result = await _post_json("/scan/url", {"url": url, "timeout": timeout})
    return _format(result)


@mcp.tool()
async def scan_skill_pkg(package_path: str, timeout: int = 300) -> str:
    """深度扫描 Skill / 插件压缩包（zip / tar 系列）。

    会解包后逐文件扫描，任一文件命中威胁即判定整包为 DETECT。
    压缩包炸弹与 Zip Slip 会被拦截。
    """
    p = Path(package_path)
    if not p.is_file():
        raise ValueError(f"文件不存在: {package_path}")
    suffix = p.name.lower()
    if not any(suffix.endswith(s) for s in ALLOWED_SUFFIXES):
        raise ValueError(f"不支持的压缩格式: {p.name}（仅支持 zip / tar 系列）")

    with open(p, "rb") as f:
        content = f.read()
    result = await _post_multipart(
        "/scan/package",
        files={"file": (p.name, content, "application/octet-stream")},
    )
    return _format(result)


@mcp.tool()
async def kse_status() -> str:
    """查看 KSE / Scan Gateway 的连通性与配置状态。"""
    try:
        async with _client() as client:
            resp = await client.get(f"{SCAN_GATEWAY}/health")
    except httpx.HTTPError as exc:
        return f"❌ 无法连接 Scan Gateway ({SCAN_GATEWAY}): {exc}"
    if resp.status_code >= 400:
        return f"❌ Scan Gateway 返回 {resp.status_code}: {resp.text[:300]}"
    data = resp.json()
    return "\n".join(
        [
            f"status: {data.get('status')}",
            f"kse_url: {data.get('kse_url')}",
            f"scan_queue: {data.get('scan_queue')}",
            f"quarantine: {data.get('quarantine')}",
            f"allowed_dirs: {', '.join(data.get('allowed_dirs', []))}",
            f"cache_size: {data.get('cache_size')}",
        ]
    )


def main() -> None:
    """以 stdio 传输启动 MCP Server."""
    asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
