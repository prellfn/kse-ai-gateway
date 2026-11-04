# 架构拓扑与数据流

> 交互式架构图源文件：`docs/kse_architecture.html`（浏览器打开可切换视图）。

## 1. 整体拓扑

```mermaid
graph TB
    subgraph WS["Windows Server — OpenClaw 运行端"]
        GW["OpenClaw Gateway<br/>127.0.0.1:18789"]
        PLUG["KSE Security Gate Plugin<br/>before_tool_call: write / exec / edit"]
        FW["KSE File Watcher<br/>计划任务 · 轮询 5s"]
        WQ["Windows 隔离区<br/>.openclaw\quarantine\"]
    end

    subgraph LINUX["kumadb (Ubuntu 22.04) — 10.254.205.89"]
        KSE["KSE 扫描引擎<br/>HTTPS + Token<br/>:8443 API · :443 Web UI"]
        SG["Scan Gateway :8000<br/>/scan/file · /scan/upload"]
        UG["Upload Gateway :8002<br/>安全上传页面"]
        SQ["扫描队列<br/>/opt/kaspersky/scanqueue"]
        LQ["Linux 隔离区<br/>/opt/kaspersky/quarantine/"]
        OW["ollama-watcher<br/>inotifywait 监控 blobs"]
        OLL["Ollama (Docker) :11434"]
        LLM["AnythingLLM :3001"]
        PY["Python venv<br/>/opt/ai-stack/venv"]
    end

    GW --> PLUG
    PLUG -->|"POST /scan/upload"| SG
    PLUG -->|"POST /scan/file"| SG
    FW -->|"curl.exe multipart"| SG
    SG --> KSE
    SG --> LQ
    UG --> SG
    UG --> LLM
    SQ --> SG
    OLL --> OW
    OW -->|"POST /scan/file"| SG
    FW --> WQ
    PLUG --> WQ

    classDef win fill:#e3f2fd,stroke:#1976d2
    classDef lnx fill:#e8f5e9,stroke:#2e7d32
    class GW,PLUG,FW,WQ win
    class KSE,SG,UG,SQ,LQ,OW,OLL,LLM,PY lnx
```

---

## 2. 五条防护数据流

### 数据流 ①：OpenClaw `write` 工具拦截（事前拦截 · 内存扫描）

```mermaid
sequenceDiagram
    participant A as AI Agent
    participant P as KSE Plugin
    participant G as Scan Gateway :8000
    participant K as KSE :8443
    participant Q as 隔离区

    A->>P: write(path, content)
    P->>G: POST /scan/upload (multipart)
    G->>K: POST /api/v3.0/scanfile
    K-->>G: CLEAN / DETECT
    G-->>P: verdict
    alt verdict == DETECT
        G->>Q: 移入隔离区
        P-->>A: block:true「[Kaspersky] 检出威胁: EICAR-Test-File」
    else verdict == CLEAN
        P-->>A: {} → 文件正常写入磁盘
    end
```

**关键特点**

- 文件内容在**写入磁盘前**就被扫描（内存中拦截），不落盘
- 扫描所有文件类型，不限扩展名（`.txt`/`.py`/`.js`/`.sh` 全部扫描）
- 跨机器调用：Windows Plugin → HTTP → Linux Scan Gateway → KSE
- 超时/异常自动 **fail-open** 放行，不影响 OpenClaw 正常使用
- 威胁文件副本保存在 kumadb 隔离区，便于审计和溯源

> **已验证**：EICAR-Test-File 被成功拦截。

### 数据流 ②：OpenClaw `exec` 工具拦截（三类检测，事前拦截）

| 类型 | 检测方式 | 示例 |
| --- | --- | --- |
| A. 脚本文件 | 正则提取 command 中的脚本路径 `.py/.js/.ts/.sh/.bat/.ps1/.exe` → `/scan/file` | `python C:\temp\test.py` |
| B. 模型文件 | 正则提取模型路径 `.gguf/.safetensors/.bin/.pt/.onnx` → `/scan/file` | `ollama run /path/model.gguf` |
| C. Skill 下载命令 | 检测下载关键词 + Skill 关键词 → 扫描命令文本本身 | `git clone` / `pip install` / `npm install` |

检出威胁 → 返回 `{ block: true, blockReason: "[Kaspersky] 检出威胁: ..." }`，脚本/模型不执行，Skill 不下载。

> **注意**：exec 拦截扫描的是 Windows 本地文件（脚本/模型），通过 `/scan/upload` 上传内容扫描；
> Skill 下载命令扫描的是**命令文本内容本身**，不是下载后的文件（文件下载后由 File Watcher 兜底）。

### 数据流 ③：Ollama 模型下载监控与自动隔离（事后扫描）

```mermaid
flowchart LR
    A["docker exec ollama ollama pull model"] --> B["写入 models/blobs/"]
    B --> C["ollama-watcher<br/>inotifywait close_write"]
    C --> D{"size >= 10MB ?"}
    D -->|否| E["跳过"]
    D -->|是| F["POST /scan/file<br/>timeout 600s"]
    F --> G{"verdict"}
    G -->|DETECT| H["mv 到 /opt/kaspersky/quarantine/<br/>{SHA256}_{时间戳}_{原文件名}"]
    G -->|CLEAN| I["保留原位<br/>Ollama 可正常加载"]
```

