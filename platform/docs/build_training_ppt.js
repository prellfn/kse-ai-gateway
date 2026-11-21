// 生成《Kaspersky AI Protect 产品培训》PPT（卡巴斯基设计风格，16:9）
// 用法：python build_training_diagrams.py && node build_training_ppt.js  → KAIP_产品培训.pptx
// 依赖：pptxgenjs（npm i pptxgenjs）；可选 APPLY_THEME=<pptx 技能 scripts/apply_theme.js 路径> 写入主题色
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");

const IMG = (n) => path.join(__dirname, "training-img", n);
const OUT = process.argv[2] || path.join(__dirname, "KAIP_产品培训.pptx");

// ---------- 主题 ----------
const THEME = {
  name: "Kaspersky AI Protect",
  headFontFace: "Kaspersky Sans Display", bodyFontFace: "Microsoft YaHei",
  colors: { dk1: "1D1D1B", lt1: "FFFFFF", dk2: "3C3C3B", lt2: "F4F6F5", accent1: "00A88E", accent2: "006D5C",
    accent3: "E6F6F3", accent4: "B7791F", accent5: "C0392B", accent6: "8A8A8A", hlink: "00A88E", folHlink: "006D5C" },
};
const K = { ink: "1D1D1B", graph: "3C3C3B", gray: "8A8A8A", line: "DCE3E0", panel: "F4F6F5", green: "00A88E", greenD: "006D5C",
  greenL: "E6F6F3", amber: "B7791F", amberL: "FDF4E3", red: "C0392B", redL: "FBECEA", white: "FFFFFF", dark2: "2A2A28" };
const HEAD = THEME.headFontFace, BODY = THEME.bodyFontFace, MONO = "Consolas";

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE";                // 13.333 × 7.5 in
pres.author = "卡巴斯基售前团队";
pres.company = "Kaspersky";
pres.title = "Kaspersky AI Protect 产品培训";
pres.theme = { headFontFace: HEAD, bodyFontFace: BODY };
const SW = 13.333, M = 0.6, CW = SW - 2 * M;   // 内容宽 12.133

// ---------- 版式（layouts） ----------
pres.defineSlideMaster({
  title: "K_COVER", background: { path: IMG("slide-cover.png") },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 2.55, w: 8.2, h: 1.3, fontFace: HEAD, fontSize: 48, bold: true, color: K.white, valign: "top", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: M, y: 3.85, w: 8.2, h: 0.9, fontFace: BODY, fontSize: 32, bold: true, color: K.white, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "K_DIVIDER", background: { path: IMG("slide-divider.png") },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 3.55, w: 9, h: 1.0, fontFace: HEAD, fontSize: 40, bold: true, color: K.white, valign: "top", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: M, y: 4.6, w: 8.2, h: 1.2, fontFace: BODY, fontSize: 16, color: "C8D0CD", valign: "top", align: "left", margin: 0 }, text: "" } },
    { text: { text: "kaspersky", options: { x: M, y: 6.75, w: 3, h: 0.4, fontFace: HEAD, fontSize: 14, bold: true, color: K.green, margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 6.8, w: 0.6, h: 0.35, fontFace: HEAD, fontSize: 11, color: "C8D0CD", align: "right" },
});
pres.defineSlideMaster({
  title: "K_CONTENT", background: { color: K.white },
  margin: [0.5, 0.6, 0.8, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: M, y: 0.32, w: CW, h: 0.8, fontFace: HEAD, fontSize: 30, bold: true, color: K.ink, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "kaspersky", options: { x: M, y: 6.98, w: 1.6, h: 0.32, fontFace: HEAD, fontSize: 13, bold: true, color: K.green, margin: 0, valign: "middle" } } },
    { text: { text: "Kaspersky AI Protect · 产品培训", options: { x: 2.2, y: 6.98, w: 6, h: 0.32, fontFace: HEAD, fontSize: 10, color: K.gray, margin: 0, valign: "middle" } } },
  ],
  slideNumber: { x: 12.13, y: 6.98, w: 0.6, h: 0.32, fontFace: HEAD, fontSize: 11, bold: true, color: K.green, align: "right" },
});

// ---------- 构件 ----------
let curSection = "";
const sec = (t) => { curSection = t; pres.addSection({ title: t }); };
const content = (title, notes) => {
  const s = pres.addSlide({ masterName: "K_CONTENT", sectionTitle: curSection });
  s.addText(title, { placeholder: "title" });
  if (notes) s.addNotes(notes);
  return s;
};
const T = (s, text, o) => s.addText(text, { isTextBox: true, fontFace: BODY, color: K.graph, fontSize: 15, valign: "top", margin: 0, ...o });
const rr = (s, x, y, w, h, fill, o = {}) => s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: fill }, line: { color: o.line || fill, width: o.lw || 0.75 }, rectRadius: o.r ?? 0.08, ...(o.name ? { objectName: o.name } : {}) });
const circle = (s, x, y, d, fill, label, color = K.white, fs = 14) => {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill } });
  s.addText(String(label), { isTextBox: true, x, y, w: d, h: d, align: "center", valign: "middle", fontFace: HEAD, fontSize: fs, bold: true, color, margin: 0 });
};
// 卡片：编号圆 + 标题 + 正文
const card = (s, x, y, w, h, { num, title, body, fill = K.panel, titleColor = K.ink, bodyColor = K.graph, bodySize = 14, titleSize = 17, dark = false } = {}) => {
  rr(s, x, y, w, h, dark ? K.ink : fill);
  let ty = y + 0.25;
  if (num !== undefined) { circle(s, x + 0.25, y + 0.25, 0.48, dark ? K.green : K.green, num); ty = y + 0.9; }
  if (title) T(s, title, { x: x + 0.25, y: ty, w: w - 0.5, h: 0.45, fontFace: HEAD, fontSize: titleSize, bold: true, color: dark ? K.white : titleColor, valign: "top" });
  if (body) T(s, body, { x: x + 0.25, y: ty + (title ? 0.5 : 0), w: w - 0.5, h: h - (ty - y) - (title ? 0.6 : 0.2), fontSize: bodySize, color: dark ? "D5DBD9" : bodyColor, paraSpaceAfter: 4 });
};
const bulletsTxt = (items, o = {}) => items.map((t, i) => {
  const parts = String(t).split(/(\*\*[^*]+\*\*)/).filter(Boolean);
  return parts.map((p, j) => ({ text: p.startsWith("**") ? p.slice(2, -2) : p,
    options: { bold: p.startsWith("**"), color: p.startsWith("**") ? K.ink : (o.color || K.graph),
      ...(j === 0 ? { bullet: o.num ? { type: "number", style: "arabicPeriod" } : { code: "25A0", indent: 18 }, paraSpaceAfter: o.space ?? 8 } : {}),
      ...(j === parts.length - 1 && i < items.length - 1 ? { breakLine: true } : {}) } }));
}).flat();
const bullets = (s, items, x, y, w, h, o = {}) => s.addText(bulletsTxt(items, o), { isTextBox: true, x, y, w, h, fontFace: BODY, fontSize: o.size || 15, valign: "top", margin: 0, color: K.graph });
const code = (s, lines, x, y, w, h, o = {}) => {
  rr(s, x, y, w, h, o.dark ? K.ink : K.panel);
  s.addText(lines.map((l, i) => ({ text: l || " ", options: { color: l.trim().startsWith("#") ? (o.dark ? "9AA5A1" : K.gray) : (o.dark ? "E6ECEA" : K.ink), ...(i < lines.length - 1 ? { breakLine: true } : {}) } })),
    { isTextBox: true, x: x + 0.2, y: y + 0.15, w: w - 0.4, h: h - 0.3, fontFace: MONO, fontSize: o.size || 12, valign: "top", margin: 0, lineSpacingMultiple: 1.05 });
};
const CALL = { tip: ["提示", K.greenD, K.greenL], warn: ["注意", K.amber, K.amberL], risk: ["重要", K.red, K.redL] };
const callout = (s, kind, text, x, y, w, h, size = 14) => {
  const [label, c, fill] = CALL[kind];
  rr(s, x, y, w, h, fill);
  s.addText([{ text: label + "   ", options: { bold: true, color: c, fontFace: HEAD } }, { text, options: { color: K.graph } }],
    { isTextBox: true, x: x + 0.25, y, w: w - 0.5, h, fontFace: BODY, fontSize: size, valign: "middle", margin: 0 });
};
// 表格：深色表头
const table = (s, headers, rows, x, y, w, colW, o = {}) => {
  const fs = o.size || 13;
  const head = headers.map((h) => ({ text: h, options: { bold: true, color: K.white, fill: { color: K.ink }, fontFace: HEAD, fontSize: fs } }));
  const body = rows.map((r, ri) => r.map((c, ci) => ({ text: c, options: { color: ci === 0 ? K.ink : K.graph, bold: ci === 0 && o.firstBold !== false,
    fill: { color: ri % 2 ? K.panel : K.white }, fontFace: ci === 0 && o.monoFirst ? MONO : BODY, fontSize: fs } })));
  s.addTable([head, ...body], { x, y, w, colW: colW.map((c) => (c / colW.reduce((a, b) => a + b, 0)) * w), margin: [0.06, 0.1, 0.06, 0.1],
    border: { type: "solid", pt: 0.75, color: K.line }, valign: "middle", rowH: o.rowH || 0.38, autoPage: false });
};
const img = (s, file, x, y, w, h, alt) => s.addImage({ path: IMG(file), x, y, w, h, altText: alt });

