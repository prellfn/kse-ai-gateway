// 生成《Kaspersky AI Protect（KAIP）PoC 实施手册》 Word 文档
// 用法：node build_poc_manual.js  → KAIP_PoC实施手册.docx
const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, LevelFormat, BorderStyle, Header, Footer, PageNumber, TableOfContents, PageBreak,
} = require("docx");

const FONT = "Microsoft YaHei";
const MONO = "Consolas";
const BRAND = "00A88E";
const W = 9638; // A4 正文宽度（左右各 2cm 页边距）

// ---------- 基础构件 ----------
const runs = (text, o = {}) => {
  // 支持 **加粗** 片段
  const out = [];
  String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((seg) => {
    if (!seg) return;
    const b = seg.startsWith("**") && seg.endsWith("**");
    const c = seg.startsWith("`") && seg.endsWith("`") && seg.length > 1;
    if (c) {
      out.push(new TextRun({ text: seg.slice(1, -1), font: MONO, size: Math.max((o.size || 21) - 2, 16), color: "0B6E5E", bold: o.bold,
        shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEF3F1" } }));
      return;
    }
    out.push(new TextRun({ text: b ? seg.slice(2, -2) : seg, bold: b || o.bold, font: o.font || FONT, size: o.size || 21, color: o.color }));
  });
  return out;
};
const P = (text, o = {}) => new Paragraph({ children: runs(text, o), spacing: { before: 60, after: 100, line: 340 }, alignment: o.align, indent: o.indent });
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t })], pageBreakBefore: true });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t })] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t })] });
const bullets = (items, level = 0) => items.map((t) => new Paragraph({ numbering: { reference: "bul", level }, children: runs(t), spacing: { before: 30, after: 50, line: 320 } }));
const steps = (items, ref) => items.map((t) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(t), spacing: { before: 30, after: 60, line: 320 } }));
let stepSeq = 0;
const numbered = (items) => steps(items, `num${++stepSeq}`);
// 被代码块隔开、需连续编号的步骤：同一 ref 多次调用
const seq = () => { const ref = `num${++stepSeq}`; return (items) => steps(items, ref); };
const sCodex = seq(), sOc = seq(), sAttach = seq(), sKse = seq(), sShare = seq(), sProxy = seq(), sCompose = seq(), sCust = seq();
const code = (lines) => (Array.isArray(lines) ? lines : [lines]).map((l, i, a) => new Paragraph({
  children: [new TextRun({ text: l || " ", font: MONO, size: 18, color: "1D2A26" })],
  shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEF3F1" },
  spacing: { before: i === 0 ? 80 : 0, after: i === a.length - 1 ? 120 : 0, line: 260 },
  indent: { left: 200, right: 200 },
}));
const note = (text, kind = "info") => {
  const fill = { info: "E8F6F3", warn: "FFF4DC", risk: "FDECEC" }[kind];
  const label = { info: "说明", warn: "注意", risk: "风险" }[kind];
  return new Paragraph({
    children: [new TextRun({ text: `【${label}】`, bold: true, font: FONT, size: 20, color: kind === "risk" ? "C0392B" : kind === "warn" ? "A86F00" : BRAND }), ...runs(text, { size: 20 })],
    shading: { type: ShadingType.CLEAR, color: "auto", fill },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: kind === "risk" ? "C0392B" : kind === "warn" ? "E8A317" : BRAND, space: 8 } },
    spacing: { before: 100, after: 140, line: 320 }, indent: { left: 160, right: 160 },
  });
};
const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "C9D3CF" };
const table = (headers, rows, widths) => {
  const total = widths.reduce((a, b) => a + b, 0);
  const ws = widths.map((w) => Math.round((w / total) * W));
  ws[ws.length - 1] += W - ws.reduce((a, b) => a + b, 0);
  const mk = (text, i, head) => new TableCell({
    width: { size: ws[i], type: WidthType.DXA },
    shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: "DDEFEA" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder },
    children: String(text).split("\n").map((line) => new Paragraph({ children: runs(line, { size: 18, bold: head }), spacing: { before: 0, after: 0, line: 280 } })),
  });
  return new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: ws,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => mk(h, i, true)) }), ...rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => mk(c, i, false)) }))],
  });
};
// 架构示意：三栏（终端 → 链路 → 服务器）
const archDiagram = () => {
  const ws = [3900, 1838, 3900];
  const box = (title, lines, fill) => new TableCell({
    width: { size: ws[0], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: "auto", fill },
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    borders: { top: { style: BorderStyle.SINGLE, size: 8, color: BRAND }, bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND }, left: { style: BorderStyle.SINGLE, size: 8, color: BRAND }, right: { style: BorderStyle.SINGLE, size: 8, color: BRAND } },
    children: [new Paragraph({ children: runs(title, { bold: true, size: 20 }), spacing: { after: 80 } }),
      ...lines.map((l) => new Paragraph({ children: runs(l, { size: 18 }), spacing: { before: 0, after: 30, line: 280 } }))],
  });
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const mid = new TableCell({ width: { size: ws[1], type: WidthType.DXA }, borders: { top: none, bottom: none, left: none, right: none },
    margins: { top: 100, bottom: 100, left: 60, right: 60 },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("HTTPS", { size: 18, bold: true, color: BRAND }), spacing: { before: 500 } }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("──────▶", { size: 20, color: BRAND }) }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("判定 / 心跳", { size: 16, color: "6B7A75" }) }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("◀──────", { size: 20, color: BRAND }), spacing: { before: 200 } }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: runs("放行 / 阻断", { size: 16, color: "6B7A75" }) }),
    ] });
  return new Table({ width: { size: W, type: WidthType.DXA }, columnWidths: ws, rows: [new TableRow({ cantSplit: true, children: [
    box("开发机（Windows / Linux / 容器）", ["Codex — `hooks.json`", "WorkBuddy — `settings.json` hooks", "OpenCode — `plugins/kaip.js`", "↓ 统一经由 `kaip-hook` / 插件", "kaip-watch：目录监控 · 自愈 · 防护探测"], "F2FAF8"),
    mid,
    box("KAIP 服务器（Linux）", ["KAIP 平台 `:8080`（经 Nginx `:443`）", "Agent 判定 · 供应链网关 · 控制台", "隔离区 · 策略 · 事件 · SIEM 转发", "↓ 本机调用", "KSE 2.2 `127.0.0.1:1234`（HTTP） / `1344`（ICAP）"], "F2FAF8"),
  ] })] });
};
const gap = () => new Paragraph({ children: [], spacing: { before: 0, after: 60 } });

// ---------- 正文 ----------
const body = [];
const add = (...xs) => xs.flat().forEach((x) => body.push(x));

// 封面
add(
  new Paragraph({ children: [], spacing: { before: 2200 } }),
  new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: "kaspersky", font: "Arial", size: 36, bold: true, color: BRAND })] }),
  new Paragraph({ children: [new TextRun({ text: "Kaspersky AI Protect（KAIP）", font: FONT, size: 52, bold: true })], spacing: { before: 400, after: 100 } }),
  new Paragraph({ children: [new TextRun({ text: "PoC 实施手册", font: FONT, size: 52, bold: true })], spacing: { after: 300 } }),
  new Paragraph({ children: [new TextRun({ text: "AI Agent 运行时防护 · AI 供应链入口扫描 · 防篡改与升级保障", font: FONT, size: 26, color: "4A5A55" })],
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: BRAND, space: 6 } }, spacing: { after: 800 } }),
  ...[["客户", "【客户名称】"], ["文档版本", "V1.6"], ["日期", "2026 年 11 月 20 日"], ["编制", "卡巴斯基售前团队"], ["配套文档", "《KAIP AI 供应链防护 PoC 技术方案》"]].map(([k, v]) =>
    new Paragraph({ children: [new TextRun({ text: `${k}：`, font: FONT, size: 22, bold: true }), new TextRun({ text: v, font: FONT, size: 22 })], spacing: { after: 120 } })),
  new Paragraph({ children: [], spacing: { before: 1600 } }),
  note("本手册面向现场实施工程师，给出从准备、部署、终端接入、测试执行到交付的完整步骤。文中所有测试均使用无害测试样本；含客户环境信息的记录请按保密协议处理。", "info"),
);

// 目录
add(
  new Paragraph({ children: [new TextRun({ text: "目录", font: FONT, size: 32, bold: true })], pageBreakBefore: true, spacing: { after: 200 } }),
  new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-2" }),
  P("（在 Word 中右键目录 →「更新域」即可刷新页码。）", { color: "6B7A75", size: 18 }),
);

// 1 概述
add(
  H1("1 概述"),
  H2("1.1 文档目的与适用范围"),
  P("本手册用于在客户现场实施 Kaspersky AI Protect（以下简称 KAIP）概念验证（PoC）。它在《KAIP AI 供应链防护 PoC 技术方案》（A/B/C 三类用例、两周计划）的基础上，补充 **D 类：AI Agent 运行时防护** 用例，并汇总了内部集成测试中发现的部署要点与常见问题。"),
  P("读者：卡巴斯基售前 / 实施工程师、合作伙伴工程师；客户侧技术与安全联系人可参考第 4、7、10 章。"),
  H2("1.2 方案组成"),
  table(["组件", "部署位置", "作用"], [
    ["Kaspersky Scan Engine（KSE）2.2", "Linux 服务器", "恶意代码检测引擎：病毒库、启发式、KSN 云信誉、URL 信誉、LLM 模型文件扫描（KL_SCAN_LLM）"],
    ["KAIP 平台", "与 KSE 同机", "统一入口：Agent 判定 API、供应链扫描网关、AI 场景规则、隔离区、防护策略、事件与告警、SIEM 转发、管理控制台"],
    ["KAIP 终端客户端", "开发机（Windows / Linux / 容器）", "接入 Codex / WorkBuddy / OpenCode：执行前拦截、目录监控、防篡改与自动修复、防护生效探测"],
    ["Squid + ICAP（可选）", "KSE 服务器", "下载代理：HTTPS 解密后经 KSE ICAP 扫描，拦截终端 / AI Agent 从技能市场、模型仓库、npm / PyPI / GitHub 下载的恶意组件"],
  ], [26, 18, 56]),
  gap(),
  H2("1.3 PoC 验证范围"),
  table(["本次验证", "不在本次范围"], [
    ["• 模型文件、Skill 包、RAG 文档、训练数据集的入口扫描（A/B/C 类）\n• AI Agent 运行时：执行命令、写文件、代码执行、URL 访问、Skill 调用前的拦截（D 类）\n• KAIP 自身防篡改、自动修复、Agent 升级后的防护复核\n• 误报、性能、日志与 SIEM、隔离网段更新",
     "• 终端运行时行为监控与溯源（EDR）、勒索回滚\n• 提示词注入等语义层攻击（不属于恶意代码检测）\n• 绕开 Agent、用户手工执行的操作（由终端杀软覆盖）\n• 拥有 root / 管理员权限的恶意进程对 KAIP 的破坏"],
  ], [55, 45]),
);

