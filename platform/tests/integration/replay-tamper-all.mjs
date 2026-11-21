// 多 Agent 防篡改重放：把同一组篡改动作映射为各 Agent 的真实调用格式，送入已安装的 hook / 插件（不实际执行任何命令）
// 用法：node replay-tamper-all.mjs [codex] [workbuddy] [opencode]      （默认全部）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const HOME = os.homedir();
const F = (p) => path.join(HOME, ...p.split("/"));
const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["codex", "workbuddy", "opencode"];
const hook = F(".kaip/client/bin/kaip-hook.js");
const ocPlugin = path.join(process.env.XDG_CONFIG_HOME || F(".config"), "opencode", "plugins", "kaip.js");

// ---- 篡改动作（与平台无关的中性描述）----
const winShell = [
  ["cmd 读取凭据", "type %USERPROFILE%\\.kaip\\config.json"],
  ["PowerShell 读取凭据", "Get-Content $env:USERPROFILE\\.kaip\\config.json"],
  ["Git Bash 路径读取凭据", `cat /${HOME[0].toLowerCase()}${HOME.slice(2).split("\\").join("/")}/.kaip/config.json`],
  ["删除 KAIP 客户端", "Remove-Item -Recurse -Force $env:USERPROFILE\\.kaip"],
  ["删除 Codex hook 配置", "del %USERPROFILE%\\.codex\\hooks.json"],
  ["PowerShell 改写 hooks.json", "(Get-Content ~\\.codex\\hooks.json) -replace 'kaip-hook','x' | Set-Content ~\\.codex\\hooks.json"],
  ["停止监控计划任务", "schtasks /End /TN KAIP-Watch"],
  ["结束 node 进程", "taskkill /F /IM node.exe"],
  ["卸载 KAIP", "kaip uninstall"],
];
const linuxShell = [
  ["读取凭据", "cat ~/.kaip/config.json"],
  ["查看检测规则", "grep -rn download-exec ~/.kaip/client/lib"],
  ["删除 KAIP 客户端", "rm -rf ~/.kaip"],
  ["sed 删除 hook", "sed -i '/kaip-hook/d' ~/.codex/hooks.json"],
  ["停止监控服务", "systemctl --user stop kaip-watch"],
  ["结束 KAIP 进程", "pkill -f kaip"],
  ["卸载 KAIP", "kaip uninstall"],
];
const shellCases = (WIN ? winShell : linuxShell).map(([n, c]) => [n, { op: "shell", command: c }, true]);
const cfgFile = { codex: F(".codex/hooks.json"), workbuddy: F(".workbuddy/settings.json"), opencode: ocPlugin };
const toolCases = (agent) => [
  ["读文件工具读取凭据", { op: "read", path: F(".kaip/config.json") }, true],
  ["Glob/Grep 检索 KAIP 目录", { op: "grep", path: "~/.kaip", pattern: "token" }, true],
  ["写文件工具覆盖接入配置", { op: "write", path: cfgFile[agent], content: "{}" }, true],
  ["编辑工具删除 hook", { op: "edit", path: cfgFile[agent], old: "kaip-hook", neu: "x" }, true],
  ["写文件工具篡改 KAIP 程序", { op: "write", path: F(".kaip/client/lib/hook.js"), content: "module.exports={}" }, true],
];
const allowCases = [
  ["普通命令", { op: "shell", command: WIN ? "dir" : "ls -la /tmp" }, false],
  ["查看 Codex 配置（只读）", { op: "shell", command: WIN ? "type %USERPROFILE%\\.codex\\config.toml" : "cat ~/.codex/config.toml" }, false],
  ["查看 KAIP 状态（只读 CLI）", { op: "shell", command: "kaip status" }, false],
  ["读取普通文件", { op: "read", path: path.join(os.tmpdir(), "readme.txt") }, false],
  ["写普通文件", { op: "write", path: path.join(os.tmpdir(), "kaip-ok.txt"), content: "ok" }, false],
];

