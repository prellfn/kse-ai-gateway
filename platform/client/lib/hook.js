"use strict";
// Agent 工具调用的统一判定逻辑（Codex / WorkBuddy hooks 与 OpenCode 插件共用）
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const C = require("./common");
const S = require("./scanfs");

const INSTALL_RX = new RegExp(
  "(\\bgit\\s+clone\\b|\\bpip3?\\s+install\\b|\\buv\\s+(pip\\s+install|add)\\b|\\bnpm\\s+(i|install|add)\\b|\\bpnpm\\s+(i|install|add)\\b|" +
  "\\byarn\\s+add\\b|\\bbun\\s+(add|install)\\b|\\bnpx\\s+|\\bcurl\\b[^\\n]*\\s-(o|O)\\b|\\bwget\\s|\\bInvoke-WebRequest\\b|\\biwr\\s|" +
  "\\bhuggingface-cli\\s+download\\b|\\bhf\\s+download\\b|\\bollama\\s+pull\\b|\\bmodelscope\\s+download\\b|" +
  "\\b(clawhub|skills?)\\s+(install|add)\\b|\\bcodex\\s+mcp\\s+add\\b|\\bopencode\\s+mcp\\b|\\bExpand-Archive\\b|\\bunzip\\s|\\btar\\s+-?x)", "i");
const URL_RX = /https?:\/\/[^\s'"<>|;)`]+/gi;
const EXEC_FILE_RX = /(?:^|[\s"'=(])((?:[A-Za-z]:)?[^\s"'|;&<>()]+\.(?:py|js|mjs|cjs|ts|sh|bash|ps1|psm1|bat|cmd|vbs|rb|pl|php|pkl|pickle|pt|pth|ckpt|bin|joblib|keras|h5|safetensors|gguf|onnx|npy|zip|whl|tgz|exe|dll|so|msi|jar))(?=$|[\s"')])/gi;

const SKILL_TOOL_RX = /^(skill|skillmanage|useskill|use_skill|skills)$/i;
const CODE_TOOL_RX = /(repl|eval|exec(ute)?_?(code|python|js)|run_?(code|python|js)|python|javascript|(^|_)js$|notebook|jupyter|code_?interpreter)/i;

// 解出代码中的字符串字面量（处理 \\ \n \t \xNN \uNNNN 等转义）。
// 每个字面量作为独立对象送检：真实引擎按「对象整体」判定（如 EICAR 要求位于文件开头、总长 ≤128 字节），
// 与代码拼在一起会漏检。返回按长度降序的前 20 个（含转义的，或 ≥64 字符的长字面量）。
const unescapeLit = (s) => s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}|[\s\S])/g, (_, e) => {
  if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
  if (e[0] === "u") return String.fromCodePoint(parseInt(e.replace(/[u{}]/g, ""), 16));
  return { n: "\n", r: "\r", t: "\t", "0": "\0", b: "\b", f: "\f", v: "\v" }[e] ?? e;
});

