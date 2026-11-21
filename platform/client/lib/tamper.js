"use strict";
// KAIP 自我保护（防篡改）
//  ① 拦截：Agent 试图读取 KAIP 凭据、改/删 KAIP 文件、改 Agent hook 配置、停止监控、卸载 KAIP → 执行前阻断
//  ② 指纹：客户端程序文件与本地策略的 SHA256 指纹随心跳上报，平台与官方包 / 当前策略比对
//  ③ 自愈：客户端文件被改/删、hook 配置被移除时，后台监控自动从平台重新下载、重装、恢复 hook
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const C = require("./common");

const IS_WIN = process.platform === "win32";
const CLIENT = path.join(C.KAIP_HOME, "client");
const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
const HOME_N = norm(C.HOME);

// ---------- ① 篡改行为识别 ----------
// 受保护路径（小写、正斜杠）：KAIP 自身目录 + 各 Agent 的接入配置
function protectedPaths() {
  const cfgHome = norm(process.env.XDG_CONFIG_HOME || path.join(C.HOME, ".config"));
  return [
    { p: norm(C.KAIP_HOME) + "/", what: "KAIP 客户端目录", read: true },
    { p: norm(process.env.CODEX_HOME || path.join(C.HOME, ".codex")) + "/hooks.json", what: "Codex hook 配置" },
    { p: norm(process.env.CODEX_HOME || path.join(C.HOME, ".codex")) + "/config.toml", what: "Codex 配置（hook 开关与信任记录）", writeOnly: true },
    { p: HOME_N + "/.workbuddy/settings.json", what: "WorkBuddy hook 配置", writeOnly: true },
    { p: HOME_N + "/.codebuddy/settings.json", what: "CodeBuddy hook 配置", writeOnly: true },
    { p: cfgHome + "/opencode/plugins/kaip.js", what: "OpenCode KAIP 插件" },
    { p: cfgHome + "/systemd/user/kaip-watch.service", what: "KAIP 监控服务" },
  ];
}

const WRITE_HINT = /(>|\btee\b|\bsed\s+-i|\brm\b|\bunlink\b|\bmv\b|\bcp\b|\bln\b|\bchmod\b|\bchattr\b|\btruncate\b|\bdd\b|\bperl\s+-[pi]|\bpython\d*\b|\bnode\b|\bjq\b.*>|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|\bdel\b|\berase\b|\bren(ame)?\b|\bvi(m)?\b|\bnano\b)/i;
// 不写任何文件的重定向：文件描述符复制（2>&1、>&2）与丢弃输出（2>/dev/null、&>/dev/null、> nul、2>$null）。
// 去掉后再判断写入特征，避免「cat ~/.codex/config.toml 2>&1」这类只读命令被当成修改
function stripHarmlessRedirects(cmd) {
  return String(cmd)
    .replace(/\d*>&\s*(\d+|-)/g, " ")
    .replace(/(&|\d)?>>?\s*(\/dev\/null|nul|\$null)(?![\w./\\-])/gi, " ");
}

// 不涉及路径但会停用防护的命令
const DISABLE_RULES = [
  [/\bkaip(\.js|\.cmd)?\s+(uninstall|enroll|install)\b/i, "卸载或重新配置 KAIP"],
  [/systemctl\s+(--user\s+)?(stop|disable|mask|kill)\s+[^\n;|&]*kaip-watch/i, "停止 KAIP 监控服务"],
  [/schtasks[^\n]*\/(delete|end|change)[^\n]*KAIP-Watch/i, "删除/停止 KAIP 监控计划任务"],
  [/\b(pkill|killall)\b[^\n;|&]*(kaip|node)/i, "结束 KAIP 进程"],
  [/\bkill\b[^\n;|&]*\$\((pgrep|pidof)[^)]*(kaip|watch)/i, "结束 KAIP 进程"],
  [/Stop-Process[^\n]*(kaip|node)/i, "结束 KAIP 进程"],
  [/taskkill[^\n]*(node|kaip)/i, "结束 KAIP 进程"],
  [/(codex_hooks|\[features\][^\n]*hooks)\s*=\s*false|\bhooks\s*=\s*false/i, "关闭 Codex hooks 功能"],
  [/--dangerously-bypass-hook-trust/i, "绕过 Codex hook 信任机制"],
];

// 允许 Agent 调用的只读 KAIP 命令（查看状态、手动扫描）
const SAFE_KAIP_CLI = /^\s*(node\s+\S*kaip\.js|kaip(\.cmd)?)\s+(status|scan|verify|test|help|--help|-h)\b/i;

