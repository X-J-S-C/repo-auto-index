// 契约三向比对：panel.html 的全部 id × panel.js 的全部 byId() × docs/CONTRACT.md §2 表
// 用途：CONTRACT.md 自称「唯一契约」，但 2026-10-13 的审计发现它与实现严重脱节。
// 本脚本把「脱节」变成可复跑的判据，不再靠人眼。
//
// 2026-10-14 扩到全页：CONTRACT.md §2 表只登记面板（它管的是面板），但「一个 id 只出现
// 一次」与「JS 引用的 id 必须存在」这两条硬规则对**每一张卡**都成立。新增 ui/chain.html
// 时这两条如果只靠人看，就会重演 8-13 那次「49 个 id 从未被引用」。
// 所以：panel 继续三向（含文档表），其余页面两向（HTML × 自己的 JS）。
//
// 用法：node _contract-check.mjs
// 退出码：0 = 无破裂；2 = 有破裂（与 sync.ps1 -Check 同一套约定）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const uiDir = path.join(root, "repo-auto-index", "ui");
const htmlPath = path.join(uiDir, "panel.html");
const jsPath = path.join(uiDir, "assets", "panel.js");
const docPath = path.join(root, "docs", "CONTRACT.md");

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const doc = fs.readFileSync(docPath, "utf8");

const uniq = (a) => [...new Set(a)];
const htmlIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const jsIds = [...js.matchAll(/byId\("([^"]+)"\)/g)].map((m) => m[1]);

// 契约表里 id 写作 `id`（反引号内）。先取全部反引号 token，再排除属性名（data-*）这类干扰项。
const docTokens = uniq([...doc.matchAll(/`([a-z][a-z0-9.-]*)`/g)].map((m) => m[1]));
const isDataAttr = (t) => /^data-/.test(t);
const looksLikeDomId = (t) => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(t);

const H = uniq(htmlIds);
const J = uniq(jsIds);

const problems = [];

// ── 全页两向：每张卡的 HTML id × 它自己的 JS byId ──────────────
// 配套 JS 按 uia_name.html → assets/<name>.js 约定定位（panel/report/chain 均如此）。
// 找不到配套 JS 的页面跳过，不报错（将来可能有纯静态页）。
const pageReports = [];
for (const f of fs.readdirSync(uiDir).sort()) {
  if (!f.endsWith(".html")) continue;
  const name = f.replace(/\.html$/, "");
  const jsFile = path.join(uiDir, "assets", `${name}.js`);
  if (!fs.existsSync(jsFile)) continue;
  const h = fs.readFileSync(path.join(uiDir, f), "utf8");
  const j = fs.readFileSync(jsFile, "utf8");
  const hIds = [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const refs = [...new Set([...j.matchAll(/byId\("([^"]+)"\)/g)].map((m) => m[1]))];
  const dupIds = hIds.filter((x, i) => hIds.indexOf(x) !== i);
  if (dupIds.length) problems.push(`${f} 有重复 id：${[...new Set(dupIds)].join(", ")}（硬规则 1：一个 id 只出现一次）`);
  const bad = refs.filter((r) => !hIds.includes(r));
  if (bad.length) problems.push(`${name}.js 引用但 ${f} 不存在：${bad.join(", ")}`);
  pageReports.push({ name, ids: [...new Set(hIds)].length, refs: refs.length, unused: [...new Set(hIds)].filter((i) => !refs.includes(i)) });
}

console.log("全页两向（id 唯一 / JS 引用必存在）：");
for (const p of pageReports) {
  console.log(`  ${p.name.padEnd(8)} id ${String(p.ids).padStart(3)} · JS 引用 ${String(p.refs).padStart(3)} · 仅展示未引用 ${p.unused.length}`);
}
console.log("");
// HTML 有、JS 没引用的：不一定是错（纯展示元素合法），但要列出来供人判断
const htmlNotJs = H.filter((x) => !J.includes(x));

// 契约表覆盖：html 的 id 应当都在契约表里（-mount 结尾的挂载点也在）
const missingInDoc = H.filter((x) => !docTokens.includes(x));
if (missingInDoc.length) problems.push(`panel.html 有但 CONTRACT.md §2 未登记：${missingInDoc.join(", ")}`);

// 反向：契约表里像 DOM id 的词，必须真的存在于 panel.html
const docNotAnywhere = docTokens.filter((t) => looksLikeDomId(t) && !isDataAttr(t) && !H.includes(t));
if (docNotAnywhere.length) problems.push(`CONTRACT.md §2 登记但 panel.html 不存在：${docNotAnywhere.join(", ")}`);

const dataMountCount = (html.match(/data-mount/g) || []).length;

console.log(`panel.html id 总数 ${htmlIds.length}（唯一 ${H.length}）`);
console.log(`panel.js byId 引用 ${jsIds.length}（唯一 ${J.length}）`);
console.log(`CONTRACT.md 反引号 token ${docTokens.length}（其中像 DOM id 的 ${docTokens.filter((t) => looksLikeDomId(t) && !isDataAttr(t)).length}）`);
console.log(`data-mount 出现次数 ${dataMountCount}（契约 §1 硬规则 4 说明实际用 -mount 后缀）`);
console.log("");
console.log(`HTML 有但 JS 未引用（${htmlNotJs.length}，纯展示元素合法）：`);
console.log("  " + (htmlNotJs.join(" ") || "(none)"));
console.log("");

if (problems.length === 0) {
  console.log("契约三向一致：无破裂。");
  process.exit(0);
}
console.log("契约破裂：");
for (const p of problems) console.log("  - " + p);
process.exit(2);
