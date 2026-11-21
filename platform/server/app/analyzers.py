"""KAIP 补充规则层：在 KSE 判定之外，针对 AI 供应链与 Agent 行为做静态风险识别。

- 模型文件：解析 pickle 操作码，识别加载时可执行代码的导入（os.system、subprocess、eval 等）
- Skill / 脚本：识别下载即执行、反弹 shell、编码执行、凭据窃取等高危模式
- Agent 命令：识别高危命令与安装/下载类命令（供策略决定拦截或扫描）

规则命中为 RISK（风险），是否阻断由策略决定；KSE 的 DETECT 始终优先。
"""
from __future__ import annotations

import io
import pickletools
import re
import zipfile

MODEL_EXT = {".pkl", ".pickle", ".pt", ".pth", ".ckpt", ".bin", ".joblib", ".keras", ".kers", ".h5",
             ".safetensors", ".gguf", ".onnx", ".npy", ".npz"}
SCRIPT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd",
              ".vbs", ".rb", ".pl", ".php"}

# pickle 中可导致代码执行的 GLOBAL 导入
DANGEROUS_GLOBALS = {
    ("os", "system"), ("os", "popen"), ("os", "execv"), ("os", "execve"), ("os", "execl"), ("os", "spawnv"),
    ("posix", "system"), ("nt", "system"), ("subprocess", "Popen"), ("subprocess", "call"),
    ("subprocess", "check_call"), ("subprocess", "check_output"), ("subprocess", "run"),
    ("builtins", "eval"), ("builtins", "exec"), ("builtins", "compile"), ("builtins", "__import__"),
    ("builtins", "open"), ("builtins", "getattr"), ("__builtin__", "eval"), ("__builtin__", "exec"),
    ("runpy", "run_path"), ("runpy", "run_module"), ("importlib", "import_module"),
    ("socket", "socket"), ("pty", "spawn"), ("webbrowser", "open"), ("shutil", "rmtree"),
    ("requests", "get"), ("requests", "post"), ("urllib.request", "urlopen"),
}
DANGEROUS_MODULES = {"os", "posix", "nt", "subprocess", "socket", "pty", "runpy", "ctypes", "commands"}

# shell 启动文件（写入即持久化）
_RC = r"\.(bashrc|zshrc|bash_profile|profile)\b"

SCRIPT_RULES = [
    ("download-exec", r"(curl|wget)[^\n|;]{0,200}\|\s*(ba|z)?sh\b", "下载后直接执行 shell"),
    ("download-exec-ps", r"(iwr|invoke-webrequest|irm|invoke-restmethod|downloadstring|downloadfile)[^\n]{0,200}(\|\s*iex|invoke-expression)", "PowerShell 下载后执行"),
    ("ps-encoded", r"powershell(\.exe)?[^\n]{0,60}\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}", "PowerShell 编码命令"),
    # 反弹 shell：必须同时具备「连接远端」与「重定向文件描述符 / 拉起 shell」，避免把本地 AF_UNIX 探测误判
    ("reverse-shell", r"(/dev/tcp/\d{1,3}(\.\d{1,3}){3}/\d+|\bnc(at)?\s+(-e|-c)\s|bash\s+-i\s*>&|"
                      r"\.connect\(\s*\(\s*[\"'][\w.\-]+[\"']\s*,\s*\d+\s*\)\s*\)[\s\S]{0,400}(os\.dup2\([^)]*fileno|pty\.spawn\(|subprocess\.\w+\(\s*\[?\s*[\"'](/bin/(ba)?sh|cmd(\.exe)?|powershell)))", "反弹 shell"),
    ("b64-exec", r"(exec|eval)\s*\(\s*(base64\.b64decode|codecs\.decode|bytes\.fromhex|zlib\.decompress|marshal\.loads)", "解码后动态执行"),
    ("js-b64-exec", r"(eval|Function)\s*\(\s*(atob|Buffer\.from)\s*\(", "JS 解码后动态执行"),
    ("cred-access", r"(\.ssh/id_(rsa|ed25519)|\.aws/credentials|\.netrc|\.git-credentials|Login Data|\.codex/auth\.json|\.config/opencode/auth|wallet\.dat|\.kube/config)", "访问凭据/密钥文件"),
    ("env-exfil", r"(os\.environ|process\.env|\$env:)[^\n]{0,120}(requests\.post|fetch\(|curl\s|Invoke-RestMethod|http\.request)", "环境变量外传"),
    # 持久化：shell 启动文件只认「写入」（重定向 / tee / sed -i / cp·mv·ln 目标 / 代码追加写），
    # 只读访问（grep、cat、source ~/.bashrc）不算；crontab -l 为只读查询
    ("persistence", r"(crontab\s+-(?!l\b)|schtasks\s+/create|HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run|systemctl\s+enable|LaunchAgents|"
                    r">>?\s*[\"']?[^\s\"'|;&<>]*" + _RC + r"|"
                    r"\btee\b[^\n|;&]*" + _RC + r"|"
                    r"\bsed\b(?=[^\n|;&]*\s-i)[^\n|;&]*" + _RC + r"|"
                    r"\b(cp|mv|ln|install)\b[^\n|;&]*\s[\"']?[^\s\"'|;&<>]*" + _RC + r"[\"']?\s*(?=$|[\n|;&)])|"
                    r"(open\(|appendFile(Sync)?\(|writeFile(Sync)?\(|Add-Content|Set-Content|Out-File)[^\n]{0,160}" + _RC + r")", "持久化驻留"),
    ("destroy", r"(rm\s+-rf\s+(/|~|\$HOME)(\s|$)|del\s+/[sq]\s+[a-z]:\\|format\s+[a-z]:|mkfs\.|Remove-Item\s+[^\n]*-Recurse[^\n]*(C:\\|\$env:USERPROFILE)\s)", "破坏性删除"),
    ("defense-evasion", r"(Set-MpPreference\s+-Disable|Add-MpPreference\s+-ExclusionPath|setenforce\s+0|ufw\s+disable|iptables\s+-F|vssadmin\s+delete\s+shadows)", "关闭/绕过安全防护"),
    ("miner", r"(stratum\+tcp://|xmrig|minerd|cryptonight)", "挖矿程序"),
]
_SCRIPT_RX = [(rid, re.compile(rx, re.I), desc) for rid, rx, desc in SCRIPT_RULES]

