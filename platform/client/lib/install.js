"use strict";
// 把 KAIP 接入各 AI Agent：Codex(hooks.json) / WorkBuddy·CodeBuddy(settings.json hooks) / OpenCode(插件)
// 并安装目录监控服务（Windows 计划任务 / Linux systemd 用户服务）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const C = require("./common");

const IS_WIN = process.platform === "win32";
const CLIENT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(C.KAIP_HOME, "bin");
const H = C.HOME;
const MARK = "kaip-hook";

const P = {
  codexDir: process.env.CODEX_HOME || path.join(H, ".codex"),
  opencodeDir: path.join(process.env.XDG_CONFIG_HOME || path.join(H, ".config"), "opencode"),
  workbuddyDirs: [path.join(H, ".workbuddy"), path.join(H, ".codebuddy")],
};

function onPath(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

function detectAgents() {
  const found = [];
  if (fs.existsSync(P.codexDir) || onPath("codex")) found.push("codex");
  if (fs.existsSync(P.opencodeDir) || onPath("opencode") || (IS_WIN && fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "ai.opencode.desktop")))) found.push("opencode");
  if (P.workbuddyDirs.some((d) => fs.existsSync(d)) || onPath("codebuddy") || (IS_WIN && fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy")))) found.push("workbuddy");
  return found;
}

function backupOnce(p) {
  if (fs.existsSync(p) && !fs.existsSync(p + ".kaip.bak")) fs.copyFileSync(p, p + ".kaip.bak");
}

// 生成不含空格问题的包装脚本，作为 hook 命令
// 客户端统一同步到 ~/.kaip/client，hook/插件/服务都引用这份副本
const INSTALLED = path.join(C.KAIP_HOME, "client");
function syncClient() {
  if (path.resolve(CLIENT_DIR).toLowerCase() === path.resolve(INSTALLED).toLowerCase()) return INSTALLED;
  fs.mkdirSync(INSTALLED, { recursive: true });
  // 不用 fs.cpSync：Node 24 在 Windows 上源路径含中文时会直接崩溃
  const copyDir = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
    }
  };
  for (const d of ["bin", "lib", "adapters", "scripts"]) copyDir(path.join(CLIENT_DIR, d), path.join(INSTALLED, d));
  fs.copyFileSync(path.join(CLIENT_DIR, "package.json"), path.join(INSTALLED, "package.json"));
  return INSTALLED;
}

function writeWrappers() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  // node 路径含非 ASCII 字符时退回 PATH 中的 node，避免 cmd 代码页问题
  const node = /[^\x20-\x7e]/.test(process.execPath) ? "node" : process.execPath;
  const hookJs = path.join(INSTALLED, "bin", "kaip-hook.js");
  const cliJs = path.join(INSTALLED, "bin", "kaip.js");
  if (IS_WIN) {
    // %~dp0 由 cmd 自行解析，路径含中文用户名时也正确
    fs.writeFileSync(path.join(BIN_DIR, "kaip-hook.cmd"), `@echo off\r\n"${node}" "%~dp0..\\client\\bin\\kaip-hook.js" %*\r\n`);
    fs.writeFileSync(path.join(BIN_DIR, "kaip.cmd"), `@echo off\r\n"${node}" "%~dp0..\\client\\bin\\kaip.js" %*\r\n`);
    // VBS 使用 UTF-16LE 保存以支持 Unicode 路径
    const vbs = `CreateObject("WScript.Shell").Run """${node}"" ""${cliJs}"" watch", 0, False\r\n`;
    fs.writeFileSync(path.join(BIN_DIR, "kaip-watch.vbs"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, "utf16le")]));
  } else {
    const sh = (js) => `#!/bin/sh\nexec "${node}" "${js}" "$@"\n`;
    fs.writeFileSync(path.join(BIN_DIR, "kaip-hook"), sh(hookJs), { mode: 0o755 });
    fs.writeFileSync(path.join(BIN_DIR, "kaip"), sh(cliJs), { mode: 0o755 });
  }
}

