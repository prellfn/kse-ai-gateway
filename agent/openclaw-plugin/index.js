/**
 * KSE Security Gate — OpenClaw 插件
 *
 * 在 Agent 真正执行危险动作之前拦截, 调用远程 Scan Gateway 让 Kaspersky Scan Engine
 * 扫描内容; 检出威胁则阻止工具调用。
 *
 * 三个拦截点:
 *   1. write  — 写入文件前扫描文件内容 (内存扫描, 不落盘)
 *   2. edit   — 编辑文件前扫描 new_string
 *   3. exec   — 执行命令前扫描 待执行脚本 / 待加载模型 / Skill 下载命令
 *
 * 设计: Fail-Open — 扫描网关异常时放行, 不阻断 Agent 正常使用。
 * 兜底: 事后扫描由 Windows File Watcher 与 Ollama Watcher 承担。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const SCAN_GATEWAY = process.env.KSE_SCAN_GATEWAY || "http://127.0.0.1:8000";
const SCAN_TIMEOUT = parseInt(process.env.KSE_SCAN_TIMEOUT || "15000", 10);
const DEBUG_LOG = path.join(__dirname, "debug.log");

const SCRIPT_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".sh", ".bash", ".bat", ".cmd", ".ps1", ".exe", ".dll",
  ".vbs", ".jscript", ".wsf", ".jar", ".rb", ".pl", ".php", ".lua",
]);

const MODEL_EXTENSIONS = new Set([
  ".gguf", ".safetensors", ".bin", ".pt", ".pth", ".onnx", ".pkl", ".h5",
  ".pb", ".tflite", ".ckpt", ".mlmodel", ".caffemodel", ".weights",
]);

const DOWNLOAD_KEYWORDS = [
  "git clone", "pip install", "npm install", "npm i ", "yarn add", "pnpm add",
  "curl ", "wget ", "invoke-webrequest", "iex ", "iwr ", "pip download",
];

const SKILL_KEYWORDS = ["skill", "plugin", "openclaw", "clawhub", "mcp", "addons"];

function debugLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG, line, "utf8");
  } catch (e) {
    // ignore
  }
}

/** 上传内容到 Scan Gateway 扫描 (multipart/form-data) */
function scanFileContent(filename, content) {
  return new Promise((resolve) => {
    const boundary = "----KSEGate" + Date.now().toString(16);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const url = new URL("/scan/upload", SCAN_GATEWAY);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        timeout: SCAN_TIMEOUT,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ verdict: "SCAN_ERROR", error: e.message });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ verdict: "SCAN_ERROR", error: "timeout" });
    });
    req.on("error", (e) => resolve({ verdict: "SCAN_ERROR", error: e.message }));
    req.write(body);
    req.end();
  });
}

/** 扫描本机已有文件 (通过 /scan/file, 由网关做路径白名单校验) */
function scanLocalFile(filePath) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ file_path: filePath, timeout: 60 });
    const url = new URL("/scan/file", SCAN_GATEWAY);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "POST",
        timeout: SCAN_TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ verdict: "SCAN_ERROR", error: e.message });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ verdict: "SCAN_ERROR", error: "timeout" });
    });
    req.on("error", (e) => resolve({ verdict: "SCAN_ERROR", error: e.message }));
    req.write(payload);
    req.end();
  });
}

/** 从命令中提取脚本文件路径 */
function extractFilePathFromCommand(command) {
  if (!command) return null;
  const quoted = command.match(/["']([^"']+\.(?:py|js|ts|sh|bash|bat|cmd|ps1|exe|dll|jar))["']/i);
  if (quoted) return quoted[1];
  const bare = command.match(/\b([\w.\\/:-]+\.(?:py|js|ts|sh|bash|bat|cmd|ps1|exe|dll|jar))\b/i);
  return bare ? bare[1] : null;
}

/** 判断命令是否是 Skill / 插件下载 */
function detectSkillDownload(command) {
  if (!command) return null;
  const lower = command.toLowerCase();
  const hasDownload = DOWNLOAD_KEYWORDS.some((k) => lower.includes(k));
  const hasSkill = SKILL_KEYWORDS.some((k) => lower.includes(k));
  return hasDownload && hasSkill ? command : null;
}

function block(reason) {
  return { block: true, blockReason: reason };
}

