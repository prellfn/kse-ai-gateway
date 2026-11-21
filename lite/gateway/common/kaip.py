"""KaipClient — Lite 网关的「KAIP 平台后端」.

与 KseClient 接口一致, 但把扫描委托给 KAIP 平台 (而不是直连 KSE)。
好处: 边缘节点上的 Lite 网关与中心平台共用同一套策略、同一份审计台账。

平台接口:
  POST /api/v1/agent/enroll     终端注册
  POST /api/v1/agent/scan       文件扫描 (multipart)
  POST /api/v1/agent/checkurl   URL 信誉检查
鉴权: Authorization: Bearer <agent_token> + X-KAIP-Agent: <agent_id>

判定映射 (尊重平台的 action 决策):
  CLEAN + allow        -> CLEAN
  DETECT + block       -> DETECT (Lite 侧同样拦截并隔离)
  RISK  + alert        -> CLEAN (平台决定只告警, Lite 放行但记录)
  NON_SCANNED / ERROR  -> SCAN_ERROR (Fail-Closed, 不放行)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EICAR_HINT = "EICAR"


class KaipError(Exception):
    """KAIP 平台调用失败."""


class KaipClient:
    def __init__(
        self,
        url: str = "http://127.0.0.1:8080",
        enroll_token: str = "",
        agent_id: str = "",
        agent_token: str = "",
        timeout: int = 120,
        agent_type: str = "lite-gateway",
        state_dir: str = "~/.cache/kse-ai-gateway",
    ):
        self.url = url.rstrip("/")
        self.enroll_token = enroll_token
        self.agent_id = agent_id
        self.agent_token = agent_token
        self.timeout = timeout
        self.agent_type = agent_type
        self.state_dir = Path(os.path.expanduser(state_dir))
        self.state_file = self.state_dir / "agent.json"
        self.last_mode_used: str | None = None
        self.last_mode_fallback: bool = False

    # -- 终端注册 --------------------------------------------------------
    def _load_state(self) -> dict:
        if self.state_file.is_file():
            try:
                return json.loads(self.state_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _save_state(self, data: dict) -> None:
        try:
            self.state_dir.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            self.state_file.chmod(0o600)
        except Exception:
            pass

    def _headers(self) -> dict[str, str]:
        h = {}
        if self.agent_token:
            h["Authorization"] = f"Bearer {self.agent_token}"
            h["X-KAIP-Agent"] = self.agent_id
        return h

    def _post(self, path: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        req = urllib.request.Request(f"{self.url}{path}", data=data, headers=self._headers(), method="POST")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout + 30) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                detail = json.loads(raw).get("detail", raw)
            except json.JSONDecodeError:
                detail = raw
            raise KaipError(f"KAIP 平台返回 {exc.code}: {str(detail)[:300]}") from exc
        except urllib.error.URLError as exc:
            raise KaipError(f"无法连接 KAIP 平台 ({self.url}): {exc.reason}") from exc

    def _upload(self, path: str, filename: str, content: bytes, fields: dict) -> dict:
        boundary = "----KSEGateway" + uuid.uuid4().hex[:12]
        parts: list[bytes] = []
        for k, v in fields.items():
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
            )
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        parts.append(content)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        body = b"".join(parts)
        headers = self._headers()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        req = urllib.request.Request(f"{self.url}{path}", data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout + 30) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return json.loads(raw) if raw.strip() else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                detail = json.loads(raw).get("detail", raw)
            except json.JSONDecodeError:
                detail = raw
            raise KaipError(f"KAIP 平台返回 {exc.code}: {str(detail)[:300]}") from exc
        except urllib.error.URLError as exc:
            raise KaipError(f"无法连接 KAIP 平台 ({self.url}): {exc.reason}") from exc

    def ensure_enrolled(self) -> tuple[str, str]:
        """确保已注册; 返回 (agent_id, agent_token)."""
        if self.agent_id and self.agent_token:
            return self.agent_id, self.agent_token
        state = self._load_state()
        if state.get("agent_id") and state.get("agent_token"):
            self.agent_id, self.agent_token = state["agent_id"], state["agent_token"]
            return self.agent_id, self.agent_token
        if not self.enroll_token:
            raise KaipError(
                "KAIP 后端未配置终端凭据。请设置 KAIP_ENROLL_TOKEN, 或 KAIP_AGENT_ID / KAIP_AGENT_TOKEN。"
            )
        r = self._post(
            "/api/v1/agent/enroll",
            {
                "enroll_token": self.enroll_token,
                "hostname": os.uname().nodename if hasattr(os, "uname") else "lite-gateway",
                "os": "linux",
                "username": os.environ.get("USER", ""),
                "client_version": "kse-ai-gateway-lite",
                "agents": [self.agent_type],
            },
        )
        self.agent_id = r.get("agent_id", "")
        self.agent_token = r.get("agent_token", "")
        if not self.agent_id or not self.agent_token:
            raise KaipError(f"KAIP 终端注册失败: {r}")
        self._save_state({
            "agent_id": self.agent_id,
            "agent_token": self.agent_token,
            "url": self.url,
            "agent_type": self.agent_type,
            "enrolled_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        return self.agent_id, self.agent_token

    # -- 判定映射 --------------------------------------------------------
    @staticmethod
    def _map(result: dict) -> dict[str, Any]:
        verdict = str(result.get("verdict") or "ERROR").upper()
        action = str(result.get("action") or "").lower()
        detection = result.get("detection") or ""

        if verdict == "CLEAN":
            out_verdict, out_detection = "CLEAN", ""
        elif verdict == "DETECT":
            out_verdict, out_detection = "DETECT", detection
        elif verdict == "RISK":
            # 平台规则命中: 尊重平台的处置决定 (block -> 拦截; alert -> 放行但记录)
            if action == "block":
                out_verdict, out_detection = "DETECT", detection or "KAIP:Rule"
            else:
                out_verdict, out_detection = "CLEAN", ""
        else:  # NON_SCANNED / ERROR / 未知
            out_verdict, out_detection = "SCAN_ERROR", detection

        return {
            "verdict": out_verdict,
            "detection_name": out_detection,
            "raw": result,
            "mode": "kaip",
            "kaip_verdict": verdict,
            "kaip_action": action,
        }

    # -- 对外接口 --------------------------------------------------------
    def scan_bytes(self, content: bytes, timeout: int | None = None, mode_used: str = "kaip",
                   name: str = "object") -> dict[str, Any]:
        self.ensure_enrolled()
        fields = {"path": name, "category": "file", "agent_type": self.agent_type, "source": "cli"}
        result = self._upload("/api/v1/agent/scan", name, content, fields)
        self.last_mode_used = "kaip"
        return self._map(result)

    def scan_path(self, path: str | Path, timeout: int | None = None) -> dict[str, Any]:
        """平台看不到本机路径, 因此按内容上传扫描."""
        p = Path(path)
        if not p.is_file():
            raise KaipError(f"文件不存在: {path}")
        return self.scan_bytes(p.read_bytes(), timeout=timeout, name=p.name)

    def scan_url(self, url: str, timeout: int | None = None) -> dict[str, Any]:
        self.ensure_enrolled()
        r = self._post("/api/v1/agent/checkurl", {"url": url, "agent_type": self.agent_type})
        self.last_mode_used = "kaip"
        return self._map(r)

    def status(self) -> dict:
        out = {"mode": "kaip", "url": self.url, "online": False}
        try:
            self.ensure_enrolled()
            p = self._post("/api/v1/agent/policy")
            out["online"] = True
            out["policy_version"] = p.get("version")
            out["policy_mode"] = p.get("mode")
            out["agent_id"] = self.agent_id
        except Exception as exc:
            out["error"] = str(exc)
        return out
