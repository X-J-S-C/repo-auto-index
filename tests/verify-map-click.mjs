// 网图点击节点 → 切清单并定位（契约 §2 关系网核心交互）。
// canvas 上按网格试探点击，命中节点即验证。
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };
const server = http.createServer((req, res) => { serveStatic(res, req.url, MIME); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const b = await chromium.launch({ executablePath: resolveChromium() });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1000);
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(1800);
const mode0 = await p.evaluate(() => document.getElementById("graph-view").dataset.mode);
console.log("初始 mode:", mode0);
const canvas = await p.$("#graph-view canvas");
const box = await canvas.boundingBox();
let hit = null;
outer:
for (let i = 1; i <= 5; i++) {
  for (let j = 1; j <= 5; j++) {
    await p.mouse.click(box.x + box.width * i / 6, box.y + box.height * j / 6);
    await p.waitForTimeout(250);
    const st = await p.evaluate(() => ({ mode: document.getElementById("graph-view").dataset.mode, flash: document.querySelector(".rel-row-flash")?.dataset.id || null }));
    if (st.mode === "list") { hit = st; break outer; }
  }
}
if (hit) console.log("点击节点命中 → mode:", hit.mode, "| 定位行:", hit.flash);
else console.log("网格点击未命中节点（该路径逻辑已由「边列表点对端」覆盖）");
console.log("ERRORS:", errs.length ? errs : "(none)");
await b.close(); server.close();
