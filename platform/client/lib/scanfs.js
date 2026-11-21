"use strict";
// 本地文件/目录扫描、增量索引、本地隔离
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./common");

const SCAN_EXT = new Set([
  // 脚本
  ".py", ".js", ".mjs", ".cjs", ".ts", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".bat", ".cmd", ".vbs", ".rb", ".pl", ".php",
  // 模型
  ".pkl", ".pickle", ".pt", ".pth", ".ckpt", ".bin", ".joblib", ".keras", ".kers", ".h5", ".safetensors", ".gguf", ".onnx", ".npy", ".npz",
  // 包/可执行/文档
  ".zip", ".tar", ".gz", ".tgz", ".whl", ".jar", ".exe", ".dll", ".so", ".dylib", ".msi", ".node", ".skill",
  ".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pdf", ".doc", ".xls", ".rtf",
  // 数据集
  ".jsonl", ".parquet", ".csv",
]);
const SPECIAL = new Set(["skill.md", "package.json", "setup.py", "pyproject.toml", "makefile", "dockerfile", "manifest.json", "plugin.json"]);
const SKIP_DIRS = new Set([".git", "__pycache__", ".venv", "venv", ".cache-kaip", ".DS_Store"]);
const MODEL_EXT = new Set([".pkl", ".pickle", ".pt", ".pth", ".ckpt", ".bin", ".joblib", ".keras", ".kers", ".h5", ".safetensors", ".gguf", ".onnx", ".npy", ".npz"]);

// AI Agent 自身的会话记录 / 日志（内容为执行过的命令文本），以及 KAIP 自身目录：不扫描
const AGENT_STATE_RX = /[\\/](\.codex[\\/](sessions|archived_sessions|log|logs)|\.kaip|\.local[\\/]share[\\/]opencode[\\/](storage|log|snapshot))([\\/]|$)/i;

function interesting(p) {
  if (AGENT_STATE_RX.test(p)) return false;
  const b = path.basename(p).toLowerCase();
  if (SPECIAL.has(b)) return true;
  const ext = path.extname(b);
  if (SCAN_EXT.has(ext)) return true;
  // 无扩展名的大文件可能是模型 blob（如 ollama blobs/sha256-xxx）
  return !ext && /^sha256[-:]/.test(b);
}

function category(p) {
  const ext = path.extname(p).toLowerCase();
  if (MODEL_EXT.has(ext) || /blobs[\\/]sha256/.test(p)) return "model";
  if (/[\\/]skills?[\\/]|[\\/]plugins?[\\/]/i.test(p)) return "skill";
  if ([".jsonl", ".parquet", ".csv"].includes(ext)) return "dataset";
  return "file";
}

function walk(root, { since = 0, maxFiles = 5000, maxDepth = 12 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  while (stack.length && out.length < maxFiles) {
    const [dir, depth] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !AGENT_STATE_RX.test(p) && depth < maxDepth) stack.push([p, depth + 1]); continue; }
      if (!e.isFile() || !interesting(p)) continue;
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs >= since) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {}
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

// 隔离：移动到 ~/.kaip/quarantine，并做 XOR 混淆，防止误执行
function quarantine(p, info) {
  try {
    const data = fs.readFileSync(p);
    const x = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) x[i] = data[i] ^ 0xaa;
    const base = path.join(C.QUAR_DIR, `${Date.now()}_${(info.sha256 || "").slice(0, 16)}_${path.basename(p)}`);
    fs.writeFileSync(base + ".q", x);
    fs.writeFileSync(base + ".json", JSON.stringify({ original: p, ...info, ts: new Date().toISOString() }, null, 2));
    fs.unlinkSync(p);
    C.log("WARN", "已隔离文件", { path: p, detection: info.detection });
    return true;
  } catch (e) {
    C.log("ERROR", "隔离失败", { path: p, err: e.message });
    return false;
  }
}

// 扫描单个本地文件（增量 + 缓存），返回服务端判定
async function scanFile(p, { agentType = "-", source = "watcher", doQuarantine = true, force = false } = {}) {
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (!st.isFile() || st.size === 0) return null;
  const idx = C.pathIdx();
  const prev = idx[p];
  if (!force && prev && prev.m === st.mtimeMs && prev.s === st.size && prev.v === "CLEAN" && C.cacheValid({ v: "CLEAN", t: prev.t || 0, b: prev.b })) return { verdict: "CLEAN", cached: true };
  let sha;
  try { sha = await C.sha256File(p); }
  catch (e) {
    if (!["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
    // 文件被占用或已被本机终端杀软锁定/拦截
    const r = { path: p, verdict: "NON_SCANNED", reason: "ACCESS DENIED（文件被占用或已被本机杀软拦截）", action: "alert" };
    if (!prev || prev.v !== "NON_SCANNED" || prev.m !== st.mtimeMs) {
      C.request("POST", "/api/v1/agent/report", { json: { agent_type: agentType, category: category(p), action: "alert", object: p, verdict: "NON_SCANNED", detection: "", details: { reason: r.reason, code: e.code } } }).catch(() => {});
      idx[p] = { m: st.mtimeMs, s: st.size, v: "NON_SCANNED" };
    }
    return r;
  }
  const hit = !force && C.cacheGet(sha);
  let r;
  if (hit) r = { verdict: hit.v, action: hit.a, detection: hit.d, sha256: sha, cached: true };
  else {
    r = await C.uploadFile(p, { path: p, category: category(p), agent_type: agentType, source });
    C.setBases(r.bases_version);
    C.cachePut(sha, r.verdict, r.action, r.detection);
  }
  idx[p] = { m: st.mtimeMs, s: st.size, v: r.verdict, h: sha, t: Date.now(), b: C.basesVersion() };
  // 只隔离引擎确认的威胁（DETECT）；启发式 RISK 不移动用户文件，执行时由 Hook 阻断
  if (r.action === "block" && r.verdict === "DETECT" && doQuarantine && C.policy().quarantine_on_detect !== false) {
    r.local_quarantined = quarantine(p, { sha256: sha, detection: r.detection, verdict: r.verdict });
    delete idx[p];
  }
  return { path: p, ...r };
}

async function scanPaths(files, opts = {}) {
  const results = [];
  for (const f of files) {
    try {
      const r = await scanFile(f.path || f, opts);
      if (r) results.push(r);
    } catch (e) {
      results.push({ path: f.path || f, verdict: "ERROR", action: C.policy().fail_open === false ? "block" : "allow", error: e.message });
      if (e.code === "ECONNREFUSED" || /超时|ENOTFOUND|ECONNRESET/.test(e.message)) break; // 平台不可达，停止批量
    }
  }
  C.savePathIdx();
  return results;
}

function watchRoots(agentTypes) {
  const wp = C.policy().watch_paths || {};
  const roots = new Set();
  for (const k of ["common", ...(agentTypes || Object.keys(wp))]) for (const p of wp[k] || []) roots.add(path.resolve(C.expandHome(p)));
  return [...roots].filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

module.exports = { walk, scanFile, scanPaths, quarantine, interesting, category, watchRoots, MODEL_EXT };