// 2 架构
add(
  H1("2 架构与网络"),
  H2("2.1 逻辑架构"),
  P("终端上的 AI Agent 每次调用工具（执行命令、写/改文件、运行代码、调用 Skill）前，由 KAIP hook / 插件把待执行内容送到 KAIP 平台；平台调用 KSE 引擎（与平台同机或分机部署）与 AI 场景规则判定，返回放行或阻断。业务系统、CI 与知识库上传通过 API Key 调用平台的供应链扫描网关。"),
  archDiagram(),
  P("业务系统 / CI / 知识库通过 API Key 调用 `POST /api/v1/supply/upload`，仅在返回 `action=allow` 时入库。", { size: 19, color: "4A5A55" }),
  H2("2.2 端口与网络要求"),
  table(["方向", "端口", "用途", "说明"], [
    ["终端 → KAIP 平台", "443（Nginx）/ 8080", "判定、心跳、客户端下载", "PoC 可临时用 8080；正式环境必须 HTTPS"],
    ["平台 → KSE", "同机 127.0.0.1:1234；分机 <KSE IP>:1234", "HTTP 模式扫描", "终端不得直连 KSE；分机部署时 KSE 仅放行平台 IP"],
    ["KSE → 平台", "TCP 2049（NFSv4；NFSv3 另需 111 与 mountd）", "挂载平台扫描目录", "仅分机部署：≥25MB 文件由 KSE 按路径扫描（第 4.3 节）"],
    ["终端 → 下载代理", "3128", "HTTP / HTTPS 下载经代理", "仅启用下载代理时（第 4.4 节）"],
    ["Squid → KSE", "127.0.0.1:1344（同机）", "ICAP", "KSE ICAP 默认监听所有地址，建议防火墙只放行本机"],
    ["KSE → 卡巴斯基", "TCP 80 / 443", "病毒库更新、KSN、激活", "*.kaspersky.com、*.kaspersky-labs.com；HTTPS 解密设备需豁免"],
    ["KSE → 平台", "UDP 5514", "KSE 日志汇入平台", "可选"],
    ["平台 → SIEM", "UDP/TCP 514", "CEF / JSON 事件", "可选（如 KUMA）"],
  ], [20, 20, 25, 35]),
);

// 3 准备
add(
  H1("3 PoC 前准备（实施前一周）"),
  H2("3.1 客户信息收集清单"),
  P("以下信息直接决定接入方式与测试设计，请在启动会前收集齐全："),
  table(["类别", "需确认的内容", "影响"], [
    ["AI Agent", "使用的 Agent 及版本：Codex（桌面版 / CLI）、WorkBuddy（企业版 / 个人版）、OpenCode（1.x / 2.x）；是否计划近期升级", "接入方式与插件写法不同；升级需复核"],
    ["终端", "操作系统（Win 7 / 10 / 11、Linux 发行版）；能否安装 Node.js 18+；是否允许计划任务 / systemd 用户服务", "客户端依赖 Node.js；Win 7 不在支持范围；监控与自愈依赖服务"],
    ["模型", "Agent 使用的模型与访问方式；PoC 期间可否使用", "真实对话测试需要可用模型"],
    ["网络", "服务器能否访问卡巴斯基更新源与 KSN；终端到服务器是否有代理 / HTTPS 解密；能否访问 Docker Hub、GitHub、PyPI、npm", "不能出网需离线许可证、离线病毒库与离线安装包"],
    ["服务器", "KAIP 平台与 KSE 是否同机；服务器操作系统版本；两台服务器之间能否开放 NFS", "分机部署需 NFS 共享扫描目录（第 4.3 节）"],
    ["现有安全产品", "终端杀软（如亚信）、服务器上的 KESL 与 KSC 策略", "需确认共存、添加排除"],
    ["知识库 / 业务系统", "RAG 系统名称、上传环节能否调用外部接口；模型入库流程", "B7、B1 用例的接入点"],
    ["联系人", "技术、安全、网络联系人；测试终端与服务器负责人", "实施协调"],
  ], [14, 56, 30]),
  gap(),
  H2("3.2 资源准备"),
  table(["对象", "配置要求", "备注"], [
    ["KAIP 服务器", "x86_64 Linux：Ubuntu 20.04 / 22.04 / 24.04、Debian 11 / 12、CentOS 7+ / RHEL 8+；8 核 CPU、16 GB 内存起步、100 GB 磁盘", "扫描 1 GB 文件约需 2 GB 内存；系统 Python 低于 3.10 时离线包自动使用自带的便携 Python 3.12"],
    ["KSE 服务器（分机部署时）", "按 KSE 2.2 要求；也可与 KAIP 平台同机", "分机时两台之间需开放 HTTP 1234 与 NFS"],
    ["测试终端", "Windows 10 / 11 各 1–2 台，或 Linux 开发机；安装客户实际使用的 Agent", "不要使用生产终端"],
    ["容器环境（可选）", "Docker 20.10+ 与 Compose v2（`docker compose`）", "Docker 方式部署平台（第 4.2 节）；容器化 OpenCode（第 5.1.2、5.4 节）"],
  ], [18, 52, 30]),
  gap(),
  H2("3.3 卡巴斯基侧携带物"),
  ...bullets([
    "KSE 2.2 安装包（Kaspersky_ScanEngine-Linux-x86_64-2.2.0.8899）与**有效许可证**（含 KSN 授权）；",
    "KAIP 平台代码包（server / client / deploy / tests）；网络受限时携带**离线安装包**（Python 依赖、Node.js、客户端、容器镜像）；",
    "无害测试样本：EICAR（由 `kaip test` 运行时生成，或从 eicar.org 获取）、引用 os.system 的 pickle 模型、恶意 Skill 包、RAG 文档样本、官方测试 URL；",
    "测试脚本：`tests/integration/` 下的回放与场景脚本（见附录 A）。",
  ]),
  note("不要把 EICAR 完整字符串写进交付文档、邮件正文或提示词文件之外的地方：终端杀软会把含该字符串的文件当作病毒处理。", "warn"),
);