// 模块扉页
const divider = (no, title, lead, notes) => {
  sec(`${no} ${title}`);
  const s = pres.addSlide({ masterName: "K_DIVIDER", sectionTitle: curSection });
  s.addText(String(no).padStart(2, "0"), { isTextBox: true, x: M, y: 1.35, w: 3, h: 1.9, fontFace: HEAD, fontSize: 120, bold: true, color: K.green, margin: 0, valign: "bottom" });
  s.addText(title, { placeholder: "title" });
  s.addText(lead, { placeholder: "body" });
  s.addText(`MODULE ${String(no).padStart(2, "0")}`, { isTextBox: true, x: M, y: 0.6, w: 4, h: 0.4, fontFace: HEAD, fontSize: 13, bold: true, color: K.green, charSpacing: 4, margin: 0 });
  if (notes) s.addNotes(notes);
  return s;
};

// ======================= 封面 =======================
sec("封面");
{
  const s = pres.addSlide({ masterName: "K_COVER", sectionTitle: curSection });
  T(s, "kaspersky", { x: M, y: 0.6, w: 4, h: 0.6, fontFace: HEAD, fontSize: 28, bold: true, color: K.green });
  T(s, "PRODUCT TRAINING", { x: M, y: 2.05, w: 6, h: 0.4, fontFace: HEAD, fontSize: 14, bold: true, color: K.green, charSpacing: 6 });
  s.addText("Kaspersky AI Protect", { placeholder: "title" });
  s.addText("产品培训", { placeholder: "body" });
  T(s, "架构 · 安装 · 配置 · 运维 · 卸载 · 故障排查 · 实验", { x: M, y: 4.85, w: 8, h: 0.4, fontSize: 16, color: "C8D0CD" });
  T(s, [{ text: "KAIP 1.0.0 · Kaspersky Scan Engine 2.2", options: { breakLine: true } }, { text: "卡巴斯基售前团队 · 2026 年 11 月" }],
    { x: M, y: 6.2, w: 7, h: 0.75, fontSize: 13, color: "C8D0CD", paraSpaceAfter: 4 });
  s.addNotes("开场：介绍培训目标——学员结束后能独立完成 KAIP 的部署、配置、日常维护与排障，并能向客户讲清楚原理与边界。课程约 8.5 小时，含 2 小时实验。");
}

