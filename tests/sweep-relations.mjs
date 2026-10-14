// 关系页巡检：打开页面 → 点第五个页签（关系）→ 切清单模式 → 截图 + 统计
// → 点开一个节点验证出/入边 → 切网图模式截图（降级提示正确也算通过）。
// 不进插件包。用法: node sweep-relations.mjs
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const root = path.resolve(process.cwd());
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
};
const server = http.createServer((req, res) => { serveStatic(res, req.url, MIME); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const b = await chromium.launch({
  executablePath: resolveChromium(),
});
const outDir = path.join(root, "out", "relations");
fs.mkdirSync(outDir, { recursive: true });

const p = await b.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const errs = collectErrors(p);
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

// ── 1. 点第五个页签「关系」 ──────────────────────────
const tabInfo = await p.evaluate(() => {
  const btns = [...document.querySelectorAll('[role="tab"]')];
  return { count: btns.length, labels: btns.map((x) => x.textContent.trim()) };
});
console.log("=== 页签 ===");
console.log("  数量:", tabInfo.count, "| 文案:", tabInfo.labels.join(" / "));
if (tabInfo.count !== 5) { console.log("  ✗ 期望 5 个页签"); }
else console.log("  ✓ 五页签");

await p.evaluate(() => {
  const btns = [...document.querySelectorAll('[role="tab"]')];
  btns[4].click();
});
await p.waitForTimeout(1500);

const afterTab = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  return {
    relationsShown: !document.querySelector('[data-pane="relations"]').hidden,
    mode: gv?.dataset.mode,
    note: document.getElementById("graph-note")?.textContent,
    status: document.querySelector('[data-block="graph"]')?.dataset.status,
    modeTabs: [...document.querySelectorAll("#graph-mode-mount [role=tab]")].map((x) => x.textContent.trim()),
  };
});
console.log("\n=== 关系页（默认网图） ===");
console.log("  relations pane 可见:", afterTab.relationsShown);
console.log("  graph 状态:", afterTab.status, "| mode:", afterTab.mode, "| note:", afterTab.note);
console.log("  二级页签:", afterTab.modeTabs.join(" / "));
await p.screenshot({ path: path.join(outDir, "01-relations-default.png"), fullPage: true });

// ── 2. 切到清单模式 ─────────────────────────────────
const clickedList = await p.evaluate(() => {
  const tabs = [...document.querySelectorAll("#graph-mode-mount [role=tab]")];
  const t = tabs.find((x) => /清单/.test(x.textContent));
  if (!t) return false;
  t.click(); return true;
});
await p.waitForTimeout(900);

const listStats = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  const groups = [...gv.querySelectorAll(".rel-group")];
  const rows = gv.querySelectorAll(".rel-row");
  let isolatedRows = 0, isolatedTitle = "";
  for (const g of groups) {
    const title = g.querySelector(".rel-group-title")?.textContent || "";
    if (/无关系/.test(title)) {
      isolatedTitle = title;
      isolatedRows = g.querySelectorAll(".rel-row").length;
    }
  }
  const unresolved = gv.querySelector(".rel-unresolved-head")?.textContent || "";
  const degrade = gv.querySelector(".rel-degrade")?.textContent || "";
  return {
    mode: gv.dataset.mode,
    groupCount: groups.length,
    totalRows: rows.length,
    groupTitles: groups.map((g) => (g.querySelector(".rel-group-title")?.textContent || "") + "(" + g.querySelectorAll(".rel-row").length + ")"),
    isolatedTitle, isolatedRows,
    unresolved, degrade,
  };
});
console.log("\n=== 清单模式 ===");
console.log("  click 清单:", clickedList, "| mode:", listStats.mode);
console.log("  分组数:", listStats.groupCount);
console.log("  总行数:", listStats.totalRows);
console.log("  孤岛组:", listStats.isolatedTitle, "| 行数:", listStats.isolatedRows);
console.log("  分组:", listStats.groupTitles.join(", "));
console.log("  unresolved 行:", listStats.unresolved || "(无)");
console.log("  降级提示:", listStats.degrade || "(无)");
await p.screenshot({ path: path.join(outDir, "02-relations-list.png"), fullPage: true });

// 孤岛组默认折叠验证
const isoCollapsed = await p.evaluate(() => {
  const groups = [...document.querySelectorAll(".rel-group")];
  for (const g of groups) {
    if (/无关系/.test(g.querySelector(".rel-group-title")?.textContent || "")) {
      return g.querySelector(".rel-group-body")?.hidden === true;
    }
  }
  return null;
});
console.log("  孤岛组默认折叠:", isoCollapsed);