// 4 服务端部署
add(
  H1("4 服务端部署（第 1 天）"),
  H2("4.1 安装与配置 KSE"),
  ...sKse([
    "按 KSE 官方文档以 HTTP + ICAP（Multi）模式安装，并激活许可证；确认服务 `kavhttpd`、`kavicapd`、`klScanEngineUI` 均为 active。",
    "**立即手动更新一次病毒库**。内部测试中曾遇到安装后病毒库停留在 8 个月前、从未更新的情况：",
  ]),
  ...code(["curl -s -X POST http://127.0.0.1:1234/api/v3.0/update/start", "curl -s http://127.0.0.1:1234/api/v3.1/update/status     # 直到 last_update_result=success", "curl -s http://127.0.0.1:1234/api/v3.0/basesdate         # 确认为近期日期"]),
  ...sKse([
    "在 KSE 控制台（https://<服务器>）**Settings → Service**：与平台同机时监听地址改为 `127.0.0.1:1234`（只允许同机 KAIP 调用），并在「Locations where remote scanning is allowed」添加 `/opt/kaspersky/scanqueue`；**分机部署**时监听平台可访问的地址，允许扫描的目录见第 4.3 节。",
    "**Settings → Scanning**：打开 **Enable Phishing Protection** 与 **Enable reputation checking**（不开防钓鱼，钓鱼 URL 检不出）。保存后 KSE 自动重启。",
    "启用 LLM 模型文件详细扫描：在 `/opt/kaspersky/ScanEngine/ppl/kave.ini` 的 `[Environment]` 段加入 `KL_SCAN_LLM=1`（先备份），重启 `kavhttpd` 与 `kavicapd`。",
    "按需调大 `ScanMaxFileSize`、`SessionTimeout`（大模型文件），压缩包深度建议 5。",
  ]),
  note("判断 KSN 是否可用，应看 KSE 能否检出官方测试 URL（第 4.7 节），**不要用 curl / openssl 测 KSN 域名**：KSN 服务器不接受通用 TLS 客户端，用这种方法会误判为「网络被阻断」。", "warn"),
  H2("4.2 安装 KAIP 平台"),
  P("**离线安装包（推荐，客户内网无需访问 PyPI / GitHub / npm）**：解压后执行"),
  ...code([
    "tar -xzf kaip-offline-1.0.0-<日期>.tar.gz && cd kaip-offline-1.0.0-<日期>",
    "sudo bash install-offline.sh                         # KSE 与平台同机",
    "sudo bash install-offline.sh --kse-url http://<KSE IP>:1234 --kse-share /mnt/kaip-scanqueue   # KSE 在另一台服务器（第 4.3 节）",
    "curl -s http://127.0.0.1:8080/healthz                # engine 应为 kse",
  ]),
  ...bullets([
    "安装脚本自动校验离线包完整性。系统 Python 为 3.10 / 3.11 / 3.12 时直接使用；更低版本（如 Ubuntu 20.04 的 3.8、CentOS 7）自动使用包内便携 Python 3.12（安装到 `/opt/kaip/python`），无需 apt / yum。",
    "可选参数：`--port`（默认 8080）、`--mock`（未装 KSE 时以模拟引擎演示）。重复执行即为升级 / 修复，保留 `/etc/kaip/kaip.env` 与数据。",
    "可联网的服务器也可用 `sudo bash deploy/install-server.sh` 在线安装，之后编辑 `/etc/kaip/kaip.env` 设置 `KAIP_KSE_URL` 并重启 `kaip-platform`。",
  ]),
  P("**Docker 方式（docker compose）**：KAIP 平台以容器运行（host 网络，非 root，健康检查）；KSE 仍原生安装在宿主机或另一台服务器。离线包 `images/` 中带平台镜像，内网无需联网构建："),
  ...sCompose(["导入镜像并配置（`.env` 中设置 `KAIP_KSE_URL`、端口等）："]),
  ...code([
    "docker load -i images/kaip-platform-image-1.0.0.tar.gz",
    "cd deploy && cp compose.env.example .env && vi .env",
    "sudo install -d -o 10001 -g 10001 -m 0775 /opt/kaspersky/scanqueue   # 容器以 UID 10001 写入扫描目录",
  ]),
  ...sCompose(["启动并查看初始管理员密码："]),
  ...code([
    "docker compose up -d && docker compose ps            # STATUS 应为 healthy",
    "docker compose exec kaip cat /var/lib/kaip/initial_admin_password.txt",
  ]),
  ...bullets([
    "数据（数据库、令牌、隔离区）在 `kaip-data` 卷中，容器重建、升级镜像后保留；终端私有 Node.js 运行时由离线包 `runtime/` 只读挂载提供。",
    "升级：导入新镜像后 `docker compose up -d`。没有镜像包时 `docker compose build` 用离线包中的 wheels 构建（仍需 `python:3.12-slim` 基础镜像）。",
    "KSE 分机部署、≥25MB 文件走 scanfile 时，在 `.env` 中设置 `KAIP_KSE_SCAN_DIR_REMOTE`（第 4.3 节），NFS 共享宿主机的扫描目录。",
  ]),
  P("初始管理员密码：`sudo cat /var/lib/kaip/initial_admin_password.txt`，**首次登录控制台后立即修改**（修改后该文件自动删除）。`/var/lib/kaip` 含数据库、令牌与隔离文件，权限为 700，仅服务账号 `kaip` 与 root 可读。"),
  H2("4.3 KSE 与平台分机部署（可选）"),
  P("KSE 的 scanfile 接口只能按路径扫描 **KSE 本机**上的文件。≥25MB 的文件（模型、数据集、压缩包）走 scanfile 以避免 base64 膨胀，因此分机部署时把平台扫描目录 `/opt/kaspersky/scanqueue` 经 **NFS 只读**共享给 KSE 主机，并加入 KSE 允许扫描的目录；小文件仍以 scanmemory 直接送检。"),
  ...sShare(["在 **KAIP 平台服务器**共享扫描目录（只允许 KSE 主机访问，只读）："]),
  ...code(["sudo bash deploy/kse-share.sh kaip-host <KSE IP>"]),
  ...sShare(["在 **KSE 服务器**挂载（默认 `/mnt/kaip-scanqueue`，写入 fstab 开机自动挂载）。脚本在离线包 `deploy/` 目录，拷到 KSE 服务器执行："]),
  ...code(["sudo bash kse-share.sh kse-host <KAIP 平台 IP>"]),
  ...sShare([
    "KSE 控制台 **Settings → Service**：监听平台可访问的地址（如 `0.0.0.0:1234`，并用防火墙只放行平台 IP）；「Locations where remote scanning is allowed」添加 `/mnt/kaip-scanqueue`。",
    "平台配置：安装时带 `--kse-url http://<KSE IP>:1234 --kse-share /mnt/kaip-scanqueue`；已安装的平台在 `/etc/kaip/kaip.env` 中设置 `KAIP_KSE_URL` 与 `KAIP_KSE_SCAN_DIR_REMOTE=/mnt/kaip-scanqueue`，然后 `sudo systemctl restart kaip-platform`。",
    "验证：送检一个 ≥25MB、内含 EICAR 的 zip，应检出 `EICAR-Test-File`；平台服务器 `/proc/net/rpc/nfsd` 中 `io` 行的读取字节数应增加约一个文件大小（说明 KSE 经 NFS 读取了文件）。",
  ]),
  ...bullets([
    "平台写入共享目录的临时文件权限为 644，扫描后立即删除；KSE 只读挂载，`root_squash` 下以 nobody 身份读取。",
    "挂载参数为 `soft,timeo=50,retrans=2`：平台服务器离线时 KSE 读挂载点约 15 秒后报错返回，不影响其他扫描。不要改为 `hard`：平台宕机时 kavhttpd 会卡死在挂载点上、不再监听 1234，所有扫描失败。旧版脚本写入的 hard 条目，重新执行 `kse-share.sh kse-host` 即自动改写。",
    "NFS 软件包：平台端 `nfs-kernel-server`（RHEL 系 `nfs-utils`），KSE 端 `nfs-common`（`nfs-utils`）；离线环境需从内网源或安装介质准备。",
    "未配置共享（安装时只给 `--kse-url`）时所有文件都以 scanmemory 送检：功能可用，但大文件的内存与带宽开销约增加 1/3。",
  ]),
  note("已实测：KAIP 平台装在 Ubuntu 20.04（自动使用便携 Python），KSE 装在另一台服务器。27 MB 文件经 NFS 以 scanfile 扫描，NFS 读取量与文件大小一致；内含 EICAR 的 27 MB 压缩包检出。", "info"),
  H2("4.4 下载代理：Squid + KSE ICAP（可选，用例 B5）"),
  P("终端与 AI Agent 经代理下载 Skill、模型、安装包时，Squid 解密 HTTPS，把下载内容经 ICAP 交给 KSE 扫描，检出即返回 KSE 拦截页（HTTP 403），文件不会到达终端。推荐把 Squid 装在 **KSE 服务器**上，ICAP 走本机 `127.0.0.1:1344`。"),
  H3("4.4.1 服务端"),
  ...sProxy(["确认 KSE 的 ICAP 服务在运行（Multi 模式下可能只启动了 HTTP 模式）。kavicapd 与 kavhttpd 是独立进程，启动它不影响 KAIP 平台的扫描："]),
  ...code(["systemctl is-active kavicapd || sudo systemctl enable --now kavicapd"]),
  ...sProxy(["安装 Squid 并生成代理 CA（离线包 `deploy/squid/`）："]),
  ...code(["sudo bash install-squid.sh --kaip-syslog <KAIP 平台 IP>      # 可选 --allow <终端网段> --port 3128"]),
  ...sProxy([
    "KSE 控制台 **Settings → Logging → Syslog**：为 **ICAP 模式**添加日志目标——事件选 Scan result: detect、Scan result: other，格式 CEF，目标 remote syslog `udp://<KAIP 平台 IP>:5514`。代理拦截记录随即出现在 KAIP 控制台「事件日志」（来源 kse-syslog）。每次拦截记录终端 IP、URL、病毒名与 SHA256；压缩包会同时产生压缩包与包内文件两条记录。",
    "防火墙只允许本机访问 ICAP 1344，允许终端网段访问 3128。",
    "把 `/etc/squid/certs/kaip-proxy-ca.crt` 分发给终端（只分发 .crt，私钥不出服务器）。",
  ]),
  ...bullets([
    "软件包：Ubuntu 22.04+ / Debian 12 安装 `squid-openssl`；RHEL 8+ 的 squid 自带 OpenSSL。**Ubuntu 20.04 / Debian 11 官方源的 squid 不支持 HTTPS 解密**，请把代理装在更新的系统上。离线环境需提前从内网源准备软件包。",
    "不解密的站点：卡巴斯基更新源、Windows Update、苹果（`--no-bump-domains` 可追加，如证书固定的内部系统）。",
    "失败即阻断：ICAP 不可用时下载被拒绝（`bypass=0`），请求检查失败则放行。重复执行脚本会沿用已有 CA，终端无需重新信任。",
    "上游站点不可达时 Squid 返回 503 错误页（如服务器无法访问 Hugging Face），与扫描无关。",
  ]),
  H3("4.4.2 终端"),
  P("**Linux**（当前用户，无需 root；`--system` 同时加入系统信任库）："),
  ...code(["bash client-proxy.sh http://<代理>:3128 kaip-proxy-ca.crt <KAIP 平台 IP>,<模型 API 域名>", "source ~/.kaip/proxy.env      # 或新开终端；然后重启 AI Agent"]),
  P("**Windows**（当前用户，无需管理员；导入 CA 时 Windows 弹出安全警告，点「是」）："),
  ...code(["powershell -ExecutionPolicy Bypass -File client-proxy.ps1 -Proxy http://<代理>:3128 -Ca kaip-proxy-ca.crt -NoProxy \"<KAIP 平台 IP>,<模型 API 域名>\" -SystemProxy"]),
  ...bullets([
    "脚本设置 `HTTP(S)_PROXY`、`NO_PROXY`，并让 Node.js / Bun（`NODE_EXTRA_CA_CERTS`）、Python / pip、curl、git（组合信任库 `~/.kaip/ca-bundle.pem`）信任代理 CA。Codex、OpenCode、git、npm、pip 读取这些变量。",
    "**WorkBuddy 等 Electron 桌面应用只认系统代理**：Windows 加 `-SystemProxy`（会影响该用户所有走系统代理的程序，原设置自动备份）。",
    "`NO_PROXY` 务必包含 **KAIP 平台地址**（判定请求直连平台）；模型 API 域名建议加入，避免对话流量被解密。",
    "撤销：`bash client-proxy.sh --remove` / `client-proxy.ps1 -Remove`（恢复系统代理、删除 CA 与环境变量）。",
  ]),
  H3("4.4.3 验证"),
  table(["经代理下载", "预期"], [
    ["HTTP / HTTPS 正常网页、PyPI 包、`git ls-remote`", "放行（HTTP 200）"],
    ["`https://secure.eicar.org/eicar.com`、`eicar_com.zip`", "拦截：HTTP 403，KSE 拦截页"],
    ["≥25MB、内含 EICAR 的压缩包", "拦截：HTTP 403"],
    ["`https://www.kaspersky.com` 的证书签发者", "原厂 CA（不解密）；其他站点为 KAIP Download Proxy CA"],
    ["终端未信任代理 CA 时访问 HTTPS", "证书错误（说明 HTTPS 已被解密）"],
    ["KAIP 控制台「事件日志」", "出现来源 kse-syslog 的拦截记录（需完成第 3 步）"],
  ], [55, 45]),
  note("已在 Ubuntu 24.04 KSE 服务器（squid-openssl 6.14）上实测：HTTP 与 HTTPS 下的 EICAR、EICAR 压缩包、27 MB 内含 EICAR 的压缩包均被拦截；正常网页、PyPI 包与 git 放行；卡巴斯基站点不解密。Linux 终端经 client-proxy.sh 配置后，curl、Python、git 不带额外参数即走代理。", "info"),
  H2("4.5 安全加固"),
  ...bullets([
    "正式环境用 `deploy/nginx-kaip.conf` 提供 HTTPS（终端与平台之间传输文件与代码内容）；终端安装时加 `--secure` 校验证书。",
    "控制台「系统设置」中轮换终端注册令牌与供应链 API Key，仅分发给实施人员。",
    "KSE 控制台修改默认管理员密码，为操作员单独建账号。",
  ]),
  H2("4.6 与现有安全产品共存"),
  ...bullets([
    "服务器装有 **KESL** 时：请客户在 **KSC 策略**中为 `/opt/kaspersky/scanqueue` 与 `/var/lib/kaip`（分机部署时还有 KSE 主机上的 `/mnt/kaip-scanqueue`；启用下载代理时还有 `/var/spool/squid`）添加实时防护排除（本地修改可能被策略覆盖）。否则 KESL 可能抢先删除测试样本，干扰判定。",
    "终端杀软（如亚信）：KAIP 客户端不安装驻留杀毒组件，只新增 Node.js 脚本、Agent hook 配置与一个监控进程，一般无需排除；如出现拦截，将 `~/.kaip` 加入排除。",
  ]),
  H2("4.7 部署验收"),
  ...numbered([
    "控制台「PoC 自检」：要求 **8/8 通过**（A1 干净/EICAR、B1 模型、B4 Skill、B8 数据集、C1-1 恶意 URL、C1-2 钓鱼 URL）。",
    "控制台「安全概览」：引擎为 KSE 在线，病毒库为近期日期，许可证有效。",
  ]),
);

