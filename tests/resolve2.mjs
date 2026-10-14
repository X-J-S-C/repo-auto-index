// 按「仓库相对路径」解析 R 边，验证解析率（同名文件必须靠路径区分）
// 默认读 tests/demo/ 下的示例索引。要换源：node resolve2.mjs <path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, "demo", "aoci.code.txt");
const raw = fs.readFileSync(file, "utf8");
const lines = raw.split(/\r?\n/);

const entries = [];
let dir = "";
for (const l0 of lines) {
  const l = l0.replace(/^\uFEFF/, "");
  if (!l.trim()) continue;
  const seg = l.match(/^=+(.+?)=+$/);
  if (seg) { dir = seg[1].replace(/\\/g, "/").replace(/\/+$/, ""); continue; }
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^(.+?)\[([A-Z0-9]{4,5})\]:\s*(.*)$/);
  if (!m) continue;
  const body = m[3];
  const re = /(?:^|\s\|\s)([FRAS]):\s*/g;
  const marks = []; let mm;
  while ((mm = re.exec(body))) marks.push({ k: mm[1], s: re.lastIndex, at: mm.index });
  const f = {};
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
    f[marks[i].k] = body.slice(marks[i].s, end).trim();
  }
  entries.push({ name: m[1].trim(), dir, tag: m[2], F: f.F || "", R: f.R || "", A: f.A || "", S: f.S || "" });
}

// 求所有 dir 的公共前缀 = 索引根
const dirs = [...new Set(entries.map(e => e.dir))];
let root = dirs[0] || "";
for (const d of dirs) {
  let i = 0;
  while (i < root.length && i < d.length && root[i] === d[i]) i++;
  root = root.slice(0, i);
}
root = root.replace(/[^/]*$/, "");
console.log("索引根（推断）:", root);

for (const e of entries) {
  e.rel = (e.dir.slice(root.length).replace(/^\/+/, "") + "/" + e.name).replace(/^\/+/, "");
}
const byPath = new Map(entries.map(e => [e.rel, e]));
console.log("Entry:", entries.length, " 唯一路径:", byPath.size);

let total = 0, byFull = 0, byBase = 0, miss = 0;
const misses = [];
for (const e of entries) {
  if (!e.R || e.R === "-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
    if (!v) continue;
    total++;
    if (byPath.has(v)) { byFull++; continue; }
    const base = v.split("/").pop();
    const cands = entries.filter(x => x.name === base);
    if (cands.length === 1) { byBase++; continue; }
    if (cands.length > 1) { byBase++; continue; }
    miss++;
    if (misses.length < 10) misses.push(v);
  }
}
console.log(`\nR 边 ${total} 条`);
console.log(`  按完整相对路径命中 : ${byFull}  (${(byFull / total * 100).toFixed(1)}%)`);
console.log(`  退化为按文件名命中 : ${byBase}`);
console.log(`  完全对不上         : ${miss}`);
if (misses.length) { console.log("\n对不上的样例:"); misses.forEach(m => console.log("  " + m)); }
