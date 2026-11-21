// Kaspersky AI Protect — OpenCode 插件
// OpenCode 1.x 版本插件；安装位置 ~/.config/opencode/plugins/kaip.js（由 kaip install 自动生成，__KAIP_CLIENT__ 会被替换为客户端绝对路径）
// 机制：tool.execute.before 中调用平台判定，检出威胁时 throw 阻断工具执行；
//       tool.execute.after 对安装/下载命令做事后扫描；session.created 时增量扫描 Skills/插件目录。
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const CLIENT = "__KAIP_CLIENT__";
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

const AGENT = "opencode";

export const KaipPlugin = async ({ directory, worktree, client }) => {
  // 加载标记：用于确认宿主确实加载了插件（排查“插件静默不加载”）
  if (C) C.log("INFO", "PLUGIN_LOADED", { agent: AGENT, api: "v1", dir: directory || process.cwd() });
  if (ST) ST.recordStatus(AGENT, { loaded_at: Date.now(), api: "v1" });
  // directory 为当前工作目录；worktree 为 git 根（非 git 目录时 1.x 给出 "/"），解析相对路径必须用 directory
  const cwdOf = () => directory || (worktree && worktree !== "/" ? worktree : "") || process.cwd();
  const notify = async (msg) => {
    try { await client?.app?.log?.({ body: { service: "kaip", level: "warn", message: msg } }); } catch {}
  };

  return {
    "tool.execute.before": async (input, output) => {
      if (loadErr && !loadKaip()) throw new Error(BROKEN());
      if (!process.env.KAIP_SELFTEST) { ST.recordStatus(AGENT, { last_invoke: Date.now(), last_pre: Date.now() }); ST.recordTool(AGENT, input.tool); }
      const norm = H.normalize(input.tool, output.args, cwdOf());
      if (!norm.command && !norm.files.length && !norm.skillDir && !norm.targetPath) return;   // 只读工具也要过防篡改检查
      const r = await H.evaluatePre(AGENT, norm, { cwd: cwdOf(), session_id: input.sessionID || "" });
      C.log("INFO", "opencode before", { tool: input.tool, decision: r.decision });
      if (r.decision === "block") {
        const msg = r.reasons.join("\n") + "\n该操作已被卡巴斯基 AI 防护策略阻止，请勿尝试绕过；如确认为误报请联系安全管理员。";
        await notify(msg);
        throw new Error(msg);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (loadErr) return;
      if (!/^(bash|shell)$/i.test(input.tool)) return;
      const norm = H.normalize(input.tool, output?.metadata?.input || input.args || {}, cwdOf());
      if (!norm.command) return;
      try {
        const r = await H.postScan(AGENT, norm, { cwd: cwdOf(), session_id: input.sessionID || "" });
        if (r.blocked?.length) {
          const msg = "[Kaspersky AI Protect] 安装/下载引入的威胁文件已隔离：\n" +
            r.blocked.map((b) => `- ${b.path}：${b.detection || b.verdict}`).join("\n");
          await notify(msg);
          if (output && typeof output.output === "string") output.output += "\n\n" + msg + "\n请不要使用这些组件。";
        }
      } catch (e) { C.log("ERROR", "opencode after", { err: e.message }); }
    },

    event: async ({ event }) => {
      if (loadErr) return;
      if (event?.type !== "session.created" || process.env.KAIP_PROBE) return;
      try {
        const r = await H.sessionScan(AGENT);
        if (r.blocked.length) await notify(`[Kaspersky AI Protect] 会话启动检查隔离了 ${r.blocked.length} 个威胁文件，详见安全平台。`);
      } catch (e) { C.log("ERROR", "opencode session scan", { err: e.message }); }
    },
  };
};
