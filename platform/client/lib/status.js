"use strict";
// 防护生效状态：探测各 AI Agent 的 KAIP 接入是否真正生效，随心跳上报平台。
// 背景：OpenCode 升级改插件接口、Codex 未信任 hook、配置被覆盖等情况下，Agent 照常运行但没有防护（静默失效）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const C = require("./common");

const IS_WIN = process.platform === "win32";
const STATUS_PATH = path.join(C.KAIP_HOME, "agent-status.json");
const MARK = "kaip-hook";

function readStatus() { return C.readJSON(STATUS_PATH, {}); }

// hook / 插件运行时调用：记录加载与调用时间（节流，避免每次工具调用都写盘）
function recordStatus(agent, fields) {
  try {
    const s = readStatus();
    const cur = s[agent] || {};
    const TS = ["last_invoke", "last_pre"];
    if (Object.keys(fields).every((k) => TS.includes(k) && cur[k] && fields[k] - cur[k] < 30000)) return;
    s[agent] = { ...cur, ...fields };
    C.writeJSON(STATUS_PATH, s);
  } catch {}
}

// ---------- OpenCode ----------
function opencodeCandidates() {
  const c = ["opencode"];
  if (IS_WIN) c.push(path.join(process.env.LOCALAPPDATA || "", "Programs", "ai.opencode.desktop", "resources", "opencode-cli.exe"));
  else c.push(path.join(C.HOME, ".opencode", "bin", "opencode"), "/usr/local/bin/opencode");
  return c;
}

function opencodeInfo() {
  for (const bin of opencodeCandidates()) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true });
      const m = String(r.stdout || "").match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) return { bin, version: m[0], major: parseInt(m[1], 10) };
    } catch {}
  }
  return null;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 不调用模型的插件加载探测：`opencode debug config` 会加载全部插件。
//  · 1.x：命令在本进程内加载插件，返回前即可看到加载记录（实测约 3 秒）；
//  · 2.x：命令交给常驻后台服务执行，插件在服务内**异步**加载 → 需轮询等待；
//         若服务早已在运行（不会重新加载），则认可其加载记录，前提是记录晚于当前插件文件与最近一次版本变化。
function probeOpencode(info, { versionChangedAt = 0 } = {}) {
  info = info || opencodeInfo();
  if (!info) return { installed: false };
  const pluginFile = path.join(process.env.XDG_CONFIG_HOME || path.join(C.HOME, ".config"), "opencode", "plugins", "kaip.js");
  const base = { installed: true, version: info.version, configured: fs.existsSync(pluginFile), probed_at: Date.now() };
  if (!base.configured) return { ...base, state: "missing", detail: "KAIP 插件文件不存在" };
  const ok = (s, how) => ({ ...base, state: "ok", api: s.api, detail: `插件已加载（${s.api} 接口${how ? "，" + how : ""}）` });
  const t0 = Date.now();
  for (const args of [["debug", "config"], ["models"]]) {
    try { spawnSync(info.bin, args, { cwd: os.tmpdir(), timeout: 90000, windowsHide: true, stdio: "ignore", env: { ...process.env, KAIP_PROBE: "1" } }); } catch {}
    const waitUntil = Date.now() + (info.major >= 2 ? 45000 : 2000);
    do {
      const s = readStatus().opencode || {};
      if (s.loaded_at && s.loaded_at >= t0) return ok(s);
      sleepSync(1000);
    } while (Date.now() < waitUntil);
  }
  const s = readStatus().opencode || {};
  let mtime = 0;
  try { mtime = fs.statSync(pluginFile).mtimeMs; } catch {}
  if (info.major >= 2 && s.loaded_at && s.loaded_at >= mtime && s.loaded_at >= versionChangedAt) return ok(s, "由运行中的 OpenCode 服务加载");
  return { ...base, state: "inactive", detail: `OpenCode ${info.version} 未加载 KAIP 插件（可能因版本升级导致插件接口不兼容）` };
}

