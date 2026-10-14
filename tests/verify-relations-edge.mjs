// 关系页边界验证：
//  A. 缓存与懒加载：默认不拉 graph；点关系页拉一次；切走再切回不重拉。
//  B. 降级：graph-map.js 不存在时，显示降级提示并自动切清单，不报错。
// 不进插件包。用法: node verify-relations-edge.mjs
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

// 是否屏蔽 graph-map.js（模拟组件缺失）
const BLOCK_MAP = process.env.BLOCK_MAP === "1";

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (BLOCK_MAP && /graph-map\.js$/.test(u)) { res.writeHead(404); res.end("gone"); return; }
  serveStatic(res, req.url, MIME);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const b = await chromium.launch({
  executablePath: resolveChromium(),
});
const p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const errs = collectErrors(p);

await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1000);

const graphCalls = () => p.evaluate(() => (globalThis.__calls || []).filter((c) => /^GET .*\/graph$/.test(c)).length);

console.log("BLOCK_MAP =", BLOCK_MAP);
console.log("\n=== A. 懒加载与缓存 ===");
const c0 = await graphCalls();
console.log("  默认页签下 graph 请求数:", c0, c0 === 0 ? "✓ 未预拉" : "✗ 不应预拉");

await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(1200);
const c1 = await graphCalls();
console.log("  点关系页后 graph 请求数:", c1, c1 === 1 ? "✓ 拉一次" : "✗");

await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][0].click());
await p.waitForTimeout(400);
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(800);
const c2 = await graphCalls();
console.log("  切走再切回后 graph 请求数:", c2, c2 === 1 ? "✓ 命中缓存" : "✗ 重复拉");

// 搜索输入框不重建：先在搜索页输入，再切到关系页再切回
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][2].click());
await p.waitForTimeout(300);
await p.fill("#search-q", "aoci-keep");
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(600);
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][2].click());
await p.waitForTimeout(300);
const kept = await p.evaluate(() => document.getElementById("search-q")?.value);
console.log("  搜索框内容跨页签保留:", JSON.stringify(kept), kept === "aoci-keep" ? "✓" : "✗");

// 点顶栏刷新 → 缓存作废，关系图重拉一次（但在关系页时）
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(600);
const cBefore = await graphCalls();
await p.click("#refresh-mount button").catch(() => {});
await p.waitForTimeout(1500);
const cAfter = await graphCalls();
console.log("  点刷新前 graph 请求数:", cBefore, "→ 后:", cAfter, cAfter === cBefore + 1 ? "✓ 刷新作废缓存" : "✗");

console.log("\n=== B. 降级路径 ===");
await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')][4].click());
await p.waitForTimeout(1500);
const deg = await p.evaluate(() => {
  const gv = document.getElementById("graph-view");
  return {
    mode: gv.dataset.mode,
    degrade: gv.querySelector(".rel-degrade")?.textContent || "",
    rows: gv.querySelectorAll(".rel-row").length,
    groups: gv.querySelectorAll(".rel-group").length,
    status: document.querySelector('[data-block="graph"]')?.dataset.status,
  };
});
console.log("  mode:", deg.mode, "| 分组:", deg.groups, "| 行:", deg.rows, "| 状态:", deg.status);
console.log("  降级提示:", deg.degrade || "(无)");
console.log("  自动切清单:", deg.mode === "list" ? "✓" : (BLOCK_MAP ? "✗" : "(组件就绪，未降级)"));
if (BLOCK_MAP) {
  await p.screenshot({ path: path.join(root, "out", "relations", "06-degrade.png"), fullPage: true });
  console.log("  截图: out/relations/06-degrade.png");
}

console.log("\nERRORS:", errs.length ? errs : "(none)");
await b.close();
server.close();
