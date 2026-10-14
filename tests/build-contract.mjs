// 生成关系数据契约：解析 aoci.code.txt，产出 /repo/:id/graph 的确切形状
// 这是派活前的接口冻结文件，三路子助手都以此为准。
// 默认读 tests/demo/ 下的示例索引（合成数据）。要换源：node build-contract.mjs <path> [outJson]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.join(here, "demo", "aoci.code.txt");
const OUT = process.argv[3] || path.join(here, "graph-contract.json");
const raw = fs.readFileSync(SRC, "utf8");

// ── 解析 ─────────────────────────────────────────────
const entries = [];
let dir = "";
for (const l0 of raw.split(/\r?\n/)) {
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
  entries.push({
    name: m[1].trim(), dir, tag: m[2],
    layer: m[2][0], module: m[2][1], importance: m[2][2], scale: m[2][3],
    F: f.F || "", R: f.R || "", A: f.A || "", S: f.S || "",
  });
}

// 索引根 = R 目标的比较基准。
// 实测坑：不能取"所有 dir 的公共前缀"再砍一段（会得到一个过浅的目录，命中率 0%）；
// 命中率 0%）；也不能假定为仓库根（Vault 根只命中 0.9%）。
// 正解：拿几个候选基准试，选按完整路径命中率最高的那个。
const dirs = [...new Set(entries.map(e => e.dir))];
let common = dirs[0] || "";
for (const d of dirs) {
  let i = 0;
  while (i < common.length && i < d.length && common[i] === d[i]) i++;
  common = common.slice(0, i);
}

function scoreRoot(root) {
  const set = new Set(entries.map(e => (e.dir + "/" + e.name)));
  let hit = 0, tot = 0;
  for (const e of entries) {
    if (!e.R || e.R === "-") continue;
    for (const t of e.R.split(",")) {
      const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
      if (!v) continue;
      tot++;
      if (set.has(root + "/" + v)) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

const rootCandidates = [common, common.replace(/[^/]*$/, "").replace(/\/+$/, ""), ...dirs.slice(0, 5)];
let root = common, best = -1;
for (const c of [...new Set(rootCandidates)]) {
  const s = scoreRoot(c);
  if (s > best) { best = s; root = c; }
}

// 每条 Entry 的仓内相对路径 = R 目标的比较基准
for (const e of entries) {
  e.rel = (e.dir.slice(root.length).replace(/^\/+/, "") + "/" + e.name).replace(/^\/+/, "");
  e.id = e.rel;                      // 稳定 id：仓内相对路径
  e.path = e.dir + "/" + e.name;     // 绝对路径（展示/复制用）
}
const byRel = new Map(entries.map(e => [e.rel, e]));
const byName = new Map();
for (const e of entries) { const a = byName.get(e.name) || []; a.push(e); byName.set(e.name, a); }

// ── 边 ───────────────────────────────────────────────
const edges = [];
let unresolved = 0;
const unresolvedSamples = [];
for (const e of entries) {
  if (!e.R || e.R === "-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
    if (!v) continue;
    let to = null, how = null;
    if (byRel.has(v)) { to = byRel.get(v); how = "path"; }
    else {
      const cands = byName.get(v.split("/").pop()) || [];
      if (cands.length === 1) { to = cands[0]; how = "name"; }
      else if (cands.length > 1) { to = cands[0]; how = "name-ambiguous"; }
    }
    if (to) edges.push({ from: e.id, to: to.id, raw: v, how });
    else { unresolved++; if (unresolvedSamples.length < 10) unresolvedSamples.push(v); }
  }
}

// ── 派生统计 ─────────────────────────────────────────
const inDeg = new Map(), outDeg = new Map();
for (const e of edges) {
  inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
}
const isolated = entries.filter(e => !inDeg.has(e.id) && !outDeg.has(e.id));

const nodes = entries.map(e => ({
  id: e.id,
  name: e.name,
  dir: e.dir.slice(root.length) || "/",
  layer: e.layer,
  module: e.module,
  importance: Number(e.importance) || 0,
  scale: e.scale,
  F: e.F,
  R: e.R,
  A: e.A,
  S: e.S,
  inDeg: inDeg.get(e.id) || 0,
  outDeg: outDeg.get(e.id) || 0,
}));

const graph = {
  root,
  volume: "aoci.code.txt",
  generatedAt: new Date().toISOString(),
  stats: {
    nodes: nodes.length,
    edges: edges.length,
    unresolved,
    isolated: isolated.length,
    byLayer: Object.entries(nodes.reduce((a, n) => (a[n.layer] = (a[n.layer] || 0) + 1, a), {})),
    byModule: Object.entries(nodes.reduce((a, n) => (a[n.module] = (a[n.module] || 0) + 1, a), {})),
    resolution: {
      path: edges.filter(e => e.how === "path").length,
      name: edges.filter(e => e.how === "name").length,
      ambiguous: edges.filter(e => e.how === "name-ambiguous").length,
    },
  },
  nodes,
  edges: edges.map(e => ({ from: e.from, to: e.to })),
  unresolvedSamples,
};

fs.writeFileSync(OUT, JSON.stringify(graph, null, 2), "utf8");

console.log("=== 契约实测结果 ===");
console.log(`root        : ${graph.root}   （按完整路径命中率 ${(best * 100).toFixed(1)}%）`);
console.log(`nodes       : ${graph.stats.nodes}`);
console.log(`edges       : ${graph.stats.edges}`);
console.log(`  by path   : ${graph.stats.resolution.path}`);
console.log(`  by name   : ${graph.stats.resolution.name}`);
console.log(`  ambiguous : ${graph.stats.resolution.ambiguous}`);
console.log(`unresolved  : ${graph.stats.unresolved}`);
console.log(`isolated    : ${graph.stats.isolated}`);
console.log("\nbyLayer:");
graph.stats.byLayer.sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k} ${v}`));
console.log("\nbyModule:");
graph.stats.byModule.sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${k} ${v}`));
console.log("\nunresolved 样例:"); graph.unresolvedSamples.forEach(s=>console.log("  "+s));
console.log("\nTop 入度:");
[...inDeg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([k,v])=>console.log(`  ${v}× ${k}`));
