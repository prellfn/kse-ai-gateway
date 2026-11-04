---
name: kse-scan
description: 使用 Kaspersky Scan Engine 在执行高危操作前扫描文件、文本、URL 与 Skill 包。当需要下载或安装 Skill / 插件、运行第三方脚本、加载模型文件、访问外部链接、或向知识库写入文档时使用。触发词：下载 skill、安装插件、运行脚本、下载模型、访问链接、上传文档、scan。
---

# KSE 安全扫描

本 Skill 通过 `kse-ai-gateway` MCP Server 调用卡巴斯基扫描引擎（KSE），在**高危操作发生之前**
判断内容是否安全。

## 何时必须调用

| 场景 | 调用工具 |
| --- | --- |
| 下载 / 安装 Skill 或插件包（.zip / .tar.gz） | `scan_skill_pkg` |
| 运行来源不明的脚本（.py / .js / .sh / .ps1 / .bat） | `scan_file` 或 `scan_text` |
| 加载模型权重（.gguf / .safetensors / .onnx / .bin） | `scan_file` |
| 访问外部 URL（尤其是登录页、下载地址） | `scan_url` |
| 向知识库 / RAG 写入文档 | `scan_text`（内容）或 `scan_file`（文件） |

## 工作流程

1. **先扫描，后执行。** 不要在扫描通过之前运行脚本或写入文件。
2. 判定结果只有三种：
   - `CLEAN` → 可以继续
   - `DETECT` → **立即停止**，向用户报告威胁名称，不要尝试绕过
   - `SCAN_ERROR` → 视为不安全，告知用户扫描网关不可用
3. 扫描 Skill 包时优先用 `scan_skill_pkg`（会解包逐文件扫描），比 `scan_file` 更严格。
4. 扫描纯文本内容（即将写入文件的内容、生成的脚本源码）用 `scan_text`。

## 示例

下载一个 Skill 包后：

```
scan_skill_pkg(package_path="/path/to/downloaded-skill.zip")
→ verdict: DETECT / detection_name: HEUR:Trojan.Script.Agent
→ 立即停止，不解压、不执行，向用户报告
```

准备执行一个下载来的脚本前：

```
scan_file(file_path="/path/to/install.sh")
```

准备访问一个链接前：

```
scan_url(url="https://example.com/download")
```

## 注意事项

- 工具返回中若含 `⛔ 检出威胁，禁止继续使用该内容。`，必须终止后续动作。
- 不要因为"看起来像误报"而跳过扫描。
- 扫描本身是安全的（内容在网关侧扫描），但扫描通过**不等于**内容无害，仍需遵循最小权限原则。
- 需要查看网关状态时调用 `kse_status`。