// ======================= 课程地图 =======================
{
  const s = content("课程地图", "按模块顺序授课。模块 1–2 讲原理，3–6 讲操作，7 讲排障，8 为动手实验。可根据学员背景压缩模块 1，或把实验穿插在对应模块之后。");
  const mods = [["01", "产品概述", "新风险、定位、能力与边界", "0.5 h"], ["02", "架构与原理", "组件、拦截流程、判定、防篡改、部署模式", "1 h"],
    ["03", "安装部署", "KSE、平台、分机、终端、容器、代理", "1.5 h"], ["04", "配置管理", "控制台、策略、参数、SIEM、凭据、集成", "1 h"],
    ["05", "运维与维护", "巡检、健康检查、升级、备份、日志", "1 h"], ["06", "卸载与清理", "终端、容器、代理、服务器", "0.5 h"],
    ["07", "故障排查", "排查路径与常见问题", "1 h"], ["08", "实验练习", "7 个课堂实验", "2 h"]];
  const w = 2.85, h = 2.45, g = 0.244;
  mods.forEach(([n, t, d, hr], i) => {
    const x = M + (i % 4) * (w + g), y = 1.45 + Math.floor(i / 4) * (h + 0.3);
    rr(s, x, y, w, h, i % 2 ? K.panel : K.greenL);
    T(s, n, { x: x + 0.25, y: y + 0.2, w: 1.2, h: 0.7, fontFace: HEAD, fontSize: 32, bold: true, color: K.green });
    T(s, hr, { x: x + w - 1.05, y: y + 0.3, w: 0.8, h: 0.4, fontFace: HEAD, fontSize: 13, bold: true, color: K.greenD, align: "right" });
    T(s, t, { x: x + 0.25, y: y + 0.95, w: w - 0.5, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
    T(s, d, { x: x + 0.25, y: y + 1.45, w: w - 0.5, h: 0.85, fontSize: 13 });
  });
}

// ======================= 1 产品概述 =======================
divider(1, "产品概述", "AI 编程助手正在获得与开发者相同的权限。KAIP 在 Agent 动手之前把关。",
  "本模块回答三个问题：AI Agent 带来了什么新风险？KAIP 是什么？它能做什么、不能做什么？");
{
  const s = content("AI Agent 带来的新风险", "Codex、WorkBuddy、OpenCode 以开发者本人账号运行，可执行命令、读写文件、访问网络、安装 Skill。开发者往往一键批准甚至开启自主模式。逐一举例：提示词诱导 curl|bash；Agent 用一行 Python 写入病毒；技能市场的带后门 Skill；含恶意 pickle 的模型；被诱导删除安全 hook。");
  const risks = [["恶意命令执行", "提示词或网页内容诱导 Agent 执行 curl | bash、反弹 shell"], ["恶意文件落盘", "经写文件工具、一行 Python、heredoc 写入病毒"],
    ["供应链投毒", "带后门的 Skill、恶意 pickle 模型、被篡改的数据集与 RAG 文档"], ["访问恶意网址", "按提示访问钓鱼或恶意 URL，下载载荷"],
    ["破坏安全组件", "删除安全 hook、停止监控进程、读取安全组件凭据"]];
  const w = 2.27, g = 0.2;
  risks.forEach(([t, d], i) => card(s, M + i * (w + g), 1.45, w, 3.35, { num: i + 1, title: t, body: d, titleSize: 16, bodySize: 14 }));
  rr(s, M, 5.15, CW, 1.35, K.ink);
  T(s, [{ text: "传统终端杀毒", options: { bold: true, color: K.green } }, { text: "在文件落盘或进程启动后才介入，看不到「Agent 正准备做什么」，也不了解 Skill、模型、RAG 这些 AI 场景特有的入口。", options: { color: K.white } }],
    { x: M + 0.35, y: 5.15, w: CW - 0.7, h: 1.35, fontSize: 17, valign: "middle" });
}
{
  const s = content("产品定位与核心能力", "一句话定位：基于 KSE 的 AI 场景安全平台，在 Agent 每次工具调用之前、以及模型/Skill/文档进入企业之前判定，恶意即阻断。三类能力对应三个价值：运行时、供应链、可运营。");
  rr(s, M, 1.4, CW, 1.25, K.greenL);
  T(s, [{ text: "KAIP", options: { bold: true, color: K.greenD } }, { text: " 是基于 Kaspersky Scan Engine 的 AI 场景安全平台：在 AI Agent 执行每一次工具调用之前，以及模型、Skill、文档进入企业之前，用卡巴斯基引擎与 AI 场景规则做判定，恶意即阻断。" }],
    { x: M + 0.35, y: 1.4, w: CW - 0.7, h: 1.25, fontSize: 18, valign: "middle", color: K.ink });
  const caps = [["AI Agent 运行时防护", "执行命令、写/改文件、运行代码、访问 URL、调用 Skill 前拦截。文件经 KSE 扫描，命令经 KAIP 规则分析，URL 经信誉检查。", "终端 hook / 插件 · 平台 · KSE"],
    ["AI 供应链入口扫描", "模型、Skill 包、RAG 文档、训练数据集上传或代下载时扫描，通过才放行入库；下载代理经 ICAP 扫描下载内容。", "供应链网关 · Squid + KSE ICAP"],
    ["自我保护与可运营", "阻止 Agent 篡改 KAIP，被改动后自动修复；Agent 升级后自动复核；事件集中展示并转发 SIEM。", "kaip-watch · 事件 · SIEM 转发"]];
  const w = 3.9, g = 0.217;
  caps.forEach(([t, d, c], i) => {
    const x = M + i * (w + g);
    card(s, x, 2.95, w, 3.65, { num: i + 1, title: t, body: d, bodySize: 14 });
    T(s, c, { x: x + 0.25, y: 6.0, w: w - 0.5, h: 0.4, fontSize: 12, bold: true, color: K.greenD });
  });
}
{
  const s = content("支持范围", "强调：终端无需预装 Node.js，一键安装会从平台下载私有运行时；不支持 Windows 7；容器需 glibc 基础镜像（Alpine 不适用私有运行时）。服务器 Python 低于 3.10 时离线包自带便携 Python。");
  table(s, ["类别", "支持情况"], [
    ["AI Agent", "Codex（桌面版 / CLI）· WorkBuddy / CodeBuddy · OpenCode 1.x / 2.x（含容器化 OpenCode）"],
    ["终端系统", "Windows 10 / 11 · 主流 Linux 发行版 · Docker 容器（glibc 基础镜像）。不支持 Windows 7"],
    ["终端依赖", "Node.js 18+；没有时一键安装从平台下载私有运行时，不影响系统环境"],
    ["服务器", "x86_64：Ubuntu 20.04 / 22.04 / 24.04、Debian 11 / 12、CentOS 7+ / RHEL 8+"],
    ["Python", "3.10–3.12 直接使用；更低版本自动使用离线包自带的便携 Python 3.12"],
    ["扫描引擎", "Kaspersky Scan Engine 2.2：HTTP 模式供平台调用，ICAP 模式供下载代理调用；需有效许可证"],
  ], M, 1.45, CW, [2, 10], { size: 15, rowH: 0.72 });
}
{
  const s = content("能力边界：必须向客户如实说明", "讲解时用「执行前拦截 + 事后监控 + 终端杀毒」三层互补来说明，避免客户把 KAIP 理解为 EDR 的替代品。PoC 启动会与总结汇报都要讲到这五条。");
  const items = [["只拦截经过 Agent 工具调用的操作", "用户手工执行的操作由目录监控（事后）与终端杀毒覆盖"],
    ["KAIP 规则是静态特征", "最终判定以 KSE 为准；刻意编码、分段写入的载荷需落盘扫描补位"],
    ["防篡改运行在用户态", "能阻断经 Agent 的篡改并事后修复，无法抵御同账号人工操作或 root 恶意进程"],
    ["语义层攻击不在范围内", "提示词注入等不属于文件与代码扫描"],
    ["Agent 升级可能改变接口", "KAIP 自测、提醒复核、发现静默失效；新工具需人工评估后补充规则"]];
  items.forEach(([t, d], i) => {
    const y = 1.45 + i * 1.02;
    circle(s, M, y + 0.12, 0.6, i % 2 ? K.greenD : K.green, i + 1, K.white, 16);
    T(s, t, { x: M + 0.9, y: y + 0.02, w: 11, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
    T(s, d, { x: M + 0.9, y: y + 0.47, w: 11, h: 0.4, fontSize: 15 });
  });
}

// ======================= 2 架构 =======================
divider(2, "架构与原理", "从一次被拦截的工具调用出发，讲清楚判定是怎么做出的。", "本模块是后面安装、配置、排障的基础，建议边画图边讲。");
{
  const s = content("组件", "六个组件：KSE（引擎）、平台（判定与管理）、hook/插件（截获）、kaip-watch（监控与自愈）、kaip 命令行（运维）、Squid（可选的下载代理）。强调终端只与平台通信，不直连 KSE。");
  const cs = [["Kaspersky Scan Engine", "Linux 服务器", "病毒库、启发式、KSN 云信誉、URL 信誉、LLM 模型扫描。HTTP 1234 供平台，ICAP 1344 供代理"],
    ["KAIP 平台", "与 KSE 同机或分机；服务或容器", "判定 API、供应链网关、缓存、规则、策略、隔离区、事件、SIEM、控制台、客户端分发"],
    ["KAIP hook / 插件", "写入各 Agent 配置", "工具调用前截获命令、文件内容、URL，送平台判定并执行结果；本地防篡改规则"],
    ["kaip-watch", "终端后台进程", "监控 Skill / 插件 / 模型目录；60 秒心跳与完整性校验；自动修复与升级"],
    ["kaip 命令行", "开发终端", "注册、安装 / 卸载、verify、selftest、scan、sync"],
    ["Squid 下载代理（可选）", "推荐与 KSE 同机", "解密 HTTPS 后经 ICAP 交给 KSE 扫描，检出即返回拦截页"]];
  const w = 3.9, h = 2.45, g = 0.217;
  cs.forEach(([t, loc, d], i) => {
    const x = M + (i % 3) * (w + g), y = 1.4 + Math.floor(i / 3) * (h + 0.25);
    rr(s, x, y, w, h, i === 1 ? K.ink : (i === 0 ? K.green : K.panel));
    const dark = i <= 1;
    T(s, t, { x: x + 0.25, y: y + 0.22, w: w - 0.5, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: dark ? K.white : K.ink });
    T(s, loc, { x: x + 0.25, y: y + 0.68, w: w - 0.5, h: 0.35, fontSize: 12, bold: true, color: dark ? "CDEFE8" : K.greenD });
    T(s, d, { x: x + 0.25, y: y + 1.08, w: w - 0.5, h: h - 1.2, fontSize: 13.5, color: dark ? "E6ECEA" : K.graph });
  });
}
{
  const s = content("总体架构", "沿箭头讲：终端 hook → 平台 → KSE；业务系统经 API Key 调用供应链网关；终端下载可选经 Squid → ICAP → KSE，拦截事件经 Syslog 5514 回到平台；平台向 SIEM 转发 CEF。");
  img(s, "arch.png", M, 1.3, 8.9, 5.34, "KAIP 总体架构图");
  const pts = [["终端", "hook / 插件在工具调用前截获，kaip-watch 负责监控与自愈"], ["平台", "名单、缓存、KSE、规则依次判定，按策略处置并记录事件"], ["KSE", "只对平台开放；ICAP 供下载代理使用"]];
  pts.forEach(([t, d], i) => card(s, 9.75, 1.3 + i * 1.82, 2.98, 1.65, { title: t, body: d, fill: i === 1 ? K.greenL : K.panel, titleSize: 16, bodySize: 13 }));
}
{
  const s = content("一次拦截的全过程", "五步：截获 → 送检 → 判定 → 决策 → 执行。送检时不超过 50 MB 的文件随请求提交，超过的交给 kaip-watch 异步扫描。判定顺序：哈希名单 → 判定缓存 → KSE → KAIP 规则；URL 交 KSE 做信誉检查。Agent 收到阻断后放弃本次调用，并转述拦截原因。");
  img(s, "flow.png", M, 1.3, CW, CW * 430 / 1000, "工具调用的判定流程与默认处置");
}
{
  const s = content("判定结果与处置", "重点讲 RISK 与 ERROR。RISK：KAIP 规则命中，高危阻断、中危告警，后台监控发现的只告警，从不自动隔离。ERROR：KSE 不可用，默认放行，但规则命中仍按 RISK 阻断——所以 KSE 故障期间 curl|bash 仍会被拦，病毒文件不会。");
  table(s, ["判定", "含义", "默认处置", "可调策略"], [
    ["CLEAN", "引擎与规则均未发现问题", "放行", "—"],
    ["DETECT", "KSE 检出恶意代码、恶意或钓鱼 URL；或命中哈希黑名单", "阻断；文件写入隔离区", "防护模式、检出后隔离"],
    ["RISK", "KSE 判定干净，但 KAIP 规则命中", "高危阻断、中危告警；从不自动隔离", "KAIP 补充规则命中"],
    ["NON_SCANNED", "加密、损坏等原因无法扫描", "按未放行处理", "无法扫描（加密 / 损坏）"],
    ["ERROR", "KSE 不可用或扫描出错", "放行；规则命中仍阻断", "平台不可达时"],
  ], M, 1.45, CW, [1.7, 4, 3.2, 2.6], { size: 14, rowH: 0.62 });
  callout(s, "risk", "fail_open 让 KSE 故障时不影响开发，但这段时间病毒文件与恶意 URL 不会被拦截。运维须监控 ERROR 事件与 KSE 状态。", M, 5.55, CW, 0.95);
}
{
  const s = content("三个关键数字", "25 MB：scanmemory 与 scanfile 的分界，分机部署时大文件经 NFS 由 KSE 按路径扫描。7 天：判定缓存按 SHA-256 复用，病毒库更新立即失效，最长 7 天。60 秒：心跳、策略下发、完整性校验的周期。");
  const st = [["25 MB", "大文件扫描方式", "小于 25 MB 以内存方式提交 KSE；以上写入扫描目录，由 KSE 按路径扫描，避免编码膨胀"],
    ["7 天", "判定缓存", "同一文件（SHA-256）在病毒库不变时复用结果；病毒库更新立即失效，最长 7 天"],
    ["60 秒", "心跳周期", "终端每 60 秒心跳：同步策略、上报状态、校验完整性；约 10 分钟无心跳显示离线"]];
  const w = 3.9, g = 0.217;
  st.forEach(([n, t, d], i) => {
    const x = M + i * (w + g);
    rr(s, x, 1.45, w, 5.0, i === 1 ? K.ink : K.panel);
    T(s, n, { x: x + 0.3, y: 1.75, w: w - 0.6, h: 1.3, fontFace: HEAD, fontSize: 60, bold: true, color: K.green });
    T(s, t, { x: x + 0.3, y: 3.15, w: w - 0.6, h: 0.5, fontFace: HEAD, fontSize: 20, bold: true, color: i === 1 ? K.white : K.ink });
    T(s, d, { x: x + 0.3, y: 3.75, w: w - 0.6, h: 2.4, fontSize: 15, color: i === 1 ? "D5DBD9" : K.graph });
  });
}
{
  const s = content("防篡改与自愈", "执行前：Agent 删除 hook、关闭 hooks、停止或卸载 KAIP、读取凭据都会被本地规则阻断，上报 KAIP:Tamper.*。事后：kaip-watch 把客户端指纹、策略指纹、hook 状态报给平台，不一致即从平台恢复。平台发布新客户端后旧指纹被识别为历史官方版本，终端自动升级。");
  img(s, "heal.png", M, 1.3, CW, CW * 250 / 1000, "防篡改与自愈流程");
  const cs = [["执行前阻断", "删除 hook、停止监控、读取凭据等操作被本地规则阻断，上报 KAIP:Tamper.*"],
    ["事后修复", "指纹与平台官方版本不一致时，从平台恢复客户端、hook 与策略"],
    ["自动升级与复核", "平台发布新版后终端自动升级；Agent 升级后显示「升级待复核」"]];
  const w = 3.9, g = 0.217;
  cs.forEach(([t, d], i) => card(s, M + i * (w + g), 4.5, w, 1.45, { title: t, body: d, titleSize: 16, bodySize: 13 }));
  callout(s, "warn", "自愈以平台上的官方客户端为准：只在终端替换客户端文件会被当作篡改并恢复，升级必须从平台侧进行。", M, 6.1, CW, 0.6, 13);
}
{
  const s = content("三种部署模式", "A 同机：最简单，PoC 推荐。B 分机：KSE 已有独立服务器时，平台扫描目录经 NFS 只读共享给 KSE，挂载必须用 soft。C 容器：平台容器 host 网络、UID 10001、数据在 kaip-data 卷，KSE 仍原生安装，可与 A/B 组合。");
  img(s, "deploy.png", M + 0.4, 1.3, CW - 0.8, (CW - 0.8) * 400 / 1000, "三种部署模式");
}
{
  const s = content("端口与网络", "提醒：终端到平台生产环境必须 HTTPS；KSE 1234 只对平台开放；ICAP 1344 只放行本机；KSE 访问卡巴斯基更新源与 KSN 时 HTTPS 解密设备要豁免。");
  table(s, ["方向", "端口", "用途"], [
    ["终端 → 平台", "443（Nginx）/ 8080", "判定、心跳、客户端与运行时下载；生产必须 HTTPS"],
    ["业务系统 / CI → 平台", "443 / 8080", "供应链扫描网关（API Key）"],
    ["平台 → KSE", "1234", "HTTP 模式扫描；同机为 127.0.0.1"],
    ["KSE → 平台", "TCP 2049（NFSv4）", "仅分机部署：读取平台扫描目录"],
    ["KSE → 平台", "UDP 5514", "KSE（含 ICAP）日志汇入平台"],
    ["终端 → 下载代理", "3128", "仅启用下载代理时"],
    ["Squid → KSE", "127.0.0.1:1344", "ICAP；防火墙只放行本机"],
    ["KSE → 卡巴斯基", "TCP 80 / 443", "病毒库更新、KSN、激活"],
    ["平台 → SIEM", "UDP / TCP 514", "CEF / JSON 事件转发"],
  ], M, 1.4, CW, [3, 3, 6], { size: 14, rowH: 0.52 });
}

// ======================= 3 安装 =======================
divider(3, "安装部署", "先服务端、后终端。客户内网通常无法访问互联网，优先使用离线安装包。", "本模块按实际部署顺序讲，建议配合实验 1、2。");
{
  const s = content("安装路线", "按顺序：规划 → KSE → 平台 → 分机共享（可选）→ 终端与容器接入 → 下载代理（可选）→ 验收。每一步都有可验证的结果，前一步不通过不要进入下一步。");
  const st = [["规划", "服务器、网络、许可证、终端与 Agent"], ["KSE", "安装、更新病毒库、TCP 监听、防钓鱼"], ["平台", "离线包或 Docker compose"],
    ["分机共享", "可选：NFS 只读共享扫描目录"], ["终端接入", "一键安装；容器用 compose 片段"], ["下载代理", "可选：Squid + ICAP"], ["验收", "PoC 自检 8/8；kaip verify"]];
  const n = st.length, w = CW / n;
  s.addShape(pres.shapes.LINE, { x: M + w / 2, y: 2.35, w: CW - w, h: 0, line: { color: K.line, width: 2 } });
  st.forEach(([t, d], i) => {
    const cx = M + i * w + w / 2;
    circle(s, cx - 0.4, 1.95, 0.8, i === n - 1 ? K.ink : K.green, i + 1, K.white, 20);
    T(s, t, { x: cx - w / 2 + 0.05, y: 3.0, w: w - 0.1, h: 0.45, fontFace: HEAD, fontSize: 17, bold: true, color: K.ink, align: "center" });
    T(s, d, { x: cx - w / 2 + 0.12, y: 3.5, w: w - 0.24, h: 1.3, fontSize: 13, align: "center" });
  });
  table(s, ["离线包目录", "内容"], [["install-offline.sh", "平台离线安装 / 升级脚本"], ["server/ · client/", "平台与终端客户端"], ["wheels/ · python/ · runtime/", "Python 依赖、便携 Python、终端私有 Node.js"], ["images/ · deploy/", "平台镜像；compose、分机共享、Squid、Nginx、容器接入"]],
    M, 4.85, CW, [3.2, 8.9], { size: 13, rowH: 0.36, monoFirst: true });
}
{
  const s = content("安装与配置 KSE", "第 3 步最常出问题：KSE 默认监听本地 socket，不改为 TCP 平台会报 Connection refused。防钓鱼不开则钓鱼 URL 检不出。KL_SCAN_LLM 用于模型文件深度扫描。");
  bullets(s, ["以 HTTP + ICAP（Multi）模式安装并激活许可证，确认 kavhttpd、kavicapd、klScanEngineUI 均为 active",
    "**立即手动更新一次病毒库**，确认病毒库日期为近期",
    "**Settings → Service**：监听 127.0.0.1:1234；允许扫描的目录添加 /opt/kaspersky/scanqueue",
    "**Settings → Scanning**：开启 Enable Phishing Protection 与 reputation checking",
    "ppl/kave.ini 的 [Environment] 加入 KL_SCAN_LLM=1，重启 kavhttpd 与 kavicapd"], M, 1.45, 6.9, 3.6, { num: true, size: 16, space: 12 });
  code(s, ["# 更新病毒库并确认日期", "curl -s -X POST http://127.0.0.1:1234/api/v3.0/update/start", "curl -s http://127.0.0.1:1234/api/v3.0/basesdate"], M, 5.15, 6.9, 1.3, { size: 12 });
  callout(s, "warn", "KSE 默认通过本地 socket 监听。不改为 TCP 地址，平台会报「无法连接 KSE: Connection refused」。", 7.8, 1.45, 4.93, 2.3, 16);
  callout(s, "tip", "判断 KSN 是否可用，看 KSE 能否检出官方测试 URL，不要用 curl 测 KSN 域名。", 7.8, 4.05, 4.93, 2.4, 16);
}
{
  const s = content("安装 KAIP 平台", "离线包：重复执行即升级或修复，保留配置与数据；系统 Python 过低时自动用便携 Python。Docker：host 网络、非 root；扫描目录需对 UID 10001 可写。首次登录后立即修改 admin 密码，初始密码文件随即删除。");
  const w = (CW - 0.3) / 2;
  T(s, "方式一  离线安装包（推荐）", { x: M, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["tar -xzf kaip-offline-1.0.0-<日期>.tar.gz", "cd kaip-offline-1.0.0-<日期>", "sudo bash install-offline.sh", "curl -s http://127.0.0.1:8080/healthz"], M, 1.95, w, 1.55);
  bullets(s, ["systemd 服务 kaip-platform，服务账号 kaip", "配置 /etc/kaip/kaip.env，重复执行即升级", "可选 --port、--kse-url、--kse-share、--mock"], M, 3.7, w, 1.6, { size: 14 });
  const x2 = M + w + 0.3;
  T(s, "方式二  Docker compose", { x: x2, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["docker load -i images/kaip-platform-image-1.0.0.tar.gz", "cd deploy && cp compose.env.example .env", "sudo install -d -o 10001 -g 10001 -m 0775 \\", "     /opt/kaspersky/scanqueue", "docker compose up -d && docker compose ps"], x2, 1.95, w, 1.85);
  bullets(s, ["host 网络，以 UID 10001 运行，带健康检查", "数据在 kaip-data 卷，重建与升级后保留"], x2, 4.0, w, 1.2, { size: 14 });
  callout(s, "risk", "首次登录（admin）后立即修改密码。初始密码在 /var/lib/kaip/initial_admin_password.txt，修改后自动删除。", M, 5.55, CW, 0.9);
}
{
  const s = content("KSE 分机部署", "scanfile 只能扫 KSE 本机文件，所以分机时把平台扫描目录经 NFS 只读共享给 KSE。挂载必须 soft：实测平台服务器离线时 hard 挂载让 kavhttpd 卡死、不再监听 1234，所有扫描 ERROR 并被 fail_open 放行。");
  bullets(s, ["**平台服务器**共享扫描目录（只读、只允许 KSE 主机）", "**KSE 服务器**挂载到 /mnt/kaip-scanqueue（写入 fstab）", "**KSE 控制台**监听平台可访问的地址，允许扫描的目录加入挂载点", "**平台**设置 KAIP_KSE_URL 与 KAIP_KSE_SCAN_DIR_REMOTE 后重启"], M, 1.45, 6.4, 3.0, { num: true, size: 15, space: 12 });
  code(s, ["# 平台服务器", "sudo bash deploy/kse-share.sh kaip-host <KSE IP>", "", "# KSE 服务器", "sudo bash kse-share.sh kse-host <平台 IP>"], 7.3, 1.45, 5.43, 2.3);
  callout(s, "risk", "挂载参数必须是 soft,timeo=50,retrans=2（脚本默认）。用 hard 时，平台服务器离线会让 KSE 的 kavhttpd 卡死、不再监听 1234，所有扫描失败。", M, 4.75, CW, 1.2, 15);
}
{
  const s = content("接入开发终端", "一键安装自动识别本机 Agent、注册、写入 hook / 插件、安装 kaip-watch，没有 Node.js 时自动下载私有运行时。三个 Agent 各有必做步骤，最常见的「不生效」就是漏了这一步。请使用默认安装（含后台监控）。");
  code(s, ["# Linux", "curl -fsSL https://<平台>/dl/install.sh | bash -s -- --server https://<平台> --token <注册令牌>", "# Windows（cmd）：在控制台「接入部署」页复制完整命令"], M, 1.4, CW, 1.25);
  const ag = [["Codex", "在终端运行一次 codex，在「Hooks need review」中信任 KAIP hook（桌面版不弹提示）"], ["WorkBuddy / CodeBuddy", "从托盘图标完全退出后重新打开；只关窗口不会加载新配置"], ["OpenCode 1.x / 2.x", "重启 OpenCode；2.x 还要结束后台常驻的 opencode-cli 进程"]];
  const w = 3.9, g = 0.217;
  ag.forEach(([t, d], i) => card(s, M + i * (w + g), 2.95, w, 2.5, { num: i + 1, title: t, body: d, bodySize: 14 }));
  callout(s, "tip", "每个 Agent 完成后执行 kaip verify，必须看到「✔ 生效」及版本号。", M, 5.75, CW, 0.75);
}
{
  const s = content("容器中的 OpenCode：compose 接入", "客户用 compose 运行自己的 OpenCode 镜像时，不换镜像、不重建：加入入口脚本、平台地址、令牌 secret、客户端只读挂载与 kaip-state 卷。command 必须是原镜像的 ENTRYPOINT + CMD。实测重启、重建后自动恢复且无需重新注册，令牌不出现在 docker inspect。");
  code(s, ["services:", "  opencode:                     # 客户 compose 中的服务名", "    entrypoint: [\"/opt/kaip-client/scripts/container-entrypoint.sh\"]", "    command: [\"opencode\"]", "    environment:", "      KAIP_SERVER: http://<平台>:8080", "      KAIP_HOME: /root/.kaip",
    "    secrets: [kaip_enroll_token]", "    volumes:", "      - /opt/kaip-client:/opt/kaip-client:ro", "      - kaip-state:/root/.kaip", "secrets:", "  kaip_enroll_token:", "    file: ./kaip_enroll_token.txt"], M, 1.4, 7.1, 5.2, { size: 11.5, dark: true });
  bullets(s, ["**不换、不重建**客户镜像，配置片段在 deploy/opencode-container/", "每次启动：注册（仅首次）→ 安装插件 → 后台监控 → 执行原命令", "令牌以 **compose secrets 文件**挂载，不进入环境变量与 docker inspect", "restart、down/up 重建后**自动恢复**，无需重新注册", "要求平台为 **20261117 或更新**版本"], 8.0, 1.45, 4.73, 5.0, { size: 15, space: 12 });
}
{
  const s = content("下载代理：Squid + KSE ICAP（可选）", "Squid 装在 KSE 服务器，ICAP 走 127.0.0.1:1344。Ubuntu 20.04 官方源的 squid 不能解密 HTTPS。ICAP 拦截事件要在 KSE 控制台为 ICAP 模式配置 Syslog 并勾选扫描结果事件。NO_PROXY 必须包含平台地址。");
  code(s, ["# KSE 服务器", "sudo bash deploy/squid/install-squid.sh --kaip-syslog <平台 IP>", "", "# Linux 终端", "bash client-proxy.sh http://<代理>:3128 kaip-proxy-ca.crt <平台 IP>", "", "# Windows 终端（WorkBuddy 等需加 -SystemProxy）", "powershell -File client-proxy.ps1 -Proxy http://<代理>:3128 \\", "  -Ca kaip-proxy-ca.crt -NoProxy \"<平台 IP>\" -SystemProxy"], M, 1.4, 7.0, 3.7, { size: 12 });
  bullets(s, ["需要支持 OpenSSL 的 Squid（Ubuntu 22.04+ / Debian 12 / RHEL 8+）", "不解密：卡巴斯基、Windows Update、Apple", "KSE 控制台为 ICAP 配置 Syslog，勾选扫描结果事件", "NO_PROXY 必须包含平台地址"], 7.9, 1.45, 4.83, 3.7, { size: 14, space: 12 });
  callout(s, "warn", "KSE 与 KSN 断开或重连期间，ICAP 扫描可能超时并原样放行。保证 KSN 网络稳定；完全隔离的网络设置 UseKSN=0。", M, 5.4, CW, 1.0);
}
{
  const s = content("安装验收", "六项全部满足才算部署完成。PoC 自检 8/8 包括干净文件、EICAR、模型、Skill、数据集、恶意 URL、钓鱼 URL。钓鱼 URL 失败几乎都是 KSE 防钓鱼没开。");
  const ck = [["healthz", "status 为 ok，engine 为 kse"], ["安全概览", "KSE 在线、病毒库为近期、许可证有效"], ["PoC 自检", "8/8 通过"], ["kaip verify", "每个 Agent「✔ 生效」并显示版本"], ["selftest / test", "全部通过；EICAR 与高危命令被阻断"], ["终端与 Agent", "终端在线，Agent 状态为生效"]];
  const w = 3.9, h = 2.3, g = 0.217;
  ck.forEach(([t, d], i) => {
    const x = M + (i % 3) * (w + g), y = 1.45 + Math.floor(i / 3) * (h + 0.3);
    rr(s, x, y, w, h, i % 2 ? K.panel : K.greenL);
    circle(s, x + 0.3, y + 0.3, 0.55, K.green, "✓", K.white, 18);
    T(s, t, { x: x + 0.3, y: y + 1.0, w: w - 0.6, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
    T(s, d, { x: x + 0.3, y: y + 1.48, w: w - 0.6, h: 0.7, fontSize: 14 });
  });
}

// ======================= 4 配置 =======================
divider(4, "配置管理", "大多数配置在控制台完成并实时下发终端；少数平台级参数在配置文件中，修改后需重启。", "本模块配合实验 4（策略调整）。");
{
  const s = content("管理控制台", "带学员逐页走一遍控制台。安全概览里的「扫描引擎状态」是日常巡检的第一眼；事件日志可按判定筛选 ERROR；接入部署页给出带令牌的一键命令。");
  const pg = [["安全概览", "终端、检出与阻断统计、扫描引擎状态"], ["事件日志", "全部判定与告警，可筛选、导出"], ["终端与 Agent", "在线状态、版本、防护状态；吊销"], ["供应链扫描", "上传扫描、安全代下载、CI 集成示例"], ["隔离区", "隔离文件的放行与删除；放行区"], ["防护策略", "模式、处置、拦截点、名单、受信任目录"], ["接入部署", "注册令牌与一键安装命令"], ["PoC 自检", "一键执行 8 个标准用例"], ["系统设置", "引擎、凭据、SIEM 转发、RAG 对接"]];
  const w = 3.9, h = 1.5, g = 0.217;
  pg.forEach(([t, d], i) => {
    const x = M + (i % 3) * (w + g), y = 1.4 + Math.floor(i / 3) * (h + 0.22);
    rr(s, x, y, w, h, i === 0 ? K.ink : K.panel);
    T(s, t, { x: x + 0.3, y: y + 0.22, w: w - 0.6, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: i === 0 ? K.white : K.ink });
    T(s, d, { x: x + 0.3, y: y + 0.72, w: w - 0.6, h: 0.65, fontSize: 14, color: i === 0 ? "D5DBD9" : K.graph });
  });
}
{
  const s = content("防护策略：处置规则", "策略保存后终端在 60 秒内生效。「平台不可达时」决定 KSE 故障时的行为：放行有防护空窗，阻断会影响开发，按客户安全要求取舍。");
  table(s, ["策略项", "选项（默认）", "说明与建议"], [
    ["防护模式", "阻断 / 审计（阻断）", "审计只告警不阻断，用于误报评估期"],
    ["平台不可达时", "放行 / 阻断（放行）", "放行不影响开发，但有防护空窗；高安全环境选阻断"],
    ["无法扫描（加密 / 损坏）", "按未放行处理", "建议保持"],
    ["KAIP 补充规则命中", "阻断 / 告警 / 关闭（阻断）", "curl | bash、反弹 shell、危险 pickle 等"],
    ["Agent 安装 / 下载命令", "允许并事后扫描", "npm i、pip install、git clone 后立即扫描新文件"],
    ["检出后隔离", "开启", "DETECT 的文件移入隔离区"],
    ["自我保护 / 自动修复", "开启", "阻止 Agent 篡改；被改动后自动恢复"],
  ], M, 1.4, CW, [3, 3.2, 5.9], { size: 14, rowH: 0.6 });
}
{
  const s = content("防护策略：拦截点与名单", "拦截点决定哪些动作会送检。写入/编辑文件前扫描是防「Agent 写入病毒」的关键。受信任来源目录内的文件仍经 KSE 扫描，只是 KAIP 规则命中降为告警。");
  table(s, ["策略项", "默认", "说明"], [
    ["写入 / 编辑文件前扫描", "开启", "防止 Agent 写入病毒文件"],
    ["执行命令前扫描脚本 / 模型", "开启", "执行脚本、加载模型前扫描"],
    ["会话启动时扫描 Skills", "开启", "Agent 会话开始时扫描已安装的 Skill"],
    ["URL 信誉检查", "开启", "需 KSE 开启 KSN 与防钓鱼"],
    ["Hook 内联扫描上限", "50 MB", "超过的文件交给 kaip-watch 异步扫描"],
    ["哈希白名单", "空", "按 SHA-256 放行确认无害的文件"],
    ["安装来源黑 / 白名单", "空", "按 URL 子串禁止或放行安装来源"],
    ["受信任来源目录", "官方插件目录", "规则命中只告警；KSE 检出仍阻断"],
    ["已确认的工具", "空", "评估过的 Agent 新工具，不再提醒"],
  ], M, 1.4, CW, [3.6, 2.2, 6.3], { size: 14, rowH: 0.52 });
}
{
  const s = content("分阶段推荐配置", "试运行用审计模式 1–2 周收集误报，用最小范围的方法处理：单个文件用哈希白名单，整个官方来源用受信任来源目录。不要为了消除误报关闭规则或长期停留在审计模式。");
  const ph = [["PoC / 演示", "阻断模式", "其余保持默认，展示完整拦截效果"], ["试运行", "审计模式 1–2 周", "收集事件，评估误报，逐条处理"], ["生产", "阻断模式", "按要求决定「平台不可达时」；开启 SIEM；HTTPS"]];
  const w = 3.9, g = 0.217;
  ph.forEach(([t, m, d], i) => {
    const x = M + i * (w + g);
    rr(s, x, 1.45, w, 3.3, i === 2 ? K.ink : K.panel);
    T(s, t, { x: x + 0.3, y: 1.7, w: w - 0.6, h: 0.5, fontFace: HEAD, fontSize: 20, bold: true, color: i === 2 ? K.white : K.ink });
    T(s, m, { x: x + 0.3, y: 2.3, w: w - 0.6, h: 0.6, fontFace: HEAD, fontSize: 24, bold: true, color: K.green });
    T(s, d, { x: x + 0.3, y: 3.05, w: w - 0.6, h: 1.5, fontSize: 15, color: i === 2 ? "D5DBD9" : K.graph });
  });
  callout(s, "tip", "误报处理：单个文件用哈希白名单；整个官方来源用受信任来源目录。不要为消除误报关闭「KAIP 补充规则命中」。", M, 5.1, CW, 1.0, 15);
}
{
  const s = content("平台参数（/etc/kaip/kaip.env）", "修改后 systemctl restart kaip-platform；Docker 方式改 deploy/.env 与 kaip.env 后 docker compose up -d。最常改的是 KSE 地址与分机挂载点。");
  table(s, ["参数", "默认值", "说明"], [
    ["KAIP_KSE_MODE", "kse", "mock 为模拟引擎（仅演示）"],
    ["KAIP_KSE_URL", "http://127.0.0.1:1234", "分机为 http://<KSE IP>:1234"],
    ["KAIP_KSE_TIMEOUT_MS", "600000", "单次扫描超时（大模型文件）"],
    ["KAIP_KSE_SCAN_DIR", "/opt/kaspersky/scanqueue", "大文件扫描目录（平台侧）"],
    ["KAIP_KSE_SCAN_DIR_REMOTE", "空", "分机时 KSE 主机上的挂载点"],
    ["KAIP_KSE_SCANFILE_THRESHOLD", "26214400", "≥25 MB 走 scanfile；0 = 全部 scanmemory"],
    ["KAIP_MAX_UPLOAD_MB", "20480", "供应链上传大小上限"],
    ["KAIP_SYSLOG_PORT", "5514", "接收 KSE（含 ICAP）Syslog"],
    ["KAIP_DATA_DIR", "/var/lib/kaip", "数据目录"],
  ], M, 1.4, CW, [4.2, 3.6, 4.3], { size: 13.5, rowH: 0.5, monoFirst: true });
}
{
  const s = content("SIEM、凭据与业务集成", "SIEM：系统设置中启用，CEF 或 JSON，可仅转发告警，保存后用测试按钮验证。凭据：注册令牌与供应链 API Key 可轮换；令牌轮换不影响已注册终端。CI 集成：X-API-Key 调用 supply/upload，仅 action=allow 时入库。");
  const cs = [["SIEM 转发", "系统设置 → SIEM / Syslog：服务器、端口、UDP / TCP、CEF / JSON，可仅转发告警；用「测试」验证"],
    ["凭据管理", "注册令牌与供应链 API Key 在「系统设置 → 凭据」轮换；只分发给实施人员；容器用 secrets 文件"],
    ["RAG 对接", "配置 AnythingLLM 或 Webhook 后，forward_rag=true 的文档扫描通过即自动入库"]];
  const w = 3.9, g = 0.217;
  cs.forEach(([t, d], i) => card(s, M + i * (w + g), 1.4, w, 2.55, { num: i + 1, title: t, body: d, bodySize: 14 }));
  T(s, "业务系统 / CI：仅当返回 action=allow 时入库", { x: M, y: 4.2, w: CW, h: 0.4, fontFace: HEAD, fontSize: 16, bold: true, color: K.ink });
  code(s, ["curl -sk -H \"X-API-Key: <API_KEY>\" -F category=model -F file=@./model.pt https://<平台>/api/v1/supply/upload", "curl -sk -H \"X-API-Key: <API_KEY>\" -F category=rag -F forward_rag=true -F file=@./doc.pdf https://<平台>/api/v1/supply/upload"], M, 4.7, CW, 1.1, { size: 12 });
}

// ======================= 5 运维 =======================
divider(5, "运维与维护", "防护效果依赖 KSE 在线、病毒库及时、终端心跳正常。", "本模块给出日常巡检、升级、备份与日志的标准做法。");
{
  const s = content("巡检清单", "每日两件事最重要：KSE 在线与 ERROR 事件。ERROR 出现即说明 KSE 不可用、处于防护空窗。每周看离线终端与「升级待复核」，每月验证备份可恢复并轮换凭据。");
  const cols = [["每日", ["KSE 在线、病毒库为当天或前一天", "有无判定为 ERROR 的事件", "新的 DETECT / RISK / Tamper 事件"]],
    ["每周", ["离线终端、「升级待复核」或未生效的 Agent", "隔离区新增文件", "数据目录与扫描目录磁盘空间"]],
    ["每月", ["备份可恢复", "轮换注册令牌与 API Key", "吊销不再使用的终端"]]];
  const w = 3.9, g = 0.217;
  cols.forEach(([t, items], i) => {
    const x = M + i * (w + g);
    rr(s, x, 1.45, w, 5.0, i === 0 ? K.ink : K.panel);
    T(s, t, { x: x + 0.3, y: 1.7, w: w - 0.6, h: 0.6, fontFace: HEAD, fontSize: 26, bold: true, color: K.green });
    bullets(s, items, x + 0.3, 2.5, w - 0.6, 3.7, { size: 15, space: 14, color: i === 0 ? "E6ECEA" : K.graph });
  });
}
{
  const s = content("健康检查：healthz ≠ KSE 可用", "这是实测中出现过的真实事故：KSE 进程还在，但不再监听 1234，healthz 一直正常，所有扫描 ERROR 并按 fail_open 放行了两天。判断 KSE 是否可用，以控制台扫描引擎状态和 1234 端口为准。");
  code(s, ["systemctl is-active kaip-platform kavhttpd kavicapd", "curl -s http://127.0.0.1:8080/healthz", "ss -ltn | grep -E ':1234 |:1344 '        # KSE 是否在监听", "curl -s http://127.0.0.1:1234/api/v3.0/basesdate   # 病毒库日期"], M, 1.45, CW, 1.75, { size: 13 });
  rr(s, M, 3.5, CW, 2.95, K.redL);
  T(s, "/healthz 不检测 KSE", { x: M + 0.4, y: 3.75, w: CW - 0.8, h: 0.6, fontFace: HEAD, fontSize: 24, bold: true, color: K.red });
  T(s, "它只说明平台进程正常与配置的引擎类型。曾出现 KSE 进程仍在、但不再监听 1234 的情况：healthz 一直正常，所有扫描都是 ERROR 并按 fail_open 放行。\n判断 KSE 是否可用，以控制台「扫描引擎状态」和 1234 端口为准，并每天检查 ERROR 事件。",
    { x: M + 0.4, y: 4.4, w: CW - 0.8, h: 1.9, fontSize: 16, color: K.graph, paraSpaceAfter: 8 });
}
{
  const s = content("升级", "平台升级后终端自动升级，不需要逐台操作。Agent 升级后 kaip verify 会显示「升级待复核」，真实使用一次后恢复「生效」。升级前先备份。");
  table(s, ["对象", "方法", "升级后检查"], [
    ["KAIP 平台（原生）", "解压新离线包，执行 sudo bash install-offline.sh（同样的参数）", "healthz、PoC 自检"],
    ["KAIP 平台（Docker）", "docker load 新镜像，docker compose up -d", "docker compose ps 为 healthy"],
    ["终端客户端", "无需操作：kaip-watch 发现版本落后后自动升级；kaip sync 可立即同步", "控制台客户端版本更新"],
    ["AI Agent", "按 Agent 自身方式升级", "kaip verify：「升级待复核」→「生效」"],
    ["KSE", "按 KSE 官方文档", "1234 / 1344 监听、病毒库、PoC 自检"],
  ], M, 1.4, CW, [2.8, 5.8, 3.5], { size: 14, rowH: 0.72 });
  callout(s, "warn", "升级前先备份。只在终端侧替换客户端文件不是升级，会被当作篡改恢复回平台版本。", M, 5.75, CW, 0.75);
}
{
  const s = content("备份与恢复", "备份 /etc/kaip 与 /var/lib/kaip，备份时短暂停服保证数据库一致。恢复后属主为 kaip、目录权限 700。终端凭据在数据库中，恢复后终端无需重新注册。备份含凭据与隔离样本，按敏感数据保管。");
  const w = (CW - 0.3) / 2;
  T(s, "原生安装", { x: M, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["sudo systemctl stop kaip-platform", "sudo tar -czf kaip-backup-$(date +%F).tgz \\", "     /etc/kaip /var/lib/kaip", "sudo systemctl start kaip-platform"], M, 1.95, w, 1.7);
  T(s, "Docker 方式", { x: M + w + 0.3, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["docker compose stop kaip", "docker run --rm -v kaip_kaip-data:/d -v \"$PWD\":/b \\", "  --entrypoint tar kaip-platform:1.0.0 \\", "  -czf /b/kaip-data-$(date +%F).tgz -C /d .", "docker compose start kaip"], M + w + 0.3, 1.95, w, 1.7);
  bullets(s, ["**恢复：**停服 → 解压覆盖 /etc/kaip 与 /var/lib/kaip → 属主 kaip、权限 700 → 启动", "终端凭据保存在数据库中，恢复后已注册终端**无需重新注册**", "备份含终端凭据与隔离样本，按**敏感数据**保管、限制访问"], M, 4.0, CW, 2.4, { size: 15, space: 12 });
}
{
  const s = content("日志、终端与隔离区", "日志：平台看 journalctl，终端看 ~/.kaip/logs/kaip.log，代理看 Squid access.log。终端约 10 分钟无心跳显示离线；不用的终端吊销。隔离区文件确认为误报时放行并加入哈希白名单。");
  const cs = [["日志", ["平台：journalctl -u kaip-platform", "Docker：docker compose logs kaip", "终端：~/.kaip/logs/kaip.log", "Squid：/var/log/squid/access.log"]],
    ["终端管理", ["每 60 秒心跳，约 10 分钟无心跳显示离线", "离线时终端执行 kaip status 检查", "不再使用的终端吊销", "重装系统后重新一键安装"]],
    ["隔离区", ["DETECT 的文件以混淆方式保存", "误报：放行并加入哈希白名单", "恶意：删除", "样本按客户安全制度处理"]]];
  const w = 3.9, g = 0.217;
  cs.forEach(([t, items], i) => {
    const x = M + i * (w + g);
    rr(s, x, 1.45, w, 5.0, K.panel);
    circle(s, x + 0.3, 1.7, 0.55, K.green, i + 1, K.white, 16);
    T(s, t, { x: x + 1.05, y: 1.72, w: w - 1.3, h: 0.5, fontFace: HEAD, fontSize: 20, bold: true, color: K.ink });
    bullets(s, items, x + 0.3, 2.55, w - 0.6, 3.7, { size: 14, space: 12 });
  });
}

// ======================= 6 卸载 =======================
divider(6, "卸载与清理", "按「终端 → 容器 → 代理 → 服务器」的顺序进行，删除数据前先导出报告。", "强调卸载必须由用户本人执行——Agent 执行会被防篡改阻断，这本身也是防护能力的体现。");
{
  const s = content("终端卸载", "普通卸载保留 ~/.kaip，可直接 kaip install 重新接入；--purge 彻底删除。两种方式都先上报 KAIP:Client.Uninstalled。卸载只删 KAIP 写入的条目，不用备份覆盖 Agent 配置。卸载后重启 Agent 并在控制台吊销终端。");
  const w = (CW - 0.3) / 2;
  [["kaip uninstall", "普通卸载", "结束 kaip-watch，移除各 Agent 的 KAIP 接入与监控服务；保留 ~/.kaip（凭据、日志），可直接 kaip install 重新接入"],
    ["kaip uninstall --purge", "彻底卸载", "另外移除 PATH 设置与配置备份 *.kaip.bak，删除整个 ~/.kaip（含私有运行时与本地隔离区）"]].forEach(([c, t, d], i) => {
    const x = M + i * (w + 0.3);
    rr(s, x, 1.45, w, 2.7, i ? K.ink : K.panel);
    T(s, c, { x: x + 0.3, y: 1.7, w: w - 0.6, h: 0.5, fontFace: MONO, fontSize: 18, bold: true, color: K.green });
    T(s, t, { x: x + 0.3, y: 2.25, w: w - 0.6, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: i ? K.white : K.ink });
    T(s, d, { x: x + 0.3, y: 2.8, w: w - 0.6, h: 1.25, fontSize: 14, color: i ? "D5DBD9" : K.graph });
  });
  callout(s, "risk", "由 AI Agent 执行卸载会被防篡改阻断。卸载必须由用户在终端中手动执行。", M, 4.45, CW, 0.75);
  bullets(s, ["两种方式都会先上报 KAIP:Client.Uninstalled 事件", "只删除 KAIP 写入的 hook / 插件条目，不用备份覆盖 Agent 配置", "卸载后重启 Agent，并在控制台吊销该终端"], M, 5.4, CW, 1.3, { size: 14, space: 6 });
}
{
  const s = content("容器、代理与服务器的清理", "服务器卸载前务必导出报告：/var/lib/kaip 与数据卷含全部事件、终端凭据与隔离样本，删除不可恢复。分机部署记得清理 NFS 共享与挂载，并从 KSE 允许扫描的目录中移除。");
  const w = (CW - 0.3) / 2;
  T(s, "容器与下载代理", { x: M, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["# compose 接入：去掉 KAIP 配置后重建", "docker compose -f docker-compose.yml up -d \\", "  --force-recreate", "docker volume rm <项目名>_kaip-state", "", "# 终端撤销代理", "bash client-proxy.sh --remove", "powershell -File client-proxy.ps1 -Remove"], M, 1.95, w, 3.1, { size: 12 });
  T(s, "服务器", { x: M + w + 0.3, y: 1.4, w, h: 0.45, fontFace: HEAD, fontSize: 18, bold: true, color: K.ink });
  code(s, ["# 原生安装", "sudo systemctl disable --now kaip-platform", "sudo rm -rf /opt/kaip /etc/kaip /var/lib/kaip", "sudo userdel kaip", "", "# Docker 方式（连同数据卷）", "docker compose --profile agent down -v", "docker rmi kaip-platform:1.0.0"], M + w + 0.3, 1.95, w, 3.1, { size: 12 });
  callout(s, "risk", "/var/lib/kaip 与数据卷包含全部事件、终端凭据与隔离样本，删除不可恢复。先按交付要求导出报告；隔离样本按安全制度销毁。", M, 5.35, CW, 1.1);
}

// ======================= 7 排障 =======================
divider(7, "故障排查", "多数问题按「终端 → 平台 → KSE」的路径几分钟内即可定位。", "先讲方法，再讲常见问题。可以把常见问题做成课堂问答。");
{
  const s = content("排查路径", "固定路径：终端 → 平台 → KSE → 复现。「没有拦截」时先确认 Agent 是否真的执行了操作：部分模型读到 curl|bash 会自行拒绝执行，此时没有 KAIP 提示，不属于漏拦。测试时让 Agent「不要先读文件、直接运行」。");
  const st = [["终端", "kaip status · kaip verify\n~/.kaip/logs/kaip.log"], ["平台", "事件日志：判定、检出名称、原因\njournalctl -u kaip-platform"], ["KSE", "扫描引擎状态 · 1234 端口\n病毒库日期 · KSE 日志"], ["复现", "kaip test · kaip selftest\nPoC 自检"]];
  const w = 2.75, g = 0.378;
  st.forEach(([t, d], i) => {
    const x = M + i * (w + g);
    rr(s, x, 1.5, w, 2.9, i === 2 ? K.green : (i === 3 ? K.ink : K.panel));
    const dark = i >= 2;
    T(s, String(i + 1), { x: x + 0.3, y: 1.7, w: 1, h: 0.8, fontFace: HEAD, fontSize: 40, bold: true, color: dark ? K.white : K.green });
    T(s, t, { x: x + 0.3, y: 2.5, w: w - 0.6, h: 0.5, fontFace: HEAD, fontSize: 20, bold: true, color: dark ? K.white : K.ink });
    T(s, d, { x: x + 0.3, y: 3.05, w: w - 0.6, h: 1.25, fontSize: 13, color: dark ? "E6ECEA" : K.graph, paraSpaceAfter: 4 });
    if (i < 3) s.addShape(pres.shapes.ISOSCELES_TRIANGLE, { x: x + w + 0.08, y: 2.85, w: 0.3, h: 0.22, rotate: 90, fill: { color: K.line }, line: { color: K.line } });
  });
  callout(s, "tip", "「没有拦截」时先确认 Agent 是否真的执行了操作：部分模型读到 curl | bash 会自行拒绝执行，此时没有 KAIP 提示，不属于漏拦。", M, 4.8, CW, 1.0, 15);
}
const faq = [
  ["无法连接 KSE: Connection refused", "KSE 仍为本地 socket 监听；或 KSE 未运行", "改为 TCP 127.0.0.1:1234；检查 kavhttpd"],
  ["KSE 运行中，但全部扫描 ERROR", "分机时平台离线，hard 挂载卡住 kavhttpd", "umount -f -l 后重启 kavhttpd；改为 soft 挂载"],
  ["钓鱼 URL 检不出", "KSE 未开启防钓鱼", "Settings → Scanning 开启 Phishing Protection"],
  ["Codex 不拦截", "hook 未信任，或未开启 hooks", "终端运行 codex 信任 hook；kaip verify"],
  ["WorkBuddy 修改后无效", "常驻托盘，未完全重启", "从托盘退出后重新打开"],
  ["OpenCode 2.x 插件不生效", "后台 opencode-cli 保留旧代码", "结束该进程后重启 OpenCode"],
  ["kaip verify 显示「升级待复核」", "Agent 升级后尚未观察到拦截调用", "正常使用一次；仍未恢复则重新接入"],
  ["终端文件被恢复成旧版本", "平台官方客户端未更新", "先升级平台，再让终端同步"],
  ["经代理访问 HTTPS 证书错误", "终端未信任代理 CA", "重新执行 client-proxy 并新开终端"],
  ["经代理下载全部失败", "kavicapd 未运行（ICAP 不可用即阻断）", "systemctl enable --now kavicapd"],
  ["代理下载的病毒偶发未拦截", "KSN 断开或重连期间 ICAP 扫描超时放行", "保证 KSN 网络；隔离网络设 UseKSN=0"],
  ["看不到代理拦截事件", "ICAP Syslog 未配置或未勾选扫描结果", "KSE 控制台修正 Syslog；tcpdump 确认"],
  ["compose 中 OpenCode 未注册", "首次启动令牌文件为空，或卷是新的", "写入令牌后重启容器"],
  ["平台容器 unhealthy", "扫描目录对 UID 10001 不可写", "install -d -o 10001 -g 10001 -m 0775"],
];
[faq.slice(0, 7), faq.slice(7)].forEach((rows, i) => {
  const s = content(`常见问题（${i + 1}/2）`, i ? "代理相关问题集中在三点：CA 信任、kavicapd 是否运行、ICAP Syslog 配置。KSN 不稳定会导致偶发放行，这是 KSE ICAP 的行为，终端侧 KAIP 仍会兜底。" : "前三条是服务端问题，后四条是终端问题。终端问题绝大多数是 Agent 没有完全重启或 hook 未被信任。");
  table(s, ["现象", "原因", "处理"], rows, M, 1.4, CW, [3.8, 4.2, 4.1], { size: 14, rowH: 0.68 });
});

// ======================= 8 实验 =======================
divider(8, "实验练习", "在培训环境中依次完成部署、接入、拦截、策略、防篡改、供应链扫描与下载代理。", "所有样本均为无害测试样本。EICAR 用 kaip test 或 PoC 自检生成，不要把完整字符串写进文档、邮件或聊天。实验 3 的 setup_helper.sh 由讲师提前准备（内容为一行 curl … | bash）。");
{
  const s = content("实验总览", "实验按顺序进行，前一个是后一个的基础。每个实验 10–20 分钟，实验 7 可选。详细步骤见培训手册模块 8。");
  const labs = [["部署平台并验收", "离线包安装、登录、PoC 自检", "自检 8/8"], ["接入 Linux 终端", "一键安装、Agent 必做步骤、verify", "「✔ 生效」"], ["运行时拦截", "EICAR 写入、curl | bash、钓鱼 URL", "三次均执行前阻断"],
    ["策略调整", "审计模式与阻断模式对比", "审计只告警"], ["防篡改与自愈", "Agent 篡改 + 手工删除 hook", "阻断；约 1 分钟恢复"], ["供应链扫描", "上传、API 调用、隔离区处置", "EICAR 隔离；缓存命中"], ["下载代理（可选）", "Squid + ICAP + Syslog", "EICAR 403；平台有事件"]];
  const w = 2.85, h = 2.45, g = 0.244;
  labs.forEach(([t, d, e], i) => {
    const x = M + (i % 4) * (w + g), y = 1.4 + Math.floor(i / 4) * (h + 0.25);
    rr(s, x, y, w, h, i % 2 ? K.panel : K.greenL);
    T(s, `LAB ${i + 1}`, { x: x + 0.25, y: y + 0.2, w: w - 0.5, h: 0.4, fontFace: HEAD, fontSize: 13, bold: true, color: K.greenD, charSpacing: 2 });
    T(s, t, { x: x + 0.25, y: y + 0.6, w: w - 0.5, h: 0.45, fontFace: HEAD, fontSize: 17, bold: true, color: K.ink });
    T(s, d, { x: x + 0.25, y: y + 1.08, w: w - 0.5, h: 0.75, fontSize: 13 });
    T(s, "预期：" + e, { x: x + 0.25, y: y + 1.85, w: w - 0.5, h: 0.45, fontSize: 13, bold: true, color: K.greenD });
  });
  rr(s, M + 3 * (w + g), 1.4 + h + 0.25, w, h, K.ink);
  T(s, [{ text: "安全提示", options: { bold: true, color: K.green, breakLine: true } }, { text: "只用无害测试样本；EICAR 由 kaip test 或 PoC 自检生成。", options: { color: "E6ECEA" } }],
    { x: M + 3 * (w + g) + 0.25, y: 1.4 + h + 0.45, w: w - 0.5, h: h - 0.6, fontSize: 14, paraSpaceAfter: 6 });
}
{
  const s = content("实验 3：运行时拦截的预期结果", "让学员在事件日志里找到三条事件，对照判定与检出名称，理解 DETECT 与 RISK 的区别：EICAR 与钓鱼 URL 由 KSE 判定，curl|bash 由 KAIP 规则判定。");
  table(s, ["操作", "判定", "检出名称", "结果"], [
    ["kaip test（写入 EICAR）", "DETECT", "EICAR-Test-File", "执行前阻断，文件未落盘"],
    ["让 Agent 直接运行 setup_helper.sh", "RISK", "KAIP:download-exec", "执行前阻断，Agent 转述原因"],
    ["让 Agent 用 curl 访问钓鱼测试 URL", "DETECT", "PHISHING_URL", "执行前阻断"],
  ], M, 1.45, CW, [4.2, 1.7, 2.9, 3.3], { size: 15, rowH: 0.75 });
  callout(s, "tip", "提示词写进文件再引用：提示词中的 $ 与反斜杠会被 shell 改写，EICAR 被破坏后引擎判定为 CLEAN，造成「漏拦」假象。", M, 4.75, CW, 1.0, 15);
}

// ======================= 结束 =======================
sec("总结");
{
  const s = content("要点回顾", "用六句话收尾，请学员复述。然后进入问答。");
  const pts = [["执行前拦截", "hook 截获 → 平台判定 → 策略决策 → Agent 执行或放弃"], ["五种判定", "ERROR 默认放行，但 KAIP 规则命中仍阻断"], ["自愈以平台为准", "升级从平台侧进行，终端自动跟进"],
    ["KSE 是关键依赖", "每天看扫描引擎状态与 ERROR 事件；healthz 不代表 KSE 可用"], ["分机用 soft 挂载", "否则平台离线会拖垮 KSE"], ["卸载由人执行", "Agent 执行卸载会被防篡改阻断"]];
  const w = 3.9, h = 2.35, g = 0.217;
  pts.forEach(([t, d], i) => card(s, M + (i % 3) * (w + g), 1.45 + Math.floor(i / 3) * (h + 0.3), w, h, { num: i + 1, title: t, body: d, fill: i % 2 ? K.panel : K.greenL, bodySize: 14 }));
}
{
  const s = pres.addSlide({ masterName: "K_COVER", sectionTitle: curSection });
  T(s, "kaspersky", { x: M, y: 0.6, w: 4, h: 0.6, fontFace: HEAD, fontSize: 28, bold: true, color: K.green });
  s.addText("Q & A", { placeholder: "title" });
  s.addText("谢谢", { placeholder: "body" });
  T(s, "配套资料：《KAIP 产品培训手册》《KAIP PoC 实施手册》 · 离线安装包 docs/", { x: M, y: 5.0, w: 8, h: 0.5, fontSize: 15, color: "C8D0CD" });
  s.addNotes("答疑。提醒学员：配套的培训手册含全部自测题与答案，PoC 实施手册含现场实施步骤与测试用例。");
}

(async () => {
  await pres.writeFile({ fileName: OUT });
  if (process.env.APPLY_THEME) {
    const { applyTheme } = require(process.env.APPLY_THEME);
    await applyTheme(OUT, THEME);
  }
  console.log("已生成", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
})();
