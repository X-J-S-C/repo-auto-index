// 交互与响应式巡检：验证按钮真的绑了事件、窄屏不溢出、搜索框在轮询中不丢焦点
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
let calls = [];
let current = fixture;
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};

const server = http.createServer((req,res)=>{
  const u=decodeURIComponent(String(req.url).split("?")[0]);
  if (u === "/fixture.json") { res.writeHead(200,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(current)); return; }
  serveStatic(res, req.url, MIME);});
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;

const b = await chromium.launch({executablePath:resolveChromium()});
const outDir = path.join(root, "out", "interact"); fs.mkdirSync(outDir, { recursive: true });

// 记录 mock 收到的调用
const p = await b.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
await p.addInitScript(() => { window.__calls = []; });
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil:"networkidle" });
await p.waitForTimeout(1200);

// 1. 点「重新扫描」，看是否真的发出 rescan 请求
const before = await p.evaluate(() => window.__calls.length);
await p.evaluate(() => {
  const btns = [...document.querySelectorAll("button")];
  const target = btns.find(b => b.textContent.includes("重新扫描"));
  target?.click();
});
await p.waitForTimeout(700);
const after = await p.evaluate(() => window.__calls.slice());
const rescanned = after.some(c => /rescan/.test(c));
console.log("1) 重新扫描按钮 =>", rescanned ? "发出 /rescan 请求 ✓" : "没反应 ✗");
console.log("   calls:", after.filter(c=>/repo\//.test(c)).slice(-4).join(" | "));

// 2. 点「复制目录路径」，验证 clipboard 调用
const clip = await p.evaluate(() => {
  window.__clip = [];
  const btns = [...document.querySelectorAll("button")];
  const t = btns.find(b => b.textContent.includes("复制目录路径"));
  if (!t) return "按钮没找到";
  t.click();
  return t.textContent;
});
await p.waitForTimeout(300);
console.log("2) 复制目录路径按钮 =>", clip);

// 3. 点每个页签，确认 content pane 真的切换
const tabRows = [];
for (let i = 0; i < 4; i++) {
  await p.evaluate((idx) => { const b=[...document.querySelectorAll('[role="tab"]')][idx]; b?.click(); }, i);
  await p.waitForTimeout(250);
  const shown = await p.evaluate(() => [...document.querySelectorAll("[data-pane]")].filter(n=>!n.hidden).map(n=>n.dataset.pane));
  tabRows.push(`tab${i} -> ${shown.join(",") || "(none)"}`);
}
console.log("3) 页签切换 =>", tabRows.join(" ; "));

// 4. 搜索框在轮询下不丢焦点
await p.evaluate(() => { const b=[...document.querySelectorAll('[role="tab"]')][2]; b?.click(); });
await p.waitForTimeout(300);
await p.click("#search-q");
await p.type("#search-q", "aoci", { delay: 30 });
// 制造一次轮询：mock 返回 scanning，让 tick 跑起来
current = { ...fixture, repos: fixture.repos.map(r => ({...r, status:"scanning", taskId:"t1", startedAt:new Date().toISOString(), progress:{phase:"walk", total:900, scanned:1200, dirCount:70}})) };
await p.waitForTimeout(2600);
const focusKept = await p.evaluate(() => ({
  activeId: document.activeElement?.id || "(none)",
  value: document.getElementById("search-q")?.value,
}));
console.log("4) 轮询中搜索框 =>", "焦点=" + focusKept.activeId, "值=" + JSON.stringify(focusKept.value));
await p.screenshot({ path: path.join(outDir, "polling-focus.png"), fullPage: true });

// 5. 窄屏不溢出
current = fixture;
const p2 = await b.newPage({viewport:{width:420,height:900},deviceScaleFactor:2});
await p2.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil:"networkidle" });
await p2.waitForTimeout(1200);
const overflow = await p2.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
}));
console.log("5) 窄屏 420px =>", JSON.stringify(overflow));
await p2.screenshot({ path: path.join(outDir, "narrow.png"), fullPage: true });

console.log("\nERRORS:", errs.length ? errs : "(none)");
await b.close(); server.close();
