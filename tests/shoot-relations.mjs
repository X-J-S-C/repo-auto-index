// 聚焦截图：只截关系区块（graph block），分别截清单、展开节点、网图、降级。
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";

const root = path.resolve(process.cwd());
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png" };
const BLOCK_MAP = process.env.BLOCK_MAP === "1";
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (BLOCK_MAP && /graph-map\.js$/.test(u)) { res.writeHead(404); res.end("gone"); return; }
  serveStatic(res, req.url, MIME);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const b = await chromium.launch({ executablePath: resolveChromium() });
const outDir = path.join(root, "out", "relations"); fs.mkdirSync(outDir, { recursive: true });
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1000);
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(1500);

const shot = async (sel, name) => {
  const el = await p.$(sel);
  if (el) await el.screenshot({ path: path.join(outDir, name) });
  else console.log("缺元素:", sel);
};

// 清单模式
await p.evaluate(() => { const t = [...document.querySelectorAll("#graph-mode-mount [role=tab]")].find(x => /清单/.test(x.textContent)); t && t.click(); });
await p.waitForTimeout(800);
await shot('[data-block="graph"]', "z1-list-top.png");

// 展开一个 hub 节点
await p.evaluate(() => { const r = document.querySelector(".rel-group .rel-group-body .rel-row .rel-row-main"); r && r.click(); });
await p.waitForTimeout(800);
await shot(".rel-row[data-open='true']", "z2-node-open.png");

// 网图
await p.evaluate(() => { const t = [...document.querySelectorAll("#graph-mode-mount [role=tab]")].find(x => /关系网/.test(x.textContent)); t && t.click(); });
await p.waitForTimeout(2000);
await shot('[data-block="graph"]', "z3-map.png");

await b.close(); server.close();
console.log("done");