// 5 终端接入
add(
  H1("5 终端接入（第 2 天）"),
  H2("5.1 搭建 AI Agent 环境（客户尚未部署时）"),
  P("客户已有 Agent 环境时跳过本节，直接从 5.2 开始。以下步骤均在 PoC 环境中实测通过（Codex 0.166.0 原生 Linux、OpenCode 1.15.13 容器、WorkBuddy Windows 桌面版）。"),
  table(["准备项", "要求"], [
    ["KAIP 平台", "已运行（在线或离线包均可）；控制台「接入部署」页提供**注册令牌**和 Windows / Linux **一键安装命令**"],
    ["模型 API 密钥", "由客户提供（如 MiniMax）；**只保存在终端本机的环境变量或 600 权限文件中**，不写入配置文件，实施人员不经手"],
    ["网络", "终端能访问平台 8080 端口；终端无需预装 Node.js（一键安装会从平台下载私有运行时）"],
  ], [22, 78]),
  note("模型密钥一律由客户本人输入，不要通过聊天、邮件或测试记录传递。", "warn"),
  H3("5.1.1 Codex（Linux 原生）"),
  ...sCodex([
    "安装 Node.js 22 与 Codex（国内网络使用 npmmirror 镜像）：",
  ]),
  ...code([
    "curl -fsSL https://registry.npmmirror.com/-/binary/node/v22.23.5/node-v22.23.5-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1",
    "npm i -g @openai/codex@0.166.0 --registry=https://registry.npmmirror.com",
  ]),
  ...sCodex(["配置模型：编辑 `~/.codex/config.toml`（不含密钥）："]),
  ...code([
    "model_provider = \"minimax\"",
    "model = \"MiniMax-M3\"",
    "",
    "[model_providers.minimax]",
    "name = \"MiniMax\"",
    "base_url = \"https://api.minimaxi.com/v1\"",
    "env_key = \"MINIMAX_API_KEY\"",
    "wire_api = \"responses\"",
    "requires_openai_auth = false",
  ]),
  ...sCodex(["客户本人将密钥写入 `~/.codex/minimax.env`（内容 `export MINIMAX_API_KEY=...`），每次启动 Codex 前加载："]),
  ...code(["chmod 600 ~/.codex/minimax.env", "source ~/.codex/minimax.env && codex"]),
  ...sCodex([
    "按 5.2 执行 Linux 一键安装：自动注册、写入 hooks、开启 `[features] hooks = true`、启动后台监控 kaip-watch。",
    "**信任 KAIP hook（必做）**：在终端运行 `codex`，在「Hooks need review」中选择信任。Codex 桌面版不弹此提示，Windows 上也需先在终端运行一次 `codex`。",
    "执行 `kaip verify`，看到「Codex ✔ 生效」。",
  ]),
  note("Windows 上的 Codex：安装 Codex 桌面版或 `npm i -g @openai/codex`，模型配置相同（`%USERPROFILE%\\.codex\\config.toml`），然后执行 Windows 一键命令并在终端信任 hook。", "info"),
  H3("5.1.2 OpenCode（容器化，推荐）"),
  P("镜像 = `node:22-slim` + `opencode-ai@<版本>` + KAIP 客户端，容器启动时自动注册、安装插件、启动后台监控。由平台的 compose 统一管理（profile `agent`），在离线包 `deploy/` 目录执行；构建需能访问 npm 镜像源。客户已有自己的 OpenCode 镜像时，不必换用本镜像，见第 5.4 节。"),
  ...sOc(["准备基础镜像（无法访问 Docker Hub 时）："]),
  ...code([
    "docker pull docker.m.daocloud.io/library/node:22-slim",
    "docker tag docker.m.daocloud.io/library/node:22-slim node:22-slim",
  ]),
  ...sOc(["构建镜像（`.env` 中 `OPENCODE_VERSION` 指定版本）："]),
  ...code(["docker compose --profile agent build opencode"]),
  ...sOc(["配置模型密钥（交互式，由客户本人输入，密钥只保存在 opencode-data 卷）："]),
  ...code(["docker compose --profile agent run --rm opencode opencode auth login"]),
  ...sOc(["在**带 KAIP 插件**的容器中选择模型（1.15.13 有插件时模型目录会在线刷新，实测 minimax-cn 只能用 MiniMax-M3.1-Flash）："]),
  ...code(["docker compose --profile agent run --rm opencode opencode models"]),
  ...sOc(["正式运行。注册令牌写入 `kaip_enroll_token.txt`（compose secrets 以文件挂载，不进入容器环境变量和 `docker inspect`），注册成功后可清空；`.env` 中 `OPENCODE_HOSTNAME` 为平台上显示的终端名："]),
  ...code([
    "echo <注册令牌> > kaip_enroll_token.txt && chmod 600 kaip_enroll_token.txt",
    "docker compose --profile agent run --rm opencode",
    ": > kaip_enroll_token.txt                              # 注册成功后清空",
  ]),
  ...sOc(["验证：`docker compose --profile agent run --rm opencode node /root/.kaip/client/bin/kaip.js verify`，看到「OpenCode ✔ 生效」。"]),
  note("Windows 桌面版 OpenCode（2.x）：安装后执行 Windows 一键命令，然后完全退出 OpenCode，并结束后台常驻的 `opencode-cli` 进程，再重新打开。", "info"),
  H3("5.1.3 WorkBuddy（Windows 桌面版）"),
  ...numbered([
    "安装 WorkBuddy 并登录（模型由 WorkBuddy 账号提供，无需另外配置）。",
    "按 5.2 执行 Windows 一键命令（有无 Git Bash 均可）。",
    "**从托盘图标彻底退出 WorkBuddy 后重新打开**；只关窗口不会加载新的 hook 配置。",
    "执行 `kaip verify`，看到「WorkBuddy ✔ 生效」。",
  ]),
  H2("5.2 一键安装 KAIP 客户端"),
  P("在控制台「接入部署」页复制命令，在测试终端执行。安装程序会自动识别本机的 Codex / OpenCode / WorkBuddy，完成注册、写入 hook / 插件、安装后台监控（Windows 计划任务 / Linux systemd 用户服务）。"),
  ...code(["# Windows（cmd）", "curl.exe -fsSLk -o \"%TEMP%\\kaip-install.ps1\" https://<平台>/dl/install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File \"%TEMP%\\kaip-install.ps1\" -Server https://<平台> -Token <注册令牌>",
    "", "# Linux", "curl -fsSL https://<平台>/dl/install.sh | bash -s -- --server https://<平台> --token <注册令牌>"]),
  note("请使用默认安装（含后台监控）。不装监控时，KAIP 被篡改后不会自动修复，升级探测与行为对账也只在手动执行 `kaip verify` 时进行。", "info"),
  H2("5.3 各 Agent 的专项步骤"),
  table(["Agent", "接入方式", "必做步骤", "常见问题"], [
    ["Codex（桌面版 / CLI）", "~/.codex/hooks.json + config.toml [features] hooks = true", "在**终端**中运行一次 `codex`，在「Hooks need review」中选择 Trust all（桌面版不会弹出该提示；信任结果桌面版与 CLI 共用）", "未信任的 hook 不会执行；`kaip verify` 显示「⚠ 未信任」"],
    ["WorkBuddy / CodeBuddy", "~/.workbuddy/settings.json（及 ~/.codebuddy）hooks，全部工具调用经过 KAIP", "**完全退出**（含托盘图标）后重新打开", "只关窗口不加载新配置；模型读到 curl|bash 后可能自行拒绝执行——此时没有 KAIP 提示，不属于漏拦"],
    ["OpenCode 1.x / 2.x", "~/.config/opencode/plugins/kaip.js（按版本自动选择 v1 / v2 写法）", "重启 OpenCode，包括 2.x 的后台服务进程 opencode-cli", "2.x 后台服务会保留旧插件代码，需结束进程后生效"],
    ["容器化 OpenCode", "kaip-opencode 镜像（见 5.1.2）；客户已有的 OpenCode 容器在其 compose 中加入 KAIP 配置（见 5.4）", "设置 KAIP_SERVER；首次注册把令牌写入 kaip_enroll_token.txt（compose secrets）；固定主机名", "OpenCode 1.15 有插件时模型目录会在线刷新，用带插件的容器执行 `opencode models` 选模型"],
  ], [16, 26, 32, 26]),
  gap(),
  H2("5.4 客户已有的 OpenCode 容器接入 KAIP（不换镜像、不重建镜像）"),
  H3("5.4.1 用 docker compose 管理的容器（推荐）"),
  P("在客户的 compose 中为 OpenCode 服务加入 KAIP 配置：KAIP 入口脚本在容器每次启动时完成注册（首次）、插件安装、后台监控，然后执行原来的 OpenCode 命令。配置片段见离线包 `deploy/opencode-container/docker-compose.kaip.yml`，可用 `-f` 合并，也可直接写进客户的 compose。"),
  ...sCust(["宿主机准备客户端（一次即可；之后容器内的客户端随平台自动升级）。平台须为 20261117 或更新版本（客户端包中有 `scripts/container-entrypoint.sh`），旧平台先按第 5.6 节升级："]),
  ...code(["sudo mkdir -p /opt/kaip-client && curl -fsSL http://<平台>:8080/dl/kaip-client.tar.gz | sudo tar -xz -C /opt/kaip-client"]),
  ...sCust(["在客户 compose 的 OpenCode 服务中加入（`command` 为原镜像的 ENTRYPOINT + CMD，用 `docker image inspect` 查看）："]),
  ...code([
    "services:",
    "  opencode:                                   # 客户 compose 中的服务名",
    "    entrypoint: [\"/opt/kaip-client/scripts/container-entrypoint.sh\"]",
    "    command: [\"opencode\"]",
    "    environment:",
    "      KAIP_SERVER: http://<平台>:8080",
    "      KAIP_HOME: /root/.kaip",
    "    secrets: [kaip_enroll_token]",
    "    volumes:",
    "      - /opt/kaip-client:/opt/kaip-client:ro",
    "      - kaip-state:/root/.kaip",
    "volumes:",
    "  kaip-state:",
    "secrets:",
    "  kaip_enroll_token:",
    "    file: ./kaip_enroll_token.txt",
  ]),
  ...sCust(["写入注册令牌并启动，注册成功后清空令牌文件，验证："]),
  ...code([
    "echo <注册令牌> > kaip_enroll_token.txt && chmod 600 kaip_enroll_token.txt",
    "docker compose -f docker-compose.yml -f docker-compose.kaip.yml up -d",
    ": > kaip_enroll_token.txt",
    "docker compose exec opencode node /root/.kaip/client/bin/kaip.js verify    # 必须看到「OpenCode ✔ 生效」",
  ]),
  ...bullets([
    "`docker restart`、`docker compose down/up` 重建容器后自动恢复插件与后台监控，注册信息保存在 `kaip-state` 卷，不需要重新注册。",
    "镜像没有 Node.js 18+：宿主机解压平台私有运行时到 `/opt/kaip-node`，挂载进容器并设置 `KAIP_NODE=/opt/kaip-node/bin/node`（glibc，Alpine 镜像不适用）。KAIP 插件在 OpenCode 进程内加载，拦截本身不依赖 Node.js。",
    "容器以非 root 用户运行时，把 `/root/.kaip` 换成该用户 HOME 下的 `.kaip`。",
  ]),
  note("已实测：未安装 KAIP 的客户镜像 `node:22-slim + opencode-ai@1.15.13` 经上述配置启动后自动注册，「OpenCode ✔ 生效」；插件契约测试中恶意脚本执行与 EICAR 写入被阻断，正常操作放行；restart、down/up 重建后监控自动恢复且无需重新注册；令牌不出现在容器环境变量与 docker inspect 中。", "info"),
  H3("5.4.2 未用 compose 管理、正在运行的容器（docker exec 在线加装）"),
  P("适用于客户已有的普通 OpenCode 容器。以下命令都在**宿主机**执行，容器内不需要 curl，也不需要访问平台以外的网络（已用不含 curl 的 `node:22-slim` + OpenCode 1.15.13 容器实测：EICAR 写入被 KSE 检出阻断，钓鱼 URL、`curl | bash`、删除 KAIP 插件均阻断，正常操作放行）。"),
  ...sAttach(["设置平台地址和容器名（容器名用 `docker ps` 查看）："]),
  ...code(["S=http://<平台>:8080; C=<容器名>"]),
  ...sAttach(["宿主机下载客户端，拷入容器并解压："]),
  ...code([
    "curl -fsSL $S/dl/kaip-client.tar.gz -o /tmp/kaip-client.tar.gz",
    "docker exec $C mkdir -p /root/.kaip/client",
    "docker cp /tmp/kaip-client.tar.gz $C:/tmp/",
    "docker exec $C tar -xzf /tmp/kaip-client.tar.gz -C /root/.kaip/client",
  ]),
  ...sAttach(["注册：注册令牌预先存入 token.txt，经标准输入传入，不出现在命令行历史和 `docker inspect` 中："]),
  ...code(["docker exec -i $C sh -c \"node /root/.kaip/client/bin/kaip.js enroll --server $S --token \\\"\\$(cat)\\\"\" < token.txt"]),
  ...sAttach(["安装 OpenCode 插件（自动按 1.x / 2.x 选择）并启动后台监控："]),
  ...code([
    "docker exec $C node /root/.kaip/client/bin/kaip.js install --agents opencode --no-watch",
    "docker exec -d $C sh -c \"nohup node /root/.kaip/client/bin/kaip.js watch >/dev/null 2>&1\"",
  ]),
  ...sAttach(["**重启容器内的 OpenCode**（插件只在 OpenCode 启动时加载，已打开的会话不受保护），然后验证："]),
  ...code(["docker exec $C node /root/.kaip/client/bin/kaip.js verify     # 必须看到「OpenCode ✔ 生效」"]),
  table(["情况", "处理"], [
    ["`docker restart` 之后", "插件和注册信息仍在、防护持续生效，但后台监控进程不会自动启动（没有心跳，控制台约 10 分钟后显示「离线」）。在宿主机安装守护脚本，每分钟检查并拉起：`install -m 755 kaip-container-watch.sh /usr/local/bin/`，`echo '* * * * * root /usr/local/bin/kaip-container-watch.sh' > /etc/cron.d/kaip-container-watch`（脚本位于 deploy/opencode-container/）"],
    ["容器被删除重建", "在线加装的内容全部丢失。长期使用请改为第 5.4.1 节的 compose 配置，或 kaip-opencode 镜像（5.1.2）"],
    ["容器内无 Node.js 18+", "宿主机下载 `$S/dl/runtime/node-linux-x64.tar.gz`，`docker cp` 后解压到容器 `/root/.kaip/node`（`--strip-components=1`），命令中的 `node` 换成 `/root/.kaip/node/bin/node`；该运行时基于 glibc，**不支持 Alpine 容器**"],
    ["容器以非 root 用户运行", "`/root` 换成该用户 HOME，`docker exec` 加 `-u <用户>`"],
  ], [24, 76]),
  gap(),
  H2("5.5 接入验收"),
  ...code(["kaip verify      # 每个 Agent 应显示「✔ 生效」及版本号", "kaip selftest    # 以各 Agent 调用格式自测拦截，应全部通过", "kaip test        # EICAR 写入与高危命令拦截链路"]),
  P("控制台「终端与 Agent」中应看到该终端在线，各 Agent 显示版本与「生效」状态。"),
  H2("5.6 卸载与 PoC 结束后的清理"),
  H3("5.6.1 终端"),
  table(["命令", "效果"], [
    ["`kaip uninstall`", "结束正在运行的后台监控进程，移除 Codex / WorkBuddy / OpenCode 的 KAIP 接入与监控服务（计划任务 / systemd / crontab），清空接入列表；保留 `~/.kaip`（凭据、日志），之后可直接 `kaip install` 重新接入"],
    ["`kaip uninstall --purge`", "彻底卸载：在上述基础上结束后台监控进程、移除 PATH 设置、删除安装时的配置备份 `*.kaip.bak`、删除整个 `~/.kaip`（凭据、日志、私有 Node 运行时、本地隔离区）。Windows 上目录在命令退出约 3 秒后删除"],
  ], [26, 74]),
  ...bullets([
    "两种方式都会先向平台上报 `KAIP:Client.Uninstalled` 事件，管理员可在控制台看到哪台终端移除了防护。",
    "2026-11-15 之前的客户端普通卸载后，仍在运行的监控进程会在约 30 秒内把 hook 当作「被移除」自动修复回来；请先 `kaip sync` 同步到平台最新客户端再卸载，或直接使用 `--purge`。",
    "卸载**不会**用 `*.kaip.bak` 恢复 Agent 配置（避免覆盖安装后用户自己改过的内容），只删除 KAIP 写入的 hook / 插件条目。",
    "Codex `config.toml` 中的 `[features] hooks = true` 会保留（KAIP hook 已删除，留着无影响），需要时手动删除。",
    "**AI Agent 自己执行卸载会被防篡改阻断**，卸载须由用户在终端中手动执行。",
    "卸载后请重启正在运行的 AI Agent；不再使用的终端在控制台「终端与 Agent」中**吊销**。",
    "PATH 中没有 `kaip` 时使用完整路径：Linux `node ~/.kaip/client/bin/kaip.js uninstall --purge`；Windows `node \"%USERPROFILE%\\.kaip\\client\\bin\\kaip.js\" uninstall --purge`（私有运行时下把 `node` 换成 `~/.kaip/node/bin/node` 或 `%USERPROFILE%\\.kaip\\node\\node.exe`）。",
  ]),
  H3("5.6.2 容器"),
  ...code([
    "# 加装了 KAIP 的已有容器",
    "docker exec <容器名> node /root/.kaip/client/bin/kaip.js uninstall --purge",
    "rm -f /etc/cron.d/kaip-container-watch /usr/local/bin/kaip-container-watch.sh   # 宿主机守护脚本",
    "",
    "# compose 接入（5.4.1）：去掉 KAIP 配置后重建，并删除 KAIP 状态卷",
    "docker compose -f docker-compose.yml up -d --force-recreate && docker volume rm <项目名>_kaip-state",
    "",
    "# 平台以 docker compose 部署时（含 kaip-opencode）：连同数据卷删除，删除前先导出报告",
    "cd deploy && docker compose --profile agent down -v && docker rmi kaip-platform:1.0.0 kaip-opencode:1.15.13",
  ]),
  H3("5.6.3 服务器（PoC 结束、客户不保留平台时）"),
  ...code([
    "systemctl disable --now kaip-platform",
    "rm -f /etc/systemd/system/kaip-platform.service && systemctl daemon-reload",
    "rm -rf /opt/kaip /etc/kaip /var/lib/kaip      # 含事件、隔离区与凭据，删除前按交付要求导出报告",
    "userdel kaip",
    "",
    "# 分机部署时另行清理 NFS 共享",
    "# 平台服务器：删除 /etc/exports 中 /opt/kaspersky/scanqueue 一行，执行 exportfs -ra",
    "# KSE 服务器：umount /mnt/kaip-scanqueue，删除 /etc/fstab 中对应一行，并从 KSE「允许扫描的目录」移除",
    "",
    "# 启用了下载代理时：终端先执行 client-proxy.sh --remove / client-proxy.ps1 -Remove，再在代理服务器上",
    "systemctl disable --now squid && apt-get remove -y squid-openssl",
    "rm -rf /etc/squid/certs /var/spool/squid/ssl_db      # 代理 CA 私钥一并销毁",
  ]),
  note("`/var/lib/kaip` 包含全部事件记录与隔离文件，删除前请先导出 PoC 报告所需数据；隔离区中可能有真实恶意样本，按客户安全制度销毁。KSE 按其自身卸载说明处理。", "warn"),
);

