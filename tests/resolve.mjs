// 早期探查：Entry 名集合与 R 目标解析率。默认读 tests/demo/ 下的示例索引。
// 要换源：node resolve.mjs <path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(process.argv[2] || path.join(here, "demo", "aoci.code.txt"), "utf8");
const lines = raw.split(/\r?\n/);
const entries = [];
let dir = "";
for (const l of lines) {
  if (/^=+(.+?)=+$/.test(l)) { dir = l.replace(/^=+/,"").replace(/=+$/,""); continue; }
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^(.+?)\[([A-Z0-9]{4,5})\]:\s*(.*)$/);
  if (!m) continue;
  const parts = m[3].split(/\s*\|\s*/);
  const f = (k)=>{const p=parts.find(x=>x.startsWith(k+":"));return p?p.slice(k.length+1).trim():"";};
  entries.push({ name:m[1], dir, R:f("R") });
}
const names = new Set(entries.map(e=>e.name));
const paths = new Set(entries.map(e=>e.dir.replace(/^=+|=$/g,"").replace(/\\/g,"/").replace(/\/$/,"")+"/"+e.name));
console.log("Entry 名集合:", names.size, " 全路径集合:", paths.size);

// R 目标解析率
let total=0, byName=0, byPath=0, miss=0;
const misses=[];
for (const e of entries) {
  if (!e.R || e.R === "-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim().replace(/^code:/,"").replace(/\\/g,"/");
    if (!v) continue;
    total++;
    const base = v.split("/").pop();
    if (names.has(base)) byName++;
    else if (paths.has(v)) byPath++;
    else { miss++; if (misses.length<8) misses.push(v); }
  }
}
console.log(`\nR 边 ${total} 条：`);
console.log(`  按 Entry 名匹配上 : ${byName}`);
console.log(`  按全路径匹配上    : ${byPath}`);
console.log(`  匹配不上          : ${miss}`);
console.log("\n未匹配样例:"); misses.forEach(m=>console.log("  "+m));
