/**
 * kse-client — Node.js 客户端库 (Scan Gateway)
 *
 * 被 OpenCode 插件、各 Agent 的 Hook 脚本复用, 避免重复实现 HTTP 细节。
 * 只做协议适配; 真正的路径白名单 / 隔离 / 审计逻辑在服务端 Scan Gateway。
 *
 * 环境变量:
 *   KSE_SCAN_GATEWAY  Scan Gateway 地址 (默认 http://127.0.0.1:8000)
 *   KSE_SCAN_TIMEOUT  单次请求超时毫秒 (默认 15000)
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const SCAN_GATEWAY = (
  process.env.KSE_SCAN_GATEWAY || "http://127.0.0.1:8000"
).replace(/\/+$/, "");
const SCAN_TIMEOUT = parseInt(process.env.KSE_SCAN_TIMEOUT || "15000", 10);

const VERDICT_DETECT = "DETECT";

/** 底层请求: JSON */
function requestJson(method, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SCAN_GATEWAY);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""),
        method,
        timeout: SCAN_TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`响应解析失败 (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
          if (res.statusCode >= 400) {
            const msg = parsed && (parsed.detail || parsed.message);
            return reject(new Error(msg || `Scan Gateway 返回 ${res.statusCode}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("扫描网关超时"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 底层请求: multipart/form-data 上传 */
function requestUpload(urlPath, fileName, content, contentType) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SCAN_GATEWAY);
    const boundary = "----KSEBoundary" + Date.now().toString(16);
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: ${contentType || "application/octet-stream"}\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"), tail]);

    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
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
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`响应解析失败 (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
          if (res.statusCode >= 400) {
            const msg = parsed && (parsed.detail || parsed.message);
            return reject(new Error(msg || `Scan Gateway 返回 ${res.statusCode}`));
          }
          resolve(parsed);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("扫描网关超时"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 扫描文本内容 (内存, 不落盘) */
async function scanText(fileName, content) {
  return requestUpload("/scan/upload", fileName || "content.txt", content);
}

/** 扫描本机文件 (需在网关允许目录内) */
async function scanFile(filePath, timeout) {
  return requestJson("POST", "/scan/file", { file_path: filePath, timeout: timeout || 120 });
}

/** 扫描 URL (钓鱼 / 恶意链接) */
async function scanUrl(url, timeout) {
  return requestJson("POST", "/scan/url", { url, timeout: timeout || 60 });
}

/** 深度扫描压缩包 (解包逐文件) */
async function scanPackage(filePath) {
  const content = fs.readFileSync(filePath);
  return requestUpload("/scan/package", path.basename(filePath), content);
}

/** 网关健康检查 */
async function checkHealth() {
  return requestJson("GET", "/health", {});
}

/** 判断结果是否为检出威胁 */
function isDetect(result) {
  return !!result && result.verdict === VERDICT_DETECT;
}

/** 统一的阻断信息 */
function blockReason(result, fallback) {
  const name = (result && result.detection_name) || "未知威胁";
  return `[Kaspersky] 检出威胁: ${name}，${fallback}`;
}

module.exports = {
  SCAN_GATEWAY,
  SCAN_TIMEOUT,
  scanText,
  scanFile,
  scanUrl,
  scanPackage,
  checkHealth,
  isDetect,
  blockReason,
};
