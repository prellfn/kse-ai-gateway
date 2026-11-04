/**
 * plugin-probe — OpenClaw 插件单元验证探针
 *
 * 直接调用插件导出的 handleBeforeToolCall, 验证三类拦截行为:
 *   1. write 工具写入 EICAR 内容 -> 应返回 block
 *   2. write 工具写入正常内容   -> 不应阻断
 *   3. web_fetch 访问恶意 URL   -> 应返回 block
 *
 * 用法:
 *   node plugin-probe.js <插件路径/index.js> [ScanGateway地址]
 *
 * 退出码: 0 = 全部符合预期, 1 = 存在不符, 2 = 插件加载失败
 *
 * 说明: 插件默认 Fail-Open —— 若 Scan Gateway 不可达, 拦截不会触发,
 *       探针会明确报告 "gateway-unreachable" 而不是误判为通过。
 */
"use strict";

const path = require("path");

const pluginPath = process.argv[2];
const gateway = process.argv[3] || process.env.KSE_SCAN_GATEWAY || "http://127.0.0.1:8000";
process.env.KSE_SCAN_GATEWAY = gateway;

if (!pluginPath) {
  console.error("用法: node plugin-probe.js <插件路径/index.js> [ScanGateway]");
  process.exit(2);
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const MALICIOUS_URL = "https://malicious.example.com/payload";
const CLEAN_URL = "https://example.com/";

async function main() {
  let plugin;
  try {
    plugin = require(path.resolve(pluginPath));
  } catch (e) {
    console.log(JSON.stringify({ error: `插件加载失败: ${e.message}` }));
    process.exit(2);
  }

  const hook = plugin.handleBeforeToolCall;
  if (typeof hook !== "function") {
    console.log(JSON.stringify({ error: "插件未导出 handleBeforeToolCall" }));
    process.exit(2);
  }

  // 先探网关连通性
  let reachable = true;
  try {
    const resp = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(8000) });
    reachable = resp.ok;
  } catch {
    reachable = false;
  }

  const writeBad = await hook("write", { path: "C:/temp/eicar.txt", content: EICAR });
  const writeGood = await hook("write", { path: "C:/temp/ok.txt", content: "harmless content" });
  const urlBad = await hook("web_fetch", { url: MALICIOUS_URL });
  const urlGood = await hook("web_fetch", { url: CLEAN_URL });

  const result = {
    gateway,
    gatewayReachable: reachable,
    writeBlocked: !!(writeBad && writeBad.block),
    writeReason: (writeBad && writeBad.blockReason) || null,
    writeCleanAllowed: !writeGood,
    urlBlocked: !!(urlBad && urlBad.block),
    urlReason: (urlBad && urlBad.blockReason) || null,
    urlCleanAllowed: !urlGood,
  };

  if (!reachable) {
    result.verdict = "GATEWAY-UNREACHABLE";
    result.note = "Scan Gateway 不可达, 插件按 Fail-Open 放行 —— 拦截未真正被验证";
  } else {
    const pass =
      result.writeBlocked && result.writeCleanAllowed && result.urlBlocked && result.urlCleanAllowed;
    result.verdict = pass ? "PASS" : "FAIL";
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(2);
});
