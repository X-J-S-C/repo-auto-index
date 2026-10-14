// 契约硬规则检查：id 唯一性 + 窄屏布局。
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic, appUiRoot as APP_UI } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };
const server = http.createServer((req, res) => { serveStatic(res, req.url, MIME); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// 静态检查：HTML 里 id 是否唯一。读 App 真源码，不读副本。
const html = fs.readFileSync(path.join(APP_UI, "panel.html"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
console.log("=== HTML id 唯一性 ===");
console.log("  id 总数:", ids.length, "| 重复:", dup.length ? dup.join(", ") : "(无) ✓");

const b = await chromium.launch({ executablePath: resolveChromium() });
const outDir = path.join(root, "out", "relations"); fs.mkdirSync(outDir, { recursive: true });

// 运行时重复 id 检查（渲染后）
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1000);
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(1500);
const runtimeDup = await p.evaluate(() => {
  const all = [...document.querySelectorAll("[id]")].map((n) => n.id);
  const d = all.filter((x, i) => all.indexOf(x) !== i);
  return d;
});
console.log("  渲染后运行时重复 id:", runtimeDup.length ? runtimeDup.join(", ") : "(无) ✓");

// 关系区块内 id 与挂载点
const graphIds = await p.evaluate(() => {
  const blk = document.querySelector('[data-block="graph"]');
  return [...blk.querySelectorAll("[id]")].map((n) => n.id);
});
console.log("  graph 区块内 id:", graphIds.join(", "));

// 窄屏
const p2 = await b.newPage({ viewport: { width: 700, height: 1000 }, deviceScaleFactor: 2 });
await p2.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p2.waitForTimeout(1000);
await p2.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p2.waitForTimeout(1500);
await p2.evaluate(() => { const t = [...document.querySelectorAll("#graph-mode-mount [role=tab]")].find(x => /清单/.test(x.textContent)); t && t.click(); });
await p2.waitForTimeout(600);
const narrow = await p2.evaluate(() => {
  const de = document.documentElement;
  return {
    overflowX: de.scrollWidth > de.clientWidth + 1,
    scrollW: de.scrollWidth, clientW: de.clientWidth,
    rows: document.querySelectorAll(".rel-row").length,
  };
});
console.log("\n=== 窄屏 700px ===");
console.log("  横向溢出:", narrow.overflowX ? "✗ " + narrow.scrollW + ">" + narrow.clientW : "无 ✓", "| 行数:", narrow.rows);
const blk = await p2.$('[data-block="graph"]');
if (blk) await blk.screenshot({ path: path.join(outDir, "z4-narrow.png") });
console.log("  截图: out/relations/z4-narrow.png");

await b.close(); server.close();
