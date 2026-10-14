// 检查回归脚本是否还在读 tests/ 里的前端副本。
//
// 为什么需要它（2026-10-14）：
//   这个仓库曾经把 ui/ 的前端资源手抄一份到 tests/assets/。手抄会漏，漏了就跑在旧代码上，
//   绿灯失去意义。2026-10-14 已改成「测试服务器直接读 App 真源码」（见 _resolve.mjs），
//   副本整目录删除。
//
//   但"删了"只是一次性动作，**约定本身需要有人守**：以后新写的回归脚本可能又顺手
//   path.join(root, "panel.html")，把副本机制悄悄复活。
//   本脚本就是那条约定：tests/ 下不得存在前端资源副本，也不得引用它们。
//
// 判据（两类，都可机检）：
//   1. 文件层面：tests/ 下不得有与 ui/ 同名的前端文件（sdk.js / theme.css 是测试专属，豁免）
//   2. 引用层面：*.mjs 里不得出现「把请求指向 tests 目录下的前端文件」的路径拼接
//
// 用法：node _no-local-copies.mjs
// 退出码：0 = 干净；2 = 有副本或引用

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appUi = path.resolve(here, "..", "repo-auto-index", "ui");

// 测试专属文件：本来就只存在于测试侧，不是副本
const EXEMPT = new Set(["sdk.js", "theme.css"]);

const problems = [];

// ── 判据 1：文件层面
function relFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "out") continue;
        walk(p);
      } else {
        out.push(path.relative(root, p).replace(/\\/g, "/"));
      }
    }
  };
  walk(root);
  return out;
}

const uiFiles = new Set(relFiles(appUi));
for (const rel of relFiles(here)) {
  if (rel.endsWith(".md") || rel.endsWith(".mjs") || rel.endsWith(".ps1")) continue;
  if (!uiFiles.has(rel)) continue;
  if (EXEMPT.has(path.basename(rel))) continue;
  problems.push(`tests/${rel} 与 ui/${rel} 同名，是副本（应删，改由 _resolve.mjs 直读真源码）`);
}

// ── 判据 2：引用层面
// 命中「path.resolve(path.join(root, ... 后跟 panel.html / report.html / assets/…」这类写法
const SUSPECT = /path\.resolve\(\s*path\.join\(\s*root\s*,[^)]*(panel\.html|report\.html|assets[\\/](panel|report|app-ui|graph-map))/;
for (const name of fs.readdirSync(here)) {
  if (!name.endsWith(".mjs")) continue;
  if (name === "_no-local-copies.mjs" || name === "_migrate-tmp.mjs") continue;
  const src = fs.readFileSync(path.join(here, name), "utf8");
  const m = src.match(SUSPECT);
  if (m) problems.push(`${name} 里仍有指向 tests 目录的静态路径拼接：${m[0].slice(0, 80)}…`);
}

console.log(`ui/ 下前端文件 ${uiFiles.size} 个；tests/ 下豁免文件 ${[...EXEMPT].join(", ")}`);
if (problems.length === 0) {
  console.log("无本地副本、无副本引用：测试直接读 App 真源码。");
  process.exit(0);
}
console.log(`发现 ${problems.length} 处：`);
for (const p of problems) console.log("  - " + p);
process.exit(2);
