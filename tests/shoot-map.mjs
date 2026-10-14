// graph-map.js 离线验证：起静态服务 → 打开 test-map.html → 截图 + 断言。
// 静态根 = 本目录；额外把 App 内的真实组件映射到 /app-assets/graph-map.js，保证测的是同一份源码。
// 用法: node shoot-map.mjs
//
// 本轮新增断言（对应「孤岛展开不能把核心挤小」）：
//   在折叠态记录核心的墨迹包围盒与像素；切到展开态后，
//   逐像素比对「核心包围盒区域」是否保持一致 —— 一致即证明核心的缩放/位置没被改变。
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appUiRoot } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here);

// App 内真实组件路径（唯一被测对象）——从 _resolve.mjs 推，不再硬编码
const APP_COMPONENT = path.join(appUiRoot, "assets", "graph-map.js");

const outDir = path.join(root, "out", "map");
fs.mkdirSync(outDir, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/app-assets/graph-map.js") {
    if (!fs.existsSync(APP_COMPONENT)) { res.writeHead(500); res.end("component missing"); return; }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    fs.createReadStream(APP_COMPONENT).pipe(res);
    return;
  }
  const file = path.resolve(path.join(root, url === "/" ? "test-map.html" : url));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("nope"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});

const page = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2 });
const errs = collectErrors(page);

