// Kaspersky AI Protect — OpenCode 2.x 插件
// 安装位置：~/.config/opencode/plugins/kaip.js（由 kaip install 生成，__KAIP_CLIENT__ 替换为客户端绝对路径）
//
// OpenCode v2 插件契约（2.2.5 实测）：
//   · 模块必须 default 导出一个对象 { id, setup }；导出函数或缺少 default 会导致插件静默不加载；
//   · 钩子注册：await ctx.tool.hook("execute.before", async (event) => {...})；
//   · 事件体 { tool, sessionID, agent, messageID, id, input }，工具入参在 event.input；
//   · 工作目录 ctx.location.directory；钩子中抛错 = 阻断该次工具调用。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CLIENT = "__KAIP_CLIENT__";
const AGENT = "opencode";

let C, H, ST, loadErr = null;
// 加载 KAIP 客户端模块；失败（被删/被改坏）时记录错误，工具调用时重试——自愈完成后自动恢复，恢复前一律阻断
function loadKaip() {
  try {
    for (const k of Object.keys(require.cache)) if (k.split("\\").join("/").startsWith(CLIENT)) delete require.cache[k];   // Windows 缓存键为反斜杠路径
    C = require(CLIENT + "/lib/common.js");
    H = require(CLIENT + "/lib/hook.js");
    ST = require(CLIENT + "/lib/status.js");
    loadErr = null;
  } catch (e) { loadErr = e; }
  return !loadErr;
}
loadKaip();
const BROKEN = () => `[Kaspersky AI Protect] 安全组件不完整（${(loadErr && (loadErr.code || loadErr.name)) || "加载失败"}），可能已被篡改，操作已阻止；后台监控将自动修复，请稍后重试或联系安全管理员。`;

const BLOCK_TAIL = "\n该操作已被卡巴斯基 AI 防护策略阻止，请勿尝试绕过；如确认为误报请联系安全管理员。";

export default {
  id: "kaspersky-ai-protect",

  setup: async (ctx) => {
    // 加载标记：用于确认宿主确实加载了插件（排查“插件静默不加载”）
    if (C) C.log("INFO", "PLUGIN_LOADED", { agent: AGENT, api: "v2", dir: (ctx && ctx.location && ctx.location.directory) || process.cwd() });
    if (ST) ST.recordStatus(AGENT, { loaded_at: Date.now(), api: "v2" });
    const dir = () => (ctx && ctx.location && ctx.location.directory) || process.cwd();

    await ctx.tool.hook("execute.before", async (event) => {
      if (loadErr && !loadKaip()) throw new Error(BROKEN());
      if (!process.env.KAIP_SELFTEST) { ST.recordStatus(AGENT, { last_invoke: Date.now(), last_pre: Date.now() }); ST.recordTool(AGENT, String((event && event.tool) || "")); }
      const tool = String((event && event.tool) || "");
      const norm = H.normalize(tool, (event && event.input) || {}, dir());
      C.log("INFO", "INVOKE", { agent: AGENT, event: "execute.before", tool });
      if (!norm.command && !norm.files.length && !norm.skillDir && !norm.targetPath) return;   // 只读工具也要过防篡改检查
      const r = await H.evaluatePre(AGENT, norm, { cwd: dir(), session_id: (event && event.sessionID) || "" });
      C.log("INFO", "PreToolUse", { agent: AGENT, tool, decision: r.decision, files: norm.files.length });
      if (r.decision === "block") throw new Error(r.reasons.join("\n") + BLOCK_TAIL);
    });

    // 安装/下载命令执行后扫描新文件（若当前版本不支持 execute.after 则忽略）
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        if (loadErr) return;
        const tool = String((event && event.tool) || "");
        if (!/^(bash|shell|powershell)$/i.test(tool)) return;
        const norm = H.normalize(tool, (event && event.input) || {}, dir());
        if (!norm.command) return;
        try {
          const r = await H.postScan(AGENT, norm, { cwd: dir(), session_id: (event && event.sessionID) || "" });
          if (r.blocked && r.blocked.length) {
            C.log("WARN", "opencode 安装后扫描隔离", { files: r.blocked.map((b) => b.path) });
          }
        } catch (e) { C.log("ERROR", "opencode execute.after", { err: e.message }); }
      });
    } catch (e) {
      if (C) C.log("INFO", "当前 OpenCode 不支持 execute.after，安装后扫描由 kaip watch 覆盖", { err: e.message });
    }

    // 插件加载时做一次 Skills 增量扫描
    if (!loadErr && !process.env.KAIP_PROBE) H.sessionScan(AGENT).catch((e) => C.log("ERROR", "opencode session scan", { err: e.message }));
  },
};
