// 终端判定缓存回归测试：node tests/test_cache.mjs
// 验证：病毒库版本不变命中缓存；平台通知新版本后缓存与目录增量索引全部失效；兜底有效期
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kaip-cache-"));
process.env.KAIP_HOME = home;                       // 隔离：不触碰本机真实 ~/.kaip
const require = createRequire(import.meta.url);
const C = require("../client/lib/common.js");
const S = require("../client/lib/scanfs.js");

let fail = 0;
const ok = (cond, name) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"} ${name}`); };

// 1. 尚未获知病毒库版本：24 小时兜底
C.cachePut("a1", "CLEAN", "allow", "");
ok(C.cacheGet("a1")?.v === "CLEAN", "未知病毒库版本时缓存可用");
ok(!C.cacheValid({ v: "CLEAN", t: Date.now() - 25 * 3600e3 }, null), "未知版本时超过 24 小时失效");

// 2. 平台告知版本 → 旧条目失效；同版本条目命中
ok(C.setBases("BASES-1") === true, "首次获知病毒库版本");
ok(C.cacheGet("a1") === null, "获知版本后，无版本标记的旧条目失效");
C.cachePut("b1", "CLEAN", "allow", "");
C.cachePut("b2", "DETECT", "block", "EICAR-Test-File");
ok(C.cacheGet("b1")?.v === "CLEAN" && C.cacheGet("b2")?.v === "DETECT", "同一病毒库版本命中（干净 / 检出）");
ok(C.setBases("BASES-1") === false && C.cacheGet("b1"), "重复通知同一版本不清缓存");
ok(C.cacheValid({ v: "CLEAN", t: Date.now() - 6 * 86400e3, b: "BASES-1" }), "版本不变 6 天仍有效（不再按 24 小时过期）");
ok(!C.cacheValid({ v: "CLEAN", t: Date.now() - 8 * 86400e3, b: "BASES-1" }), "版本不变但超过 7 天兜底失效");
ok(!C.cacheValid({ v: "RISK", t: Date.now(), b: "BASES-1" }), "启发式 RISK 不缓存");

// 3. 跨进程：另一个进程（hook）读取同一缓存文件
const disk = JSON.parse(fs.readFileSync(path.join(home, "cache.json"), "utf8"));
ok(disk._meta?.bases === "BASES-1" && disk.b1?.b === "BASES-1", "缓存文件记录病毒库版本");

// 4. 病毒库更新 → 全部失效
ok(C.setBases("BASES-2") === true, "病毒库更新被识别");
ok(C.cacheGet("b1") === null && C.cacheGet("b2") === null, "病毒库更新后干净 / 检出缓存全部失效");

// 5. 目录增量扫描：文件未改动，病毒库未变 → 跳过；病毒库更新 → 重新送检
const f = path.join(home, "skill.py");
fs.writeFileSync(f, "print('hello')\n");
let uploads = 0, bases = "BASES-2";
C.uploadFile = async () => { uploads++; return { verdict: "CLEAN", action: "allow", detection: "", bases_version: bases }; };
await S.scanFile(f, { doQuarantine: false });
await S.scanFile(f, { doQuarantine: false });
ok(uploads === 1, `未改动文件第二次扫描走缓存（送检 ${uploads} 次）`);
bases = "BASES-3"; C.setBases("BASES-3");
await S.scanFile(f, { doQuarantine: false });
ok(uploads === 2, `病毒库更新后同一文件重新送检（送检 ${uploads} 次）`);
await S.scanFile(f, { doQuarantine: false });
ok(uploads === 2, "新病毒库下再次扫描走缓存");

fs.rmSync(home, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
