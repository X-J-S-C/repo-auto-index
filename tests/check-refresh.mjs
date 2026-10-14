import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const fixture = JSON.parse(fs.readFileSync(path.join(root,"fixture.json"),"utf8"));
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};
const server = http.createServer((req,res)=>{
  const u = decodeURIComponent(String(req.url).split("?")[0]);
  if (u === "/fixture.json") { res.writeHead(200,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(fixture)); return; }
  serveStatic(res, req.url, MIME);});
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;
const b = await chromium.launch({executablePath:resolveChromium()});
const p = await b.newPage({viewport:{width:1440,height:900}});
await p.goto(`http://127.0.0.1:${port}/panel.html`,{waitUntil:"networkidle"});
await p.waitForTimeout(1200);
const r = await p.evaluate(()=>({
  refreshMountHTML: document.getElementById("refresh-mount")?.innerHTML?.slice(0,200),
  refreshMountButtons: document.getElementById("refresh-mount")?.querySelectorAll("button").length,
  barButtons: [...document.querySelectorAll(".bar button")].map(b=>b.textContent),
}));
console.log(JSON.stringify(r,null,2));
await b.close(); server.close();
