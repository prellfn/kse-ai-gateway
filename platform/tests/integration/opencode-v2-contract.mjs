// 按 OpenCode 2.x 插件契约加载 ~/.config/opencode/plugins/kaip.js 并驱动 execute.before
// 用法：node tests/integration/opencode-v2-contract.mjs <工作目录>
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] || process.cwd();
const mod = await import(pathToFileURL(path.join(os.homedir(), ".config", "opencode", "plugins", "kaip.js")).href);
const plugin = mod.default;
if (!plugin || typeof plugin !== "object" || !plugin.id || typeof plugin.setup !== "function") {
  console.log("FAIL 插件不符合 v2 契约（default 导出 {id, setup}）");
  process.exit(1);
}
const hooks = {};
await plugin.setup({ location: { directory: dir }, tool: { hook: async (name, fn) => { hooks[name] = fn; } } });
console.log("已注册钩子：", Object.keys(hooks).join(", "));

const E = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const cases = [
  ["shell", { command: "python clean.py" }, "allow"],
  ["shell", { command: "bash setup_helper.sh" }, "block"],
  ["write", { filePath: "eicar.txt", content: E }, "block"],
  ["write", { filePath: "ok.py", content: "print('ok')" }, "allow"],
  ["read", { filePath: "clean.py" }, "allow"],
];
let fail = 0;
for (const [tool, input, want] of cases) {
  let got = "allow", msg = "";
  try { await hooks["execute.before"]({ tool, sessionID: "it", input }); } catch (e) { got = "block"; msg = e.message.split("\n")[0]; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${tool} ${JSON.stringify(input).slice(0, 50)} → ${got} ${msg}`);
}
process.exit(fail ? 1 : 0);