- **零侵入**：不改 Ollama 代码，只旁路监听文件系统
- **fail-open**：扫描异常不隔离，只记录日志
- 大模型友好：<10MB 跳过，超时 600 秒

> **已验证**：12MB EICAR 测试文件被成功检出并自动隔离。

### 数据流 ④：Upload Gateway 安全上传扫描（上传拦截）

```mermaid
sequenceDiagram
    participant U as 用户浏览器
    participant G as Upload Gateway :8002
    participant S as Scan Gateway :8000
    participant K as KSE
    participant A as AnythingLLM :3001

    U->>G: POST /upload (multipart)
    G->>S: POST /scan/file
    S->>K: 扫描
    K-->>S: CLEAN / DETECT
    alt DETECT
        S-->>G: DETECT + 隔离
        G-->>U: 403「文件包含威胁」→ 不入知识库
    else CLEAN
        G->>A: POST /api/v1/document/upload
        G->>A: POST /api/v1/workspace/{slug}/update-embeddings (可选)
        A-->>G: OK
        G-->>U: 上传成功
    end
```

**安全特性**

- `add_to_workspace` 参数控制入库范围
- SHA256 缓存避免重复扫描
- 威胁文件自动隔离 + 记录

### 数据流 ⑤：Windows 文件监控（skills / plugins / npm 安装扫描，事后兜底）

```mermaid
flowchart LR
    A["openclaw skills install<br/>npm install / 手动复制"] --> B["文件写入 workspace/"]
    B --> C["KSE File Watcher<br/>计划任务 · 轮询 5s<br/>对比文件列表"]
    C --> D["curl.exe POST /scan/upload"]
    D --> E["Scan Gateway :8000<br/>保存到 scanqueue → KSE 扫描"]
    E --> F{"verdict"}
    F -->|DETECT| G["Move-Item 到隔离区<br/>{SHA256}_{文件名}"]
    F -->|CLEAN| H["保留原位 → OpenClaw 正常加载"]
```

**关键特点与设计取舍**

- **定时轮询(5s)而非 FileSystemWatcher**：Windows 上 FSW 子目录监控不可靠，轮询 100% 稳定
- **curl.exe 上传而非 Invoke-RestMethod -Form**：兼容 PowerShell 5.1（`-Form` 是 6.1+ 才有）
- **纯英文注释 + UTF-8 BOM**：避免 PowerShell 5.1 中文乱码导致脚本解析失败
- **排除目录** `\out\` `\state\` `\.clawhub\`：不扫 agent 输出文件和元数据，减少噪音
- **超 100MB 跳过**：大文件不扫描，避免影响性能（模型文件由 Ollama 监控覆盖）
- **与 Plugin 互补**：Plugin 是事前拦截（write/exec），Watcher 是事后兜底（skills install/npm install）

> **已验证**：EICAR 测试文件被检出并隔离；tmux skill 安装文件全部扫描通过（CLEAN）。

---

## 3. 五种防护场景对比

| 场景 | 类型 | 触发方式 | 处置 |
| --- | --- | --- | --- |
| OpenClaw `write` | 事前拦截 · 内存扫描 | Agent 调用 write 工具 | ✓ 不落盘 |
| OpenClaw `exec` | 事前拦截 · 脚本/模型/Skill | Agent 调用 exec 工具 | ✓ 不执行 |
| Ollama 监控 | 事后扫描 · inotifywait | 模型文件写入 blobs | ✓ 自动隔离 |
| Upload Gateway | 上传拦截 · Web 页面 | 用户上传文件 | ✓ 不入知识库 |
| File Watcher | 事后扫描 · 定时轮询 | skills/plugins/npm 安装 | ✓ 自动隔离 |

---

## 4. 核心设计原则

- 所有场景**共用同一个 KSE 扫描引擎和 Scan Gateway**，威胁统一隔离
  （Linux 端 `/opt/kaspersky/quarantine/`，Windows 端 `.openclaw\quarantine\`）
- **Fail-Closed**：Upload Gateway 扫描异常 → 拒绝入库
- **Fail-Open**：OpenClaw Plugin 扫描异常 → 放行，不阻断 Agent 业务
- **最小侵入**：不改 Agent 本体，通过插件 Hook / 目录监听 / 上传代理接入
- **全链路可审计**：JSONL 审计日志记录 请求来源、SHA-256、判定结果、处置动作

---

## 5. 与 Agent 的接入方式

| Agent | 接入方式 |
| --- | --- |
| **OpenClaw** | `before_tool_call` 插件 Hook（write / edit / exec）+ File Watcher 兜底 |
| **Codex** | 通过 MCP / 本地 Hook 调用 Scan Gateway `/scan/upload` |
| **WorkBuddy** | Skill 下载代理 + 知识库上传安全端点 |
| **OpenCode** | 工具端点代理 + 脚本执行前置扫描 Hook |