function decodeStringLiterals(code, { minLen = 64, depth = 0, acc = [] } = {}) {
  // 任意长度都要匹配，保证引号正确配对（短字符串如 "e.txt" 若不匹配会导致后续引号错位）；长度在下面过滤
  const rx = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m, n = 0;
  while ((m = rx.exec(code)) && n < 2000 && acc.length < 200) {
    const s = m[1] ?? m[2] ?? m[3];
    n++;
    if (s.length < 8) continue;
    const dec = unescapeLit(s);
    if (s.includes("\\") || s.length >= minLen) {
      // 原样（Python r"..." 原始字符串、shell 单引号不处理转义）与解转义两种形态都送检
      acc.push(s, dec);
    }
    // 嵌套引号：python3 -c 'open("f").write(r"<payload>")' —— 外层引号内还有内层字面量
    if (depth < 2 && /["'`]/.test(s)) {
      decodeStringLiterals(s, { minLen, depth: depth + 1, acc });
      if (dec !== s) decodeStringLiterals(dec, { minLen, depth: depth + 1, acc });
    }
  }
  if (depth > 0) return acc;
  return [...new Set(acc)].sort((a, b) => b.length - a.length).slice(0, 20);
}

// shell 命令中“随命令一起交付的内容”：引号内字符串（python -c / node -e / echo '…' > f 等）与 heredoc 正文。
// 这些内容不落盘就被执行或写入文件，需要像文件一样交给引擎判定。
function commandPayloads(cmd) {
  const out = [];
  const hd = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/g;
  let m;
  while ((m = hd.exec(cmd)) && out.length < 10) if (m[3].trim()) out.push(m[3]);
  const quoted = decodeStringLiterals(cmd.replace(hd, " "), { minLen: 16 });
  return [...new Set([...out, ...quoted])].slice(0, 20);
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// KAIP 自身程序：完整性由指纹校验保证，不做执行前扫描（避免 kaip test 等自检命令被误判）
const KAIP_CLIENT_N = path.join(C.KAIP_HOME, "client").split(path.sep).join("/").toLowerCase() + "/";
const isKaipOwn = (p) => p.split(path.sep).join("/").toLowerCase().startsWith(KAIP_CLIENT_N);

// 按技能名定位技能目录：目录名相同，或 SKILL.md frontmatter 中 name 相同
function findSkillDir(name, cwd) {
  if (!name || /[\\/]|\.\./.test(name)) return null;
  const roots = new Set(S.watchRoots());
  for (const base of [cwd, C.HOME].filter(Boolean)) {
    for (const d of [".workbuddy/skills", ".codebuddy/skills", ".codex/skills", ".agents/skills", ".opencode/skills", ".claude/skills", "skills"]) {
      const p = path.resolve(base, d);
      if (isDir(p)) roots.add(p);
    }
  }
  const want = name.toLowerCase();
  for (const r of roots) {
    const direct = path.join(r, name);
    if (isDir(direct)) return direct;
    let ents = [];
    try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const dir = path.join(r, e.name);
      if (e.name.toLowerCase() === want) return dir;
      try {
        const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").slice(0, 2000);
        const m = md.match(/^name:\s*["']?([^"'\r\n]+)/m);
        if (m && m[1].trim().toLowerCase() === want) return dir;
      } catch {}
    }
  }
  return null;
}

// ---------- 归一化：把不同 Agent 的工具调用转成 {tool, command, files[]} ----------
function lowerKeys(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) r[k.toLowerCase().replace(/_/g, "")] = v; return r; }

function parseApplyPatch(text, cwd) {
  // Codex apply_patch 格式：*** Add File: / *** Update File: + 以 "+" 开头的新增行
  const files = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (Add|Update) File: (.+)$/);
    if (m) { cur = { path: path.resolve(cwd || ".", m[2].trim()), lines: [] }; files.push(cur); continue; }
    if (/^\*\*\* (Delete File|End Patch|Move to)/.test(line)) { cur = line.startsWith("*** Move to") ? cur : null; continue; }
    if (cur && line.startsWith("+")) cur.lines.push(line.slice(1));
  }
  return files.map((f) => ({ path: f.path, content: f.lines.join("\n"), kind: "write" }));
}

