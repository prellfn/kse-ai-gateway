/**
 * kse-gate — OpenCode 插件 (事前拦截)
 *
 * 挂载在 OpenCode 的 `tool.execute.before` 钩子上, 在工具真正执行前调用远端
 * Scan Gateway 让 Kaspersky Scan Engine 扫描内容; 检出威胁则抛错阻断。
 *
 * 拦截范围:
 *   - write / edit / patch / multiedit  → 扫描写入/编辑的内容
 *   - bash / shell / exec               → 扫描待执行脚本、待加载模型、命令中的 URL
 *   - webfetch / fetch / browse         → 扫描待访问的 URL
 *
 * 设计: Fail-Open — 扫描网关不可达时放行, 不阻断 OpenClaw 正常使用;
 *       事后扫描由 Windows File Watcher 与 Ollama Watcher 兜底。
 *
 * 安装: 见同目录 install.sh (会把 kse-client.js 一并复制到插件目录)
 */

import { existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 复用共用客户端库 (install.sh 会复制到同目录)
const { scanText, scanFile, scanUrl, isDetect, blockReason } = await import(
  path.join(__dirname, "kse-client.js").replace(/\\/g, "/")
).then((m) => m.default || m);

const DEBUG_LOG = path.join(__dirname, "debug.log");

const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit", "create", "createfile"]);
const EXEC_TOOLS = new Set(["bash", "shell", "exec", "run"]);
const FETCH_TOOLS = new Set(["webfetch", "web_fetch", "fetch", "browse", "openurl", "open_url"]);

const MODEL_EXT = /\.(gguf|safetensors|bin|pt|pth|onnx|pkl|h5|pb|tflite|ckpt)\b/i;
const SCRIPT_EXT = /\.(py|js|ts|tsx|jsx|sh|bash|zsh|bat|cmd|ps1|exe|dll|jar|rb|pl|php)\b/i;

function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s"'`)\]<>]+/gi) || [];
  return [...new Set(matches)].slice(0, 20);
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.length) return v;
  }
  return "";
}

export const KseGate = async ({ project, client, $, directory, worktree }) => {
  debugLog("register() called");

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool || "").toLowerCase();
      const args = output?.args || {};

      try {
        // ---- 写入类工具: 扫描内容 ----
        if (WRITE_TOOLS.has(tool)) {
          const content = firstString(args.content, args.text, args.newString, args.new_string, args.body);
          const filePath = firstString(args.filePath, args.file_path, args.path);
          if (!content) return;

          debugLog(`扫描写入内容: ${filePath || "(unknown)"}`);
          const result = await scanText(path.basename(filePath || "content.txt"), content);
          if (isDetect(result)) {
            debugLog(`检出威胁，阻止写入: ${filePath} - ${result.detection_name}`);
            throw new Error(blockReason(result, `文件写入已被阻止: ${filePath}`));
          }
          return;
        }

        // ---- 执行类工具: 扫描脚本 / 模型 / URL ----
        if (EXEC_TOOLS.has(tool)) {
          const command = firstString(args.command, args.cmd, args.script);
          const cwd = firstString(args.cwd, args.workdir, args.workingDirectory);
          if (!command) return;

          // A. 待执行脚本
          const scriptMatch = command.match(/["']([^"']+\.[a-z0-9]+)["']/i) ||
            command.match(/\b([\w.\\/:-]+\.[a-z0-9]+)\b/i);
          if (scriptMatch && SCRIPT_EXT.test(scriptMatch[1])) {
            let full = scriptMatch[1];
            if (!path.isAbsolute(full) && cwd) full = path.join(cwd, full);
            if (existsSync(full)) {
              debugLog(`扫描待执行脚本: ${full}`);
              const result = await scanFile(full);
              if (isDetect(result)) {
                debugLog(`检出威胁，阻止执行: ${full} - ${result.detection_name}`);
                throw new Error(blockReason(result, `脚本执行已被阻止: ${full}`));
              }
            }
          }

          // B. 待加载模型
          const modelMatch = command.match(/["']?([^\s"']+\.(?:gguf|safetensors|bin|pt|pth|onnx|pkl|h5|pb|tflite|ckpt))["']?/i);
          if (modelMatch) {
            let full = modelMatch[1];
            if (!path.isAbsolute(full) && cwd) full = path.join(cwd, full);
            if (existsSync(full)) {
              debugLog(`扫描待加载模型: ${full}`);
              const result = await scanFile(full);
              if (isDetect(result)) {
                debugLog(`检出威胁，阻止模型加载: ${full} - ${result.detection_name}`);
                throw new Error(blockReason(result, `模型加载已被阻止: ${full}`));
              }
            }
          }

          // C. 命令中的 URL
          for (const url of extractUrls(command)) {
            debugLog(`扫描命令中的 URL: ${url}`);
            const result = await scanUrl(url);
            if (isDetect(result)) {
              debugLog(`检出威胁 URL，阻止执行: ${url} - ${result.detection_name}`);
              throw new Error(blockReason(result, `命令已被阻止 (恶意 URL): ${url}`));
            }
          }
          return;
        }

        // ---- 网络类工具: 扫描 URL ----
        if (FETCH_TOOLS.has(tool)) {
          const url = firstString(args.url, args.href, args.link, args.uri, args.target);
          if (!url) return;
          debugLog(`扫描 URL: ${url}`);
          const result = await scanUrl(url);
          if (isDetect(result)) {
            debugLog(`检出威胁 URL，阻止访问: ${url} - ${result.detection_name}`);
            throw new Error(blockReason(result, `访问已被阻止: ${url}`));
          }
          return;
        }
      } catch (e) {
        // 阻断异常必须向上抛; 其余异常 fail-open 放行
        if (String(e?.message || "").startsWith("[Kaspersky]")) throw e;
        debugLog(`hook 异常 (fail-open): ${e?.message}`);
        return;
      }
    },
  };
};

export default KseGate;
