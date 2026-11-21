"use strict";
// 常驻监控：心跳/策略同步 + Skills/插件/模型目录实时监控（覆盖绕过 Agent 直接安装的组件）
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("./common");
const S = require("./scanfs");

const HEARTBEAT_MS = 60 * 1000;
const FULLSCAN_MS = 15 * 60 * 1000;

const report = (ev) => C.request("POST", "/api/v1/agent/report", { json: ev, timeoutMs: 10000 }).catch(() => {});

async function heartbeat({ forceProbe = false, heal = false } = {}) {
  const cfg = C.loadConfig();
  const T = require("./tamper");
  let agentStatus = {};
  try { agentStatus = require("./status").collect(cfg.agents, { forceProbe }); } catch (e) { C.log("WARN", "防护状态采集失败", { err: e.message }); }
  let man = { hash: "", files: {} };
  try { man = T.manifest(); } catch (e) { C.log("WARN", "客户端指纹计算失败", { err: e.message }); }
  let changed = false;
  try {
    const r = await C.request("POST", "/api/v1/agent/heartbeat", {
      json: { client_version: C.VERSION, agents: cfg.agents || [], policy_version: (cfg.policy || {}).version || 0, agent_status: agentStatus,
        client_hash: man.hash, client_files: man.files, policy_hash: T.policyHash(cfg.policy) },
      timeoutMs: 60000,
    });
    C.setBases(r.bases_version);   // 病毒库更新：本地判定缓存失效，下一轮定期全量扫描（15 分钟）按新病毒库重新判定
    if (r.policy) {
      const c2 = C.loadConfig();
      const tampered = r.tamper && r.tamper.policy && (c2.policy || {}).version === r.policy.version;   // 同版本不同内容 = 本地被改
      c2.policy = r.policy;
      C.saveConfig(c2);
      C.log(tampered ? "WARN" : "INFO", tampered ? "本地策略被修改，已用平台策略覆盖" : "策略已更新", { version: r.policy.version });
      changed = true;
    }
    // 自愈：客户端文件被改/删（平台比对官方包），或 hook / 插件配置被移除（本地状态探测）
    const pol = C.loadConfig().policy || {};
    const missing = Object.entries(agentStatus).filter(([, s]) => s.state === "missing").map(([a]) => a);
    if (heal || (pol.self_heal !== false && ((r.tamper && r.tamper.client) || missing.length))) {
      const upgrade = !!(r.tamper && r.tamper.client && r.tamper.outdated);
      const reason = upgrade ? "平台已发布新版客户端" : r.tamper && r.tamper.client ? `客户端文件与平台不一致（${(r.tamper.client_files || []).slice(0, 5).join(", ")}）` : `接入配置被移除：${missing.join(", ")}`;
      try {
        const h = await T.selfHeal(reason);
        await report({ agent_type: missing[0] || "-", category: upgrade ? "agent" : "tamper", action: "log", verdict: "CLEAN",
          detection: upgrade ? "KAIP:Client.Upgraded" : "KAIP:Tamper.Repaired",
          object: upgrade ? "客户端已自动升级到平台最新版本" : `已自动修复：${reason}`, details: { reason, agents: h.agents, files: h.files } });
        changed = true;
      } catch (e) {
        C.log("ERROR", "自愈失败", { reason, err: e.message });
        await report({ agent_type: "-", category: "tamper", action: "alert", verdict: "ERROR", detection: "KAIP:Tamper.RepairFailed",
          object: `自动修复失败：${reason}`, details: { err: e.message } });
      }
    }
  } catch (e) {
    C.log("WARN", "心跳失败", { err: e.message });
  }
  return changed;
}

async function runWatch() {
  C.log("INFO", "kaip watch 启动", { pid: process.pid, platform: process.platform });
  const lock = path.join(C.KAIP_HOME, "watch.pid");
  // 锁内容为 pid@hostname：~/.kaip 位于容器持久卷时，新容器的 PID 可能与旧容器重号，
  // 只有同一主机/容器内且该进程确为 kaip watch 时才视为已在运行
  try {
    const [pidStr, host] = fs.readFileSync(lock, "utf8").trim().split("@");
    const old = parseInt(pidStr, 10);
    if (old && old !== process.pid && host === os.hostname()) {
      let alive = false;
      try { process.kill(old, 0); alive = true; } catch {}
      if (alive && process.platform === "linux") {
        try { alive = fs.readFileSync(`/proc/${old}/cmdline`, "utf8").includes("watch"); } catch { alive = false; }
      }
      if (alive) { C.log("INFO", "已有 watch 进程运行，退出", { old }); return; }
    }
  } catch {}
  fs.writeFileSync(lock, `${process.pid}@${os.hostname()}`);

  await heartbeat();
  let watchers = [];
  const queue = new Map();
  let busy = false;

  async function flush() {
    if (busy || !queue.size) return;
    busy = true;
    const items = [...queue.keys()];
    queue.clear();
    const files = [];
    for (const p of items) {
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) files.push(...S.walk(p, { maxFiles: 2000 }));
        else if (S.interesting(p)) files.push({ path: p });
      } catch {}
    }
    if (files.length) {
      const res = await S.scanPaths(files, { agentType: "-", source: "watcher" });
      const bad = res.filter((r) => r.action === "block");
      if (bad.length) C.log("WARN", "监控发现威胁", { files: bad.map((b) => b.path + " " + b.detection) });
    }
    busy = false;
    if (queue.size) setTimeout(flush, 500);
  }

  let timer = null;
  function enqueue(p) {
    queue.set(p, true);
    clearTimeout(timer);
    timer = setTimeout(flush, 2000); // 去抖：等待下载/解压完成
  }

  function setup() {
    for (const w of watchers) try { w.close(); } catch {}
    watchers = [];
    const cfg = C.loadConfig();
    const roots = S.watchRoots(cfg.agents);
    for (const r of roots) {
      try {
        const w = fs.watch(r, { recursive: true }, (_ev, f) => { if (f) enqueue(path.join(r, f.toString())); });
        w.on("error", (e) => C.log("WARN", "watch 错误", { root: r, err: e.message }));
        watchers.push(w);
      } catch (e) { C.log("WARN", "无法监控目录", { root: r, err: e.message }); }
    }
    C.log("INFO", "监控目录", { roots });
    return roots;
  }

  async function fullScan() {
    for (const r of S.watchRoots(C.loadConfig().agents)) enqueue(r);
  }

  setup();
  fullScan();
  setInterval(async () => { if (await heartbeat()) setup(); }, HEARTBEAT_MS);
  setInterval(fullScan, FULLSCAN_MS);
  // 新建的监控目录（如首次安装 Skill 时才创建）定期补挂
  let lastRoots = "";
  setInterval(() => { const cur = S.watchRoots(C.loadConfig().agents).join("|"); if (cur !== lastRoots) { lastRoots = cur; setup(); } }, 60 * 1000);
}

module.exports = { runWatch, heartbeat };
