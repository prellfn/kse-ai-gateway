// OpenCode 插件在 KAIP 客户端被改坏时的行为：应阻断（fail-closed），修复后无需重启 OpenCode 即自动恢复
// 用法：node tests/test_plugin_broken.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kaip-broken-"));
const client = path.join(tmp, "client");
fs.cpSync ? null : null;
const copy = (s, d) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(s, { withFileTypes: true })) e.isDirectory() ? copy(path.join(s, e.name), path.join(d, e.name)) : fs.copyFileSync(path.join(s, e.name), path.join(d, e.name)); };
for (const d of ["bin", "lib", "adapters"]) copy(path.join(repo, "client", d), path.join(client, d));
const hookJs = path.join(client, "lib", "hook.js");
const good = fs.readFileSync(hookJs);
fs.appendFileSync(hookJs, "\nthis is not javascript (((\n");     // 改坏

let fail = 0;
for (const v of ["v1", "v2"]) {
  const src = fs.readFileSync(path.join(repo, "client", "adapters", "opencode", `kaip.${v}.js`), "utf8")
    .split("__KAIP_CLIENT__").join(client.split(path.sep).join("/"));
  const pf = path.join(tmp, `plugin-${v}.mjs`);
  fs.writeFileSync(pf, src);
  fs.writeFileSync(hookJs, Buffer.concat([good, Buffer.from("\nthis is not javascript (((\n")]));   // 每轮从“已损坏”开始
  const mod = await import(pathToFileURL(pf).href + "?" + v);
  let before;
  if (v === "v2") {
    const hooks = {};
    await mod.default.setup({ location: { directory: tmp }, tool: { hook: async (n, fn) => { hooks[n] = fn; } } });
    before = (tool, args) => hooks["execute.before"]({ tool, sessionID: "t", input: args });
  } else {
    const hooks = await mod.KaipPlugin({ directory: tmp, worktree: "/", client: null });
    before = (tool, args) => hooks["tool.execute.before"]({ tool, sessionID: "t", callID: "c" }, { args });
  }
  let r1 = "allow";
  try { await before("bash", { command: "ls" }); } catch (e) { r1 = /安全组件不完整/.test(e.message) ? "block" : "error:" + e.message.slice(0, 60); }
  fs.writeFileSync(hookJs, good);                                      // 模拟自愈完成
  let r2 = "allow";
  try { await before("bash", { command: "ls" }); } catch (e) { r2 = "block:" + e.message.slice(0, 60); }
  const ok = r1 === "block" && r2 === "allow";
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} 插件 ${v}：客户端损坏时 ${r1}，修复后（不重启 OpenCode）${r2}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
