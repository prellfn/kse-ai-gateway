// KAIP 管理控制台（无外部依赖，适用于隔离网络）
const $ = (s, el = document) => el.querySelector(s);
const main = () => $("#main");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTs = (t) => (t ? new Date(t * 1000).toLocaleString("zh-CN", { hour12: false }) : "-");
const fmtSize = (n) => { if (n == null) return "-"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + " " + u[i]; };
const tag = (v) => v ? `<span class="tag t-${esc(v)}">${esc(LABEL[v] || v)}</span>` : "";
const LABEL = { DETECT: "检出威胁", RISK: "规则风险", NON_SCANNED: "未能扫描", CLEAN: "安全", ERROR: "错误", block: "已阻断", allow: "放行", alert: "告警", log: "日志" };
const SRC = { "agent-hook": "Agent 拦截", "supply-chain": "供应链网关", watcher: "目录监控", "kse-syslog": "KSE/ICAP", console: "控制台", "agent-local": "终端本地", cli: "命令行" };
const CAT = { tamper: "防篡改", literal: "内联内容", protection: "防护状态", code: "代码执行", write: "写文件", exec: "执行命令", install: "安装/下载", skill: "Skill 包", model: "模型文件", rag: "RAG 文档", dataset: "训练数据集", url: "URL", file: "文件", icap: "ICAP 流量", enroll: "终端注册", policy: "策略", quarantine: "隔离区", test: "测试" };
const AGENTS = { codex: "Codex", opencode: "OpenCode", workbuddy: "WorkBuddy", openclaw: "OpenClaw" };

function toast(msg) { const d = document.createElement("div"); d.textContent = msg; $("#toast").appendChild(d); setTimeout(() => d.remove(), 3500); }

async function api(path, opt = {}) {
  const o = { credentials: "same-origin", ...opt, headers: { ...(opt.headers || {}) } };
  if (o.body && !(o.body instanceof FormData) && typeof o.body !== "string") { o.body = JSON.stringify(o.body); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, o);
  if (r.status === 401 && !path.endsWith("/login")) { showLogin(); throw new Error("未登录"); }
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.detail) || r.statusText);
  return data;
}

function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); route(); refreshEngine(); }

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api("/api/v1/console/login", { method: "POST", body: { username: f.get("username"), password: f.get("password") } }); showApp(); }
  catch (err) { $("#loginErr").textContent = err.message; }
});
$("#logout").addEventListener("click", async (e) => { e.preventDefault(); await api("/api/v1/console/logout", { method: "POST" }); showLogin(); });

async function refreshEngine() {
  try {
    const s = await api("/api/v1/console/kse/status");
    $("#engineBadge").innerHTML = `<span class="dot ${s.online ? "on" : ""}"></span>${s.mode === "mock" ? "模拟引擎" : "KSE"} ${s.online ? "在线" : "离线"}`;
  } catch {}
}

const pages = {};
window.addEventListener("hashchange", route);
function route() {
  const p = (location.hash || "#dashboard").slice(1).split("?")[0];
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.p === p));
  (pages[p] || pages.dashboard)().catch((e) => { main().innerHTML = `<div class="card err">${esc(e.message)}</div>`; });
}

function bars(items, key, val, red) {
  const max = Math.max(1, ...items.map((x) => x[val] || 0));
  return `<div class="bars">${items.map((x) => `<div class="row"><div class="name" title="${esc(x[key])}">${esc(x._label || x[key] || "-")}</div>
    <div class="bar"><i style="width:${(100 * (x[val] || 0)) / max}%"></i>${red ? `<i class="r" style="width:${(100 * (x[red] || 0)) / max}%"></i>` : ""}</div>
    <div class="n">${x[val] || 0}${red ? ` / <span style="color:var(--danger)">${x[red] || 0}</span>` : ""}</div></div>`).join("") || '<div class="muted">暂无数据</div>'}</div>`;
}