await page.goto(`http://127.0.0.1:${port}/test-map.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 页内通用工具：墨迹包围盒 + 区域像素指纹
await page.evaluate(() => {
  window.__bbox = () => {
    const c = document.querySelector("#stage canvas");
    const g = c.getContext("2d");
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, cnt = 0;
    for (let y = 0; y < c.height; y++) {
      const row = y * c.width;
      for (let x = 0; x < c.width; x++) {
        if (d[(row + x) * 4 + 3] > 8) {
          cnt++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return { minX, minY, maxX, maxY, cnt, w: maxX - minX + 1, h: maxY - minY + 1 };
  };
  window.__region = (b) => {
    const c = document.querySelector("#stage canvas");
    const g = c.getContext("2d");
    return g.getImageData(b.minX, b.minY, b.maxX - b.minX + 1, b.maxY - b.minY + 1).data;
  };
});

// ── 折叠态基础信息
const info = await page.evaluate(() => {
  const h = window.__handle;
  const c = document.querySelector("#stage canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let ink = 0, total = 0;
  for (let i = 3; i < d.length; i += 4 * 37) { total++; if (d[i] > 8) ink++; }
  return {
    ready: !!window.__ready,
    stats: h ? h.stats : null,
    hasCanvas: !!c,
    canvasW: c.width,
    canvasH: c.height,
    inkRatio: total ? ink / total : 0,
    graphCounts: {
      nodes: window.__graph.nodes.length,
      edges: window.__graph.edges.length,
      isolated: window.__graph.stats.isolated,
    },
    bbox: window.__bbox(),
  };
});
await page.screenshot({ path: path.join(outDir, "map.png") });

// ── 核心保真检查：折叠态核心区域像素 vs 展开态同区域像素
const coreCheck = await page.evaluate(async () => {
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const foldedBBox = window.__bbox();
  const foldedRegion = window.__region(foldedBBox);

  window.__handle.setShowIsolated(true);
  await nextFrame();

  const expandedBBox = window.__bbox();
  const nowRegion = window.__region(foldedBBox); // 同一区域
  let diff = 0;
  const n = foldedRegion.length / 4;
  for (let i = 0; i < foldedRegion.length; i += 4) {
    if (Math.abs(foldedRegion[i] - nowRegion[i]) > 8 ||
        Math.abs(foldedRegion[i + 3] - nowRegion[i + 3]) > 8) diff++;
  }
  return {
    foldedBBox,
    expandedBBox,
    coreTotalPixels: n,
    coreDiffPixels: diff,
    coreSameRatio: n ? 1 - diff / n : 1,
    expandedStats: window.__handle.stats,
  };
});
await page.screenshot({ path: path.join(outDir, "map-isolated.png") });

// 回到折叠态，供点击测试
await page.evaluate(async () => {
  window.__handle.setShowIsolated(false);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});

// ── 点击回调：定位度数最高的节点 → 点画面中心 → 校验 onSelectNode
const top = await page.evaluate(() => {
  const g = window.__graph;
  const t = [...g.nodes].filter((n) => n.inDeg + n.outDeg > 0)
    .sort((a, b) => (b.inDeg + b.outDeg) - (a.inDeg + a.outDeg))[0];
  return { id: t.id, deg: t.inDeg + t.outDeg };
});
const focused = await page.evaluate((id) => window.__focusNode(window.__handle, id), top.id);
await page.waitForTimeout(200);
const rect = await page.evaluate(() => {
  const r = document.querySelector("#stage canvas").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
await page.waitForTimeout(200);
const selected = await page.evaluate(() => window.__getSelected());
const clickProbe = { topId: top.id, topDeg: top.deg, focused, selectedAfterClick: selected, match: selected === top.id };
await page.screenshot({ path: path.join(outDir, "map-click.png") });

// ── 交互：滚轮缩放 / 拖拽平移（像素指纹变化作证）
await page.evaluate(async () => {
  window.__handle.setShowIsolated(false);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
});
const beforeFp = await page.evaluate(() => document.querySelector("#stage canvas").toDataURL().slice(-32));
const cx = rect.x + rect.w / 2;
const cy = rect.y + rect.h / 2;
await page.mouse.move(cx, cy);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(250);
const afterZoom = await page.evaluate(() => document.querySelector("#stage canvas").toDataURL().slice(-32));
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 120, cy + 90, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const afterDrag = await page.evaluate(() => document.querySelector("#stage canvas").toDataURL().slice(-32));
const zoomChanged = afterZoom !== beforeFp;
const dragChanged = afterDrag !== afterZoom;

// ── destroy 幂等
const destroyProbe = await page.evaluate(() => {
  const stage = document.getElementById("stage");
  const before = stage.childElementCount;
  window.__handle.destroy();
  const afterFirst = stage.childElementCount;
  let threw = null;
  try { window.__handle.destroy(); } catch (e) { threw = String(e && e.message); }
  return { before, afterFirst, afterSecond: stage.childElementCount, threw };
});

await browser.close();
server.close();

// ── 报告
const expectedDrawn = info.graphCounts.nodes - info.graphCounts.isolated;
const foldedArea = coreCheck.foldedBBox.w * coreCheck.foldedBBox.h;
const expandedArea = coreCheck.expandedBBox.w * coreCheck.expandedBBox.h;

console.log("=== graph-map 验证 ===");
console.log("ready          :", info.ready);
console.log("hasCanvas      :", info.hasCanvas, `${info.canvasW}x${info.canvasH}`);
console.log("graph counts   :", JSON.stringify(info.graphCounts));
console.log("stats(folded)  :", JSON.stringify(info.stats));
console.log("inkRatio       :", info.inkRatio);
console.log("");
console.log("-- 核心保真（孤岛展开不挤小核心）--");
console.log("folded  bbox   :", `${coreCheck.foldedBBox.w}x${coreCheck.foldedBBox.h}  area=${foldedArea}`);
console.log("expanded bbox  :", `${coreCheck.expandedBBox.w}x${coreCheck.expandedBBox.h}  area=${expandedArea}`);
console.log("bbox 面积增长  :", `x${(expandedArea / foldedArea).toFixed(2)}  （孤岛落在核心外围，总包围盒变大）`);
console.log("核心区域逐像素 :", `${coreCheck.coreTotalPixels - coreCheck.coreDiffPixels}/${coreCheck.coreTotalPixels} 一致  = ${(coreCheck.coreSameRatio * 100).toFixed(3)}%`);
console.log("stats(expanded):", JSON.stringify(coreCheck.expandedStats));
console.log("");
console.log("click probe    :", JSON.stringify(clickProbe));
console.log("wheel zoom     :", zoomChanged ? "画面已变化（缩放生效）" : "无变化（失败）");
console.log("drag pan       :", dragChanged ? "画面已变化（平移生效）" : "无变化（失败）");
console.log("destroy        :", JSON.stringify(destroyProbe));
console.log("errors         :", errs.length ? errs : "(none)");
console.log("screenshots    : out/map/map.png, out/map/map-isolated.png, out/map/map-click.png");

const pass =
  info.ready && errs.length === 0 && info.hasCanvas &&
  info.stats && info.stats.drawn === expectedDrawn &&
  info.inkRatio > 0.005 &&
  clickProbe.match === true &&
  zoomChanged && dragChanged &&
  destroyProbe.threw === null && destroyProbe.afterFirst === 0 && destroyProbe.afterSecond === 0 &&
  // 核心保真：核心区域像素 99% 以上与折叠态一致；展开后总包围盒确实变大
  coreCheck.coreSameRatio >= 0.99 && expandedArea > foldedArea;

console.log("");
console.log("EXPECTED drawn(folded) =", expectedDrawn, "| actual =", info.stats && info.stats.drawn);
console.log("CORE same ratio =", (coreCheck.coreSameRatio * 100).toFixed(3) + "% (阈值 >= 99%)");
console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(pass ? 0 : 1);