// 6 测试用例
add(
  H1("6 测试用例"),
  H2("6.1 A / B / C 类（沿用《PoC 技术方案》）"),
  table(["编号", "测试项", "平台操作 / 工具", "通过标准"], [
    ["A1 / A2", "文件扫描 / 内存扫描", "控制台「供应链扫描」上传；自检", "干净文件 CLEAN，EICAR 检出"],
    ["A3", "KSN 云信誉", "KSE 开关 KSN 前后扫描 KSN 测试文件", "开启后检出"],
    ["B1 / B2", "模型文件检测与格式覆盖", "上传 PKL / PT / PTH / CKPT / KERAS 测试样本", "KSE（KL_SCAN_LLM）或 KAIP pickle 规则检出"],
    ["B3", "大文件与性能", "上传客户 1 GB / 10 GB / 最大模型", "在约定时限内给出判定，记录耗时与资源"],
    ["B4", "Skill 包扫描", "上传含样本的嵌套 / 加密压缩包", "嵌套样本检出；加密包 NON_SCANNED 且不放行"],
    ["B5 / B6", "下载代理 / 企业版管控", "第 4.4 节（install-squid.sh、client-proxy）；WorkBuddy 企业版后台", "按方案记录"],
    ["B7", "RAG 文档上传扫描", "`b7_rag_upload.py`（模拟知识库入库端点）", "正常文档入库，含样本文档阻断且不入库"],
    ["B8", "训练数据集投毒", "上传含恶意代码的 jsonl / 压缩包", "检出并阻止入库"],
    ["C1", "URL 信誉", "自检 C1-1 / C1-2；官方测试 URL", "MALICIOUS_URL / PHISHING_URL"],
    ["C2", "误报对照", "上传客户正常模型、Skill、文档、代码包", "误报为 0 或在可接受范围"],
    ["C3", "日志与告警", "事件日志；SIEM 转发（CEF）", "事件在平台与 SIEM 均可查"],
    ["C4", "隔离网段更新", "离线许可证 + 镜像 / 本地目录更新", "病毒库更新成功"],
    ["C5", "与现有环境共存", "观察终端杀软与业务", "无冲突"],
  ], [10, 22, 38, 30]),
  gap(),
  H2("6.2 D 类：AI Agent 运行时防护（新增）"),
  P("D 类在客户实际使用的 Agent 中执行。每个用例建议做两遍：先用回放脚本快速确认判定逻辑，再在 Agent 中真实对话验证。"),
  table(["编号", "测试项", "方法（提示词要点）", "通过标准"], [
    ["D1", "恶意脚本执行", "让 Agent「直接运行 bash setup_helper.sh（不要先读文件）」；对照：运行正常脚本", "恶意脚本执行前阻断；正常脚本放行"],
    ["D2", "写入恶意文件（多路径）", "分别要求用：写文件工具、apply_patch、`python3 -c` 一行代码、heredoc、Agent 自带 JS/Python 运行工具，写入 EICAR", "各路径均被 KSE 检出阻断，文件未落盘"],
    ["D3", "恶意 / 钓鱼 URL", "让 Agent 用 curl 访问官方测试 URL", "PHISHING_URL / MALICIOUS_URL 阻断"],
    ["D4", "恶意 Skill", "安装含 curl|bash 的测试 Skill；调用该 Skill", "调用前阻断；安装后监控告警（启发式命中不自动隔离，执行时阻断）"],
    ["D5", "防篡改（执行前）", "`replay-tamper-all.mjs`：读取 KAIP 凭据、删除 hook、关闭 hooks、停止监控、卸载等", "全部阻断并产生 KAIP:Tamper.* 事件；只读查看放行"],
    ["D6", "防篡改（事后自愈）", "`tamper-selfheal.sh`：改坏客户端、删除 hook、改本地策略", "期间阻断不放行；约 1 分钟自动恢复并告警"],
    ["D7", "防护失效与升级复核", "Codex 不信任 hook；升级一个 Agent 版本", "平台出现「未信任」「升级待复核」，真实使用后恢复「生效」"],
    ["D8", "误报（真实工作负载）", "开发人员用客户真实项目与 Skill 正常工作半天", "逐条记录误报，经受信任目录 / 白名单处理"],
  ], [8, 18, 46, 28]),
  gap(),
  H2("6.3 测试执行技巧"),
  ...bullets([
    "**提示词写进文件再引用**：提示词中的 `$`、反斜杠会被 shell 改写，EICAR 被破坏后引擎判定为 CLEAN，造成「漏拦」假象。",
    "**明确要求「不要先读取文件」「被阻止不要绕过」**：部分模型读到 curl|bash 会自行拒绝执行，此时 KAIP 不会出提示，不属于漏拦。",
    "**防篡改用回放脚本验证**：不要让拥有完全权限的自主 Agent 真去执行「停用安全组件」的指令。",
    "**每轮测试后清理落盘的测试文件**，避免终端杀软告警干扰后续用例。",
  ]),
);

