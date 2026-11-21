"""SIEM 对接：事件以 CEF 或 JSON 通过 Syslog(UDP/TCP) 转发（如 Kaspersky KUMA）。
同时内置 Syslog 接收器，把 KSE 自身（ICAP/HTTP 模式）发出的扫描日志纳入平台事件。"""
from __future__ import annotations

import json
import logging
import re
import socket
import socketserver
import threading
import time

from . import db

log = logging.getLogger("kaip.siem")

SEV = {"DETECT": 9, "RISK": 7, "NON_SCANNED": 5, "ERROR": 4, "CLEAN": 1}


def _cef_escape(v: str, header=False) -> str:
    v = str(v)
    if header:
        return v.replace("\\", "\\\\").replace("|", "\\|")
    return v.replace("\\", "\\\\").replace("=", "\\=").replace("\n", " ").replace("\r", " ")


def to_cef(ev: dict) -> str:
    ext = {
        "rt": int(ev.get("ts", time.time()) * 1000),
        "act": ev.get("action", ""),
        "cat": ev.get("category", ""),
        "src": ev.get("host", ""),
        "suser": ev.get("username", ""),
        "fname": (ev.get("object") or "")[:1000],
        "fileHash": ev.get("sha256", ""),
        "fsize": ev.get("size") or 0,
        "cs1Label": "verdict", "cs1": ev.get("verdict", ""),
        "cs2Label": "detection", "cs2": ev.get("detection", ""),
        "cs3Label": "aiAgent", "cs3": ev.get("agent_type", ""),
        "cs4Label": "source", "cs4": ev.get("source", ""),
        "externalId": ev.get("id", ""),
    }
    name = ev.get("detection") or ev.get("verdict") or "event"
    hdr = "|".join(_cef_escape(x, True) for x in [
        "CEF:0", "Kaspersky", "KAIP Platform", "1.0", f"{ev.get('source','')}:{ev.get('verdict','')}", name,
        str(SEV.get(ev.get("verdict", ""), 3))])
    return hdr + "|" + " ".join(f"{k}={_cef_escape(v)}" for k, v in ext.items() if v not in ("", None))


def forward(ev: dict):
    cfg = db.kv_get("siem", {}) or {}
    if not cfg.get("enabled") or not cfg.get("host"):
        return
    if cfg.get("only_alerts", True) and ev.get("verdict") == "CLEAN":
        return
    msg = to_cef(ev) if cfg.get("format", "cef") == "cef" else json.dumps(ev, ensure_ascii=False, default=str)
    line = f"<{14 if ev.get('verdict') == 'CLEAN' else 12}>{time.strftime('%b %d %H:%M:%S')} kaip {msg}"
    try:
        port = int(cfg.get("port", 514))
        if cfg.get("protocol", "udp") == "tcp":
            with socket.create_connection((cfg["host"], port), timeout=3) as s:
                s.sendall(line.encode() + b"\n")
        else:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.sendto(line.encode()[:65000], (cfg["host"], port))
    except Exception as e:
        log.warning("SIEM 转发失败: %s", e)


# ---------- KSE 日志接收 ----------
_key_rx = re.compile(r"(?:^|(?<=\s))(\w+)=")


def _cef_ext(ext: str) -> dict:
    """解析 CEF 扩展字段。按「空白 + 键=」切分：KSE 不转义值中的 =（如 URL 查询参数 ?x=1），不能按 = 切。"""
    keys = list(_key_rx.finditer(ext))
    out = {}
    for i, m in enumerate(keys):
        end = keys[i + 1].start() if i + 1 < len(keys) else len(ext)
        out[m.group(1)] = ext[m.end():end].strip().replace("\\=", "=")
    return out


def parse_kse_line(line: str) -> dict | None:
    """尽力解析 KSE 的 CEF / RAW 日志行，只关注扫描结果。"""
    if "CEF:" in line:
        body = line[line.index("CEF:"):]
        parts = body.split("|", 7)
        if len(parts) < 8:
            return None
        name = parts[5]
        # 只收扫描结果（Scan result detect / other / clean）；启动、停止、KSN 连接等 Audit 事件不入库
        if not name.lower().startswith("scan result"):
            return None
        ext = _cef_ext(parts[7])
        # KSE 的自定义字段含义由 csNLabel 给出（ICAP：cs1=Scan result、cs3=X-Client-IP、cs4=Virus name、cs5=SHA256）
        lab = {ext[k + "Label"].lower(): v for k, v in ext.items() if k + "Label" in ext}
        result = (lab.get("scan result") or name).upper()
        verdict = "DETECT" if ("DETECT" in result or "INFECTED" in result) else (
            "NON_SCANNED" if ("NON_SCANNED" in result or "OTHER" in name.upper()) else "CLEAN")
        virus = lab.get("virus name", "")
        client = next((v for v in (lab.get("x-client-ip"), ext.get("src"), ext.get("shost")) if v and v != "-"), "")
        return {
            "object": ext.get("request") or ext.get("fname") or ext.get("filePath") or name,
            "detection": virus if virus not in ("", "-") else (name if verdict == "DETECT" else ""),
            "verdict": verdict, "host": client,
            "sha256": (lab.get("sha256") or "").lower(), "raw": line[:2000],
        }
    up = line.upper()
    if "DETECT" in up or "NON_SCANNED" in up:
        m = re.search(r"(https?://\S+|/\S+)", line)
        d = re.search(r"(?:detectionName|Detect(?:ed)?)[\"=: ]+\"?([\w.\-:/]+)", line, re.I)
        return {"object": m.group(1) if m else line[:200], "detection": d.group(1) if d else "",
                "verdict": "DETECT" if "DETECT" in up else "NON_SCANNED", "host": "", "raw": line[:2000]}
    return None


class _UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        data = self.request[0].decode("utf-8", errors="ignore")
        for line in data.splitlines():
            ev = parse_kse_line(line)
            if ev:
                raw = ev.pop("raw")
                # 下载代理（ICAP RESPMOD）检出时 KSE 返回拦截页，下载被阻断
                db.add_event(source="kse-syslog", category="icap", agent_type="-",
                             action="block" if ev["verdict"] == "DETECT" else "log",
                             host=ev.pop("host") or self.client_address[0], details={"raw": raw}, **ev)


def start_syslog_listener(port: int):
    def run():
        try:
            srv = socketserver.ThreadingUDPServer(("0.0.0.0", port), _UDPHandler)
            log.info("KSE syslog 接收已启动 udp/%s", port)
            srv.serve_forever()
        except OSError as e:
            log.warning("syslog 接收启动失败: %s", e)
    threading.Thread(target=run, daemon=True, name="kaip-syslog").start()