// ---------- Codex ----------
function codexStatus() {
  const dir = process.env.CODEX_HOME || path.join(C.HOME, ".codex");
  const hf = path.join(dir, "hooks.json");
  if (!fs.existsSync(dir)) return { installed: false };
  const hooks = C.readJSON(hf, {}).hooks || {};
  const ours = Object.entries(hooks).filter(([, groups]) => (groups || []).some((g) => (g.hooks || []).some((h) => String(h.command || "").includes(MARK))));
  if (!ours.length) return { installed: true, configured: false, state: "missing", detail: "hooks.json 中没有 KAIP hook" };
  let toml = "";
  try { toml = fs.readFileSync(path.join(dir, "config.toml"), "utf8"); } catch {}
  const enabled = /^\s*(hooks|codex_hooks)\s*=\s*true/m.test(toml);
  // 信任记录：[hooks.state.'<hooks.json 路径>:pre_tool_use:<组>:<序号>'] trusted_hash = "..."
  const esc = hf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trusted = new RegExp(`hooks\\.state\\.['"]${esc}:pre_tool_use:\\d+:\\d+['"]\\]\\s*\\r?\\ntrusted_hash`, "i").test(toml);
  const s = readStatus().codex || {};
  const base = { installed: true, configured: true, enabled, trusted, last_invoke: s.last_invoke || null };
  if (!enabled) return { ...base, state: "inactive", detail: "config.toml 未开启 [features] hooks" };
  if (!trusted) return { ...base, state: "untrusted", detail: "KAIP hook 尚未被 Codex 信任（需在 Codex 终端界面确认一次），未信任的 hook 不会执行" };
  return { ...base, state: "ok", detail: "hook 已配置且已信任" };
}

// ---------- WorkBuddy / CodeBuddy ----------
function workbuddyStatus() {
  const dirs = [path.join(C.HOME, ".workbuddy"), path.join(C.HOME, ".codebuddy")].filter((d) => fs.existsSync(d));
  if (!dirs.length) return { installed: false };
  const configured = dirs.some((d) => JSON.stringify(C.readJSON(path.join(d, "settings.json"), {}).hooks || {}).includes(MARK));
  const s = readStatus().workbuddy || {};
  if (!configured) return { installed: true, configured: false, state: "missing", detail: "settings.json 中没有 KAIP hook" };
  return { installed: true, configured: true, last_invoke: s.last_invoke || null, state: "ok", detail: "hook 已配置" };
}