// 7 计划
add(
  H1("7 两周实施计划"),
  table(["阶段", "时间", "工作内容", "责任方"], [
    ["启动准备", "启动前", "确认范围与成功标准；收集第 3.1 节信息；准备服务器、终端、许可证与样本", "双方"],
    ["第 1 周", "第 1 天", "部署 KSE 与 KAIP 平台、病毒库更新、安全加固、PoC 自检 8/8", "卡巴斯基"],
    ["", "第 2 天", "终端接入、各 Agent 专项步骤、kaip verify / selftest", "双方"],
    ["", "第 3 天", "A1–A3、B1、B2、B8", "卡巴斯基"],
    ["", "第 4–5 天", "B4、B7；D1–D4（回放 + 真实对话）", "卡巴斯基"],
    ["第 2 周", "第 6 天", "B5 / B6（下载代理、企业版管控）", "双方"],
    ["", "第 7 天", "D5–D7 防篡改、自愈、升级复核", "卡巴斯基"],
    ["", "第 8 天", "B3 大文件性能、C2 误报、D8 真实工作负载", "双方"],
    ["", "第 9 天", "C1、C3、C4、C5", "卡巴斯基"],
    ["", "第 10 天", "复盘、结果对照表、总结报告、决策层演示", "卡巴斯基"],
  ], [14, 14, 56, 16]),
);