function normalize(toolName, toolInput, cwd) {
  const tool = String(toolName || "");
  const ti = typeof toolInput === "string" ? { command: toolInput } : (toolInput || {});
  const k = lowerKeys(ti);
  const out = { tool, command: null, files: [], skillDir: null };
  const filePath = k.filepath || k.path || k.file || k.targetfile || k.notebookpath;
  const abs = filePath ? path.resolve(cwd || ".", toNativePath(String(filePath))) : null;
  out.targetPath = abs;   // 读/写/编辑的目标路径（防篡改检查用，含只读工具）

  // 调用技能（WorkBuddy/CodeBuddy: Skill / use_skill，技能名可能在 skill/name/command 字段）
  if (SKILL_TOOL_RX.test(tool)) {
    const name = String(k.skill || k.name || k.skillname || k.command || "").trim().split(/\s+/)[0];
    const direct = k.skillpath || k.path || k.filepath;
    out.skill = name;
    out.skillDir = direct && isDir(path.resolve(cwd || ".", String(direct))) ? path.resolve(cwd || ".", String(direct)) : findSkillDir(name, cwd);
    return out;
  }

  // 代码执行类工具（如 Codex 的 mcp__node_repl__js、Jupyter/Python REPL）：代码本身即「执行内容」
  // 实测：Codex 会改用 node_repl 的 fs.writeFileSync 写文件，绕过 Write/apply_patch/Shell 拦截点
  const code = [k.code, k.source, k.cell, k.snippet].find((v) => typeof v === "string" && v.trim()) ??
    (CODE_TOOL_RX.test(tool) ? [k.script, k.input, k.expression].find((v) => typeof v === "string" && v.trim()) : undefined);
  if (code && !(typeof k.command === "string" && k.command.trim())) {
    out.files.push({ path: `${tool || "code"}:code`, content: code, kind: "code" });
    // 字面量只交引擎判定（kind=literal，不跑启发式规则，避免字符串里提到命令就被误判）
    decodeStringLiterals(code).forEach((lit, i) => out.files.push({ path: `${tool || "code"}:literal#${i + 1}`, content: lit, kind: "literal" }));
    return out;
  }

  // 补丁（Codex apply_patch / OpenCode patch）
  for (const v of Object.values(ti)) {
    if (typeof v === "string" && v.includes("*** Begin Patch")) { out.files.push(...parseApplyPatch(v, cwd)); return out; }
    if (Array.isArray(v) && v.some((x) => typeof x === "string" && x.includes("*** Begin Patch"))) {
      out.files.push(...parseApplyPatch(v.find((x) => typeof x === "string" && x.includes("*** Begin Patch")), cwd)); return out;
    }
  }
  // 写文件
  if (abs && (k.content != null || k.text != null || k.filetext != null)) {
    out.files.push({ path: abs, content: String(k.content ?? k.text ?? k.filetext), kind: "write" });
    return out;
  }
  // 编辑：尽量还原编辑后的完整文件再扫描
  const edits = Array.isArray(k.edits) ? k.edits.map(lowerKeys) : (k.newstring != null || k.newstr != null) ? [k] : [];
  if (abs && edits.length) {
    let content = null;
    try { content = fs.readFileSync(abs, "utf8"); } catch {}
    let fragments = [];
    for (const e of edits) {
      const ns = String(e.newstring ?? e.newstr ?? "");
      const os_ = e.oldstring ?? e.oldstr;
      if (content != null && os_ != null && content.includes(os_)) content = e.replaceall ? content.split(os_).join(ns) : content.replace(os_, () => ns);
      else fragments.push(ns);
    }
    out.files.push({ path: abs, content: content != null ? content + (fragments.length ? "\n" + fragments.join("\n") : "") : fragments.join("\n"), kind: "edit" });
    return out;
  }
  // 命令执行
  let cmd = k.command ?? k.cmd ?? k.script;
  if (Array.isArray(cmd)) cmd = cmd.join(" ");
  if (typeof cmd === "string" && cmd.trim()) {
    out.command = cmd;
    // 内联代码 / heredoc / 引号内容 → 独立对象送引擎（实测：python3 -c 'open(...).write(r"<EICAR>")' 可绕过文件扫描）
    commandPayloads(cmd).forEach((p, i) => out.files.push({ path: `${tool || "shell"}:inline#${i + 1}`, content: p, kind: "literal" }));
    const seen = new Set();
    // 只扫描「会被执行/加载/解包」的文件；cat / Get-Content / grep 等只读查看不触发（读取不执行代码）
    for (const { seg, dir } of executingSegments(cmd, k.workdir || k.cwd || cwd || ".")) {
      for (const m of seg.matchAll(EXEC_FILE_RX)) {
        const p = path.resolve(dir, toNativePath(m[1].replace(/^["']|["']$/g, "")));
        if (seen.has(p)) continue;
        seen.add(p);
        if (isKaipOwn(p)) continue;
        try { const st = fs.statSync(p); if (st.isFile()) out.files.push({ path: p, kind: S.MODEL_EXT.has(path.extname(p).toLowerCase()) ? "model" : "script", size: st.size }); } catch {}
      }
    }
  }
  return out;
}

// 解释器 / 运行器 / 安装与解包工具：其参数中的文件会被执行或加载
const RUNNER_RX = /^(bash|sh|zsh|dash|ksh|fish|python\d*(\.\d+)?|py|pythonw|ipython|node|nodejs|deno|bun|tsx|ts-node|npx|pnpx|bunx|pwsh|powershell|cmd|start-process|start|call|source|\.|&|perl|ruby|php|lua|java|wscript|cscript|mshta|rundll32|regsvr32|msiexec|invoke-expression|iex|uv|uvx|pip\d*|conda|poetry|torchrun|accelerate|deepspeed|jupyter|streamlit|gunicorn|uvicorn|tar|unzip|7z|expand-archive|gzip|gunzip|bsdtar|chmod|sudo|env|exec|nohup|time|timeout|xargs)$/i;

// Git Bash / MSYS 风格路径 /c/Users/x → C:/Users/x（仅 Windows）；~ → 主目录
function toNativePath(p) {
  if (process.platform === "win32") {
    const m = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) return m[1].toUpperCase() + ":" + (m[2] || "/");
  }
  return p.replace(/^~(?=$|[\\/])/, C.HOME);
}

// 返回需要扫描的子命令及其工作目录；跟踪 cd / Set-Location / pushd
// （WorkBuddy 常生成 `cd "dir" && timeout 90 bash x.sh`）
function executingSegments(cmd, baseDir) {
  const segs = [];
  let dir = baseDir;
  // 按 ; && || | 换行 拆分子命令（不处理引号内的分隔符，足够用于判定）
  for (let seg of cmd.split(/;|&&|\|\||\||\r?\n/)) {
    seg = seg.trim().replace(/^[({\s]+/, "");
    if (!seg) continue;
    const cdm = seg.match(/^(?:cd|chdir|pushd|set-location|sl)(?:\s+\/d)?(?:\s+-(?:literal)?path)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
    if (cdm) {
      const target = cdm[1] || cdm[2] || cdm[3];
      if (target && target !== "-") dir = path.resolve(dir, toNativePath(target));
      continue;
    }
    const first = (seg.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/) || [])[0] || "";
    const tok = first.replace(/^["']|["']$/g, "");
    const base = tok.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "");
    if (RUNNER_RX.test(base) || RUNNER_RX.test(tok)) { segs.push({ seg, dir }); continue; }
    // 直接执行脚本：./x.sh、C:\x\run.ps1、x.bat
    if (EXEC_FILE_RX.test(" " + tok)) { EXEC_FILE_RX.lastIndex = 0; segs.push({ seg, dir }); continue; }
    EXEC_FILE_RX.lastIndex = 0;
  }
  return segs;
}

// ---------- 判定 ----------
function failDecision(err) {
  const p = C.policy();
  C.log("WARN", "平台不可达，按离线策略处理", { err: err.message, fail_open: p.fail_open });
  if (p.fail_open === false) return { decision: "block", reasons: [`[KAIP] 安全平台不可达（${err.message}），按高安全策略阻断。`], offline: true };
  return { decision: "allow", reasons: [], offline: true };
}

async function evaluatePre(agentType, norm, ctx = {}) {
  const p = C.policy();
  // 自我保护：本地判定（平台不可达也生效），命中即阻断并上报篡改告警
  if (p.tamper_protection !== false) {
    const t = require("./tamper").check(norm);
    if (t) {
      C.log("WARN", "拦截篡改行为", { agent: agentType, rule: t.rule, desc: t.desc });
      if (!process.env.KAIP_SELFTEST) await C.request("POST", "/api/v1/agent/report", {
        json: { agent_type: agentType, category: "tamper", action: "block", verdict: "RISK", detection: `KAIP:Tamper.${t.rule}`,
          object: t.target, details: { desc: t.desc, tool: norm.tool, cwd: ctx.cwd || "" } }, timeoutMs: 5000,
      }).catch(() => {});
      return { decision: "block", reasons: [`[Kaspersky AI Protect] 禁止${t.desc}：安全组件受保护，AI Agent 不得读取其凭据、修改或停用它。`] };
    }
  }
  // 技能执行前：全量扫描技能目录（增量缓存，重复调用几乎零开销）
  if (norm.skillDir) {
    try {
      const files = S.walk(norm.skillDir, { maxFiles: 500 });
      const res = await S.scanPaths(files, { agentType, source: "agent-hook", doQuarantine: false });
      const bad = res.filter((r) => r.action === "block");
      const err = res.find((r) => r.verdict === "ERROR");
      if (err && !bad.length) { const fd = failDecision(new Error(err.error || "扫描失败")); if (fd.decision === "block") return fd; }
      C.log("INFO", "技能执行前扫描", { skill: norm.skill, dir: norm.skillDir, files: res.length, blocked: bad.length });
      if (bad.length) return { decision: "block", reasons: bad.map((b) => `[Kaspersky AI Protect] 技能「${norm.skill}」包含威胁文件 ${b.detection || b.verdict}：${b.path}`) };
    } catch (e) { return failDecision(e); }
    return { decision: "allow", reasons: [] };
  }
  const files = [];
  const maxBytes = (p.max_inline_scan_mb || 50) * 1024 * 1024;
  const big = [];
  for (const f of norm.files) {
    if (f.kind === "write" || f.kind === "edit" || f.kind === "code" || f.kind === "literal") {
      if (p.scan_on_write === false) continue;
      const buf = Buffer.from(f.content || "", "utf8");
      if (!buf.length) continue;
      const hit = C.cacheGet(C.sha256Buf(buf));
      if (hit && hit.v === "CLEAN") continue;
      files.push({ path: f.path, content_b64: buf.toString("base64"), kind: f.kind });
    } else {
      if (p.scan_on_exec === false) continue;
      if (f.size > maxBytes) { big.push(f); continue; }
      let buf;
      try { buf = fs.readFileSync(f.path); }
      catch (e) { C.log("WARN", "无法读取待执行文件（可能被本机杀软拦截）", { path: f.path, code: e.code }); continue; }
      const hit = C.cacheGet(C.sha256Buf(buf));
      if (hit && hit.v === "CLEAN") continue;
      if (hit && hit.a === "block") return { decision: "block", reasons: [`[KAIP] 文件此前已被判定为威胁 ${hit.d}：${f.path}`] };
      files.push({ path: f.path, content_b64: buf.toString("base64"), kind: f.kind });
    }
  }
  if (!files.length && !norm.command && !big.length) return { decision: "allow", reasons: [] };
  let r;
  try {
    r = await C.request("POST", "/api/v1/agent/evaluate", {
      json: { agent_type: agentType, event: "PreToolUse", tool: norm.tool, command: norm.command, files, cwd: ctx.cwd || "", session_id: ctx.session_id || "" },
      timeoutMs: 120000,
    });
  } catch (e) { return failDecision(e); }
  C.setBases(r.bases_version);
  for (const x of r.results || []) if (x.sha256) C.cachePut(x.sha256, x.verdict, x.action, x.detection);
  // 大模型文件：流式上传扫描（KSE scanfile）
  for (const f of big) {
    try {
      const sr = await S.scanFile(f.path, { agentType, source: "agent-hook", doQuarantine: false });
      if (sr && sr.action === "block") { r.decision = "block"; r.reasons.push(`卡巴斯基检出 ${sr.detection || sr.verdict}：${f.path}`); }
    } catch (e) { const fd = failDecision(e); if (fd.decision === "block") return fd; }
  }
  if (r.post_scan) markPending(agentType, norm, ctx);
  return { decision: r.decision, reasons: (r.reasons || []).map((x) => "[Kaspersky AI Protect] " + x), post_scan: r.post_scan };
}

function pendingKey(norm, ctx) { return crypto.createHash("sha1").update((ctx.session_id || "") + "|" + (norm.command || "")).digest("hex").slice(0, 20); }
function markPending(agentType, norm, ctx) {
  try { C.writeJSON(path.join(C.PENDING_DIR, pendingKey(norm, ctx) + ".json"), { t: Date.now() - 2000, cwd: ctx.cwd, command: norm.command, agentType }); } catch {}
}

// 安装/下载类命令执行后：扫描期间新增或修改的文件
async function postScan(agentType, norm, ctx = {}) {
  if (!norm.command || !INSTALL_RX.test(norm.command)) return { blocked: [] };
  const p = C.policy();
  if (p.install_action === "allow") return { blocked: [] };
  const pf = path.join(C.PENDING_DIR, pendingKey(norm, ctx) + ".json");
  const pend = C.readJSON(pf, null);
  try { fs.unlinkSync(pf); } catch {}
  const since = pend ? pend.t : Date.now() - 5 * 60 * 1000;
  const roots = new Set(S.watchRoots([agentType]));
  if (ctx.cwd) roots.add(path.resolve(ctx.cwd));
  const files = [];
  for (const r of roots) files.push(...S.walk(r, { since, maxFiles: 3000 }));
  // 命令中显式的输出路径（-o/-O、git clone 目标）
  const m = norm.command.match(/(?:-o|--output|-OutFile)\s+["']?([^\s"']+)/i);
  if (m) { const op = path.resolve(ctx.cwd || ".", m[1]); try { if (fs.statSync(op).isFile()) files.push({ path: op }); } catch {} }
  const uniq = [...new Map(files.map((f) => [f.path, f])).values()];
  if (!uniq.length) return { blocked: [], scanned: 0 };
  const results = await S.scanPaths(uniq, { agentType, source: "agent-hook" });
  const blocked = results.filter((x) => x.action === "block");
  return { blocked, scanned: results.length };
}

// 会话启动：增量扫描 Skills / 插件 / 模型目录
async function sessionScan(agentType, limit = 300) {
  const p = C.policy();
  if (p.scan_skills_on_session_start === false) return { blocked: [], scanned: 0 };
  const files = [];
  for (const r of S.watchRoots([agentType])) files.push(...S.walk(r, { maxFiles: 5000 }));
  const idx = C.pathIdx();
  const todo = files.filter((f) => { const x = idx[f.path]; return !(x && x.m === f.mtime && x.s === f.size && x.v === "CLEAN"); }).slice(0, limit);
  if (!todo.length) return { blocked: [], scanned: 0 };
  const results = await S.scanPaths(todo, { agentType, source: "watcher" });
  return { blocked: results.filter((x) => x.action === "block"), scanned: results.length };
}

module.exports = { normalize, evaluatePre, postScan, sessionScan, INSTALL_RX, parseApplyPatch, findSkillDir };
