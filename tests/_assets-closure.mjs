// 从 manifest 的卡片入口派生「宿主/回归真正需要哪些 ui 资源」。
//
// 为什么需要它（2026-10-14）：
//   tests/assets/ 是 repo-auto-index/ui/assets/ 的手抄副本。手抄会漏，漏了就静默测旧代码。
//   补齐方式是「从入口出发，按引用关系求传递闭包」——引用的来源是页面自身写的 href/src、
//   CSS 的 url()、JS 的静态与动态 import，都是事实，不是清单。
//
//   为什么不用「把 ui/ 全拷过去」这种更简单的办法：那会把页面根本不加载的文件也搬进来
//   （cover.png 只被 manifest 的 face 引用、THIRD_PARTY_NOTICES.txt / *.LEGAL.txt 是许可文本），
//   让测试目录变成一个「缩小版镜像」。测试目录该装的是**回归所需的最小集**，不是镜像。
//
// 入口从哪来：manifest 的 contributes.cards[].route —— 那是宿主真正会服务成卡片的页面。
// 不硬编码，避免 manifest 加卡之后脚本悄悄漏掉。
//
// 用法：node _assets-closure.mjs          打印闭包
//       node _assets-closure.mjs --json   机器可读（供 sync-assets.ps1 消费）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..", "repo-auto-index");
const uiRoot = path.join(appRoot, "ui");

// 入口 = manifest 声明的全部卡片 route（去掉开头的 /）
const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "manifest.json"), "utf8"));
const cards = manifest?.contributes?.cards ?? [];
const ENTRIES = cards.map((c) => String(c.route || "").replace(/^\//, "")).filter(Boolean);

// 宿主把卡片页按 /api/apps/<id>/ui/_surface/<token>/<route> 服务，页面里的相对路径
// （如 ./assets/panel.js）在 UI 根下解析，所以闭包在 ui/ 这颗树下求。
const seen = new Set();
const queue = [...ENTRIES];
const edges = [];
const missing = [];

function resolveRef(fromFile, ref) {
  // 只跟相对路径；跳过 http(s)、data:、#锚点、根路径（根路径交给测试服务器另行映射）
  if (/^(https?:|data:|#|\/)/.test(ref)) return null;
  const dir = path.dirname(fromFile);
  const abs = path.resolve(path.join(uiRoot, dir), ref.split("?")[0].split("#")[0]);
  if (!abs.startsWith(uiRoot)) return null;
  return path.relative(uiRoot, abs).replace(/\\/g, "/");
}

function extract(ext, text) {
  const out = [];
  if (ext === ".html") {
    for (const m of text.matchAll(/(?:href|src)="([^"]+)"/g)) out.push(m[1]);
    // 内联 module 脚本里的相对 import
    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) out.push(m[1]);
  } else if (ext === ".css") {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) out.push(m[1]);
  } else if (ext === ".js" || ext === ".mjs") {
    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) out.push(m[1]);
    for (const m of text.matchAll(/import\s+["'](\.[^"']+)["']/g)) out.push(m[1]);
    // 动态 import：宿主静态校验器的 DYNAMIC_DEPENDENCIES_NOT_PROVEN warning 指的就是它。
    // panel.js 用 `await import("./graph-map.js")` 延迟加载关系网组件，静态 import 扫不到，
    // 而回归确实需要这个文件（关系页测试会切到 map 模式）。
    for (const m of text.matchAll(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(m[1]);
  }
  return out;
}

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  const abs = path.join(uiRoot, rel);
  if (!fs.existsSync(abs)) {
    missing.push(rel);
    continue;
  }
  const ext = path.extname(abs).toLowerCase();
  const text = fs.readFileSync(abs, "utf8");
  for (const raw of extract(ext, text)) {
    const target = resolveRef(rel, raw);
    if (!target) continue;
    edges.push({ from: rel, to: target, raw });
    if (!seen.has(target)) queue.push(target);
  }
}

const files = [...seen].sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ entries: ENTRIES, files, edges, missing }, null, 2));
} else if (missing.length) {
  console.error("闭包里有文件在 ui/ 下不存在（引用悬空）：");
  for (const m of missing) console.error("  " + m);
  process.exit(2);
} else {
  console.log(`入口（来自 manifest 的 cards[].route）：${ENTRIES.join(", ")}`);
  console.log(`闭包 ${files.length} 个文件：`);
  for (const f of files) console.log("  " + f);
  console.log("");
  console.log("引用边：");
  for (const e of edges) console.log(`  ${e.from}  →  ${e.to}`);
}