function checkCommand(cmd) {
  if (!cmd || SAFE_KAIP_CLI.test(cmd)) return null;
  for (const [rx, what] of DISABLE_RULES) if (rx.test(cmd)) return { rule: "disable", desc: what };
  const n = norm(cmd).replace(/(^|[\s"'=(])~(?=\/)/g, `$1${HOME_N}`).replace(/\$home|\$\{home\}|%userprofile%|\$env:userprofile/g, HOME_N);
  for (const pp of protectedPaths()) {
    const rel = pp.p.startsWith(HOME_N) ? pp.p.slice(HOME_N.length) : null;   // 也识别相对主目录写法：.kaip/、/.codex/hooks.json
    const hit = n.includes(pp.p.replace(/\/$/, "")) || (rel && new RegExp(`(^|[\\s"'=(/])${rel.replace(/^\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n));
    if (!hit) continue;
    if (pp.read) return { rule: "access", desc: `访问${pp.what}（含终端凭据与检测规则）` };
    if (!pp.writeOnly || WRITE_HINT.test(stripHarmlessRedirects(cmd))) return { rule: "modify", desc: `修改${pp.what}` };
  }
  return null;
}

function checkPath(p) {
  const n = norm(path.resolve(p));
  for (const pp of protectedPaths()) if (n === pp.p.replace(/\/$/, "") || n.startsWith(pp.p.endsWith("/") ? pp.p : pp.p + "/") || n === pp.p) return { rule: "modify", desc: `修改${pp.what}` };
  return null;
}

// 对归一化后的工具调用做篡改检查；命中返回 {rule, desc, target}
function check(normed) {
  // 任何工具（含 read 类）以 KAIP 自身目录为目标
  if (normed.targetPath) {
    const n = norm(path.resolve(normed.targetPath));
    const k = norm(C.KAIP_HOME);
    if (n === k || n.startsWith(k + "/")) return { rule: "access", desc: "访问KAIP 客户端目录（含终端凭据与检测规则）", target: normed.targetPath };
  }
  for (const f of normed.files || []) {
    if (f.kind === "literal" || f.kind === "code") continue;
    if (f.kind === "write" || f.kind === "edit") { const r = checkPath(f.path); if (r) return { ...r, target: f.path }; }
  }
  if (normed.command) { const r = checkCommand(normed.command); if (r) return { ...r, target: normed.command.slice(0, 300) }; }
  for (const f of normed.files || []) {
    if (f.kind === "code" && f.content) { const r = checkCommand(f.content); if (r) return { ...r, target: f.path }; }
  }
  return null;
}

// ---------- ② 指纹 ----------
function listFiles(dir, base = dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, base, out);
    else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

// 客户端程序指纹：bin/ lib/ adapters/ 下全部脚本（与平台 client 包的同名文件比对）
function manifest(root = CLIENT) {
  const files = [];
  for (const d of ["bin", "lib", "adapters"]) for (const f of listFiles(path.join(root, d), root)) files.push(f);
  files.sort();
  const h = crypto.createHash("sha256");
  const per = {};
  for (const f of files) {
    const fh = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
    per[f] = fh;
    h.update(f + ":" + fh + "\n");
  }
  return { hash: h.digest("hex"), files: per, count: files.length };
}

// 策略指纹：与平台 policy_fingerprint() 规则一致（键排序 JSON，忽略 updated_at）
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).filter((k) => k !== "updated_at").sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return JSON.stringify(v);
}
const policyHash = (p) => crypto.createHash("sha256").update(canon(p || {})).digest("hex");

// ---------- ③ 自愈 ----------
// 最小 tar 解包（ustar，平台生成的 tar.gz 只含普通文件）
function untar(buf, dest) {
  let off = 0, n = 0;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const str = (a, b) => hdr.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = prefix + "/" + name;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(hdr[156] || 48);
    off += 512;
    if ((type === "0" || type === "\0") && name && !name.includes("..")) {
      const p = path.join(dest, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf.subarray(off, off + size));
      n++;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return n;
}

function fetchBuffer(urlPath) {
  const http = require("http"), https = require("https");
  const cfg = C.loadConfig();
  const u = new URL(urlPath, cfg.server);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(u, { rejectUnauthorized: !cfg.insecure_tls, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("下载超时")); });
  });
}

// 从平台重新下载客户端并重装各 Agent 接入；返回修复说明
async function selfHeal(reason) {
  const buf = zlib.gunzipSync(await fetchBuffer("/dl/kaip-client.tar.gz"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaip-heal-"));
  const n = untar(buf, tmp);
  if (n < 5) throw new Error("客户端包不完整");
  for (const d of ["bin", "lib", "adapters", "scripts"]) {
    if (!fs.existsSync(path.join(tmp, d))) continue;
    const copy = (s, t) => {
      fs.mkdirSync(t, { recursive: true });
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        if (e.isDirectory()) copy(path.join(s, e.name), path.join(t, e.name));
        else fs.writeFileSync(path.join(t, e.name), fs.readFileSync(path.join(s, e.name)), { mode: 0o755 });
      }
    };
    copy(path.join(tmp, d), path.join(CLIENT, d));
  }
  try { fs.copyFileSync(path.join(tmp, "package.json"), path.join(CLIENT, "package.json")); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  // 用恢复后的安装器重装 hook / 插件（Codex hooks.json 内容不变，信任记录保持有效）
  const agents = (C.loadConfig().agents || []).filter(Boolean);
  for (const k of Object.keys(require.cache)) if (k.startsWith(CLIENT)) delete require.cache[k];
  const report = require(path.join(CLIENT, "lib", "install.js")).install(agents, { watcher: false });
  C.log("WARN", "自愈完成", { reason, files: n, agents, report });
  return { files: n, agents, report };
}

module.exports = { check, checkCommand, checkPath, manifest, policyHash, canon, selfHeal, untar, protectedPaths };