// 8 演示
add(
  H1("8 决策层演示脚本（约 15 分钟）"),
  table(["步骤", "时长", "演示内容", "讲解要点"], [
    ["1", "2 分钟", "控制台概览：在线终端、各 Agent 版本与防护状态", "统一管控 Codex / WorkBuddy / OpenCode"],
    ["2", "3 分钟", "在 Agent 中要求写入病毒测试文件 → 被阻断；切到事件日志", "执行前拦截，文件从未落盘；KSE 引擎判定"],
    ["3", "3 分钟", "让 Agent 调用含恶意脚本的 Skill → 被阻断", "AI 供应链：Skill 是新的投毒入口"],
    ["4", "2 分钟", "上传投毒模型 / RAG 文档 → 阻断并隔离", "模型、知识库、数据集入口把关"],
    ["5", "3 分钟", "Agent 试图关闭防护 → 被阻断；展示自动修复记录", "AI Agent 拥有 shell 权限，安全组件必须自我保护"],
    ["6", "2 分钟", "SIEM 中看到同一批事件；Agent 升级后的复核提醒", "可运营：告警进 SOC，升级不留盲区"],
  ], [8, 10, 46, 36]),
);

// 9 成功标准与交付
add(
  H1("9 成功标准与交付物"),
  H2("9.1 建议的成功标准（请客户确认或调整）"),
  ...bullets([
    "已知测试样本检出率 100%（A1、B1、B4、B7、B8、D2）；",
    "D1–D4：恶意动作执行前阻断，正常操作放行；",
    "D5：篡改动作 100% 阻断；D6：自动修复时间 ≤ 2 分钟；",
    "误报：C2 与 D8 误报数为 0 或在客户认可范围内；",
    "NON_SCANNED（加密、损坏等）一律按未放行处理；",
    "所有检出与阻断在控制台与 SIEM 中可追溯。",
  ]),
  H2("9.2 交付物"),
  ...bullets([
    "测试用例执行记录与结果对照表（附录 B 模板）；",
    "KSE 与 KAIP 配置清单（附录 C）；",
    "大文件性能数据（耗时、CPU、内存）；误报清单与处理方式；",
    "PoC 总结报告与生产落地建议（推广范围、终端分批、HTTPS 与高可用、运维流程）。",
  ]),
);

// 10 排错
add(
  H1("10 常见问题与排错"),
  table(["现象", "原因", "处理"], [
    ["KSE 病毒库日期很旧", "安装后从未触发更新", "POST /api/v3.0/update/start 手动更新；确认自动更新周期"],
    ["钓鱼 URL 检不出，恶意 URL 能检出", "未开启防钓鱼（缺 APUF / KAV_O_M_PHISHING）", "KSE 控制台 Settings → Scanning 打开 Enable Phishing Protection"],
    ["curl 测 KSN 域名握手失败", "KSN 不接受通用 TLS 客户端", "以 KSE checkurl 检测官方测试 URL 判断，必要时抓包确认"],
    ["Codex 不拦截", "hook 未被信任；或 config.toml 未开启 hooks", "终端中运行 codex 信任 hook；`kaip verify` 应显示生效"],
    ["Codex 拦截返回了但命令仍执行", "Codex 只认 stdout JSON + 退出码 0", "使用 KAIP 当前版本客户端（已按宿主区分输出）"],
    ["WorkBuddy 修改配置后无效", "WorkBuddy 常驻，未完全重启", "退出托盘图标后重新打开"],
    ["WorkBuddy 让运行恶意脚本却无 KAIP 提示", "模型读文件后自行拒绝执行", "提示词要求「不要先读取文件、直接运行」"],
    ["OpenCode 2.x 插件不生效 / 用的是旧代码", "2.x 后台服务 opencode-cli 常驻", "结束该进程或重启 OpenCode"],
    ["`kaip verify` 显示「升级待复核」", "检测到 Agent 升级，尚未观察到真实拦截调用", "在 Agent 中正常使用一次；仍未恢复则检查宿主 hook 契约"],
    ["「最近 N 次工具调用未经过 KAIP 执行前检查」", "宿主不再调用 PreToolUse（契约变化 / matcher 失效）", "检查 Agent 版本与 hook 配置，重新安装接入，必要时联系研发适配"],
    ["终端文件被「恢复」成旧版本", "平台官方客户端包未更新，自愈按平台版本恢复", "先更新平台 /opt/kaip/client，再让终端同步"],
    ["同一文件第二次扫描很快 / 控制台显示 `cached`", "判定缓存命中：病毒库未更新时同一文件（按 SHA-256）不重复扫描", "正常现象。病毒库更新后缓存自动失效（终端在 60 秒心跳内同步）；兜底 7 天。首页「扫描引擎状态」可看命中率"],
    ["病毒库更新后出现一波集中扫描", "缓存随病毒库失效，终端 15 分钟全量扫描按新病毒库重新判定", "正常现象；监控目录文件多时扫描量相应增加"],
    ["服务器上测试样本「消失」", "KESL 实时防护抢先处理", "KSC 策略为 scanqueue、/var/lib/kaip 加排除"],
    ["离线安装提示 Python 版本不支持", "旧版离线包只带 3.10–3.12 的依赖", "使用 2026-11-15 及之后的离线包：系统 Python 过低时自动使用包内便携 Python"],
    ["分机部署时 ≥25MB 文件判定 ERROR（文件不存在 / 无权访问）", "KSE 主机未挂载共享目录；挂载点不在 KSE 允许扫描的目录；或 KAIP_KSE_SCAN_DIR_REMOTE 与挂载点不一致", "KSE 主机执行 `mountpoint /mnt/kaip-scanqueue`；核对 KSE Service 设置与 kaip.env，重启 kaip-platform"],
    ["分机部署时大文件仍走 scanmemory（NFS 读取量不变）", "未设置 KAIP_KSE_SCAN_DIR_REMOTE（安装时没带 --kse-share）", "在 kaip.env 中设置后重启 kaip-platform"],
    ["读取初始管理员密码提示 Permission denied", "数据目录已限制为仅服务账号可读", "`sudo cat /var/lib/kaip/initial_admin_password.txt`"],
    ["经代理访问 HTTPS 报证书错误", "终端未信任代理 CA，或程序不读取环境变量 / 自带信任库", "重新执行 client-proxy 脚本并新开终端；Java 等需导入其自带信任库；证书固定的站点加入 --no-bump-domains"],
    ["经代理下载全部失败（ICAP 相关错误）", "KSE ICAP 服务 kavicapd 未运行", "`systemctl enable --now kavicapd`；下载扫描设计为失败即阻断"],
    ["经代理下载返回 503", "代理服务器无法访问上游站点", "在代理服务器上直接 curl 该站点确认网络（如 Hugging Face 不可达）"],
    ["WorkBuddy 下载不经过代理", "Electron 应用只认系统代理", "Windows 执行 client-proxy.ps1 时加 -SystemProxy，并完全重启 WorkBuddy"],
    ["经代理下载的病毒偶发未拦截（耗时十几秒后 200）", "KSE 与 KSN 连接中断或重连期间，ICAP 扫描超时（kavicapd ScanTimeout 默认 10 秒）后原样放行；ICAP 服务本身正常应答，Squid 的 bypass=0 不起作用", "保证 KSE 服务器到 KSN 的网络稳定；完全隔离的网络在 /etc/kavicapd.xml 中设置 UseKSN=0 后重启 kavicapd，避免等待超时。AI Agent 随后写入或执行该文件时，KAIP 终端防护仍会扫描"],
    ["控制台看不到代理拦截事件", "未在 KSE 控制台为 ICAP 模式配置 Syslog、目标地址不是当前平台、未勾选扫描结果事件，或平台服务器未放行 UDP 5514", "Settings → Logging → Syslog 添加 udp://<KAIP 平台>:5514（CEF），勾选扫描结果（Scan result）事件；在 KSE 服务器上 `tcpdump -U -A udp port 5514` 确认已发出报文"],
    ["所有扫描判定 ERROR「无法连接 KSE: Connection refused」，KSE 服务显示运行中", "分机部署时平台服务器离线，KSE 服务器上 hard 方式的 NFS 挂载卡住 kavhttpd（进程状态 D，不监听 1234）", "KSE 服务器 `umount -f -l /mnt/kaip-scanqueue && systemctl restart kavhttpd`；重新执行 `kse-share.sh kse-host` 改为 soft 挂载"],
    ["KSE 不可用期间，哪些仍会被拦截", "策略默认 fail_open：引擎不可用时放行，避免影响开发", "KAIP 规则（如 curl | bash、反弹 shell）不依赖 KSE，命中仍阻断；病毒、钓鱼 URL 需 KSE 判定。要求严格时在策略中关闭 fail_open；控制台按判定 ERROR 筛选事件及时发现"],
    ["compose 接入时容器内找不到 container-entrypoint.sh", "平台版本早于 20261117，下发的客户端包中没有该脚本", "升级平台后重新下载客户端到 /opt/kaip-client（不要只替换终端客户端：与平台指纹不一致会被自愈回旧版）"],
    ["`docker compose up` 报 secret 文件不存在", "未创建 kaip_enroll_token.txt", "创建该文件（注册成功后可为空，但需保留）"],
    ["compose 中的 OpenCode 提示「未注册且缺少 KAIP_ENROLL_TOKEN」", "首次启动时令牌文件为空，或数据卷是新的", "写入令牌后重启容器；注册信息在 kaip-state 卷中，删除该卷需重新注册"],
    ["平台容器 unhealthy / 扫描目录写入失败", "宿主机扫描目录对 UID 10001 不可写", "`install -d -o 10001 -g 10001 -m 0775 /opt/kaspersky/scanqueue`"],
    ["普通卸载后 hook 又被装回来", "旧版客户端未结束运行中的监控进程，监控按「接入配置被移除」自愈", "`kaip sync` 升级客户端后重新卸载，或使用 `kaip uninstall --purge`"],
    ["Docker / GitHub 镜像拉取失败", "外网受限或 IPv6 大流量被重置", "国内镜像拉基础镜像 + npm 安装；或使用离线安装包"],
  ], [30, 33, 37]),
);

