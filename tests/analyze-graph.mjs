// 分析 aoci.code.txt 的关系结构：Entry 数、R 边、层/模块分布、枢纽节点
// 默认读 tests/demo/ 下的示例索引（合成数据，与真实规模同形）。
// 要分析别的索引：node analyze-graph.mjs <path-to-aoci.code.txt> [outGraphJson]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(here, "demo", "aoci.code.txt");
const OUT = process.argv[3] || "graph.json";
const raw = fs.readFileSync(file, "utf8");
const lines = raw.split(/\r?\n/);

// A 层字典（来自 aoci.meta.txt）
const A_LAYER = {
  C: "共享基础", E: "入口边界", A: "应用编排", D: "领域逻辑", K: "算法计算",
  M: "中间件", P: "持久化", I: "集成适配", R: "运行基础", L: "库与SDK",
  F: "声明配置", O: "运维交付", T: "测试验证", S: "文档规范", X: "开发工具", Z: "其他",
};
const B_MODULE = {
  G: "跨域通用", U: "用户交互", B: "核心业务", D: "数据状态", I: "身份权限",
  N: "网络协议", M: "消息事件", S: "安全隐私", C: "配置策略", O: "可观测性",
  R: "可靠性恢复", P: "性能资源", W: "流程调度", A: "分析智能", H: "硬件设备",
  L: "本地化", V: "构建发布", Q: "质量保障", E: "扩展插件", Z: "其他",
};

const entries = [];
let dir = "";
for (const l of lines) {
  if (/^=+(.+?)=+$/.test(l)) { dir = l.replace(/^=+/, "").replace(/=+$/, ""); continue; }
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^(.+?)\[([A-Z0-9]{4,5})\]:\s*(.*)$/);
  if (!m) continue;
  const [, name, tag, body] = m;
  const parts = body.split(/\s*\|\s*/);
  const field = (k) => {
    const p = parts.find((x) => x.startsWith(k + ":"));
    return p ? p.slice(k.length + 1).trim() : "";
  };
  entries.push({
    name, tag, dir,
    layer: tag[0], module: tag[1], importance: tag[2], scale: tag[3],
    F: field("F"), R: field("R"), A: field("A"), S: field("S"),
  });
}

// R 边：R 形如 code:path/to/file 或 A:some-action，多个用逗号分隔
const edges = [];
for (const e of entries) {
  if (!e.R || e.R === "-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim();
    if (!v || v === "-") continue;
    edges.push({ from: e.name, to: v, kind: v.includes(":") ? v.split(":")[0] : "ref" });
  }
}

// 入度：被指向最多的目标
const indeg = new Map();
for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
const hubs = [...indeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

// 层分布
const byLayer = new Map();
for (const e of entries) byLayer.set(e.layer, (byLayer.get(e.layer) || 0) + 1);
const layers = [...byLayer.entries()].sort((a, b) => b[1] - a[1]);

// 模块分布
const byMod = new Map();
for (const e of entries) byMod.set(e.module, (byMod.get(e.module) || 0) + 1);
const mods = [...byMod.entries()].sort((a, b) => b[1] - a[1]);

// 跨层边：from 的层 → to 的层（to 需能解析到某个 entry）
const nameToEntry = new Map(entries.map((e) => [e.name, e]));
const crossLayer = new Map();
for (const e of edges) {
  const target = e.to.replace(/^(code|database):/, "");
  const base = target.split("/").pop();
  const tgt = nameToEntry.get(base);
  if (!tgt) continue;
  const key = `${e.from === tgt.name ? "self" : ""}${nameToEntry.get(e.from)?.layer}→${tgt.layer}`;
  crossLayer.set(key, (crossLayer.get(key) || 0) + 1);
}
const cross = [...crossLayer.entries()].filter(([k]) => k.length === 3 && k[0] !== k[2]).sort((a, b) => b[1] - a[1]).slice(0, 15);

// 目录分段
const byDir = new Map();
for (const e of entries) byDir.set(e.dir, (byDir.get(e.dir) || 0) + 1);

console.log("=== 总览 ===");
console.log(`Entry 数        : ${entries.length}`);
console.log(`目录分段        : ${byDir.size}`);
console.log(`R 边总数        : ${edges.length}`);
console.log(`有 R 的 Entry   : ${entries.filter((e) => e.R && e.R !== "-").length}`);
console.log(`指向多目标的    : ${entries.filter((e) => e.R && e.R.includes(",")).length}`);
console.log(`入度 > 0 的目标 : ${indeg.size}`);

console.log("\n=== A 层分布（板块之一） ===");
for (const [k, v] of layers) console.log(`  ${k} ${A_LAYER[k] || "?"}  ${v}  ${"█".repeat(Math.round(v / 4))}`);

console.log("\n=== B 模块分布（板块之二） ===");
for (const [k, v] of mods) console.log(`  ${k} ${B_MODULE[k] || "?"}  ${v}  ${"█".repeat(Math.round(v / 4))}`);

console.log("\n=== 枢纽节点（被引用最多） ===");
for (const [k, v] of hubs) console.log(`  ${v}× ${k}`);

console.log("\n=== 跨层关系（前 15） ===");
for (const [k, v] of cross) {
  const [f, t] = k.split("→");
  console.log(`  ${A_LAYER[f] || f} → ${A_LAYER[t] || t}  ${v}`);
}

// 存一份给可视化用
const out = { entries, edges, layers, mods, hubs, cross, byDir: [...byDir.entries()], dict: { A_LAYER, B_MODULE } };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(`\n已写出 ${OUT}（${JSON.stringify(out).length} 字节）`);
