# KSE Security Gate (OpenClaw 插件)

在 OpenClaw Agent 真正执行危险动作**之前**调用远程 `Scan Gateway`，由 Kaspersky Scan Engine
扫描内容；检出威胁则直接阻止工具调用，**文件不落盘、命令不执行**。

## 三个拦截点

| 工具 | 扫描对象 | 触发行为 |
| --- | --- | --- |
| `write` / `create_file` | 写入的完整文件内容（不限扩展名） | 阻止写入 |
| `edit` / `str_replace` | 编辑后的新内容 `new_string` | 阻止编辑 |
| `exec` / `shell` | ① 待执行脚本文件 ② 待加载模型文件 ③ Skill 下载命令文本 ④ 命令中的 URL | 阻止执行 |
| `web_fetch` / `fetch` / `browse` / `http_request` | 待访问的 URL | 阻止访问 |

## 安装

```powershell
# 1. 复制插件到 OpenClaw 插件目录
$dst = "$env:USERPROFILE\.openclaw\plugins\kse-gate"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item .\* $dst -Recurse -Force

# 2. 链接 node_modules\openclaw
cd $dst
cmd /c mklink /D node_modules\openclaw "$env:APPDATA\npm\node_modules\openclaw"

# 3. Link 安装
openclaw plugins install --link "$dst"
```

## 配置

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "allow": ["kse-security-gate"],
    "entries": {
      "kse-security-gate": { "enabled": true }
    }
  }
}
```

Scan Gateway 地址通过环境变量覆盖（默认 `http://127.0.0.1:8000`）：

```powershell
$env:KSE_SCAN_GATEWAY = "http://10.0.0.1:8000"
$env:KSE_SCAN_TIMEOUT = "15000"
```

## 验证

```powershell
openclaw gateway stop
openclaw gateway run

# 发起一次对话触发插件预热后查看日志
Get-Content "$env:USERPROFILE\.openclaw\plugins\kse-gate\debug.log" -Encoding utf8 -Tail 20
```

预期出现 `register() called` 与 `before_tool_call hook registered successfully`。

## 设计取舍

- **Fail-Open**：扫描网关不可达时放行，不阻断业务（事后扫描由 File Watcher 兜底）。
- **Fail-Closed** 不在这里 — 需要绝对阻断的场景（知识库上传）由 Upload Gateway 负责。
---

## URL 扫描（钓鱼 / 恶意链接）

插件会对两类 URL 做扫描：

1. **URL 工具**：`web_fetch` / `fetch` / `webfetch` / `browse` / `http_request` / `open_url`
   在真正发起请求前，URL 先经 Scan Gateway `/scan/url` 送 KSE `checkurl` 检测。
2. **exec 命令中的 URL**：`curl https://...` / `wget https://...` 等命令里的链接同样会被提取扫描。

检出威胁时返回：

```json
{ "block": true, "blockReason": "[Kaspersky] 检出威胁 URL: HEUR:Phishing.URL，访问已被阻止: https://..." }
```

> ⚠️ 前置条件：需在 KSE Web UI `Settings → Service` →
> **Locations where remote scanning is allowed** 中放行相应 URL，否则 KSE 会拒绝远程 URL 扫描。

## Skill 包深度扫描

压缩包（zip / tar 系列）可交由 Scan Gateway 的 `/scan/package` 处理：解包后**逐文件扫描**，
任一文件命中威胁即判定整包为 `DETECT` 并整包隔离。内置 Zip Slip 路径穿越与压缩包炸弹防护。