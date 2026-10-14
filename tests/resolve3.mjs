// 确认 R 目标路径的基准：找出 R 目标对应的 Entry，反推基准
// 默认读 tests/demo/ 下的示例索引。要换源：node resolve3.mjs <path>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(process.argv[2] || path.join(here, "demo", "aoci.code.txt"), "utf8");
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
  entries.push({ name: m[1].trim(), dir, R: f.R || "" });
}
const byName = new Map();
for (const e of entries) { const a = byName.get(e.name) || []; a.push(e); byName.set(e.name, a); }

console.log("=== 抽样：R 目标 vs 实际 Entry 路径 ===");
let shown = 0;
for (const e of entries) {
  if (shown >= 10) break;
  if (!e.R || e.R === "-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
    const base = v.split("/").pop();
    const cands = byName.get(base);
    if (!cands || cands.length !== 1) continue;
    const tgt = cands[0];
    const tgtFull = tgt.dir + "/" + tgt.name;
    // 目标全路径去掉哪些前缀等于 v？
    const suffixMatch = tgtFull.endsWith("/" + v) || tgtFull === v;
    console.log(`\n来源: ${e.name}`);
    console.log(`  R 写作 : ${v}`);
    console.log(`  实际在 : ${tgtFull}`);
    console.log(`  后缀吻合: ${suffixMatch}`);
    shown++;
    if (shown >= 10) break;
  }
}

// 统计：R 目标去掉基准后能对上的比例（试几个候选基准）
console.log("\n=== 候选基准命中率 ===");
// 候选基准：不写死路径，从实际数据推。取「第一个目录」逐级上溯，
// 再加各目录的公共前缀，覆盖真实场景下的典型候选。
const dirs0 = [...new Set(entries.map((e) => e.dir))];
let common0 = dirs0[0] || "";
for (const d of dirs0) {
  let i = 0;
  while (i < common0.length && i < d.length && common0[i] === d[i]) i++;
  common0 = common0.slice(0, i);
}
const candidates = [...new Set([
  dirs0[0],
  common0,
  common0.replace(/[^/]*$/, "").replace(/\/+$/, ""),
  ...dirs0.slice(0, 3),
])];
for (const root of candidates) {
  let hit = 0, tot = 0;
  for (const e of entries) {
    if (!e.R || e.R === "-") continue;
    for (const t of e.R.split(",")) {
      const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
      if (!v) continue;
      tot++;
      const full = root + "/" + v;
      if (entries.some(x => (x.dir + "/" + x.name) === full)) hit++;
    }
  }
  console.log(`  ${root}  ->  ${hit}/${tot}  (${(hit / tot * 100).toFixed(1)}%)`);
}