// hook 命令统一写成 `node "<正斜杠绝对路径>" --agent X`：
// 同一字符串在 cmd / PowerShell / bash 下都能执行（WorkBuddy 在 Windows 上也用 bash 执行 hook，反斜杠会被吞掉）。
// 标记串 kaip-hook 用于卸载/重装时识别本产品的条目。
function hookCmd(agent) {
  const js = path.join(INSTALLED, "bin", "kaip-hook.js").split("\\").join("/");
  // 使用 KAIP 私有 Node 运行时（离线安装、终端原本无 Node）时写绝对路径；系统已有 Node 时保持 `node`，
  // 避免 hook 命令变化导致 Codex 已有的信任记录失效
  const priv = path.join(C.KAIP_HOME, "node");
  if (process.execPath.toLowerCase().startsWith(priv.toLowerCase())) {
    const exe = process.execPath.split("\\").join("/");
    return `${/\s/.test(exe) ? `"${exe}"` : exe} "${js}" --agent ${agent}`;
  }
  return `node "${js}" --agent ${agent}`;
}

// Claude 风格 hooks 结构合并：先移除旧的 KAIP 条目再添加
function mergeHooks(hooksObj, agent, defs) {
  hooksObj = hooksObj || {};
  for (const ev of Object.keys(hooksObj)) {
    hooksObj[ev] = (hooksObj[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || "").includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (!hooksObj[ev].length) delete hooksObj[ev];
  }
  for (const [ev, matcher, timeout, msg] of defs) {
    const entry = { type: "command", command: hookCmd(agent), timeout };
    if (msg) entry.statusMessage = msg;
    const g = { hooks: [entry] };
    if (matcher) g.matcher = matcher;
    (hooksObj[ev] = hooksObj[ev] || []).push(g);
  }
  return hooksObj;
}

function removeHooks(hooksObj) {
  return mergeHooks(hooksObj, "", []);
}

// ---------- Codex ----------
function installCodex() {
  fs.mkdirSync(P.codexDir, { recursive: true });
  const hf = path.join(P.codexDir, "hooks.json");
  backupOnce(hf);
  const cur = C.readJSON(hf, {});
  cur.hooks = mergeHooks(cur.hooks, "codex", [
    ["PreToolUse", ".*", 120, "Kaspersky AI Protect 安全检查"],
    ["PostToolUse", "^(Bash|shell|exec_command|local_shell)$", 600, "Kaspersky AI Protect 扫描新增文件"],
    ["SessionStart", null, 300, "Kaspersky AI Protect 检查 Skills"],
  ]);
  C.writeJSON(hf, cur);
  // 启用 hooks 功能开关
  const tf = path.join(P.codexDir, "config.toml");
  backupOnce(tf);
  let t = fs.existsSync(tf) ? fs.readFileSync(tf, "utf8") : "";
  // 新版 Codex 的开关为 [features] hooks；codex_hooks 是旧别名（会告警），一并迁移
  t = t.replace(/^\s*codex_hooks\s*=.*\r?\n?/m, "");
  const fm = t.match(/^\[features\][^\S\r\n]*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (fm && /^\s*hooks\s*=/m.test(fm[1])) {
    const body = fm[1].replace(/^(\s*hooks\s*=\s*).*$/m, "$1true");
    t = t.replace(fm[0], fm[0].replace(fm[1], body));
  } else if (fm) {
    t = t.replace(/^\[features\][^\S\r\n]*$/m, "[features]\nhooks = true");
  } else {
    t = t.replace(/\s*$/, "") + (t ? "\n\n" : "") + "[features]\nhooks = true\n";
  }
  fs.writeFileSync(tf, t);
  return [hf, tf];
}
function uninstallCodex() {
  const hf = path.join(P.codexDir, "hooks.json");
  if (!fs.existsSync(hf)) return [];
  const cur = C.readJSON(hf, {});
  cur.hooks = removeHooks(cur.hooks);
  C.writeJSON(hf, cur);
  return [hf];
}

// ---------- WorkBuddy / CodeBuddy ----------
// WorkBuddy 内置 agent 的技能 / 命令执行 / 写文件类工具名（matcher 为正则）
const WB_SKILL = "Skill|skill|SkillManage|skillmanage|UseSkill|useskill|use_skill";
const WB_EXEC = "Bash|bash|PowerShell|powershell|Shell|shell|execute_command|ExecuteCommand|run_command|run_terminal_cmd|exec_command|shell_command|TerminalExecutor|CloudStudioExecuteCommand|InstallBinary";
const WB_WRITE = "Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_in_file|WriteFile|EditFile|create_file|str_replace_editor";
// 读取类工具：用于防篡改（阻止通过内置读文件工具读取 KAIP 凭据/规则），非 KAIP 路径在本地快速放行
const WB_READ = "Read|read|ReadFile|read_file|View|view|view_file|Glob|Grep|LS|list_files|search_files";
// 可执行代码的 MCP 工具（REPL / Notebook / 代码解释器），只匹配这类，避免普通 MCP 调用都拉起检查进程
const WB_MCP_CODE = "mcp__.*(repl|exec|eval|python|javascript|_js|code|notebook|jupyter|shell|terminal|command).*";
const WB_DEFS = [
  // 全量匹配：Agent 升级新增的工具也会经过 KAIP（判定 + 新工具上报）；非敏感调用在本地快速放行
  ["PreToolUse", ".*", 120, null],
  ["PostToolUse", `^(${WB_EXEC})$`, 600, null],
  ["SessionStart", null, 300, null],
];
function installWorkbuddy() {
  const files = [];
  const dirs = P.workbuddyDirs.filter((d) => fs.existsSync(d));
  for (const d of dirs.length ? dirs : [P.workbuddyDirs[0]]) {
    fs.mkdirSync(d, { recursive: true });
    const sf = path.join(d, "settings.json");
    backupOnce(sf);
    const cur = C.readJSON(sf, {});
    cur.hooks = mergeHooks(cur.hooks, "workbuddy", WB_DEFS);
    C.writeJSON(sf, cur);
    files.push(sf);
  }
  return files;
}
function uninstallWorkbuddy() {
  const files = [];
  for (const d of P.workbuddyDirs) {
    const sf = path.join(d, "settings.json");
    if (!fs.existsSync(sf)) continue;
    const cur = C.readJSON(sf, {});
    cur.hooks = removeHooks(cur.hooks);
    C.writeJSON(sf, cur);
    files.push(sf);
  }
  return files;
}

// ---------- OpenCode ----------
// OpenCode 1.x 与 2.x 插件 API 不兼容，按本机版本选择模板（默认 2.x）
function opencodeMajor() {
  if (process.env.KAIP_OPENCODE_API) return parseInt(process.env.KAIP_OPENCODE_API.replace(/\D/g, ""), 10) || 2;
  const info = require("./status").opencodeInfo();
  return info ? info.major : 2;
}

function installOpencode() {
  const dir = path.join(P.opencodeDir, "plugins");
  fs.mkdirSync(dir, { recursive: true });
  const major = opencodeMajor();
  const tpl = fs.readFileSync(path.join(INSTALLED, "adapters", "opencode", major >= 2 ? "kaip.v2.js" : "kaip.v1.js"), "utf8");
  const f = path.join(dir, "kaip.js");
  fs.writeFileSync(f, tpl.split("__KAIP_CLIENT__").join(INSTALLED.replace(/\\/g, "/")));
  return [f];
}
function uninstallOpencode() {
  const f = path.join(P.opencodeDir, "plugins", "kaip.js");
  if (fs.existsSync(f)) { fs.unlinkSync(f); return [f]; }
  return [];
}

// ---------- 目录监控服务 ----------
function installWatcher() {
  try {
    if (IS_WIN) {
      const vbs = path.join(BIN_DIR, "kaip-watch.vbs");
      execFileSync("schtasks", ["/Create", "/F", "/TN", "KAIP-Watch", "/SC", "ONLOGON", "/RL", "LIMITED", "/TR", `wscript.exe "${vbs}"`], { stdio: "ignore" });
      spawnSync("schtasks", ["/Run", "/TN", "KAIP-Watch"], { stdio: "ignore" });
      return "Windows 计划任务 KAIP-Watch（登录时启动）";
    }
    if (process.platform === "linux" && onPath("systemctl")) {
      const ud = path.join(H, ".config", "systemd", "user");
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, "kaip-watch.service"),
        `[Unit]\nDescription=Kaspersky AI Protect - AI Agent 目录监控\nAfter=network-online.target\n\n[Service]\nExecStart="${process.execPath}" "${path.join(INSTALLED, "bin", "kaip.js")}" watch\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`);
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      const r = spawnSync("systemctl", ["--user", "enable", "--now", "kaip-watch.service"], { stdio: "ignore" });
      spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "ignore" });
      if (r.status === 0) return "systemd 用户服务 kaip-watch.service";
    }
    // 兜底：crontab @reboot
    const line = `@reboot "${process.execPath}" "${path.join(INSTALLED, "bin", "kaip.js")}" watch >/dev/null 2>&1 # kaip-watch`;
    const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" }).stdout || "";
    if (!cur.includes("kaip-watch")) spawnSync("crontab", ["-"], { input: cur + line + "\n" });
    require("child_process").spawn(process.execPath, [path.join(INSTALLED, "bin", "kaip.js"), "watch"], { detached: true, stdio: "ignore" }).unref();
    return "crontab @reboot + 已后台启动";
  } catch (e) {
    return "监控服务安装失败：" + e.message + "（可手动运行 kaip watch）";
  }
}
function uninstallWatcher() {
  if (IS_WIN) { spawnSync("schtasks", ["/End", "/TN", "KAIP-Watch"], { stdio: "ignore" }); spawnSync("schtasks", ["/Delete", "/F", "/TN", "KAIP-Watch"], { stdio: "ignore" }); return; }
  spawnSync("systemctl", ["--user", "disable", "--now", "kaip-watch.service"], { stdio: "ignore" });
  try { fs.unlinkSync(path.join(H, ".config", "systemd", "user", "kaip-watch.service")); } catch {}
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" }).stdout || "";
  if (cur.includes("kaip-watch")) spawnSync("crontab", ["-"], { input: cur.split("\n").filter((l) => !l.includes("kaip-watch")).join("\n") });
}