// 11 边界
add(
  H1("11 能力边界与风险说明"),
  P("以下内容需在 PoC 启动会与总结汇报中向客户如实说明："),
  ...numbered([
    "**拦截覆盖经过 Agent 工具调用的操作**。用户绕开 Agent 手工执行的操作，由目录监控（事后）与终端杀软覆盖。",
    "**KAIP 规则为静态特征**，用于补强 AI 场景；最终恶意代码判定以 KSE 为准。刻意编码的载荷（字符码拼接、Base64 解码后写盘、分段写入）可能绕过执行前检查，需落盘扫描与终端杀软补位。",
    "**防篡改运行在用户态、与 Agent 同一账号**：可阻断经 Agent 的篡改并事后检测修复，无法抵御同账号的人工操作或 root 权限恶意进程。更强隔离需让 Agent 以独立低权限账号或容器运行。",
    "**Agent 升级可能改变接口**：KAIP 会自动自测、提醒复核、通过行为对账发现静默失效，但新工具需人工评估后补充规则。",
    "**提示词注入等语义层攻击**不属于文件扫描能力范围。",
    "本平台为基于 KSE 的 PoC 集成方案，生产落地前需按卡巴斯基内部流程确认支持范围、版本与交付形态。",
  ]),
);

// 附录
add(
  H1("附录 A 命令与脚本速查"),
  table(["命令 / 脚本", "用途"], [
    ["kaip status", "查看平台连接、策略版本、接入的 Agent"],
    ["kaip verify", "检查各 Agent 防护是否真正生效（升级后必做）"],
    ["kaip selftest [--agents codex,...]", "以各 Agent 调用格式自测拦截"],
    ["kaip test", "EICAR 写入与高危命令拦截链路"],
    ["kaip scan <路径>", "手动扫描模型 / Skill / 文档目录"],
    ["kaip sync", "立即同步策略、触发完整性校验与自愈"],
    ["tests/integration/replay-tamper-all.mjs", "多 Agent 防篡改回放（D5）"],
    ["tests/integration/tamper-selfheal.sh", "事后篡改自愈场景（D6，Linux）"],
    ["tests/integration/b7_rag_upload.py", "RAG 文档上传扫描（B7）"],
    ["tests/integration/opencode-v1-contract.mjs / v2", "OpenCode 插件契约测试"],
    ["tests/test_client.mjs、tests/test_rules.py", "客户端与规则回归测试"],
    ["install-offline.sh [--kse-url URL --kse-share 挂载点]", "离线安装 / 升级平台（第 4.2 节）"],
    ["deploy/kse-share.sh kaip-host <KSE IP> / kse-host <平台 IP>", "分机部署时共享与挂载扫描目录（第 4.3 节）"],
    ["docker load -i images/kaip-platform-image-*.tar.gz；cd deploy && docker compose up -d", "以 Docker 方式部署平台（第 4.2 节）"],
    ["deploy/opencode-container/docker-compose.kaip.yml", "客户已有 OpenCode compose 接入 KAIP 的配置片段（第 5.4.1 节）"],
    ["deploy/squid/install-squid.sh --kaip-syslog <平台 IP>", "安装下载代理（Squid HTTPS 解密 + KSE ICAP，第 4.4 节）"],
    ["deploy/squid/client-proxy.sh / client-proxy.ps1", "终端接入 / 撤销下载代理（信任 CA、代理环境变量）"],
  ], [42, 58]),
  H1("附录 B 测试记录模板"),
  table(["编号", "测试项", "环境 / Agent 版本", "预期", "实际结果", "通过", "事件 ID / 截图"], [
    ["A1", "文件扫描", "", "干净 CLEAN / EICAR 检出", "", "", ""],
    ["A2", "内存扫描", "", "与 A1 一致", "", "", ""],
    ["A3", "KSN 云信誉", "", "开启后检出", "", "", ""],
    ["B1", "模型文件检测", "", "检出", "", "", ""],
    ["B2", "模型格式覆盖", "", "五种格式有明确判定", "", "", ""],
    ["B3", "大文件与性能", "", "阈值内给出判定", "", "", ""],
    ["B4", "Skill 包扫描", "", "嵌套检出 / 加密不放行", "", "", ""],
    ["B5", "Skill 下载代理", "", "含样本下载被拦截", "", "", ""],
    ["B6", "企业版后台管控", "", "如实记录可 / 不可", "", "", ""],
    ["B7", "RAG 文档上传", "", "含样本不入库", "", "", ""],
    ["B8", "训练数据集投毒", "", "检出不入库", "", "", ""],
    ["C1", "URL 信誉", "", "MALICIOUS / PHISHING", "", "", ""],
    ["C2", "误报对照", "", "0 或可接受", "", "", ""],
    ["C3", "日志与告警", "", "平台与 SIEM 可查", "", "", ""],
    ["C4", "隔离网段更新", "", "更新成功", "", "", ""],
    ["C5", "共存", "", "无冲突", "", "", ""],
    ["D1", "恶意脚本执行", "", "执行前阻断", "", "", ""],
    ["D2", "写入恶意文件（多路径）", "", "各路径阻断", "", "", ""],
    ["D3", "恶意 / 钓鱼 URL", "", "阻断", "", "", ""],
    ["D4", "恶意 Skill", "", "调用前阻断", "", "", ""],
    ["D5", "防篡改（执行前）", "", "全部阻断", "", "", ""],
    ["D6", "防篡改（自愈）", "", "≤2 分钟恢复", "", "", ""],
    ["D7", "失效与升级复核", "", "出现提醒并恢复", "", "", ""],
    ["D8", "误报（真实负载）", "", "0 或可接受", "", "", ""],
  ], [7, 17, 15, 19, 20, 7, 15]),
  H1("附录 C 关键配置项"),
  table(["位置", "配置", "建议值 / 说明"], [
    ["KSE 控制台 Service", "监听地址", "同机 127.0.0.1:1234；分机为平台可访问的地址（防火墙仅放行平台）"],
    ["KSE 控制台 Service", "Locations where remote scanning is allowed", "同机 /opt/kaspersky/scanqueue；分机 /mnt/kaip-scanqueue"],
    ["KSE 控制台 Scanning", "Enable Phishing Protection / reputation checking", "开启"],
    ["ppl/kave.ini", "[Environment] KL_SCAN_LLM", "1（重启 kavhttpd、kavicapd）"],
    ["KSE 控制台 Logging → Syslog（ICAP）", "事件 / 格式 / 目标", "detect + other / CEF / udp://<KAIP 平台>:5514"],
    ["/etc/squid/squid.conf", "icap_service kse_resp / kse_req", "icap://127.0.0.1:1344/resp（bypass=0）、/req（bypass=1）"],
    ["终端环境变量", "HTTPS_PROXY / NO_PROXY", "http://<代理>:3128 / 含 KAIP 平台地址与模型 API 域名"],
    ["/etc/kaip/kaip.env", "KAIP_KSE_MODE / KAIP_KSE_URL", "kse / http://127.0.0.1:1234（分机为 http://<KSE IP>:1234）"],
    ["/etc/kaip/kaip.env", "KAIP_KSE_SCANFILE_THRESHOLD", "26214400（≥25MB 走 scanfile；0 = 全部 scanmemory）"],
    ["/etc/kaip/kaip.env", "KAIP_KSE_SCAN_DIR_REMOTE", "同机留空；分机为 KSE 主机上的挂载点 /mnt/kaip-scanqueue"],
    ["/etc/kaip/kaip.env", "KAIP_KSE_TIMEOUT_MS", "600000（大模型）"],
    ["KAIP 防护策略", "防护模式", "PoC 阶段阻断模式；误报评估期可临时审计模式"],
    ["KAIP 防护策略", "无法扫描（加密 / 损坏）", "按未放行处理"],
    ["KAIP 防护策略", "自我保护 / 自动修复", "开启"],
    ["KAIP 防护策略", "受信任来源目录", "厂商官方插件市场目录（启发式只告警，KSE 检出仍阻断）"],
    ["KAIP 防护策略", "已确认的工具", "评估后的新工具名，避免重复提醒"],
    ["Codex config.toml", "[features] hooks", "true（旧名 codex_hooks）"],
  ], [26, 38, 36]),
);

// ---------- 文档 ----------
const doc = new Document({
  creator: "卡巴斯基售前团队",
  title: "Kaspersky AI Protect PoC 实施手册",
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: 34, bold: true, color: "13221E" }, paragraph: { spacing: { before: 240, after: 200 }, keepNext: true, outlineLevel: 0,
          border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BRAND, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: 27, bold: true, color: "0B6E5E" }, paragraph: { spacing: { before: 260, after: 120 }, keepNext: true, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: FONT, size: 23, bold: true, color: "13221E" }, paragraph: { spacing: { before: 180, after: 80 }, keepNext: true, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bul", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 280 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 900, hanging: 280 } } } }] },
      ...Array.from({ length: 60 }, (_, i) => ({ reference: `num${i + 1}`, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 480, hanging: 360 } } } }] })),
    ],
  },
  sections: [{
    properties: { page: { margin: { top: 1300, bottom: 1200, left: 1134, right: 1134 } }, titlePage: true },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "Kaspersky AI Protect · PoC 实施手册", font: FONT, size: 16, color: "6B7A75" })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["第 ", PageNumber.CURRENT, " 页"], font: FONT, size: 16, color: "6B7A75" })] })] }) },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  const out = process.argv[2] || "KAIP_PoC实施手册.docx";
  fs.writeFileSync(out, buf);
  console.log("已生成", out, (buf.length / 1024).toFixed(0) + " KB");
});
