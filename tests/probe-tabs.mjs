// 实测：面板页签点击后，(a) 内容是否切换 (b) 官方 Tabs 的高亮指示是否跟随
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
const p = await b.newPage({viewport:{width:1440,height:1000}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil:"networkidle" });
await p.waitForTimeout(1500);

const snapshot = async (tag) => {
  const d = await p.evaluate(() => {
    const root = document.getElementById("root");
    // 官方 Tabs 渲染成什么结构？先摸清
    const tabsHost = document.getElementById("tabs-mount");
    const all = [...tabsHost.querySelectorAll("*")];
    const clickable = all.filter(n => n.tagName === "BUTTON" || n.getAttribute("role") === "tab" || n.tabIndex >= 0);
    return {
      status: root?.dataset.status,
      tabsHostHtml: tabsHost.innerHTML.slice(0, 900),
      clickables: clickable.slice(0, 8).map(n => ({
        tag: n.tagName,
        text: (n.textContent||"").trim().slice(0,12),
        role: n.getAttribute("role"),
        ariaSelected: n.getAttribute("aria-selected"),
        dataState: n.getAttribute("data-state"),
        cls: String(n.className||"").slice(0,140),
      })),
      panes: [...document.querySelectorAll("[data-pane]")].map(n => n.dataset.pane + (n.hidden ? ":hidden" : ":shown")),
    };
  });
  console.log(`\n##### ${tag} #####`);
  console.log("root.status:", d.status);
  console.log("panes:", d.panes.join(", "));
  console.log("clickables:");
  d.clickables.forEach((c,i) => console.log(`  [${i}] <${c.tag}> role=${c.role} aria=${c.ariaSelected} dataState=${c.dataState} text="${c.text}"`));
  console.log("tabsHost html:", d.tabsHostHtml.replace(/\s+/g," ").slice(0,500));
  return d;
};

await snapshot("初始");

// 点第 2 项（索引）
await p.evaluate(() => {
  const host = document.getElementById("tabs-mount");
  const all = [...host.querySelectorAll("*")];
  const clickable = all.filter(n => n.tagName === "BUTTON" || n.getAttribute("role") === "tab" || n.tabIndex >= 0);
  if (clickable[1]) clickable[1].click();
});
await p.waitForTimeout(700);
await snapshot("点了「索引」之后");

await p.evaluate(() => {
  const host = document.getElementById("tabs-mount");
  const all = [...host.querySelectorAll("*")];
  const clickable = all.filter(n => n.tagName === "BUTTON" || n.getAttribute("role") === "tab" || n.tabIndex >= 0);
  if (clickable[4]) clickable[4].click();
});
await p.waitForTimeout(700);
await snapshot("点了「关系」之后");

console.log("\nERRORS:", errs.length ? errs : "(none)");
await b.close(); server.close();
