# Lite 网关形态（零依赖）

面向「只需要扫描网关、不需要集中管控」的场景：三个 HTTP 服务 + 一个 MCP Server，
**全部只用 Python 3.9+ 标准库实现**，不需要 pip / venv / 外网。

| 服务 | 端口 | 作用 |
| --- | --- | --- |
| Scan Gateway | 8000 | 扫描核心：文件 / 内容 / 压缩包逐文件 / URL；命中威胁自动隔离 |
| Upload Gateway | 8002 | 安全上传 → AnythingLLM（先扫后入库，Fail-Closed） |
| Quarantine Console | 8004 | 隔离区人工复核台：复扫 / 恢复 / 标记 / 审计 / 统计 |
| MCP Server | stdio | 让 Codex / Claude Code 等原生 MCP 客户端调用扫描能力 |

## 两种后端

| 后端 | 配置 | 说明 |
| --- | --- | --- |
| **直连 KSE** | `KSE_BACKEND=kse` | 直接调用卡巴斯基扫描引擎（默认） |
| **委托 KAIP 平台** | `KSE_BACKEND=kaip` | 把扫描委托给中心 KAIP 平台，**共用同一套策略与审计台账** |

委托模式适合：边缘节点只做就近扫描与拦截，策略、事件、审计统一由中心平台管理。

```bash
KSE_BACKEND=kaip
KAIP_URL=http://kaip-center:8080
KAIP_ENROLL_TOKEN=<平台注册令牌>
```

首次扫描会自动向平台注册终端，凭据缓存在 `~/.cache/kse-ai-gateway/agent.json`（权限 600）。

### 委托模式下的判定映射

平台返回的判定与处置会被如实映射，**尊重平台的决策**：

| 平台 verdict / action | Lite 判定 | 行为 |
| --- | --- | --- |
| `CLEAN` / `allow` | CLEAN | 放行 |
| `DETECT` / `block` | DETECT | 拦截 + 本地隔离 |
| `RISK` / `alert` | CLEAN | 放行（平台决定只告警），事件已入平台台账 |
| `NON_SCANNED` / `ERROR` | SCAN_ERROR | **Fail-Closed**，不放行 |

## 部署

```bash
sudo ./lite/scripts/install_ubuntu.sh
sudo vi /opt/ai-stack/scan-gateway/.env     # 填写 KSE_URL / KSE_MODE（或 KAIP_* ）
sudo systemctl restart scan-gateway upload-gateway quarantine-console
```

## 验证

```bash
sudo ./lite/scripts/verify.sh              # L0-L5 分层验证
sudo ./lite/scripts/verify.sh --layer l1   # 只跑某层
```

无 KSE 许可证时可用 Mock 跑通除真实检测外的全链路：

```bash
python3 lite/scripts/mock_kse.py --port 18123 --reject-remote
python3 lite/scripts/mock_scan_gateway.py --port 18000
```

## 与平台形态的关系

本目录是 `kse-ai-gateway` 仓库的**轻量形态**；完整产品见 [`../platform/`](../platform/)。
两者共用同一套判定语义与验证方法，可独立部署也可并存（边缘 Lite + 中心 KAIP 平台）。