// ── 3. 点开一个节点，验证出/入边 ────────────────────
const expand = await p.evaluate(async () => {
  const gv = document.getElementById("graph-view");
  const row = gv.querySelector(".rel-group .rel-group-body .rel-row .rel-row-main");
  if (!row) return { ok: false };
  const id = row.closest(".rel-row")?.dataset.id;
  row.click();
  return { ok: true, id };
});
await p.waitForTimeout(900);
const detail = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  const row = gv.querySelector('.rel-row[data-open="true"]');
  if (!row) return { open: false };
  const d = row.querySelector(".rel-detail");
  const fields = [...d.querySelectorAll(".rel-field-k")].map((x) => x.textContent);
  const edges = [...d.querySelectorAll(".rel-edges")].map((s) => ({
    title: s.querySelector(".rel-edges-title")?.textContent,
    n: s.querySelectorAll(".rel-edge").length,
  }));
  const edgeClickable = !!d.querySelector(".rel-edge");
  return {
    open: true,
    fields,
    edges,
    metaLen: (d.querySelector(".rel-detail-meta")?.textContent || "").length,
    edgeClickable,
  };
});
console.log("\n=== 展开节点 ===");
console.log("  点击 id:", expand.id);
console.log("  展开:", detail.open, "| F/R/A/S 字段:", (detail.fields || []).join(""));
console.log("  边分组:", JSON.stringify(detail.edges));
console.log("  对端可点:", detail.edgeClickable);
await p.screenshot({ path: path.join(outDir, "03-relations-node-open.png"), fullPage: true });

// 点一条出边验证跳转（跳转后应滚动/高亮）
const jump = await p.evaluate(() => {
  const edge = document.querySelector('.rel-row[data-open="true"] .rel-edge');
  if (!edge) return { ok: false };
  const target = edge.title;
  edge.click();
  return { ok: true, target };
});
await p.waitForTimeout(700);
const jumped = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  const flash = gv.querySelector(".rel-row-flash");
  return { flashId: flash?.dataset.id || null, mode: gv.dataset.mode };
});
console.log("\n=== 点对端跳转 ===");
console.log("  目标:", jump.target, "| mode:", jumped.mode, "| 高亮行:", jumped.flashId);

// ── 4. 切到网图模式 ─────────────────────────────────
const clickedMap = await p.evaluate(() => {
  const tabs = [...document.querySelectorAll("#graph-mode-mount [role=tab]")];
  const t = tabs.find((x) => /关系网/.test(x.textContent));
  if (!t) return false;
  t.click(); return true;
});
await p.waitForTimeout(2000);

const mapStats = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  const stage = gv.querySelector(".graph-stage");
  const canvas = gv.querySelector("canvas");
  const degrade = gv.querySelector(".rel-degrade")?.textContent || "";
  const isoNote = gv.querySelector(".graph-iso-note button")?.textContent || "";
  const foot = [...gv.querySelectorAll(".foot-note")].map((x) => x.textContent).join(" | ");
  return {
    mode: gv.dataset.mode,
    stageW: stage?.clientWidth || 0,
    stageH: stage?.clientHeight || 0,
    hasCanvas: !!canvas,
    canvasW: canvas?.width || 0,
    canvasH: canvas?.height || 0,
    degrade,
    isoNote,
    foot,
  };
});
console.log("\n=== 网图模式 ===");
console.log("  click 关系网:", clickedMap, "| mode:", mapStats.mode);
console.log("  stage 尺寸:", mapStats.stageW + "x" + mapStats.stageH);
console.log("  canvas:", mapStats.hasCanvas, mapStats.canvasW + "x" + mapStats.canvasH);
console.log("  降级提示:", mapStats.degrade || "(无，组件已就绪)");
console.log("  孤岛折叠行:", mapStats.isoNote || "(无)");
console.log("  诚实数字:", mapStats.foot || "(无)");
await p.screenshot({ path: path.join(outDir, "04-relations-map.png"), fullPage: true });

// 展开孤岛再截一张
const isoExpand = await p.evaluate(() => {
  const btn = document.querySelector(".graph-iso-note button");
  if (!btn) return false;
  btn.click(); return true;
});
await p.waitForTimeout(1500);
const isoAfter = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  return {
    isoNote: gv.querySelector(".graph-iso-note button")?.textContent || "",
    foot: [...gv.querySelectorAll(".foot-note")].map((x) => x.textContent).join(" | "),
  };
});
console.log("\n=== 展开孤岛 ===");
console.log("  点击:", isoExpand, "| 按钮文案:", isoAfter.isoNote);
console.log("  诚实数字:", isoAfter.foot);
await p.screenshot({ path: path.join(outDir, "05-relations-map-isolated.png"), fullPage: true });

console.log("\nERRORS:", errs.length ? errs : "(none)");
await b.close();
server.close();