// 汇总（OpenCode 探测有成本：版本变化或超过 6 小时才重新探测，其余用缓存结果）
function collect(agents, { forceProbe = false } = {}) {
  const out = {};
  const want = new Set(agents && agents.length ? agents : ["codex", "opencode", "workbuddy"]);
  if (want.has("codex")) out.codex = codexStatus();
  if (want.has("workbuddy")) out.workbuddy = workbuddyStatus();
  if (want.has("opencode")) {
    const cache = readStatus()._probe_opencode || {};
    const info = opencodeInfo();
    const stale = !cache.probed_at || Date.now() - cache.probed_at > 6 * 3600e3 || (info && cache.version !== info.version) || cache.configured === false;
    let r = cache;
    if (!info) r = { installed: false };
    else if (forceProbe || stale || process.env.KAIP_PROBE_ALWAYS) {
      // 记录首次发现版本变化的时间：升级后的旧加载记录不能作为“已生效”的证据
      const changedAt = cache.version && cache.version !== info.version ? Date.now() : (cache.version_changed_at || 0);
      r = { ...probeOpencode(info, { versionChangedAt: changedAt }), version_changed_at: changedAt };
      const s = readStatus();
      s._probe_opencode = r;
      try { C.writeJSON(STATUS_PATH, s); } catch {}
    }
    const s = readStatus().opencode || {};
    out.opencode = { ...r, last_invoke: s.last_invoke || null, last_pre: s.last_pre || null };
  }
  for (const k of Object.keys(out)) if (out[k].installed === false) delete out[k];

  // 版本跟踪 + 升级复核 + 行为对账 + 新工具上报
  const st = readStatus();
  for (const [agent, s] of Object.entries(out)) {
    if (!s.version) { const v = agentVersion(agent); if (v) s.version = v; }
    const vk = "_ver_" + agent;
    const vr = st[vk] || {};
    if (s.version && vr.version && vr.version !== s.version) {
      // 发现升级：记录时间并立即自测（自测只验证 KAIP 侧在新版本下仍能正确判定，宿主契约变化靠下面的行为对账发现）
      vr.prev = vr.version; vr.changed_at = Date.now(); vr.confirmed = false;
      try { vr.self_test = require("./selftest").run([agent]); } catch (e) { vr.self_test = { error: e.message }; }
      C.log("WARN", "检测到 AI Agent 升级", { agent, from: vr.prev, to: s.version, self_test: vr.self_test });
    }
    if (s.version) vr.version = s.version;
    const lastInv = (st[agent] || {}).last_invoke || 0;
    // 行为对账只认「执行前检查」：宿主可能仍调用 SessionStart / PostToolUse，却不再调用 PreToolUse（拦截失效但事后检查还在）
    const lastPre = (st[agent] || {}).last_pre || 0;
    if (vr.changed_at && !vr.confirmed && lastPre > vr.changed_at) vr.confirmed = true;   // 升级后已观察到真实的执行前检查
    st[vk] = vr;
    if (vr.changed_at) Object.assign(s, { prev_version: vr.prev, upgraded_at: vr.changed_at, self_test: vr.self_test });

    // 行为对账：Agent 会话里有工具调用，但 KAIP 没被调用 → 拦截已失效（宿主改了 hook 契约 / 配置未生效）
    if (s.state === "ok" || s.state === "untrusted") {
      // 首次运行（如 KAIP 自身刚升级、尚无执行前检查记录）以当下为对账起点，避免把历史调用误判为未经检查
      vr.recon_since = vr.recon_since || Date.now();
      const since = Math.max(lastPre, vr.recon_since, Date.now() - 24 * 3600e3) + 60e3;
      const n = sessionToolCalls(agent, since);
      if (n >= 3) {
        s.state = "inactive";
        s.detail = `最近 ${n} 次工具调用未经过 KAIP 执行前检查（${lastPre ? "上次检查于 " + new Date(lastPre).toLocaleString() : "从未检查"}${lastInv > lastPre + 60e3 ? "；其他 hook 仍在调用" : ""}）——拦截可能已失效${vr.changed_at ? `，疑与升级 ${vr.prev} → ${vr.version} 有关` : ""}`;
      } else if (s.state === "ok" && vr.changed_at && !vr.confirmed) {
        const t = vr.self_test || {};
        s.state = "review";
        s.detail = `已从 ${vr.prev} 升级到 ${vr.version}；KAIP 自测 ${t.pass ?? "?"}/${t.total ?? "?"} 通过，等待实际使用中确认拦截被调用`;
      }
    }
    // 新工具：KAIP 未识别的工具名（上报后由平台产生一次性提醒）
    const tools = (st._tools || {})[agent] || {};
    const unknown = Object.entries(tools).filter(([name]) => !isKnownTool(agent, name)).map(([name, x]) => ({ name, count: x.n, first_seen: x.first }));
    if (unknown.length) s.unknown_tools = unknown.slice(0, 50);
  }
  // 只回写版本跟踪字段：期间 hook / 自测进程可能已写入调用记录，避免整体覆盖
  try {
    const cur = readStatus();
    for (const k of Object.keys(st)) if (k.startsWith("_ver_")) cur[k] = st[k];
    C.writeJSON(STATUS_PATH, cur);
  } catch {}
  return out;
}

