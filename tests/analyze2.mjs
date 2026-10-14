// 深挖关系结构：跨模块边、桥接节点、目录分段聚类
// 默认读 tests/demo/ 下的示例索引（合成数据）。要换源：node analyze2.mjs <path> [outGraphJson]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(process.argv[2] || path.join(here, "demo", "aoci.code.txt"), "utf8");
const OUT = process.argv[3] || "graph2.json";
const lines = raw.split(/\r?\n/);
const A_LAYER = { C:"共享基础",E:"入口边界",A:"应用编排",D:"领域逻辑",K:"算法计算",M:"中间件",P:"持久化",I:"集成适配",R:"运行基础",L:"库与SDK",F:"声明配置",O:"运维交付",T:"测试验证",S:"文档规范",X:"开发工具",Z:"其他" };
const B_MODULE = { G:"跨域通用",U:"用户交互",B:"核心业务",D:"数据状态",I:"身份权限",N:"网络协议",M:"消息事件",S:"安全隐私",C:"配置策略",O:"可观测性",R:"可靠性恢复",P:"性能资源",W:"流程调度",A:"分析智能",H:"硬件设备",L:"本地化",V:"构建发布",Q:"质量保障",E:"扩展插件",Z:"其他" };

const entries = [];
let dir = "";
for (const l of lines) {
  if (/^=+(.+?)=+$/.test(l)) { dir = l.replace(/^=+/,"").replace(/=+$/,""); continue; }
  if (/^\s*#/.test(l)) continue;
  const m = l.match(/^(.+?)\[([A-Z0-9]{4,5})\]:\s*(.*)$/);
  if (!m) continue;
  const parts = m[3].split(/\s*\|\s*/);
  const f = (k)=>{const p=parts.find(x=>x.startsWith(k+":"));return p?p.slice(k.length+1).trim():"";};
  entries.push({ name:m[1], dir, layer:m[2][0], module:m[2][1], F:f("F"), R:f("R") });
}

const byName = new Map(entries.map(e=>[e.name,e]));
const edges = [];
for (const e of entries) {
  if (!e.R || e.R==="-") continue;
  for (const t of e.R.split(",")) {
    const v = t.trim().replace(/^code:/,"").replace(/\\/g,"/");
    if (!v) continue;
    const base = v.split("/").pop();
    const tgt = byName.get(base);
    if (tgt) edges.push({ from:e, to:tgt });
  }
}
console.log(`可解析的仓内边: ${edges.length}`);

// 跨模块边
const mm = new Map();
for (const e of edges) {
  if (e.from.module === e.to.module) continue;
  const k = `${e.from.module}→${e.to.module}`;
  mm.set(k,(mm.get(k)||0)+1);
}
console.log("\n=== 跨模块关系（前 15） ===");
[...mm.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>{
  const [a,b]=k.split("→");
  console.log(`  ${B_MODULE[a]||a} → ${B_MODULE[b]||b}   ${v}`);
});

// 桥接节点：既被引也多引用（连接不同模块）
const inD=new Map(), outD=new Map();
for (const e of edges) { inD.set(e.to.name,(inD.get(e.to.name)||0)+1); outD.set(e.from.name,(outD.get(e.from.name)||0)+1); }
const bridges = entries.map(e=>({ name:e.name, layer:e.layer, module:e.module, inD:inD.get(e.name)||0, outD:outD.get(e.name)||0 }))
  .filter(x=>x.inD>0&&x.outD>0)
  .sort((a,b)=>(b.inD+b.outD)-(a.inD+a.outD)).slice(0,10);
console.log("\n=== 桥接节点（既被引用、也引用别人） ===");
bridges.forEach(b=>console.log(`  入${b.inD}/出${b.outD}  ${A_LAYER[b.layer]}·${B_MODULE[b.module]}  ${b.name}`));

// 孤立节点（无任何边）
const linked = new Set();
for (const e of edges) { linked.add(e.from.name); linked.add(e.to.name); }
const isolated = entries.filter(e=>!linked.has(e.name));
console.log(`\n=== 孤立 Entry（无任何关系）: ${isolated.length} / ${entries.length} ===`);
isolated.slice(0,8).forEach(e=>console.log(`  ${A_LAYER[e.layer]}·${B_MODULE[e.module]}  ${e.name}`));

// 目录分段规模 top
const dc = new Map();
for (const e of entries) dc.set(e.dir,(dc.get(e.dir)||0)+1);
console.log("\n=== 目录分段规模（前 10） ===");
[...dc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log(`  ${v} 条  ${k}`));

fs.writeFileSync(OUT, JSON.stringify({ entries, edges: edges.map(e=>({from:e.from.name,to:e.to.name})), A_LAYER, B_MODULE }, null, 2), "utf8");
console.log(`\n已写出 ${OUT}`);
