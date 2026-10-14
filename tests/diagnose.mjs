// 定位 PAGEERROR 来源：逐个控件单独挂载，看谁崩
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};
const base = JSON.parse(fs.readFileSync(path.join(root,"fixture.json"),"utf8"));
const server = http.createServer((req,res)=>{
  const u = decodeURIComponent(String(req.url).split("?")[0]);
  if (u==="/fixture.json") { res.writeHead(200,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(base)); return; }
  serveStatic(res, req.url, MIME);});
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;

const b = await chromium.launch({executablePath:resolveChromium()});
const p = await b.newPage({viewport:{width:1440,height:900}});
const errs = [];
p.on("pageerror", e => errs.push({ msg: e.message, stack: (e.stack||"").split("\n").slice(0,4).join(" | ") }));
await p.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);
console.log("PAGEERRORS:");
for (const e of errs) console.log("  - " + e.msg + "\n    " + e.stack);

// 逐个控件探测
const res = await p.evaluate(async () => {
  const { mountAppUi, appUi, appUiIcon } = await import("./assets/app-ui.js");
  const scope = document.getElementById("root");
  const cases = [
    ["Tabs", { items: [{value:"a",label:"A"},{value:"b",label:"B"}], value:"a", onChange:()=>{} }],
    ["Tabs(options)", { items: [{value:"a",label:"A"}], value:"a", onChange:()=>{} }],
    ["Grid", { minColumnWidth:"150px", gap:"sm", children:[appUi("ListRow",{title:"x",description:"1"})] }],
    ["ListRow", { title:"x", description:"1", meta:"m" }],
    ["Button", { children:"b", size:"sm", variant:"ghost", onClick:()=>{} }],
    ["EmptyState", { title:"t", description:"d" }],
    ["ErrorState", { title:"t", message:"m" }],
    ["TextInput", { label:"l", placeholder:"p" }],
    ["IconButton", { label:"l", children: appUiIcon("chevron") }],
    ["Button+icon", { children:"c", iconLeft: appUiIcon("failure"), variant:"danger", size:"sm" }],
  ];
  const out = [];
  for (const [name, props] of cases) {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-9999px;top:0";
    scope.appendChild(host);
    let err = null;
    const onErr = (e) => { err = e.message; };
    window.addEventListener("error", onErr);
    try { const h = mountAppUi(host, name.split("(")[0], props); await new Promise(r=>setTimeout(r,60)); h.destroy(); }
    catch (e) { err = "THROWN: " + e.message; }
    window.removeEventListener("error", onErr);
    out.push(name + " => " + (err || "ok"));
  }
  return out;
});
console.log("\nCONTROL PROBE:");
for (const r of res) console.log("  " + r);
await b.close(); server.close();
