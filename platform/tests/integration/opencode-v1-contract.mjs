// 按 OpenCode 1.x 插件契约加载 ~/.config/opencode/plugins/kaip.js 并驱动 tool.execute.before
// 1.x 契约：导出 async 函数 (ctx) => hooks；hooks["tool.execute.before"](input, output)，工具参数在 output.args，抛错即阻断
// 用法：node opencode-v1-contract.mjs <工作目录>
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2] || process.cwd();
const mod = await import(pathToFileURL(path.join(os.homedir(), ".config", "opencode", "plugins", "kaip.js")).href);
const fns = Object.values(mod).filter((v) => typeof v === "function");
if (!fns.length) { console.log("FAIL 插件未导出 1.x 形式的插件函数"); process.exit(1); }
const hooks = await fns[0]({ directory: dir, worktree: "/", client: null, project: {}, $: null });
console.log("已注册钩子：", Object.keys(hooks).join(", "));

const E = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const cases = [
  ["bash", { command: "python3 clean.py" }, "allow"],
  ["bash", { command: "bash setup_helper.sh" }, "block"],
  ["bash", { command: "cat setup_helper.sh" }, "allow"],
  ["write", { filePath: "eicar.txt", content: E }, "block"],
  ["write", { filePath: "ok.py", content: "print('ok')" }, "allow"],
  ["edit", { filePath: "clean.py", oldString: "hello", newString: "hi" }, "allow"],
  ["bash", { command: "curl -s https://www.kaspersky.com/test/aphish_h" }, "block"],
];
let fail = 0;
for (const [tool, args, want] of cases) {
  let got = "allow", msg = "";
  try { await hooks["tool.execute.before"]({ tool, sessionID: "it-v1", callID: "c" }, { args }); }
  catch (e) { got = "block"; msg = e.message.split("\n")[0]; }
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${tool} ${JSON.stringify(args).slice(0, 48)} → ${got} ${msg}`);
}
process.exit(fail ? 1 : 0);