// ---------------- 概览 ----------------
pages.dashboard = async () => {
  const [s, k] = await Promise.all([api("/api/v1/console/stats?days=7"), api("/api/v1/console/kse/status")]);
  const cnt = (arr, key, v) => (arr.find((x) => x[key] === v) || {}).n || 0;
  const threats = cnt(s.by_verdict, "verdict", "DETECT") + cnt(s.by_verdict, "verdict", "RISK");
  const total = s.by_verdict.reduce((a, b) => a + b.n, 0);
  const recent = await api("/api/v1/console/events?limit=10&action=block");
  main().innerHTML = `
  <h1>安全概览 <span class="muted" style="font-size:13px;font-weight:400">最近 7 天</span></h1>
  <div class="grid g4">
    <div class="card kpi"><div class="v">${total}</div><div class="l">扫描/检查事件</div></div>
    <div class="card kpi red"><div class="v">${threats}</div><div class="l">检出威胁与风险</div></div>
    <div class="card kpi amber"><div class="v">${cnt(s.by_action, "action", "block")}</div><div class="l">已阻断操作</div></div>
    <div class="card kpi green"><div class="v">${s.agents.online || 0} / ${s.agents.total || 0}</div><div class="l">在线终端 / 已接入终端</div></div>
  </div>
  ${(s.protection_inactive || []).length ? `<div class="card" style="margin-top:16px;border-color:#f1c4c4;background:#fff7f7"><h2 style="color:var(--danger)">⚠ ${s.protection_inactive.length} 个 AI Agent 防护未生效</h2>
    <table><tr><th>终端</th><th>Agent</th><th>状态</th><th>说明</th></tr>${s.protection_inactive.map((x) => `<tr><td>${esc(x.host)}</td><td>${esc(AGENTS[x.agent] || x.agent)} ${x.version ? "v" + esc(x.version) : ""}</td><td>${pstate(x.state)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</table>
    <p class="hint">常见原因：Agent 升级后插件接口变化、Codex 未信任 hook、配置被覆盖。处理后在终端执行 <code>kaip verify</code> 复核。</p></div>` : ""}
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><h2>各 AI Agent 拦截情况 <span class="hint">总数 / 阻断</span></h2>${bars(s.by_agent.map((x) => ({ ...x, _label: AGENTS[x.agent_type] || x.agent_type })), "agent_type", "n", "blocked")}</div>
    <div class="card"><h2>按防护入口 <span class="hint">总数 / 威胁</span></h2>${bars(s.by_category.map((x) => ({ ...x, _label: CAT[x.category] || x.category })), "category", "n", "threats")}</div>
    <div class="card"><h2>Top 检出名称</h2>${bars(s.top_detections, "detection", "n")}</div>
  </div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>最近阻断</h2><table><tr><th>时间</th><th>来源</th><th>对象</th><th>判定</th></tr>
      ${recent.rows.map((e) => `<tr><td>${fmtTs(e.ts)}</td><td>${esc(AGENTS[e.agent_type] || SRC[e.source] || e.source)}</td><td class="obj">${esc((e.object || "").slice(0, 120))}</td><td>${tag(e.verdict)}<br><small>${esc(e.detection)}</small></td></tr>`).join("") || '<tr><td colspan=4 class="muted">暂无</td></tr>'}</table></div>
    <div class="card"><h2>扫描引擎状态</h2>
      <div class="form">
        <label>引擎模式</label><div>${k.mode === "mock" ? '模拟引擎 <span class="hint">（演示用；生产请设置 KAIP_KSE_MODE=kse）</span>' : "Kaspersky Scan Engine"}</div>
        <label>连接状态</label><div><span class="dot ${k.online ? "on" : ""}"></span>${k.online ? "在线" : "离线 " + esc(k.error || "")}</div>
        <label>病毒库日期</label><div>${esc(k.basesdate || "-")}</div>
        <label>KAV SDK 版本</label><div>${esc(k.version || "-")}</div>
        <label>许可证</label><div>${esc((k.license && (k.license.licenseName + " 到期 " + (k.license.licenseExpirationDate || "-"))) || "-")}</div>
        <label>隔离区文件</label><div>${s.quarantine}</div>
        <label>判定缓存</label><div>${cacheLine(k.cache)}</div>
      </div></div>
  </div>`;
};

function cacheLine(c) {
  if (!c) return "-";
  const rate = c.hit_rate == null ? "暂无扫描" : `命中率 ${(c.hit_rate * 100).toFixed(1)}%（命中 ${c.hits} / 未命中 ${c.misses}）`;
  return `${rate}<br><small class="muted">当前病毒库下有效 ${c.valid} 条 · 共 ${c.entries} 条 · 病毒库更新即失效，最长 ${c.max_ttl_days} 天</small>`;
}

// ---------------- 事件 ----------------
pages.events = async () => {
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  main().innerHTML = `<h1>事件日志</h1>
  <div class="toolbar">
    <select id="fv"><option value="">全部判定</option>${["DETECT", "RISK", "NON_SCANNED", "CLEAN", "ERROR"].map((v) => `<option value="${v}">${LABEL[v]}</option>`).join("")}</select>
    <select id="fa"><option value="">全部动作</option>${["block", "alert", "allow", "log"].map((v) => `<option value="${v}">${LABEL[v]}</option>`).join("")}</select>
    <select id="fs"><option value="">全部来源</option>${Object.entries(SRC).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <select id="fg"><option value="">全部 Agent</option>${Object.entries(AGENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
    <input id="fq" placeholder="搜索对象 / 检出名 / 主机 / SHA256" style="width:280px">
    <button class="btn primary" id="fgo">查询</button>
    <a class="btn" href="/api/v1/console/events/export?days=30">导出 CSV</a>
    <span class="muted" id="ftotal"></span>
  </div>
  <div class="card" style="padding:0;overflow:auto"><table id="et"></table></div>
  <div class="toolbar" style="margin-top:10px"><button class="btn" id="prev">上一页</button><button class="btn" id="next">下一页</button></div>`;
  for (const [id, k] of [["fv", "verdict"], ["fa", "action"], ["fs", "source"], ["fg", "agent_type"], ["fq", "q"]]) if (qs.get(k)) $("#" + id).value = qs.get(k);
  let offset = 0, rows = [];
  async function load() {
    const p = new URLSearchParams({ verdict: $("#fv").value, action: $("#fa").value, source: $("#fs").value, agent_type: $("#fg").value, q: $("#fq").value, limit: 50, offset });
    const r = await api("/api/v1/console/events?" + p);
    rows = r.rows;
    $("#ftotal").textContent = `共 ${r.total} 条`;
    $("#et").innerHTML = `<tr><th>时间</th><th>来源</th><th>入口</th><th>终端</th><th>对象</th><th>判定</th><th>检出</th><th>动作</th></tr>` +
      rows.map((e, i) => `<tr class="click" data-i="${i}"><td>${fmtTs(e.ts)}</td><td>${esc(SRC[e.source] || e.source)}${e.agent_type && e.agent_type !== "-" ? `<br><span class="agent-chip">${esc(AGENTS[e.agent_type] || e.agent_type)}</span>` : ""}</td>
      <td>${esc(CAT[e.category] || e.category)}</td><td>${esc(e.host)}<br><small class="muted">${esc(e.username)}</small></td>
      <td class="obj">${esc((e.object || "").slice(0, 200))}</td><td>${tag(e.verdict)}</td><td>${esc(e.detection)}</td><td>${tag(e.action)}</td></tr>`).join("");
    document.querySelectorAll("#et tr.click").forEach((tr) => tr.onclick = () => detail(rows[tr.dataset.i]));
  }
  $("#fgo").onclick = () => { offset = 0; load(); };
  $("#prev").onclick = () => { offset = Math.max(0, offset - 50); load(); };
  $("#next").onclick = () => { offset += 50; load(); };
  load();
};

function detail(e) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="card"><h2>事件 #${e.id}</h2><div class="form">
    <label>时间</label><div>${fmtTs(e.ts)}</div><label>来源 / 入口</label><div>${esc(SRC[e.source] || e.source)} / ${esc(CAT[e.category] || e.category)}</div>
    <label>AI Agent</label><div>${esc(AGENTS[e.agent_type] || e.agent_type)}</div><label>终端 / 用户</label><div>${esc(e.host)} / ${esc(e.username)}</div>
    <label>对象</label><div class="obj" style="word-break:break-all">${esc(e.object)}</div>
    <label>判定 / 动作</label><div>${tag(e.verdict)} ${tag(e.action)} ${esc(e.detection)}</div>
    <label>SHA256 / 大小</label><div class="obj">${esc(e.sha256 || "-")} · ${fmtSize(e.size)}</div></div>
    <h2 style="margin-top:14px">详情</h2><div class="code">${esc(JSON.stringify(e.details, null, 2))}</div>
    <div class="toolbar" style="margin-top:12px;justify-content:flex-end">${e.sha256 ? `<button class="btn" id="allowH">加入哈希白名单（误报）</button>` : ""}<button class="btn primary" id="close">关闭</button></div></div>`;
  document.body.appendChild(m);
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  $("#close", m).onclick = () => m.remove();
  const ah = $("#allowH", m);
  if (ah) ah.onclick = async () => { const p = await api("/api/v1/console/policy"); if (!p.allow_hashes.includes(e.sha256)) p.allow_hashes.push(e.sha256); await api("/api/v1/console/policy", { method: "PUT", body: p }); toast("已加入白名单"); m.remove(); };
}

// ---------------- 防护状态 ----------------
const PSTATE = { ok: ["生效", "t-CLEAN"], review: ["升级待复核", "t-RISK"], untrusted: ["未信任", "t-RISK"], inactive: ["未生效", "t-DETECT"], missing: ["未接入", "t-DETECT"] };
const pstate = (s) => { const [l, c] = PSTATE[s] || [s || "未知", "t-ERROR"]; return `<span class="tag ${c}">${esc(l)}</span>`; };
const agentChips = (a) => {
  const st = a.agent_status || {};
  const names = [...new Set([...(a.agents || []), ...Object.keys(st)])];
  return names.map((x) => { const s = st[x] || {}; const nt = (s.unknown_tools || []).length;
    return `<span class="agent-chip" title="${esc(s.detail || "未上报状态")}${s.last_invoke ? " · 最近调用 " + fmtTs(s.last_invoke / 1000) : ""}${nt ? " · 未识别工具：" + esc(s.unknown_tools.map((t) => t.name).join(", ")) : ""}">${esc(AGENTS[x] || x)}${s.version ? " " + esc(s.version) : ""} ${s.state ? pstate(s.state) : ""}${nt ? ` <span class="tag t-RISK">新工具 ${nt}</span>` : ""}</span>`; }).join("") || '<span class="muted">-</span>';
};

// ---------------- 终端 ----------------
pages.endpoints = async () => {
  const rows = await api("/api/v1/console/agents");
  main().innerHTML = `<h1>终端与 AI Agent</h1>
  <div class="card" style="padding:0;overflow:auto"><table><tr><th>状态</th><th>主机名</th><th>系统</th><th>用户</th><th>AI Agent 及防护状态</th><th>客户端版本</th><th>IP</th><th>最后在线</th><th></th></tr>
  ${rows.map((a) => `<tr><td><span class="dot ${a.online && a.status === "active" ? "on" : ""}"></span>${a.status === "active" ? (a.online ? "在线" : "离线") : "已吊销"}</td>
    <td><b>${esc(a.hostname)}</b><br><small class="muted">${esc(a.id)}</small></td><td>${esc(a.os)}</td><td>${esc(a.username)}</td>
    <td>${agentChips(a)}</td>
    <td>${esc(a.client_version)}</td><td>${esc(a.ip)}</td><td>${fmtTs(a.last_seen)}</td>
    <td><a href="#events?q=${encodeURIComponent(a.hostname)}">事件</a> ${a.status === "active" ? `<button class="btn sm danger" data-rv="${a.id}">吊销</button>` : `<button class="btn sm" data-del="${a.id}">删除</button>`}</td></tr>`).join("") || '<tr><td colspan=9 class="muted">暂无终端，请到「接入部署」获取安装命令</td></tr>'}</table></div>`;
  document.querySelectorAll("[data-rv]").forEach((b) => b.onclick = async () => { if (confirm("吊销后该终端将无法调用平台（客户端按离线策略处理），确定？")) { await api(`/api/v1/console/agents/${b.dataset.rv}/revoke`, { method: "POST" }); route(); } });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { await api(`/api/v1/console/agents/${b.dataset.del}`, { method: "DELETE" }); route(); });
};

// ---------------- 供应链 ----------------
pages.supply = async () => {
  const rel = await api("/api/v1/supply/released");
  main().innerHTML = `<h1>AI 供应链入口扫描</h1>
  <div class="grid g2">
    <div class="card"><h2>上传扫描</h2>
      <div class="toolbar"><label>文件类别</label><select id="cat">
        <option value="model">大模型文件（PKL/PT/PTH/CKPT/KERAS/GGUF…）</option><option value="skill">Skill / 插件包</option>
        <option value="rag">RAG 知识库文档</option><option value="dataset">训练 / 微调数据集</option><option value="file">其他文件</option></select>
        <label class="switch"><input type="checkbox" id="rag"> 通过后入库知识库</label></div>
      <div class="drop" id="drop">拖拽文件到此处，或 <a href="#" id="pick">选择文件</a>（支持多选、大文件流式上传）<input type="file" id="file" multiple class="hidden"></div>
      <div id="upres" style="margin-top:12px"></div>
    </div>
    <div class="card"><h2>安全代下载</h2>
      <p class="hint">由平台代为下载模型/Skill：先做 URL 信誉检查，下载后经 KSE 与 KAIP 规则扫描，通过后放入放行区供内网下载。适用于隔离网段统一引入外部组件。</p>
      <div class="toolbar"><input id="furl" placeholder="https://huggingface.co/.../model.pt" style="flex:1">
        <select id="fcat"><option value="model">模型</option><option value="skill">Skill</option><option value="dataset">数据集</option><option value="rag">文档</option><option value="file">其他</option></select>
        <button class="btn primary" id="fetch">下载并扫描</button></div>
      <div id="fres"></div>
      <h2 style="margin-top:18px">URL 信誉查询</h2>
      <div class="toolbar"><input id="curl" placeholder="http://..." style="flex:1"><button class="btn" id="chk">查询</button></div><div id="cres"></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h2>放行区（已通过扫描）</h2><table><tr><th>文件</th><th>大小</th><th>SHA256</th><th>时间</th><th></th></tr>
  ${rel.map((r) => `<tr><td>${esc(r.name)}</td><td>${fmtSize(r.size)}</td><td class="obj">${r.sha256}</td><td>${fmtTs(r.ts)}</td><td><a href="/api/v1/supply/released/${r.sha256}">下载</a></td></tr>`).join("") || '<tr><td colspan=5 class="muted">暂无</td></tr>'}</table></div>`;
  const show = (r, name) => `<div class="card" style="margin:6px 0;padding:10px 14px"><b>${esc(name)}</b> ${tag(r.verdict)} ${tag(r.action)} ${esc(r.detection || "")}
     <span class="hint">${r.elapsed_ms != null ? r.elapsed_ms + " ms" : ""} ${r.reason ? "· " + esc(r.reason) : ""}</span>
     ${(r.findings || []).map((f) => `<div class="hint">⚠ ${esc(f.desc)} ${f.file ? "@" + esc(f.file) : ""} ${f.match ? "<code>" + esc(f.match) + "</code>" : ""}</div>`).join("")}
     ${(r.sub_results || []).map((s) => `<div class="hint">↳ ${esc(s.object)} ${esc(s.detection)}</div>`).join("")}
     ${r.download ? `<div><a href="${r.download}">下载放行文件</a></div>` : ""}${r.rag ? `<div class="hint">${esc(r.rag.msg)}</div>` : ""}</div>`;
  async function up(files) {
    for (const f of files) {
      const id = "u" + Math.random().toString(36).slice(2);
      $("#upres").insertAdjacentHTML("afterbegin", `<div id="${id}" class="hint">上传扫描中：${esc(f.name)} (${fmtSize(f.size)}) …</div>`);
      const fd = new FormData(); fd.append("file", f); fd.append("category", $("#cat").value); fd.append("forward_rag", $("#rag").checked);
      try { const r = await api("/api/v1/supply/upload", { method: "POST", body: fd }); $("#" + id).outerHTML = show(r, f.name); }
      catch (e) { $("#" + id).outerHTML = `<div class="err">${esc(f.name)}：${esc(e.message)}</div>`; }
    }
  }
  $("#pick").onclick = (e) => { e.preventDefault(); $("#file").click(); };
  $("#file").onchange = (e) => up(e.target.files);
  const d = $("#drop");
  d.ondragover = (e) => { e.preventDefault(); d.classList.add("over"); };
  d.ondragleave = () => d.classList.remove("over");
  d.ondrop = (e) => { e.preventDefault(); d.classList.remove("over"); up(e.dataTransfer.files); };
  $("#fetch").onclick = async () => {
    $("#fres").innerHTML = '<div class="hint">下载扫描中…</div>';
    try { const r = await api("/api/v1/supply/fetch", { method: "POST", body: { url: $("#furl").value, category: $("#fcat").value } }); $("#fres").innerHTML = show(r, r.name || r.url); }
    catch (e) { $("#fres").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $("#chk").onclick = async () => {
    try { const r = await api("/api/v1/console/checkurl?url=" + encodeURIComponent($("#curl").value)); $("#cres").innerHTML = show(r, r.url); }
    catch (e) { $("#cres").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
};

// ---------------- 隔离区 ----------------
pages.quarantine = async () => {
  const st = new URLSearchParams(location.hash.split("?")[1] || "").get("s") || "quarantined";
  const rows = await api("/api/v1/console/quarantine?status=" + st);
  main().innerHTML = `<h1>隔离区</h1>
  <div class="toolbar">${[["quarantined", "隔离中"], ["released", "已放行"], ["deleted", "已删除"]].map(([k, v]) => `<a class="btn ${k === st ? "primary" : ""}" href="#quarantine?s=${k}">${v}</a>`).join("")}
  <span class="hint">隔离文件经混淆存储，不可直接执行。终端本地隔离的文件位于 ~/.kaip/quarantine。</span></div>
  <div class="card" style="padding:0;overflow:auto"><table><tr><th>时间</th><th>文件</th><th>检出</th><th>来源</th><th>主机</th><th>大小</th><th>SHA256</th><th></th></tr>
  ${rows.map((q) => `<tr><td>${fmtTs(q.ts)}</td><td class="obj">${esc(q.name)}</td><td>${esc(q.detection)}</td><td>${esc(SRC[q.source] || q.source)}</td><td>${esc(q.host)}</td><td>${fmtSize(q.size)}</td><td class="obj">${esc(q.sha256)}</td>
    <td>${st === "quarantined" ? `<button class="btn sm" data-rel="${q.id}">误报放行</button> <button class="btn sm danger" data-del="${q.id}">删除</button>` : ""}</td></tr>`).join("") || '<tr><td colspan=8 class="muted">暂无</td></tr>'}</table></div>`;
  document.querySelectorAll("[data-rel]").forEach((b) => b.onclick = async () => { if (confirm("放行后该文件哈希将加入白名单，确定是误报？")) { await api(`/api/v1/console/quarantine/${b.dataset.rel}/release`, { method: "POST" }); toast("已放行"); route(); } });
  document.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { if (confirm("永久删除该隔离文件，无法恢复。确定？")) { await api(`/api/v1/console/quarantine/${b.dataset.del}`, { method: "DELETE" }); route(); } });
};

// ---------------- 策略 ----------------
pages.policy = async () => {
  const p = await api("/api/v1/console/policy");
  const sel = (id, v, opts) => `<select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${String(v) === String(k) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const lines = (a) => esc((a || []).join("\n"));
  main().innerHTML = `<h1>防护策略 <span class="muted" style="font-size:13px;font-weight:400">版本 v${p.version} · 更新于 ${fmtTs(p.updated_at)} · 终端心跳时自动同步</span></h1>
  <div class="grid g2">
  <div class="card"><h2>处置规则</h2><div class="form">
    <label>防护模式</label>${sel("mode", p.mode, [["enforce", "阻断模式（检出即拦截）"], ["audit", "审计模式（仅告警放行）"]])}
    <label>KAIP 补充规则命中</label>${sel("rules_action", p.rules_action, [["block", "阻断"], ["alert", "仅告警"], ["off", "关闭"]])}
    <label>无法扫描（加密/损坏）</label>${sel("block_non_scanned", p.block_non_scanned, [["true", "按未放行处理（推荐）"], ["false", "放行并告警"]])}
    <label>Agent 安装/下载命令</label>${sel("install_action", p.install_action, [["scan", "允许，执行后立即扫描新文件"], ["block", "禁止 Agent 自行安装"], ["allow", "允许，不额外扫描"]])}
    <label>平台不可达时</label>${sel("fail_open", p.fail_open, [["true", "放行（不影响研发）"], ["false", "阻断（高安全）"]])}
    <label>检出后隔离</label>${sel("quarantine_on_detect", p.quarantine_on_detect, [["true", "是"], ["false", "否"]])}
    <label>URL 信誉检查</label>${sel("check_urls", p.check_urls, [["true", "开启"], ["false", "关闭"]])}
    <label>自我保护（防篡改）</label>${sel("tamper_protection", p.tamper_protection, [["true", "开启：禁止 Agent 读取凭据、修改/停用 KAIP"], ["false", "关闭"]])}
    <label>自动修复</label>${sel("self_heal", p.self_heal, [["true", "开启：客户端/hook 被改或删除时自动恢复"], ["false", "关闭（仅告警）"]])}
  </div></div>
  <div class="card"><h2>拦截点</h2><div class="form">
    <label>写入/编辑文件前扫描</label>${sel("scan_on_write", p.scan_on_write, [["true", "开启"], ["false", "关闭"]])}
    <label>执行命令前扫描脚本/模型</label>${sel("scan_on_exec", p.scan_on_exec, [["true", "开启"], ["false", "关闭"]])}
    <label>会话启动时扫描 Skills</label>${sel("scan_skills_on_session_start", p.scan_skills_on_session_start, [["true", "开启"], ["false", "关闭"]])}
    <label>Hook 内联扫描上限 (MB)</label><input id="max_inline_scan_mb" type="number" value="${p.max_inline_scan_mb}">
  </div>
  <h2 style="margin-top:14px">已确认的工具（JSON，评估过的新工具加入后不再提醒）</h2><textarea id="known_tools" rows="4">${esc(JSON.stringify(p.known_tools || {}, null, 2))}</textarea>
  <h2 style="margin-top:14px">目录监控（JSON）</h2><textarea id="watch_paths" rows="8">${esc(JSON.stringify(p.watch_paths, null, 2))}</textarea></div>
  <div class="card"><h2>安装来源黑名单（子串匹配，一行一个）</h2><textarea id="block_url_patterns" rows="5">${lines(p.block_url_patterns)}</textarea>
    <h2 style="margin-top:12px">可信来源前缀（白名单）</h2><textarea id="allow_url_prefixes" rows="4">${lines(p.allow_url_prefixes)}</textarea></div>
  <div class="card"><h2>受信任来源目录 <span class="hint">（仍经 KSE 扫描；KAIP 启发式命中只告警不阻断。子串匹配，支持 *）</span></h2><textarea id="trusted_paths" rows="5">${lines(p.trusted_paths)}</textarea></div>
  <div class="card"><h2>哈希白名单（SHA256）</h2><textarea id="allow_hashes" rows="5">${lines(p.allow_hashes)}</textarea>
    <h2 style="margin-top:12px">哈希黑名单（SHA256）</h2><textarea id="block_hashes" rows="4">${lines(p.block_hashes)}</textarea></div>
  </div>
  <div class="toolbar" style="margin-top:16px"><button class="btn primary" id="save">保存并下发</button><button class="btn" id="reset">恢复默认</button></div>`;
  $("#save").onclick = async () => {
    const b = (id) => $("#" + id).value === "true";
    const arr = (id) => $("#" + id).value.split("\n").map((x) => x.trim()).filter(Boolean);
    let wp; try { wp = JSON.parse($("#watch_paths").value); } catch { return toast("目录监控 JSON 格式错误"); }
    let kt; try { kt = JSON.parse($("#known_tools").value || "{}"); } catch { return toast("已确认工具 JSON 格式错误"); }
    const np = { mode: $("#mode").value, rules_action: $("#rules_action").value, install_action: $("#install_action").value,
      block_non_scanned: b("block_non_scanned"), fail_open: b("fail_open"), tamper_protection: b("tamper_protection"), self_heal: b("self_heal"), quarantine_on_detect: b("quarantine_on_detect"), check_urls: b("check_urls"),
      scan_on_write: b("scan_on_write"), scan_on_exec: b("scan_on_exec"), scan_skills_on_session_start: b("scan_skills_on_session_start"),
      max_inline_scan_mb: +$("#max_inline_scan_mb").value, watch_paths: wp, known_tools: kt,
      block_url_patterns: arr("block_url_patterns"), trusted_paths: arr("trusted_paths"), allow_url_prefixes: arr("allow_url_prefixes"), allow_hashes: arr("allow_hashes"), block_hashes: arr("block_hashes") };
    await api("/api/v1/console/policy", { method: "PUT", body: np }); toast("策略已保存，终端将在下次心跳时同步"); route();
  };
  $("#reset").onclick = async () => { if (confirm("恢复默认策略？")) { await api("/api/v1/console/policy/reset", { method: "POST" }); route(); } };
};

// ---------------- 接入部署 ----------------
// HTTP（非 HTTPS / 非 localhost）下 navigator.clipboard 不可用，回退到 execCommand
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(t).then(() => toast("已复制"), () => copyFallback(t));
  }
  copyFallback(t);
}
function copyFallback(t) {
  const ta = document.createElement("textarea");
  ta.value = t; ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
  ta.remove();
  toast(ok ? "已复制" : "复制失败，请手动选中命令后 Ctrl+C");
}
const codeBlock = (t) => `<div class="code"><button class="btn sm copy" onclick="copyText(this.parentNode.dataset.t)">复制</button>${esc(t)}</div>`;
pages.deploy = async () => {
  const d = await api("/api/v1/console/deploy");
  main().innerHTML = `<h1>接入部署</h1>
  <div class="card"><h2>一键安装终端防护（自动识别并接入 Codex / OpenCode / WorkBuddy）</h2>
    <p class="hint">前置条件：终端已安装 Node.js 18+（Codex CLI 自带此依赖）。安装程序会：注册终端 → 写入各 Agent 的 Hook/插件配置 → 安装目录监控服务（Windows 计划任务 / Linux systemd 用户服务）。</p>
    <h2>Windows（cmd 命令提示符）</h2>${codeBlock(d.windows)}
    <h2 style="margin-top:12px">Linux / macOS</h2>${codeBlock(d.linux)}
    <p class="hint">只接入部分 Agent：Windows 追加 <code>-Agents codex,opencode</code>；Linux 追加 <code>--agents codex,opencode</code>。卸载：<code>kaip uninstall</code>（保留凭据，可重新接入）；彻底卸载：<code>kaip uninstall --purge</code>。</p>
  </div>
  <div class="grid g3" style="margin-top:16px">
    <div class="card"><h2>Codex</h2><p class="hint">写入 <code>~/.codex/hooks.json</code>（PreToolUse / PostToolUse / SessionStart），并在 config.toml 启用 <code>[features] codex_hooks = true</code>。首次启动 Codex 需在「Hooks need review」中确认信任。</p></div>
    <div class="card"><h2>OpenCode</h2><p class="hint">安装插件 <code>~/.config/opencode/plugins/kaip.js</code>，通过 <code>tool.execute.before</code> 在写文件 / 执行命令前调用平台判定，检出即抛错阻断。</p></div>
    <div class="card"><h2>WorkBuddy / CodeBuddy</h2><p class="hint">写入 <code>~/.workbuddy/settings.json</code> 与 <code>~/.codebuddy/settings.json</code> 的 hooks 字段（PreToolUse 拒绝）。修改后需完全重启 WorkBuddy。企业版可在后台统一下发该 Hook 配置。</p></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>业务系统 / CI 集成（API Key 在「系统设置」中查看）</h2>
  ${codeBlock(`# 模型入库前扫描（返回 action=allow 才入库）\ncurl -sk -H "X-API-Key: <API_KEY>" -F category=model -F file=@./model.pt ${d.server}/api/v1/supply/upload\n\n# RAG 文档上传扫描并转发知识库\ncurl -sk -H "X-API-Key: <API_KEY>" -F category=rag -F forward_rag=true -F file=@./doc.pdf ${d.server}/api/v1/supply/upload\n\n# 平台代下载模型\ncurl -sk -H "X-API-Key: <API_KEY>" -H "Content-Type: application/json" -d '{"url":"https://.../model.pt","category":"model"}' ${d.server}/api/v1/supply/fetch`)}
  <p class="hint">完整 API 文档：<a href="/docs" target="_blank">/docs</a>（OpenAPI）。下载代理（Squid + KSE ICAP）：在 KSE 服务器执行 deploy/squid/install-squid.sh，终端用 client-proxy.sh / client-proxy.ps1 接入。</p></div>`;
  document.querySelectorAll(".code").forEach((c) => c.dataset.t = c.textContent.replace(/^复制/, ""));
};

// ---------------- PoC 自检 ----------------
pages.poc = async () => {
  main().innerHTML = `<h1>PoC 自检</h1>
  <div class="card"><p>使用内置的<b>无害测试样本</b>（EICAR、引用 os.system 的 pickle 模型、嵌套压缩 Skill 包、数据集、钓鱼测试 URL）一键验证平台与引擎的检测链路，对应 PoC 测试用例 A1 / B1 / B4 / B8 / C1。</p>
  <button class="btn primary" id="run">运行自检</button> <span id="st" class="hint"></span><div id="res" style="margin-top:14px"></div></div>
  <div class="card" style="margin-top:16px"><h2>PoC 用例清单</h2><table><tr><th>编号</th><th>测试项</th><th>平台对应能力</th></tr>
  ${[["A1", "文件扫描 scanfile", "供应链上传扫描 / 自检"], ["A2", "内存扫描 scanmemory", "Agent Hook 内容扫描（scanmemory）"], ["A3", "云信誉 KSN", "KSE 侧开启 KSN 后经平台扫描"],
     ["B1", "模型文件检测 (KL_SCAN_LLM)", "供应链·模型 + pickle 反序列化规则"], ["B2", "模型格式覆盖", "PKL/PT/PTH/CKPT/KERAS 逐一上传记录"], ["B3", "大文件与性能", "流式上传 + scanfile，事件记录耗时"],
     ["B4", "Skill 包扫描", "供应链·Skill / Agent 安装后扫描 / 目录监控"], ["B5", "Skill 下载代理", "deploy/squid/install-squid.sh（Squid HTTPS 解密 + KSE ICAP），检出经 syslog 汇入"], ["B6", "企业版后台管控", "WorkBuddy 企业版下发 Hook 配置"],
     ["B7", "RAG 文档上传扫描", "供应链·RAG + AnythingLLM/Webhook 转发"], ["B8", "训练数据集投毒", "供应链·数据集"], ["C1", "URL 信誉", "URL 查询 / Agent 命令 URL 检查"],
     ["C2", "误报对照", "隔离区误报放行 + 哈希白名单"], ["C3", "日志与告警", "事件日志 + SIEM(CEF/Syslog) 转发"], ["C4", "隔离网段更新", "KSE 本地镜像更新；平台代下载"], ["C5", "与现有环境共存", "终端仅 Node 脚本与 Hook，无驻留杀软组件"]]
    .map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join("")}</table></div>`;
  $("#run").onclick = async () => {
    $("#st").textContent = "运行中…";
    const r = await api("/api/v1/console/selftest", { method: "POST" });
    const ok = r.cases.filter((c) => c.pass).length;
    $("#st").textContent = `完成：${ok}/${r.cases.length} 通过（引擎：${r.engine === "mock" ? "模拟" : "KSE"}）`;
    $("#res").innerHTML = `<table><tr><th>用例</th><th>说明</th><th>预期</th><th>实际</th><th>检出名</th><th>耗时</th><th>结果</th></tr>${r.cases.map((c) => `<tr><td>${c.id}</td><td>${esc(c.title)}</td><td>${esc(c.expect)}</td><td>${tag(c.got)}</td><td>${esc(c.detection)}</td><td>${c.ms ?? "-"} ms</td><td class="${c.pass ? "pass" : "fail"}">${c.pass ? "通过" : "未通过"}</td></tr>`).join("")}</table>`;
  };
};

// ---------------- 设置 ----------------
pages.settings = async () => {
  const s = await api("/api/v1/console/settings");
  const chk = (id, v) => `<input type="checkbox" id="${id}" ${v ? "checked" : ""}>`;
  main().innerHTML = `<h1>系统设置</h1><div class="grid g2">
  <div class="card"><h2>SIEM / Syslog 转发</h2><div class="form">
    <label>启用</label>${chk("s_en", s.siem.enabled)}<label>服务器</label><input id="s_host" value="${esc(s.siem.host)}" placeholder="KUMA 采集器 IP">
    <label>端口</label><input id="s_port" type="number" value="${s.siem.port}"><label>协议</label><select id="s_proto"><option ${s.siem.protocol === "udp" ? "selected" : ""}>udp</option><option ${s.siem.protocol === "tcp" ? "selected" : ""}>tcp</option></select>
    <label>格式</label><select id="s_fmt"><option value="cef" ${s.siem.format === "cef" ? "selected" : ""}>CEF</option><option value="json" ${s.siem.format === "json" ? "selected" : ""}>JSON</option></select>
    <label>仅转发告警</label>${chk("s_only", s.siem.only_alerts)}</div>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="s_save">保存</button><button class="btn" id="s_test">发送测试事件</button></div>
    <p class="hint">平台内置 Syslog 接收：${s.syslog.listen ? "UDP " + s.syslog.port : "未启用"}。在 KSE Web UI → Settings → Logging 中把 syslog 目标指向本平台，即可汇入 ICAP/HTTP 扫描事件。</p></div>
  <div class="card"><h2>RAG 知识库对接</h2><div class="form">
    <label>启用</label>${chk("r_en", s.rag.enabled)}<label>类型</label><select id="r_type"><option value="anythingllm" ${s.rag.type === "anythingllm" ? "selected" : ""}>AnythingLLM</option><option value="webhook" ${s.rag.type === "webhook" ? "selected" : ""}>通用 Webhook（multipart file）</option></select>
    <label>地址</label><input id="r_url" value="${esc(s.rag.url)}" placeholder="http://10.0.0.5:3001"><label>API Key</label><input id="r_key" value="${esc(s.rag.api_key)}">
    <label>工作区 slug</label><input id="r_ws" value="${esc(s.rag.workspace)}"></div>
    <div class="toolbar" style="margin-top:12px"><button class="btn primary" id="r_save">保存</button></div></div>
  <div class="card"><h2>凭据</h2><div class="form">
    <label>终端注册令牌</label><div class="obj">${esc(s.enroll_token)} <button class="btn sm" data-rot="enroll_token">轮换</button></div>
    <label>供应链 API Key</label><div class="obj">${esc(s.api_key)} <button class="btn sm" data-rot="api_key">轮换</button></div></div>
    <h2 style="margin-top:14px">修改管理员密码</h2><div class="toolbar"><input id="pw_old" type="password" placeholder="原密码"><input id="pw_new" type="password" placeholder="新密码（≥10位）"><button class="btn" id="pw_save">修改</button></div></div>
  <div class="card"><h2>扫描引擎</h2><div class="form"><label>模式</label><div>${esc(s.kse.mode)}</div><label>KSE 地址</label><div>${esc(s.kse.url)}</div><label>scanfile 目录</label><div>${esc(s.kse.scan_dir)}</div></div>
    <p class="hint">引擎参数通过环境变量配置（见 deploy/kaip.env）。启用 LLM 模型详细扫描：在 KSE 的 ppl/kave.ini [Environment] 段加入 KL_SCAN_LLM=1 后重启 KSE。</p></div>
  </div>`;
  $("#s_save").onclick = async () => { await api("/api/v1/console/settings/siem", { method: "PUT", body: { enabled: $("#s_en").checked, host: $("#s_host").value, port: +$("#s_port").value, protocol: $("#s_proto").value, format: $("#s_fmt").value, only_alerts: $("#s_only").checked } }); toast("已保存"); };
  $("#s_test").onclick = async () => { const r = await api("/api/v1/console/siem/test", { method: "POST" }); toast("已发送：" + r.cef.slice(0, 60) + "…"); };
  $("#r_save").onclick = async () => { await api("/api/v1/console/settings/rag", { method: "PUT", body: { enabled: $("#r_en").checked, type: $("#r_type").value, url: $("#r_url").value, api_key: $("#r_key").value, workspace: $("#r_ws").value } }); toast("已保存"); };
  document.querySelectorAll("[data-rot]").forEach((b) => b.onclick = async () => { if (confirm("轮换后旧值立即失效，确定？")) { await api("/api/v1/console/settings/rotate/" + b.dataset.rot, { method: "POST" }); route(); } });
  $("#pw_save").onclick = async () => { try { await api("/api/v1/console/password", { method: "POST", body: { old: $("#pw_old").value, new: $("#pw_new").value } }); toast("密码已修改"); } catch (e) { toast(e.message); } };
};

// 启动
api("/api/v1/console/me").then(showApp).catch(showLogin);
