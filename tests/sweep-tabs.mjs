// 页签巡检：对 ready 态逐个切页签截图，检查索引/预览/搜索/轨迹四个面板
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};
const server = http.createServer((req,res)=>{
  const u=decodeURIComponent(String(req.url).split("?")[0]);
  if (u === "/fixture.json") { res.writeHead(200,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(fixture)); return; }
  serveStatic(res, req.url, MIME);});
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;

const b = await chromium.launch({executablePath:resolveChromium()});
const outDir = path.join(root, "out", "tabs"); fs.mkdirSync(outDir, { recursive: true });

const p = await b.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil:"networkidle" });
await p.waitForTimeout(1200);

for (const [value, label] of [["overview","概览"],["index","索引"],["search","搜索"],["trace","轨迹"],["relations","关系"]]) {
  // 点官方 Tabs 里对应按钮
  const ok = await p.evaluate((val) => {
    const btns = [...document.querySelectorAll('[role="tab"]')];
    const idx = ["overview","index","search","trace","relations"].indexOf(val);
    if (!btns[idx]) return false;
    btns[idx].click(); return true;
  }, value);
  await p.waitForTimeout(400);
  const diag = await p.evaluate(() => {
    const panes = [...document.querySelectorAll("[data-pane]")].map(n => n.dataset.pane + (n.hidden ? ":hidden" : ":shown"));
    const idxBody = document.getElementById("preview-body")?.textContent || "";
    const traceBody = document.getElementById("trace-body")?.textContent || "";
    const searchRes = document.getElementById("search-results")?.innerText || "";
    const graphView = document.getElementById("graph-view");
    return {
      panes,
      indexInfo: document.getElementById("index-info")?.innerText?.replace(/\n/g," | ") || "",
      previewFirst: idxBody.split("\n")[0]?.slice(0,90) || "(空)",
      previewLen: idxBody.length,
      traceFirst: traceBody.split("\n")[0]?.slice(0,90) || "(空)",
      traceLen: traceBody.length,
      search: searchRes.slice(0,120),
      graphMode: graphView?.dataset.mode || "(无)",
      graphNote: document.getElementById("graph-note")?.textContent || "",
      graphLen: graphView?.innerText?.length || 0,
    };
  });
  console.log(`\n=== ${label} (click=${ok}) ===`);
  console.log("  panes:", diag.panes.join(", "));
  console.log("  index:", diag.indexInfo);
  console.log("  preview:", diag.previewFirst, "| len", diag.previewLen);
  console.log("  trace:", diag.traceFirst, "| len", diag.traceLen);
  console.log("  search:", diag.search);
  console.log("  graph:", diag.graphMode, "| note:", diag.graphNote, "| len:", diag.graphLen);
  await p.screenshot({ path: path.join(outDir, value + ".png"), fullPage: true });
}

// 搜索实测
await p.evaluate(() => { const b=[...document.querySelectorAll('[role="tab"]')][2]; b.click(); });
await p.waitForTimeout(300);
await p.fill("#search-q", "aoci");
await p.click("#search-submit-mount button").catch(()=>{});
await p.waitForTimeout(700);
const sres = await p.evaluate(() => document.getElementById("search-results")?.innerText?.slice(0,400));
console.log("\n=== 搜索 aoci 结果 ===");
console.log(sres);
await p.screenshot({ path: path.join(outDir, "search-hit.png"), fullPage: true });

console.log("\nERRORS:", errs.length ? errs : "(none)");
await b.close(); server.close();