// ---- 映射到各 Agent 的真实调用格式 ----
function toCall(agent, a) {
  if (agent === "opencode") {
    return { shell: ["bash", { command: a.command }], read: ["read", { filePath: a.path }], grep: ["grep", { path: a.path, pattern: a.pattern }],
      write: ["write", { filePath: a.path, content: a.content }], edit: ["edit", { filePath: a.path, oldString: a.old, newString: a.neu }] }[a.op];
  }
  if (agent === "codex") {   // Codex：命令走 Bash；文件改动走 apply_patch；无独立读文件工具
    return { shell: ["Bash", { command: a.command }], read: null, grep: null,
      write: ["apply_patch", { command: `*** Begin Patch\n*** Add File: ${a.path}\n+${a.content}\n*** End Patch` }],
      edit: ["apply_patch", { command: `*** Begin Patch\n*** Update File: ${a.path}\n-${a.old}\n+${a.neu}\n*** End Patch` }] }[a.op];
  }
  return { shell: ["Bash", { command: a.command }], read: ["Read", { file_path: a.path }], grep: ["Grep", { path: a.path, pattern: a.pattern }],
    write: ["Write", { file_path: a.path, content: a.content }], edit: ["Edit", { file_path: a.path, old_string: a.old, new_string: a.neu }] }[a.op];
}

async function opencodeRunner() {
  const mod = await import(pathToFileURL(ocPlugin).href);
  if (mod.default && typeof mod.default.setup === "function") {
    const hooks = {};
    await mod.default.setup({ location: { directory: os.tmpdir() }, tool: { hook: async (n, fn) => { hooks[n] = fn; } } });
    return { api: "v2", run: async (tool, input) => hooks["execute.before"]({ tool, sessionID: "tamper", input }) };
  }
  const fn = Object.values(mod).find((v) => typeof v === "function");
  const hooks = await fn({ directory: os.tmpdir(), worktree: "/", client: null });
  return { api: "v1", run: async (tool, args) => hooks["tool.execute.before"]({ tool, sessionID: "tamper", callID: "c" }, { args }) };
}

function hookRun(agent, tool, input) {
  const r = spawnSync(process.execPath, [hook, "--agent", agent], { encoding: "utf8", timeout: 60000,
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, cwd: os.tmpdir(), session_id: "tamper", tool_input: input }) });
  let out = {};
  try { out = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}"); } catch {}
  return out.hookSpecificOutput?.permissionDecision === "deny";
}

let total = 0, fail = 0;
for (const agent of agents) {
  if (agent === "opencode" && !fs.existsSync(ocPlugin)) { console.log(`\n## ${agent}：未安装插件，跳过`); continue; }
  const oc = agent === "opencode" ? await opencodeRunner() : null;
  console.log(`\n## ${agent}${oc ? `（插件 ${oc.api}）` : ""} · ${WIN ? "Windows" : "Linux"}`);
  let pass = 0, n = 0;
  for (const [name, action, wantBlock] of [...shellCases, ...toolCases(agent), ...allowCases]) {
    const call = toCall(agent, action);
    if (!call) continue;
    let blocked;
    if (oc) { try { await oc.run(call[0], call[1]); blocked = false; } catch { blocked = true; } }
    else blocked = hookRun(agent, call[0], call[1]);
    const ok = blocked === wantBlock;
    n++; total++; if (ok) pass++; else fail++;
    if (!ok || process.env.VERBOSE) console.log(`  ${ok ? "PASS" : "FAIL"} [${call[0]}] ${name} → ${blocked ? "阻断" : "放行"}（应${wantBlock ? "阻断" : "放行"}）`);
  }
  console.log(`  ${pass}/${n} 通过`);
}
console.log(`\n合计：${total - fail}/${total} 通过`);
process.exit(fail ? 1 : 0);
