// 客户端归一化回归测试：node tests/test_client.mjs
// 验证「只有执行/加载/解包才扫描引用文件，只读查看不扫描」，以及各宿主的工具调用形态
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../client/lib/hook.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kaip-norm-"));
for (const f of ["setup.sh", "run.ps1", "train.py", "model.pt", "pkg.zip"]) fs.writeFileSync(path.join(dir, f), "x");

const files = (tool, input) => H.normalize(tool, input, dir).files.filter((f) => f.kind !== "literal").map((f) => path.basename(f.path)).sort().join(",");
const cases = [
  // [说明, 工具, 入参, 期望扫描的文件]
  ["bash 执行脚本", "Bash", { command: "bash setup.sh" }, "setup.sh"],
  ["直接执行 ./x.sh", "Bash", { command: "./setup.sh --x" }, "setup.sh"],
  ["PowerShell -File", "Bash", { command: "powershell -ExecutionPolicy Bypass -File run.ps1" }, "run.ps1"],
  ["python 加载模型", "Bash", { command: "python train.py --ckpt model.pt" }, "model.pt,train.py"],
  ["解包", "Bash", { command: "unzip pkg.zip -d out" }, "pkg.zip"],
  ["管道后执行", "Bash", { command: "echo hi && sh setup.sh" }, "setup.sh"],
  ["Get-Content 只读", "Bash", { command: "Get-Content -Raw setup.sh" }, ""],
  ["cat 只读", "Bash", { command: "cat setup.sh | head -5" }, ""],
  ["grep 只读", "Bash", { command: "grep -n curl setup.sh run.ps1" }, ""],
  ["type / Select-String 只读", "Bash", { command: "type setup.sh; Select-String curl run.ps1" }, ""],
  ["复制不执行", "Bash", { command: "cp setup.sh backup.sh" }, ""],
  ["混合：查看后执行", "Bash", { command: "cat setup.sh; bash setup.sh" }, "setup.sh"],
  ["Codex 数组形式", "shell", { command: ["bash", "-lc", "bash setup.sh"] }, "setup.sh"],
];
let fail = 0;
for (const [name, tool, input, want] of cases) {
  const got = files(tool, input);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: 期望[${want}] 实际[${got}]`);
}
// 命令内 cd 切换目录（WorkBuddy 实测形态：cwd 是其工作区，命令里先 cd 到目标目录）
const other = os.homedir();
const fwd = dir.split("\\").join("/");
const msys = process.platform === "win32" ? "/" + fwd[0].toLowerCase() + fwd.slice(2) : fwd;
const cdCases = [
  ["WorkBuddy cd && timeout bash", `cd "${fwd}" && timeout 90 bash setup.sh; echo "=== EXIT CODE: $? ==="`, "setup.sh"],
  ["Git Bash 风格路径", `cd ${msys} && ./setup.sh`, "setup.sh"],
  ["PowerShell Set-Location", `Set-Location -Path '${dir}'; powershell -File run.ps1`, "run.ps1"],
  ["cd 后只读", `cd "${fwd}" && cat setup.sh`, ""],
];
for (const [name, command, want] of cdCases) {
  const got = H.normalize("Bash", { command }, other).files.filter((f) => f.kind !== "literal").map((f) => path.basename(f.path)).sort().join(",");
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: 期望[${want}] 实际[${got}]`);
}