const INSTALLERS = { codex: [installCodex, uninstallCodex], opencode: [installOpencode, uninstallOpencode], workbuddy: [installWorkbuddy, uninstallWorkbuddy] };

function install(agents, { watcher = true } = {}) {
  syncClient();
  writeWrappers();
  const report = [];
  for (const a of agents) {
    if (!INSTALLERS[a]) { report.push(`未知 Agent：${a}`); continue; }
    try { report.push(`✔ ${a}: ${INSTALLERS[a][0]().join(", ")}`); } catch (e) { report.push(`✘ ${a}: ${e.message}`); }
  }
  const cfg = C.loadConfig();
  cfg.agents = agents;
  cfg.client_dir = INSTALLED;
  C.saveConfig(cfg);
  if (watcher) report.push("✔ 目录监控：" + installWatcher());
  return report;
}

// 结束正在运行的后台监控进程（crontab / Windows 计划任务 / docker exec -d 方式下，移除服务不会结束已在运行的进程）
function stopWatchProcess(report) {
  try {
    const [pidStr, host] = fs.readFileSync(path.join(C.KAIP_HOME, "watch.pid"), "utf8").trim().split("@");
    const pid = parseInt(pidStr, 10);
    if (!pid || pid === process.pid || host !== os.hostname()) return;
    let isWatch;   // 防止 PID 被系统复用后误杀其他进程
    if (process.platform === "linux") { try { isWatch = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("watch"); } catch { isWatch = false; } }
    else if (IS_WIN) isWatch = /node/i.test(spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }).stdout || "");
    else isWatch = true;
    if (isWatch) { try { process.kill(pid); report.push(`✔ 已结束后台监控进程 ${pid}`); } catch {} }
  } catch {}
}

