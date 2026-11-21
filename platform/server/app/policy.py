"""集中策略：控制台编辑，客户端定期拉取。"""
import copy
import time

from . import db

DEFAULT_POLICY = {
    "version": 1,
    "mode": "enforce",                 # enforce = 阻断；audit = 仅告警放行
    "fail_open": True,                 # 平台/KSE 不可达时是否放行（客户端离线时生效）
    "block_non_scanned": True,         # NON_SCANNED（加密/损坏/跳过）按未放行处理
    "rules_action": "block",           # KAIP 补充规则命中：block / alert / off
    "install_action": "scan",          # Agent 执行安装/下载命令：scan(事后扫描) / block / allow
    "quarantine_on_detect": True,
    "max_inline_scan_mb": 50,          # Hook 内联提交的最大文件大小，超过则交给 watcher 异步扫描
    "scan_on_write": True,
    "scan_on_exec": True,
    "scan_skills_on_session_start": True,
    "check_urls": True,                # 对命令中的 URL 做信誉检查（需 KSE 开启 KSN/反钓鱼）
    "watch_paths": {                   # 客户端 watcher 监控的目录（~ 为用户主目录）
        "common": ["~/.agents/skills", "~/.cache/huggingface/hub", "~/.ollama/models"],
        "codex": ["~/.codex/skills", "~/.codex/plugins"],
        "opencode": ["~/.config/opencode/plugins", "~/.config/opencode/skills", "~/.opencode/skills"],
        "workbuddy": ["~/.workbuddy/skills", "~/.workbuddy/plugins", "~/.codebuddy/skills", "~/.codebuddy/plugins"],
    },
    # 受信任来源目录（子串匹配，支持 *；路径统一为小写正斜杠）：目录内文件仍经 KSE 扫描，
    # 但 KAIP 启发式规则命中只告警不阻断 —— 用于厂商官方插件市场等已有签名/审核的来源
    "trusted_paths": [
        "/.workbuddy/plugins/marketplaces/workbuddy-connector-plugins-official/",
        "/.workbuddy/plugins/marketplaces/codebuddy-plugins-official/",
        "/.workbuddy/plugins/cache/workbuddy-builtin/",
        "/.codex/plugins/cache/openai-*/",
    ],
    "tamper_protection": True,         # 自我保护：阻止 Agent 读取 KAIP 凭据、修改/停用 KAIP 与 hook 配置
    "self_heal": True,                 # 客户端文件被改/删、hook 被移除时自动从平台恢复
    "known_tools": {"codex": [], "workbuddy": [], "opencode": []},   # 管理员评估后确认的工具名（不再作为新工具提醒）
    "allow_hashes": [],                # 白名单 sha256
    "block_hashes": [],                # 黑名单 sha256
    "allow_url_prefixes": [],          # 安装来源白名单（如内部镜像）
    "block_url_patterns": [],          # 安装来源黑名单（子串）
}


def policy_fingerprint(p: dict) -> str:
    """与客户端 tamper.policyHash 一致：去掉 updated_at 后按键排序的紧凑 JSON 的 SHA256。"""
    import hashlib
    import json

    def strip(v):
        if isinstance(v, dict):
            return {k: strip(x) for k, x in v.items() if k != "updated_at"}
        if isinstance(v, list):
            return [strip(x) for x in v]
        return v
    s = json.dumps(strip(p or {}), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def get_policy() -> dict:
    p = db.kv_get("policy")
    if not p:
        p = copy.deepcopy(DEFAULT_POLICY)
        p["updated_at"] = time.time()
        db.kv_set("policy", p)
    # 平台升级新增的策略键：补默认值并提升版本号，确保终端在下次心跳时拉取
    added = [k for k in DEFAULT_POLICY if k not in p]
    if added:
        for k in added:
            p[k] = copy.deepcopy(DEFAULT_POLICY[k])
        p["version"] = int(p.get("version", 1)) + 1
        p["updated_at"] = time.time()
        db.kv_set("policy", p)
    return p


def set_policy(newp: dict) -> dict:
    cur = get_policy()
    for k in DEFAULT_POLICY:
        if k in newp and k != "version":
            cur[k] = newp[k]
    cur["version"] = int(cur.get("version", 1)) + 1
    cur["updated_at"] = time.time()
    db.kv_set("policy", cur)
    return cur