// 代码执行类 MCP 工具（Codex 实测绕过形态：mcp__node_repl__js + fs.writeFileSync）
const js = 'import fs from "node:fs";\nconst e = "X5O!P%@AP[4\\\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";\nfs.writeFileSync("a.txt", e);';
const cn = H.normalize("mcp__node_repl__js", { code: js, title: "x" }, dir);
// 字面量必须作为「独立对象」送检，且内容与运行时写盘内容完全一致（真实引擎对 EICAR 有位置/长度要求）
const okCode = cn.files[0]?.kind === "code" &&
  cn.files.some((f) => f.content === "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
if (!okCode) fail++;
console.log(`${okCode ? "PASS" : "FAIL"} MCP 代码执行工具：送检代码并解出字符串字面量中的真实内容`);
const py = H.normalize("execute_python", { input: "print('hi')" }, dir);
console.log(py.files[0]?.kind === "code" ? "PASS execute_python 识别为代码执行" : (fail++, "FAIL execute_python"));

// shell 命令内联内容（Codex 0.166 实测绕过形态：python3 -c 'open(...).write(r"<EICAR>")'）
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const inlineCases = [
  ["python3 -c 原始字符串", `python3 -c 'open("e.txt","w").write(r"${EICAR}")'`],
  ["python3 -c 普通字符串（转义）", `python3 -c "open('e.txt','w').write('${EICAR.replace(/\\/g, "\\\\")}')"`],
  ["node -e", `node -e 'require("fs").writeFileSync("e.txt", ${JSON.stringify(EICAR)})'`],
  ["heredoc 写文件", `cat > e.txt <<'EOF'\n${EICAR}\nEOF`],
  ["echo 重定向", `echo '${EICAR}' > e.txt`],
];
for (const [name, command] of inlineCases) {
  const n = H.normalize("Bash", { command }, dir);
  const ok = n.files.some((f) => f.kind === "literal" && f.content.trim() === EICAR);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} 内联内容送检：${name}`);
}
const g = H.normalize("Bash", { command: 'grep -rn "curl.*| bash" ./scripts' }, dir);
const okG = g.files.every((f) => f.kind === "literal");
if (!okG) fail++;
console.log(`${okG ? "PASS" : "FAIL"} grep 的检索串仅作 literal（只交引擎、不跑启发式规则）`);

// 防篡改：应阻断 / 不应误拦
const T = require("../client/lib/tamper.js");
const HM = os.homedir().split("\\").join("/");
const tamperBlock = [
  "cat ~/.kaip/config.json", `grep -rn download-exec ${HM}/.kaip/client`, "ls -la .kaip/", "rm -rf ~/.kaip",
  `echo '{}' > ${HM}/.codex/hooks.json`, "sed -i '/kaip-hook/d' ~/.codex/hooks.json", "sed -i 's/hooks = true/hooks = false/' ~/.codex/config.toml",
  "rm ~/.config/opencode/plugins/kaip.js", "systemctl --user stop kaip-watch", "systemctl --user disable kaip-watch.service",
  "pkill -f kaip", "kaip uninstall", "node ~/.kaip/client/bin/kaip.js uninstall", "codex exec --dangerously-bypass-hook-trust 'x'",
  'schtasks /Delete /F /TN KAIP-Watch', "taskkill /F /IM node.exe", "Remove-Item $env:USERPROFILE\\.kaip -Recurse",
  "python3 -c \"import json;d=json.load(open('/root/.workbuddy/settings.json'));d.pop('hooks');json.dump(d,open('/root/.workbuddy/settings.json','w'))\"",
];
const tamperAllow = [
  "cat ~/.codex/config.toml", "ls ~/.codex", "git status", "npm install", "node ~/.kaip/client/bin/kaip.js status",
  "kaip scan ./models", "grep -n hooks README.md", "cat ~/.workbuddy/settings.json", "python3 train.py",
  // 只读 + 无害重定向（真实误报：Agent 命令普遍带 2>&1 / 2>/dev/null）
  "ls 2>&1; cat ~/.codex/config.toml", "cat ~/.codex/config.toml 2>/dev/null", "grep -n hooks ~/.codex/config.toml 2>&1 | head",
  "cat ~/.workbuddy/settings.json &>/dev/null", "Get-Content $env:USERPROFILE\\.codebuddy\\settings.json 2>$null",
];
// 写入特征仍然有效（重定向到受保护文件、或与写命令同时出现）
tamperBlock.push(
  "echo '[features]' >> ~/.codex/config.toml 2>&1", "cat /tmp/x > ~/.codex/config.toml 2>/dev/null",
  "cp /tmp/evil.toml ~/.codex/config.toml 2>&1", "echo '{}' >~/.workbuddy/settings.json",
);
for (const c of tamperBlock) { const r = T.checkCommand(c); const ok = !!r; if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} 防篡改阻断：${c.slice(0, 60)}${r ? " → " + r.desc : ""}`); }
for (const c of tamperAllow) { const r = T.checkCommand(c); const ok = !r; if (!ok) fail++; console.log(`${ok ? "PASS" : "FAIL"} 防篡改不误拦：${c.slice(0, 60)}${r ? " → " + r.desc : ""}`); }
const tw = T.check(H.normalize("Write", { file_path: path.join(os.homedir(), ".codex", "hooks.json"), content: "{}" }, dir));
console.log(tw ? "PASS 防篡改阻断：Write 覆盖 hooks.json" : (fail++, "FAIL Write hooks.json"));
const tr = T.check(H.normalize("read", { filePath: path.join(os.homedir(), ".kaip", "config.json") }, dir));
console.log(tr ? "PASS 防篡改阻断：read 工具读取 KAIP 凭据" : (fail++, "FAIL read config.json"));

// 写文件 / 补丁 / 技能
const w = H.normalize("Write", { file_path: "a.py", content: "print(1)" }, dir);
console.log(w.files[0]?.kind === "write" ? "PASS Write 内容扫描" : (fail++, "FAIL Write"));
const p = H.normalize("apply_patch", { command: "*** Begin Patch\n*** Add File: b.py\n+print(2)\n*** End Patch" }, dir);
console.log(p.files[0]?.content === "print(2)" ? "PASS apply_patch 解析" : (fail++, "FAIL apply_patch"));
const s = H.normalize("Skill", { command: "no-such-skill-xyz" }, dir);
console.log(s.command === null && s.files.length === 0 ? "PASS Skill 不当作命令" : (fail++, "FAIL Skill"));

fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
