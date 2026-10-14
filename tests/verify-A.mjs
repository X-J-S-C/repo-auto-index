// A 路自证脚本：把 index.js 里 GRAPH-PARSE 区块的解析函数原样抽出，对索引跑一遍。
// 唯一数据源是 index.js 本身，不复制粘贴实现，避免"验证脚本和实现不一致"。
//
// 数据源：默认 tests/demo/ 下的示例索引（合成数据，与真实规模同形）。
// 期望值也跟着示例走——392/313/310/3/0/6/154 这些数字在示例里被刻意保持同形。
// 要拿真实仓库跑：node verify-A.mjs <dir-with-aoci-files> <expected-root>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appUiRoot } from "./_resolve.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(appUiRoot, "..");
const INDEX = path.join(APP_ROOT, "index.js");
const DEMO_DIR = process.argv[2] || path.join(here, "demo");
const SRC = path.join(DEMO_DIR, "aoci.code.txt");

const src = fs.readFileSync(INDEX, "utf8");
const begin = src.indexOf("// ===== GRAPH-PARSE-BEGIN =====");
const end = src.indexOf("// ===== GRAPH-PARSE-END =====");
if (begin < 0 || end < 0) {
  console.error("找不到 GRAPH-PARSE 区块标记，index.js 未按约定加标记");
  process.exit(1);
}
const block = src.slice(begin, end);
// 从 index.js 抽出的是纯函数块，无外部依赖，直接求值拿到两个函数。
const factory = new Function(`${block}\nreturn { parseGraphEntries, buildGraph };`);
const { buildGraph } = factory();

const text = fs.readFileSync(SRC, "utf8");
const g = buildGraph(text, { repo: "atlas-workspace", volume: "aoci.code.txt" });

// root 命中率：与 build-contract.mjs 的 scoreRoot 同口径 = 完整路径命中数 / 全部 R 目标数。
function rootHitRate(graph) {
  const relSet = new Set(graph.nodes.map((n) => n.id));
  let hit = 0, tot = 0;
  for (const n of graph.nodes) {
    if (!n.R || n.R === "-") continue;
    for (const t of n.R.split(",")) {
      const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
      if (!v) continue;
      tot++;
      // graph.root + "/" + v 命中某 Entry 的完整路径 ⇔ 相对 id 集合里直接命中 v
      if (relSet.has(v)) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

console.log("=== A 路实测（源文件 aoci.code.txt，函数来自 index.js）===");
console.log(`root        : ${g.root}   （完整路径命中率 ${(rootHitRate(g) * 100).toFixed(1)}%）`);
console.log(`nodes       : ${g.stats.nodes}`);
console.log(`edges       : ${g.stats.edges}`);
console.log(`  by path   : ${g.stats.resolution.path}`);
console.log(`  by name   : ${g.stats.resolution.name}`);
console.log(`  ambiguous : ${g.stats.resolution.ambiguous}`);
console.log(`unresolved  : ${g.stats.unresolved}`);
console.log(`isolated    : ${g.stats.isolated}`);

// 契约 §1 硬要求：边两端必须都能在 nodes 里找到。
const ids = new Set(g.nodes.map((n) => n.id));
const dangling = g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
console.log(`dangling edges (两端不在 nodes): ${dangling.length}`);

// 度数自洽：outDeg/inDeg 与边表一致。
const od = new Map(), id2 = new Map();
for (const e of g.edges) { od.set(e.from, (od.get(e.from) || 0) + 1); id2.set(e.to, (id2.get(e.to) || 0) + 1); }
let degBad = 0;
for (const n of g.nodes) {
  if (n.outDeg !== (od.get(n.id) || 0) || n.inDeg !== (id2.get(n.id) || 0)) degBad++;
}
console.log(`deg mismatch: ${degBad}`);

// importance 必须是 number。
const numBad = g.nodes.filter((n) => typeof n.importance !== "number").length;
console.log(`importance 非 number 的节点: ${numBad}`);

// 期望值断言
const want = { root: process.argv[3] || "C:/projects/atlas", nodes: 392, edges: 313, path: 310, name: 3, ambiguous: 0, unresolved: 6, isolated: 154 };
const got = { root: g.root, nodes: g.stats.nodes, edges: g.stats.edges, path: g.stats.resolution.path, name: g.stats.resolution.name, ambiguous: g.stats.resolution.ambiguous, unresolved: g.stats.unresolved, isolated: g.stats.isolated };
const bad = Object.keys(want).filter((k) => want[k] !== got[k]);
console.log(bad.length === 0 ? "\n[PASS] 全部硬数字与契约一致" : `\n[FAIL] 不一致字段: ${bad.map((k) => `${k} want=${want[k]} got=${got[k]}`).join(", ")}`);

// 附加：路由实际走 readIndexFile（三文件合并）。验证合并后不引入额外 Entry。
const merged = ["aoci.code.txt", "aoci.meta.txt", "aoci.txt"]
  .map((n) => { try { return fs.readFileSync(path.join(DEMO_DIR, n), "utf8"); } catch { return null; } })
  .filter((t) => t != null).join("\n");
const gm = buildGraph(merged, { repo: "atlas-workspace", volume: "aoci.code.txt" });
console.log(`\n[附加] 三文件合并正文：nodes=${gm.stats.nodes} edges=${gm.stats.edges} unresolved=${gm.stats.unresolved} isolated=${gm.stats.isolated}（应与 code 单文件一致）`);

// [附加] /repo/:id/node 语义抽查：挑最高入度节点，复现路由的 out/in 摘要逻辑。
const byId = new Map(g.nodes.map((n) => [n.id, n]));
const top = [...g.nodes].sort((a, b) => (b.inDeg + b.outDeg) - (a.inDeg + a.outDeg))[0];
const brief = (n) => ({ id: n.id, name: n.name, layer: n.layer, module: n.module, F: n.F });
const out = [], inn = [];
for (const e of g.edges) {
  if (e.from === top.id) { const p = byId.get(e.to); if (p) out.push(brief(p)); }
  if (e.to === top.id) { const p = byId.get(e.from); if (p) inn.push(brief(p)); }
}
console.log(`\n[附加] /node 抽查：path=${top.id}`);
console.log(`  node: name=${top.name} layer=${top.layer} module=${top.module} importance=${top.importance}(${typeof top.importance}) inDeg=${top.inDeg} outDeg=${top.outDeg}`);
console.log(`  out(${out.length}): ${out.map((o) => o.name).join(", ") || "—"}`);
console.log(`  in(${inn.length}): ${inn.slice(0, 5).map((o) => o.name).join(", ")}${inn.length > 5 ? " …" : ""}`);
const briefKeys = out.length ? Object.keys(out[0]).join(",") : (inn.length ? Object.keys(inn[0]).join(",") : "—");
console.log(`  摘要字段: ${briefKeys}（应为 id,name,layer,module,F）`);

// [附加] 404 分支：不存在的 path 应落空。
console.log(`\n[附加] 不存在 path 命中: ${byId.has("__no_such__") ? "误命中" : "落空（路由将返回 404）"}`);
