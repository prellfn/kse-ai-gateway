---
name: kse-security-gate
description: 卡巴斯基安全网关 —— 在下载/安装 Skill、运行脚本、加载模型、访问链接、上传文档之前调用扫描。触发词：下载 skill、安装插件、run script、下载模型、访问链接、上传文档、kaspersky、扫描。
---

# KSE 安全网关（WorkBuddy 接入）

本 Skill 通过 `kse-ai-gateway` MCP Server 调用卡巴斯基扫描引擎（KSE），在**动作发生之前**判断内容安全。

## 三个必须插检查点的位置

### ① Skill 下载代理（最高优先级）

下载任何第三方 Skill / 插件包时：

1. 先下载到临时目录，**不要**直接安装
2. 调用 `scan_skill_pkg(package_path=...)` —— 会解包逐文件扫描，比整包扫描更严格
3. `CLEAN` → 安装；`DETECT` → 停止，删除临时文件，向用户报告威胁名称

### ② 知识库上传端点

向知识库 / RAG 写入文档前：

- 调 `scan_file(file_path=...)`（文档在磁盘上时）
- 或 `scan_text(filename=..., content=...)`（内容在内存中时）
- `CLEAN` → 才上传；`DETECT` → 拒绝并告知用户

> 也可直接使用本仓库的 Upload Gateway（:8002），它已经把「先扫后入库」做成了默认行为。

### ③ 脚本 / 模型执行前

- 执行来源不明的脚本：先 `scan_file` 或 `scan_text`
- 加载模型权重（`.gguf` / `.safetensors` / `.onnx`）：先 `scan_file`
- 访问外部 URL：先 `scan_url`

## 判定处理

| verdict | 动作 |
| --- | --- |
| `CLEAN` | 正常继续 |
| `DETECT` | **立即停止**，报告 `detection_name`，不要重试或绕过 |
| `SCAN_ERROR` | 视为不安全，说明扫描网关不可用，请人工确认 |

## 判定处理之外

- 不要因为「看起来像误报」跳过扫描。
- 扫描本身安全（内容在网关侧扫描），但通过 ≠ 无害。
- 排查网关状态用 `kse_status`。

## 辅助脚本

`scripts/scan.sh` 提供命令行方式，便于在自动化流程中直接调用：

```bash
./scripts/scan.sh file  /path/to/file
./scripts/scan.sh text  /path/to/content.txt
./scripts/scan.sh url   https://example.com/file.zip
./scripts/scan.sh pkg   /path/to/skill.zip
```