INSTALL_RX = re.compile(
    r"(\bgit\s+clone\b|\bpip3?\s+install\b|\buv\s+(pip\s+install|add)\b|\bnpm\s+(i|install|add)\b|\bpnpm\s+(i|install|add)\b|"
    r"\byarn\s+add\b|\bbun\s+(add|install)\b|\bnpx\s+|\bcurl\b[^\n]*\s-(o|O)\b|\bwget\s|\bInvoke-WebRequest\b|\biwr\s|"
    r"\bhuggingface-cli\s+download\b|\bhf\s+download\b|\bollama\s+pull\b|\bmodelscope\s+download\b|"
    r"\b(clawhub|skills?)\s+(install|add)\b|\bcodex\s+mcp\s+add\b|\bopencode\s+mcp\b)",
    re.I,
)


def scan_pickle(data: bytes) -> list[dict]:
    findings = []
    try:
        ops = list(pickletools.genops(io.BytesIO(data)))
    except Exception:
        return findings
    strings: list[str] = []
    for op, arg, _pos in ops:
        name = op.name
        if name in ("SHORT_BINUNICODE", "BINUNICODE", "UNICODE", "BINUNICODE8", "STRING", "SHORT_BINSTRING", "BINSTRING"):
            strings.append(str(arg))
        if name in ("GLOBAL", "INST"):
            mod, _, attr = str(arg).partition(" ")
            if (mod, attr) in DANGEROUS_GLOBALS or mod.split(".")[0] in DANGEROUS_MODULES:
                findings.append({"rule": "pickle-dangerous-global", "desc": f"反序列化时调用 {mod}.{attr}", "severity": "high"})
        elif name == "STACK_GLOBAL" and len(strings) >= 2:
            mod, attr = strings[-2], strings[-1]
            if (mod, attr) in DANGEROUS_GLOBALS or mod.split(".")[0] in DANGEROUS_MODULES:
                findings.append({"rule": "pickle-dangerous-global", "desc": f"反序列化时调用 {mod}.{attr}", "severity": "high"})
    return findings


def scan_model(data: bytes, name: str) -> list[dict]:
    """PyTorch .pt/.pth/.ckpt 实为 zip(data.pkl)；.pkl/.joblib 为原始 pickle。"""
    findings = []
    if data[:4] == b"PK\x03\x04":
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
            for n in zf.namelist():
                if n.endswith(".pkl") or n.endswith("/data.pkl"):
                    for f in scan_pickle(zf.read(n)):
                        f["desc"] += f"（{n}）"
                        findings.append(f)
                elif n.lower().endswith(tuple(SCRIPT_EXT)) or n.endswith("config.json") or n.endswith(".keras"):
                    findings += scan_script(zf.read(n)[:2_000_000], n)
        except zipfile.BadZipFile:
            pass
    elif data[:1] == b"\x80" or name.lower().endswith((".pkl", ".pickle", ".joblib", ".bin", ".pt", ".pth", ".ckpt", ".npy")):
        findings += scan_pickle(data)
    # Keras Lambda 层可携带任意代码
    if name.lower().endswith((".keras", ".h5", ".kers")) and b"Lambda" in data and (b"marshal" in data or b"exec" in data):
        findings.append({"rule": "keras-lambda-code", "desc": "Keras Lambda 层嵌入可执行代码", "severity": "high"})
    return findings


