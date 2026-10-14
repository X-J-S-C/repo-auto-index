// 实测官方 Grid / ListRow / Tabs 的布局行为，确定列数控制方式
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};
const server = http.createServer((req, res) => { serveStatic(res, req.url, MIME); });
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;

const b = await chromium.launch({executablePath:resolveChromium()});
const p = await b.newPage({viewport:{width:1440,height:900}});
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

const out = await p.evaluate(async () => {
  const { mountAppUi, appUi } = await import("./assets/app-ui.js");
  const root = document.createElement("div");
  root.setAttribute("data-hana-app-ui", "");
  root.style.cssText = "position:fixed;left:0;top:0;width:1200px;background:#fff;z-index:99999;padding:10px";
  document.body.appendChild(root);

  const res = {};
  const probed = [];
  const probe = async (label, name, props, boxW) => {
    const host = document.createElement("div");
    host.style.cssText = `width:${boxW}px;border:1px solid red;margin-bottom:6px`;
    root.appendChild(host);
    mountAppUi(host, name, props);
    await new Promise(r => setTimeout(r, 120));
    const content = host.querySelector("[data-hana-app-ui-content]") || host.firstElementChild;
    const inner = (content && content.firstElementChild) || content;
    const cs = inner ? getComputedStyle(inner) : null;
    res[label] = cs ? {
      tag: inner.tagName, cls: inner.className,
      gridTemplateColumns: cs.gridTemplateColumns,
      display: cs.display,
      width: Math.round(inner.getBoundingClientRect().width),
      childCount: inner.children.length,
      childrenW: [...inner.children].map(c => Math.round(c.getBoundingClientRect().width)),
    } : "no child";
  };

  const rows = [
    appUi("ListRow", { title: "文件", description: "740", meta: "progress.total" }),
    appUi("ListRow", { title: "目录", description: "76", meta: "progress.dirCount" }),
    appUi("ListRow", { title: "读不到", description: "0", meta: "progress.denied" }),
    appUi("ListRow", { title: "索引条目", description: "392", meta: "index.entries" }),
  ];

  await probe("Grid-150", "Grid", { minColumnWidth: "150px", gap: "sm", children: rows }, 1200);
  await probe("Grid-260", "Grid", { minColumnWidth: "260px", gap: "sm", children: rows }, 1200);
  await probe("Grid-nostyle", "Grid", { gap: "sm", children: rows }, 1200);

  // 单 ListRow 结构
  const h1 = document.createElement("div");
  h1.style.cssText = "width:400px;border:1px solid blue";
  root.appendChild(h1);
  mountAppUi(h1, "ListRow", { title: "文件", description: "740", meta: "progress.total" });
  await new Promise(r => setTimeout(r, 120));
  res.listRowOuter = h1.innerHTML.slice(0, 200);
  const lrContent = h1.querySelector("[data-hana-app-ui-content]");
  res.listRowHTML = lrContent ? lrContent.innerHTML.slice(0, 700) : "(none)";

  // Tabs 宽度
  const h2 = document.createElement("div");
  h2.style.cssText = "width:1200px;border:1px solid green";
  root.appendChild(h2);
  mountAppUi(h2, "Tabs", { items: [{value:"a",label:"概览"},{value:"b",label:"索引"},{value:"c",label:"搜索"},{value:"d",label:"轨迹"}], value:"a", onChange:()=>{} });
  await new Promise(r => setTimeout(r, 150));
  const tabContent = h2.querySelector("[data-hana-app-ui-content]");
  const tabInner = tabContent?.firstElementChild;
  res.tabs = tabInner ? { tag: tabInner.tagName, cls: tabInner.className, display: getComputedStyle(tabInner).display, width: Math.round(tabInner.getBoundingClientRect().width), childW: [...tabInner.children].map(c=>Math.round(c.getBoundingClientRect().width)), html: tabContent.innerHTML.slice(0, 500) } : "(no tabs)";

  return res;
});
console.log(JSON.stringify(out, null, 2));
await b.close(); server.close();
