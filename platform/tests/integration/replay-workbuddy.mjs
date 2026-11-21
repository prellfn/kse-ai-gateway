// 用 WorkBuddy 桌面版实测到的调用形态重放已安装的 hook（验证契约与判定，不依赖 GUI）
// 用法：node tests/integration/replay-workbuddy.mjs <测试目录，内含 setup_helper.sh / clean.py>
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const dir = (process.argv[2] || path.join(os.homedir(), "kaip-it-work")).split("\\").join("/");
const hook = path.join(os.homedir(), ".kaip", "client", "bin", "kaip-hook.js");
const E = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const wbCwd = path.join(os.homedir(), "WorkBuddy");
const cases = [
  ["cd 后执行恶意脚本", { tool_name: "Bash", tool_input: { command: `cd "${dir}" && timeout 90 bash setup_helper.sh; echo "=== EXIT CODE: $? ==="` } }, 2],
  ["cd 后执行正常脚本", { tool_name: "Bash", tool_input: { command: `cd "${dir}" && python clean.py` } }, 0],
  ["cd 后只读查看", { tool_name: "Bash", tool_input: { command: `cd "${dir}" && cat setup_helper.sh` } }, 0],
  ["调用内置技能 xlsx", { tool_name: "Skill", tool_input: { command: "xlsx" } }, 0],
  ["写入 EICAR", { tool_name: "Write", tool_input: { file_path: `${dir}/eicar_wb.txt`, content: E } }, 2],
];
let fail = 0;
for (const [name, p, want] of cases) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", cwd: wbCwd, session_id: "replay", ...p });
  const r = spawnSync(process.execPath, [hook, "--agent", "workbuddy"], { input, encoding: "utf8", timeout: 120000 });
  let out = {};
  try { out = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}"); } catch {}
  const contractOk = r.status === 2 ? out.continue === false && out.hookSpecificOutput?.permissionDecision === "deny" : out.continue === true;
  const ok = r.status === want && contractOk;
  if (!ok) fail++;
  const reason = (out.stopReason || "").split("\n")[0];
  console.log(`${ok ? "PASS" : "FAIL"} ${name} → exit=${r.status} ${reason}`);
}
process.exit(fail ? 1 : 0);
