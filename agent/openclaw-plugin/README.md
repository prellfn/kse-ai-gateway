# KSE Security Gate (OpenClaw 插件)

在 OpenClaw Agent 真正执行危险动作**之前**调用远程 `Scan Gateway`，由 Kaspersky Scan Engine
扫描内容；检出威胁则直接阻止工具调用，**文件不落盘、命令不执行**。

## 三个拦截点

| 工具 | 扫描对象 | 触发行为 |
| --- | --- | --- |
| `write` / `create_file` | 写入的完整文件内容（不限扩展名） | 阻止写入 |
| `edit` / `str_replace` | 编辑后的新内容 `new_string` | 阻止编辑 |
| `exec` / `shell` | ① 待执行脚本文件 ② 待加载模型文件 ③ Skill 下载命令文本 | 阻止执行 |

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