function uninstall() {
  const report = [];
  // 先停监控进程并清空接入列表：否则仍在运行的监控进程会把「hook 被移除」当作篡改，在下一次心跳时自愈重装
  stopWatchProcess(report);
  if (fs.existsSync(C.CONFIG_PATH)) { const cfg = C.loadConfig(); cfg.agents = []; C.saveConfig(cfg); }
  for (const [a, [, un]] of Object.entries(INSTALLERS)) { try { const f = un(); if (f.length) report.push(`✔ 已移除 ${a}: ${f.join(", ")}`); } catch (e) { report.push(`✘ ${a}: ${e.message}`); } }
  uninstallWatcher();
  report.push("✔ 已移除目录监控服务");
  return report;
}

// 彻底清理（kaip uninstall --purge，须在 uninstall() 之后调用）：
// 结束后台监控进程 → 移除 PATH → 删除 KAIP 安装时留下的配置备份 → 删除 ~/.kaip（终端凭据、日志、私有运行时、本地隔离区）
// 不改动 Codex config.toml 中的 [features] hooks = true（hook 已移除，该开关无副作用，且可能被用户其他 hook 使用）
function purge() {
  const report = [];
  const home = path.resolve(C.KAIP_HOME);

  // 1. 后台监控进程（uninstall() 已结束过，这里兜底）
  stopWatchProcess(report);

  // 2. PATH
  if (IS_WIN) {
    const bin = path.join(home, "bin");
    const ps = `$b='${bin.replace(/'/g, "''")}';$p=[Environment]::GetEnvironmentVariable('Path','User');` +
      `if($p){$n=(($p -split ';') | Where-Object { $_ -and $_ -ne $b }) -join ';';if($n -ne $p){[Environment]::SetEnvironmentVariable('Path',$n,'User');'changed'}}`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
    if ((r.stdout || "").includes("changed")) report.push(`✔ 已从用户 PATH 移除 ${bin}`);
  } else {
    for (const rc of [".bashrc", ".zshrc", ".profile"].map((f) => path.join(H, f))) {
      let t; try { t = fs.readFileSync(rc, "utf8"); } catch { continue; }
      const kept = t.split("\n").filter((l) => !(/\.kaip\/bin/.test(l) && /\bPATH\b/.test(l)));
      if (kept.length !== t.split("\n").length) { fs.writeFileSync(rc, kept.join("\n")); report.push(`✔ 已从 ${rc} 移除 PATH 设置`); }
    }
  }

  // 3. 安装时的配置备份（首次安装时的快照，不用于恢复，避免覆盖安装后用户的修改）
  const baks = [path.join(P.codexDir, "hooks.json.kaip.bak"), path.join(P.codexDir, "config.toml.kaip.bak"),
    ...P.workbuddyDirs.map((d) => path.join(d, "settings.json.kaip.bak"))].filter((f) => fs.existsSync(f));
  for (const f of baks) { try { fs.unlinkSync(f); } catch {} }
  if (baks.length) report.push(`✔ 已删除配置备份：${baks.join(", ")}`);

  // 4. ~/.kaip：确认是 KAIP 目录后才删除，防止 KAIP_HOME 被误设为主目录等
  const looksLikeKaip = home !== path.resolve(H) && path.parse(home).root !== home &&
    (fs.existsSync(path.join(home, "config.json")) || fs.existsSync(path.join(home, "client")));
  if (!fs.existsSync(home)) { /* 已不存在 */ }
  else if (!looksLikeKaip) report.push(`⚠ 未删除 ${home}：不像 KAIP 目录，请手动确认`);
  else if (IS_WIN) {
    // 当前进程（node.exe / kaip.cmd）可能就在该目录下运行，退出后再删
    const { spawn } = require("child_process");
    // windowsVerbatimArguments：否则 Node 会把引号转义成 \"，cmd 无法识别带空格的路径
    spawn("cmd.exe", ["/d", "/s", "/c", `"ping -n 4 127.0.0.1 >nul & rmdir /s /q "${home}""`],
      { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
    report.push(`✔ ${home} 将在命令结束后几秒内删除`);
  } else {
    fs.rmSync(home, { recursive: true, force: true });
    report.push(`✔ 已删除 ${home}（终端凭据、日志、私有运行时、本地隔离区）`);
  }
  report.push("ℹ Codex config.toml 中的 [features] hooks = true 未改动（无副作用，如需可手动删除）");
  return report;
}

module.exports = { install, uninstall, purge, detectAgents, P, mergeHooks, CLIENT_DIR, BIN_DIR };
