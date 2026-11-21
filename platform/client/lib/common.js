"use strict";
// KAIP 客户端公共模块：配置、日志、HTTP（零依赖，Windows / Linux / macOS 通用）
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const VERSION = "1.0.0";
const HOME = os.homedir();
const KAIP_HOME = process.env.KAIP_HOME || path.join(HOME, ".kaip");
const CONFIG_PATH = path.join(KAIP_HOME, "config.json");
const CACHE_PATH = path.join(KAIP_HOME, "cache.json");
const LOG_DIR = path.join(KAIP_HOME, "logs");
const QUAR_DIR = path.join(KAIP_HOME, "quarantine");
const PENDING_DIR = path.join(KAIP_HOME, "pending");

for (const d of [KAIP_HOME, LOG_DIR, QUAR_DIR, PENDING_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

function readJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); } catch { return def; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function loadConfig() { return readJSON(CONFIG_PATH, {}); }
function saveConfig(c) {
  writeJSON(CONFIG_PATH, c);
  if (process.platform !== "win32") { try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {} }
}

function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] [pid ${process.pid}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`;
  try {
    const f = path.join(LOG_DIR, "kaip.log");
    try { if (fs.statSync(f).size > 10 * 1024 * 1024) fs.renameSync(f, f + ".1"); } catch {}
    fs.appendFileSync(f, line);
  } catch {}
  if (process.env.KAIP_DEBUG) process.stderr.write(line);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(HOME, p.slice(2));
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || "").replace(/\$\{?([A-Z_]+)\}?/g, (m, v) => process.env[v] ?? m);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(p).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}
const sha256Buf = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---------- HTTP ----------
function request(method, urlPath, { json, headers = {}, body, timeoutMs = 30000, raw = false } = {}) {
  const cfg = loadConfig();
  if (!cfg.server) return Promise.reject(new Error("客户端未注册（缺少 server），请先运行 kaip enroll"));
  const u = new URL(urlPath, cfg.server);
  const mod = u.protocol === "https:" ? https : http;
  const h = { "User-Agent": `kaip-client/${VERSION}`, ...headers };
  if (cfg.agent_id && cfg.agent_token) {
    h["X-KAIP-Agent"] = cfg.agent_id;
    h["Authorization"] = "Bearer " + cfg.agent_token;
  }
  let payload = null;
  if (json !== undefined) { payload = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; h["Content-Length"] = payload.length; }
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: h, rejectUnauthorized: !cfg.insecure_tls, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        if (raw) return resolve({ status: res.statusCode, body: txt });
        let data; try { data = JSON.parse(txt); } catch { data = { detail: txt }; }
        if (res.statusCode >= 400) { const e = new Error(`HTTP ${res.statusCode}: ${data.detail || txt.slice(0, 200)}`); e.status = res.statusCode; return reject(e); }
        resolve(data);
      });
    });
    req.on("timeout", () => req.destroy(new Error("请求平台超时")));
    req.on("error", reject);
    if (body) { body.pipe(req); body.on("error", (e) => req.destroy(e)); }
    else { if (payload) req.write(payload); req.end(); }
  });
}

// 流式 multipart 上传（大模型文件不进内存）
function uploadFile(filePath, fields = {}, timeoutMs = 30 * 60 * 1000) {
  const { PassThrough } = require("stream");
  const boundary = "----kaip" + crypto.randomBytes(12).toString("hex");
  const pt = new PassThrough();
  const name = path.basename(filePath).replace(/"/g, "");
  let pre = "";
  for (const [k, v] of Object.entries(fields)) pre += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  pre += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const post = `\r\n--${boundary}--\r\n`;
  const size = fs.statSync(filePath).size;
  const len = Buffer.byteLength(pre) + size + Buffer.byteLength(post);
  pt.write(pre);
  const rs = fs.createReadStream(filePath);
  rs.on("error", (e) => pt.destroy(e));
  rs.on("end", () => pt.end(post));
  rs.pipe(pt, { end: false });
  return request("POST", "/api/v1/agent/scan", {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": len }, body: pt, timeoutMs,
  });
}

// ---------- 判定缓存 ----------
// 以文件 SHA-256 为键，按平台病毒库版本失效：版本不变即有效，平台通知新版本（心跳 / 判定响应）后全部作废。
// 兜底有效期 7 天（KSN 云信誉不随病毒库更新变化）；尚未获知病毒库版本时退回 24 小时。
const CACHE_MAX_MS = 7 * 86400e3;
const CACHE_NO_BASES_MS = 86400e3;
const META = "_meta";
let _cache = null;
function cache() {
  if (!_cache) _cache = readJSON(CACHE_PATH, {});
  if (!_cache[META] || typeof _cache[META] !== "object") _cache[META] = { bases: null };
  return _cache;
}
function basesVersion() { return cache()[META].bases || null; }
// 平台告知当前病毒库版本；变化时清空本地判定缓存。返回是否发生变化。
function setBases(v) {
  if (!v) return false;
  _cache = null;                                   // 重新读取，合并其他进程（hook / watch）写入的条目
  const c = cache();
  if (c[META].bases === v) return false;
  const old = c[META].bases;
  for (const k of Object.keys(c)) if (k !== META) delete c[k];
  c[META] = { bases: v, changed_at: Date.now() };
  try { writeJSON(CACHE_PATH, c); } catch {}
  if (old) log("INFO", "病毒库已更新，本地判定缓存已失效", { from: old, to: v });
  return true;
}
function cacheValid(e, bases = basesVersion(), now = Date.now()) {
  if (!e || (e.v !== "CLEAN" && e.v !== "DETECT")) return false;
  const age = now - e.t;
  return bases ? e.b === bases && age < CACHE_MAX_MS : age < CACHE_NO_BASES_MS;
}
function cacheGet(sha) { const e = cache()[sha]; return sha !== META && cacheValid(e) ? e : null; }
function cachePut(sha, verdict, action, detection) {
  // 只缓存引擎确认的结论；启发式 RISK / NON_SCANNED 随规则与策略变化，每次重新判定
  if (verdict !== "CLEAN" && verdict !== "DETECT") return;
  const c = cache();
  c[sha] = { v: verdict, a: action, d: detection || "", t: Date.now(), b: basesVersion() };
  const keys = Object.keys(c).filter((k) => k !== META);
  if (keys.length > 50000) keys.sort((a, b) => c[a].t - c[b].t).slice(0, 10000).forEach((k) => delete c[k]);
  try { writeJSON(CACHE_PATH, c); } catch {}
}
// 路径级缓存：path -> mtime/size/sha，用于目录增量扫描
const PATHIDX = path.join(KAIP_HOME, "pathidx.json");
let _pidx = null;
function pathIdx() { if (!_pidx) _pidx = readJSON(PATHIDX, {}); return _pidx; }
function savePathIdx() { try { writeJSON(PATHIDX, pathIdx()); } catch {} }

function policy() {
  return loadConfig().policy || { mode: "enforce", fail_open: true, block_non_scanned: true, max_inline_scan_mb: 50,
    scan_on_write: true, scan_on_exec: true, scan_skills_on_session_start: true, install_action: "scan", watch_paths: {} };
}

module.exports = {
  VERSION, HOME, KAIP_HOME, CONFIG_PATH, LOG_DIR, QUAR_DIR, PENDING_DIR,
  readJSON, writeJSON, loadConfig, saveConfig, log, expandHome, sha256File, sha256Buf,
  request, uploadFile, cacheGet, cachePut, cacheValid, setBases, basesVersion, pathIdx, savePathIdx, policy,
};