async function handleBeforeToolCall(toolName, params) {
  try {
    params = params || {};

    // ---- 拦截点一: write ----
    if (toolName === "write" || toolName === "create_file") {
      const filePath = params.path || params.file_path || params.file;
      const content = params.content || params.text || params.data;
      if (!filePath || !content) return;

      debugLog("扫描写入文件: " + filePath);
      const result = await scanFileContent(path.basename(filePath), content);
      if (result.verdict === "DETECT") {
        debugLog("检出威胁，阻止写入: " + filePath + " - " + result.detection_name);
        return block(
          `[Kaspersky] 检出威胁: ${result.detection_name}，文件已被阻止写入: ${filePath}`
        );
      }
      debugLog("文件扫描通过: " + filePath);
      return;
    }

    // ---- 拦截点三: edit ----
    if (toolName === "edit" || toolName === "str_replace") {
      const newString = params.new_string || params.newText || params.content || "";
      const filePath = params.path || params.file_path || params.file;
      if (newString && filePath) {
        debugLog("扫描编辑内容: " + filePath);
        const result = await scanFileContent(path.basename(filePath), newString);
        if (result.verdict === "DETECT") {
          debugLog("检出威胁，阻止编辑: " + filePath + " - " + result.detection_name);
          return block(
            `[Kaspersky] 检出威胁: ${result.detection_name}，文件编辑已被阻止: ${filePath}`
          );
        }
        debugLog("编辑内容扫描通过: " + filePath);
      }
      return;
    }

    // ---- 拦截点二: exec ----
    if (toolName === "exec" || toolName === "shell" || toolName === "bash") {
      const command = params.command || params.cmd || params.script || "";
      const workdir = params.workdir || params.cwd || "";

      // A. 待执行脚本
      const scriptFile = extractFilePathFromCommand(command);
      if (scriptFile) {
        let fullPath = scriptFile;
        if (!path.isAbsolute(scriptFile) && workdir) {
          fullPath = path.join(workdir, scriptFile);
        }
        if (fs.existsSync(fullPath)) {
          debugLog("扫描待执行脚本: " + fullPath);
          const result = await scanLocalFile(fullPath);
          if (result.verdict === "DETECT") {
            debugLog("检出威胁，阻止执行: " + fullPath + " - " + result.detection_name);
            return block(
              `[Kaspersky] 检出威胁: ${result.detection_name}，脚本执行已被阻止: ${fullPath}`
            );
          }
          debugLog("脚本扫描通过: " + fullPath);
        }
      }

      // B. 待加载模型
      const modelMatch = command.match(
        /["']?([^\s"']+\.(?:gguf|safetensors|bin|pt|pth|onnx|pkl|h5|pb|tflite|ckpt))["']?/i
      );
      if (modelMatch) {
        let fullPath = modelMatch[1];
        if (!path.isAbsolute(fullPath) && workdir) {
          fullPath = path.join(workdir, fullPath);
        }
        if (fs.existsSync(fullPath)) {
          debugLog("扫描待加载模型: " + fullPath);
          const result = await scanLocalFile(fullPath);
          if (result.verdict === "DETECT") {
            debugLog("检出威胁，阻止模型加载: " + fullPath + " - " + result.detection_name);
            return block(
              `[Kaspersky] 检出威胁: ${result.detection_name}，模型加载已被阻止: ${fullPath}`
            );
          }
          debugLog("模型扫描通过: " + fullPath);
        }
      }

      // C. Skill 下载命令 (扫描命令文本本身)
      const skillCmd = detectSkillDownload(command);
      if (skillCmd) {
        debugLog("检测到 Skill 下载命令，扫描命令内容");
        const result = await scanFileContent("skill_download.sh", skillCmd);
        if (result.verdict === "DETECT") {
          debugLog("检出威胁，阻止 Skill 下载: " + result.detection_name);
          return block(
            `[Kaspersky] 检出威胁: ${result.detection_name}，Skill 下载命令已被阻止`
          );
        }
        debugLog("Skill 下载命令扫描通过");
      }
      return;
    }
  } catch (e) {
    debugLog("hook 异常 (fail-open): " + e.message);
    return;
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------
function register(api) {
  api.on("before_tool_call", async (payload) => {
    const toolName = payload && payload.toolName;
    const params = (payload && payload.params) || {};
    return await handleBeforeToolCall(toolName, params);
  });
  debugLog("before_tool_call hook registered successfully");
  console.log("[Kaspersky-Gate] register() called");
  console.log("[Kaspersky-Gate] 插件已加载，Scan Gateway: " + SCAN_GATEWAY);
}

module.exports = { register, handleBeforeToolCall };

// 兼容不同 OpenClaw 版本的入口声明
if (typeof definePluginEntry === "function") {
  module.exports = definePluginEntry({ register });
}
