#!/usr/bin/env node
"use strict";
// Codex / WorkBuddy(CodeBuddy) 命令型 Hook 入口
// 用法: kaip-hook.js --agent codex|workbuddy
// 从 stdin 读取 hook JSON（hook_event_name / tool_name / tool_input / cwd / session_id）
// 阻断时：stdout 输出 hookSpecificOutput.permissionDecision=deny，stderr 输出原因，exit 2（两种 Agent 均识别）
const argv = process.argv.slice(2);
const agent = (argv[argv.indexOf("--agent") + 1] || "codex").toLowerCase();

// 防篡改兜底：KAIP 模块被删/被改坏时 require 会抛错，宿主会把异常退出当作“hook 失败”而放行。
// 这里只用 Node 内置模块完成阻断判定：默认阻断（客户端完整性受损时不可信），平台显式 fail_open 且非篡改时才放行。
let C, H;
try {
  C = require("../lib/common");
  H = require("../lib/hook");
} catch (e) {
  const fs = require("fs"), os = require("os"), path = require("path");
  const msg = `[Kaspersky AI Protect] 安全组件不完整（${e.code || e.message}），可能已被篡改，操作已阻止。请联系安全管理员。`;
  try { fs.appendFileSync(path.join(process.env.KAIP_HOME || path.join(os.homedir(), ".kaip"), "logs", "kaip.log"), `${new Date().toISOString()} [ERROR] hook 模块加载失败 ${JSON.stringify({ agent, err: String(e.message).slice(0, 200) })}\n`); } catch {}
  let ev = "PreToolUse";
  try { ev = JSON.parse(fs.readFileSync(0, "utf8") || "{}").hook_event_name || ev; } catch {}
  if (ev !== "PreToolUse") process.exit(0);
  if (agent === "workbuddy" || agent === "codebuddy") {
    process.stdout.write(JSON.stringify({ continue: false, stopReason: msg, hookSpecificOutput: { hookEventName: ev, permissionDecision: "deny", permissionDecisionReason: msg } }) + "\n");
    process.stderr.write(msg + "\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, permissionDecision: "deny", permissionDecisionReason: msg } }) + "\n");
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => resolve(d));
    setTimeout(() => resolve(d), 5000);
  });
}

// 各宿主的「阻断契约」不同（依据实测）：
//   Codex v0.154+ : 只认 stdout 上的 JSON 决策 + exit 0；exit 2 + stderr 不会拦住；
//                   不能带 continue:false / stopReason，否则被判 hook 失败而放行。
//   WorkBuddy     : exit 2 + {continue:false, stopReason, hookSpecificOutput.permissionDecision:'deny'}；
//                   放行输出 {continue:true}，绝不能返回 permissionDecision:'allow'。
//   stdout 必须是单行纯 JSON。
const IS_WB = agent === "workbuddy" || agent === "codebuddy";

function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function deny(event, reason) {
  let out;
  if (event === "PostToolUse") {
    out = { decision: "block", reason, hookSpecificOutput: { hookEventName: event, additionalContext: reason } };
  } else {
    out = { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } };
  }
  if (IS_WB) {
    if (event === "PreToolUse") { out.continue = false; out.stopReason = reason; }
    emit(out);
    process.stderr.write(reason + "\n");
    process.exit(2);
  }
  emit(out);                       // Codex：JSON 决策 + exit 0
  process.exit(0);
}

function allow() {
  if (IS_WB) emit({ continue: true });
  process.exit(0);
}

(async () => {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch (e) { C.log("WARN", "hook stdin 非 JSON，放行", { err: e.message }); allow(); }
  const event = input.hook_event_name || input.hookEventName || argv[argv.indexOf("--event") + 1] || "PreToolUse";
  const cwd = input.cwd || process.cwd();
  const ctx = { cwd, session_id: input.session_id || "" };
  // 每次调用都记录（不含 tool_input 内容），用于排查"宿主是否调用了 hook / matcher 是否命中"
  C.log("INFO", "INVOKE", { agent, event, tool: input.tool_name || "-" });
  if (!process.env.KAIP_SELFTEST) {   // 自测调用不计入「真实调用」，否则会把升级复核误判为已确认
    const ST = require("../lib/status"), ag = agent === "codebuddy" ? "workbuddy" : agent;
    ST.recordStatus(ag, event === "PreToolUse" ? { last_invoke: Date.now(), last_pre: Date.now() } : { last_invoke: Date.now() });
    if (event === "PreToolUse") ST.recordTool(ag, input.tool_name);
  }
  try {
    if (event === "PreToolUse") {
      const norm = H.normalize(input.tool_name, input.tool_input, cwd);
      const r = await H.evaluatePre(agent, norm, ctx);
      C.log("INFO", "PreToolUse", { agent, tool: input.tool_name, decision: r.decision, files: norm.files.length, cmd: (norm.command || "").slice(0, 120) });
      if (r.decision === "block") deny(event, r.reasons.join("\n") + "\n该操作已被卡巴斯基 AI 防护策略阻止，请勿尝试绕过；如确认为误报请联系安全管理员。");
    } else if (event === "PostToolUse") {
      const norm = H.normalize(input.tool_name, input.tool_input, cwd);
      const r = await H.postScan(agent, norm, ctx);
      if (r.blocked && r.blocked.length) {
        const lines = r.blocked.map((b) => `- ${b.path}：${b.detection || b.verdict}${b.local_quarantined ? "（已隔离）" : ""}`).join("\n");
        deny(event, `[Kaspersky AI Protect] 刚才的安装/下载引入了威胁文件，已处置：\n${lines}\n请不要使用或重新下载这些组件。`);
      }
    } else if (event === "SessionStart") {
      const r = await H.sessionScan(agent);
      if (r.blocked.length) {
        const msg = `[Kaspersky AI Protect] 会话启动安全检查：发现并隔离 ${r.blocked.length} 个威胁文件（Skills/插件/模型目录）：\n` +
          r.blocked.map((b) => `- ${b.path}：${b.detection || b.verdict}`).join("\n") + "\n不要调用这些已被隔离的组件。";
        emit({ ...(IS_WB ? { continue: true } : {}), hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: msg } });
        process.exit(0);
      }
    }
  } catch (e) {
    C.log("ERROR", "hook 异常", { err: e.stack || e.message });
    if (C.policy().fail_open === false && event === "PreToolUse") deny(event, "[KAIP] 安全检查异常，按高安全策略阻断：" + e.message);
  }
  allow();
})();