DOC_EXT = (".md", ".markdown", ".txt", ".rst", ".adoc", ".html", ".htm", ".json", ".yaml", ".yml", ".toml")
# 单独出现时只作中危提示的规则（常见于正常安装脚本：写 PATH 到 .bashrc、提及 .netrc 等）
MEDIUM_RULES = {"persistence", "cred-access"}


def scan_script(data: bytes, name: str = "") -> list[dict]:
    """文档类文件（SKILL.md、README 等）中的命中只作为中危提示：
    文档里写安装命令（如官方 uv/rustup 安装脚本）非常普遍，不应阻断或隔离。"""
    text = data[:5_000_000].decode("utf-8", errors="ignore")
    low = (name or "").lower().replace("\\", "/")
    is_doc = low.endswith(DOC_EXT) and not low.endswith("package.json")   # npm postinstall 是真实攻击面
    out = []
    for rid, rx, desc in _SCRIPT_RX:
        m = rx.search(text)
        if m:
            sev = "medium" if (is_doc or rid in MEDIUM_RULES) else "high"
            out.append({"rule": rid, "desc": desc + ("（文档/配置中出现）" if is_doc else ""), "severity": sev,
                        "match": m.group(0)[:160], "file": name})
    return out


def downgrade(findings: list) -> list:
    for f in findings:
        if f.get("severity") == "high":
            f["severity"] = "medium"
            f["desc"] += "（受信任来源目录）"
    return findings


def scan_archive(data: bytes, name: str, depth: int = 0) -> list[dict]:
    """Skill 包 / 代码包：逐个检查脚本与模型文件。"""
    out = []
    if depth > 4:
        return out
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return out
    for info in zf.infolist()[:5000]:
        if info.is_dir() or info.flag_bits & 0x1 or info.file_size > 200 * 1024 * 1024:
            continue
        n = info.filename
        low = n.lower()
        ext = "." + low.rsplit(".", 1)[-1] if "." in low else ""
        if ext in SCRIPT_EXT or low.endswith(("skill.md", "package.json", "setup.py", "pyproject.toml", "makefile")):
            for f in scan_script(zf.read(info), n):
                out.append(f)
        elif ext in MODEL_EXT:
            for f in scan_model(zf.read(info), n):
                f["file"] = n
                out.append(f)
        elif ext == ".zip":
            out += scan_archive(zf.read(info), n, depth + 1)
    return out


# AI Agent 自身的会话记录 / 日志：内容是 Agent 执行过的命令文本，跑启发式规则必然误报（仍交 KSE 扫描）
AGENT_STATE_RX = re.compile(r"[\\/](\.codex[\\/](sessions|archived_sessions|log|logs)|\.kaip|"
                            r"\.local[\\/]share[\\/]opencode[\\/](storage|log|snapshot))[\\/]", re.I)


def analyze_content(data: bytes, name: str = "", category: str = "") -> list[dict]:
    if AGENT_STATE_RX.search(name or ""):
        return []
    if category == "literal":
        # 从命令/代码中提取的字符串字面量：只交引擎判定，不跑启发式规则（命令整体已单独过规则）
        return []
    low = (name or "").lower()
    ext = "." + low.rsplit(".", 1)[-1] if "." in low else ""
    if ext in MODEL_EXT or category in ("model",):
        return scan_model(data, low)
    if data[:4] == b"PK\x03\x04":
        if ext in (".docx", ".xlsx", ".pptx"):
            return []
        return scan_archive(data, name)
    if ext in SCRIPT_EXT or category in ("write", "skill", "exec", "code") or not ext:
        return scan_script(data, name)
    if category == "dataset" or ext in (".jsonl", ".json", ".csv", ".parquet", ".txt", ".md"):
        # 训练/微调数据集：检查嵌入的可执行代码模式
        return scan_script(data, name)
    return []


def analyze_command(cmd: str) -> dict:
    """返回 {'risks': [...], 'install': bool}"""
    risks = scan_script(cmd.encode(), "command")
    return {"risks": risks, "install": bool(INSTALL_RX.search(cmd))}
