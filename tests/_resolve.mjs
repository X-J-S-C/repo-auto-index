// 测试静态服务器的双根解析。
//
// 为什么需要它（2026-10-14）：
//   回归脚本以前从 tests/ 读页面与资源，而那些页面与资源是 repo-auto-index/ui/ 的
//   **手抄副本**。手抄会漏，漏了就跑在旧代码上，绿灯失去意义。
//
//   上一版的做法是加一个同步器（sync-assets.ps1）把副本对齐。那只是把"人记得"
//   换成"脚本记得"，第二份物理副本还在——同一份事实存两处，靠机制同步，终究是欠账。
//
//   本模块取消副本：让测试服务器**直接读 App 真源码**。
//   真理源回到一处（repo-auto-index/ui/），测试目录不再持有前端代码的任何拷贝。
//
// 解析顺序（每一层都有明确理由）：
//   1. 测试专属覆盖（sdk.js / theme.css）——这两个本来就**不是**副本：
//        sdk.js   4379 字节的 mock，用来模拟无 SDK / 后端不可达等失败路径
//        theme.css 探针页用的样式
//      它们必须优先，否则会被 ui/ 下的真 SDK 顶掉，失败路径就测不出来了。
//   2. App 真源码（repo-auto-index/ui/）——页面、样式、脚本、资源。
//   3. 测试目录回退——探针页（probe-*.html / tabs-probe.html / test-map.html）、
//      fixture.json、graph-contract.json 等测试自有数据。
//
// 安全：两层都做前缀校验，路径逃不出各自的根。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const testsRoot = path.dirname(fileURLToPath(import.meta.url));
export const appUiRoot = path.resolve(testsRoot, "..", "repo-auto-index", "ui");

// 测试专属覆盖：按**文件名**匹配（它们位于 assets/ 下，但只按名字判断更稳）
const TEST_OVERRIDES = new Set(["sdk.js", "theme.css"]);

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 把请求路径解析成本地文件绝对路径；解析不到返回 null。
 * @param {string} urlPath 形如 "/panel.html" 或 "/assets/panel.js"（可带 query）
 * @returns {string|null}
 */
export function resolveStatic(urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(String(urlPath).split("?")[0]).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!clean) clean = "panel.html";

  // 1. 测试专属覆盖
  if (TEST_OVERRIDES.has(path.basename(clean))) {
    const t = path.resolve(testsRoot, clean);
    if (inside(t, testsRoot) && isFile(t)) return t;
    return null;
  }

  // 2. App 真源码优先
  const a = path.resolve(appUiRoot, clean);
  if (inside(a, appUiRoot) && isFile(a)) return a;

  // 3. 测试目录回退
  const t = path.resolve(testsRoot, clean);
  if (inside(t, testsRoot) && isFile(t)) return t;

  return null;
}

/**
 * 给测试服务器用的一步式响应：解析 + 写响应。
 * 让各脚本的 server 回调收敛成一行，避免 20 份重复的解析逻辑各自漂移。
 * @param {import("node:http").ServerResponse} res
 * @param {string} urlPath
 * @param {Record<string,string>} mime
 * @returns {boolean} 是否已处理（false 表示 404 已写出）
 */
export function serveStatic(res, urlPath, mime) {
  const file = resolveStatic(urlPath);
  if (!file) {
    res.writeHead(404);
    res.end("nope");
    return false;
  }
  res.writeHead(200, {
    "content-type": mime[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