// ---------- 版本 ----------
function newestCodexBin() {
  const c = [];
  if (IS_WIN) {
    const base = path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
    try { for (const d of fs.readdirSync(base)) { const f = path.join(base, d, "codex.exe"); if (fs.existsSync(f)) c.push([f, fs.statSync(f).mtimeMs]); } } catch {}
  }
  c.sort((a, b) => b[1] - a[1]);
  return [...c.map((x) => x[0]), "codex"];
}
function agentVersion(agent) {
  try {
    if (agent === "codex") {
      for (const bin of newestCodexBin()) {
        const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20000, windowsHide: true });
        const m = String(r.stdout || "").match(/(\d+\.\d+\.\d+[\w.-]*)/);
        if (m) return m[1];
      }
    }
    if (agent === "workbuddy") {
      const res = IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy", "resources")
        : process.platform === "darwin" ? "/Applications/WorkBuddy.app/Contents/Resources" : "/opt/WorkBuddy/resources";
      const app = C.readJSON(path.join(res, "install-manifest.json"), {}).appVersion;
      const cli = C.readJSON(path.join(res, "app.asar.unpacked", "cli", "package.json"), {}).version;
      if (app || cli) return [app, cli && `cli ${cli}`].filter(Boolean).join(" / ");
    }
    if (agent === "opencode") { const i = opencodeInfo(); return i && i.version; }
  } catch {}
  return null;
}

// ---------- 行为对账：统计会话记录中的工具调用（只计数，不读取/上报内容） ----------
function recentFiles(root, since, ext = ".jsonl", depth = 5, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth > 0) recentFiles(p, since, ext, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(ext)) { try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {} }
    if (out.length > 200) break;
  }
  return out;
}
function sessionToolCalls(agent, since) {
  const roots = { codex: [path.join(process.env.CODEX_HOME || path.join(C.HOME, ".codex"), "sessions")],
    workbuddy: [path.join(C.HOME, ".workbuddy", "projects"), path.join(C.HOME, ".codebuddy", "projects")] }[agent];
  if (!roots) return 0;
  let n = 0;
  for (const r of roots) for (const f of recentFiles(r, since)) {
    let buf;
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, "r"); const len = Math.min(st.size, 8 * 1024 * 1024);
      buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    } catch { continue; }
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"function_call"') || line.includes('"function_call_output"') || line.includes('"function_call_result"')) continue;
      let t = 0;
      const m = line.match(/"timestamp"\s*:\s*("([^"]+)"|(\d{12,}))/);
      if (m) t = m[2] ? Date.parse(m[2]) : Number(m[3]);
      if (t >= since) n++;
    }
  }
  return n;
}

// ---------- 工具名记录 / 已知工具 ----------
const KNOWN = {
  codex: /^(bash|shell|exec_command|local_shell|shell_command|apply_patch|write_stdin|update_plan|view_image|web_search|read_file|list_dir|grep_files|mcp__.+)$/i,
  workbuddy: /^(bash|powershell|shell|execute_command|executecommand|run_command|run_terminal_cmd|exec_command|shell_command|terminalexecutor|cloudstudioexecutecommand|installbinary|bashoutput|killshell|read|readfile|read_file|view|view_file|glob|grep|ls|list_files|search_files|write|edit|multiedit|notebookedit|notebookread|write_to_file|replace_in_file|writefile|editfile|create_file|str_replace_editor|skill|skillmanage|useskill|use_skill|webfetch|websearch|web_fetch|web_search|todowrite|todoread|task|agent|exitplanmode|askuserquestion|mcp__.+)$/i,
  opencode: /^(bash|shell|read|write|edit|multiedit|patch|apply_patch|grep|glob|list|ls|webfetch|websearch|codesearch|todowrite|todoread|task|skill|question|lsp|batch|invalid)$/i,
};
const isKnownTool = (agent, name) => (KNOWN[agent] || /^$/).test(String(name)) ||
  (((C.policy().known_tools || {})[agent]) || []).some((x) => String(x).toLowerCase() === String(name).toLowerCase());

// hook / 插件每次调用时记录工具名（计数 + 首次出现时间）
function recordTool(agent, tool) {
  if (!tool) return;
  try {
    const s = readStatus();
    const t = ((s._tools = s._tools || {})[agent] = s._tools[agent] || {});
    const x = t[tool] || { n: 0, first: Date.now() };
    x.n++; x.last = Date.now();
    t[tool] = x;
    if (Object.keys(t).length > 300) return;   // 防止异常膨胀
    C.writeJSON(STATUS_PATH, s);
  } catch {}
}

module.exports = { recordStatus, readStatus, collect, opencodeInfo, probeOpencode, codexStatus, workbuddyStatus, agentVersion, sessionToolCalls, recordTool, isKnownTool };
