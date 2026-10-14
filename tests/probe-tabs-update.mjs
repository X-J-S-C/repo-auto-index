// 独立探针：验证 handle.update(props) 能否驱动官方 Tabs 的选中指示
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
const root = path.resolve(process.cwd());
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".png":"image/png"};
const server = http.createServer((req,res)=>{
  const u=decodeURIComponent(String(req.url).split("?")[0]);
  serveStatic(res, u==="/" ? "/tabs-probe.html" : req.url, MIME);});
await new Promise(r=>server.listen(0,"127.0.0.1",r)); const port=server.address().port;

const b = await chromium.launch({executablePath:resolveChromium()});
const p = await b.newPage({viewport:{width:900,height:400}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${port}/tabs-probe.html`, { waitUntil:"networkidle" });
await p.waitForTimeout(600);

const step = async (tag, fn) => {
  if (fn) await p.evaluate(fn);
  await p.waitForTimeout(350);
  const d = await p.evaluate(() => window.__read());
  console.log(`\n[${tag}]`);
  console.log("  aria      :", d.aria.join(", "));
  console.log("  选中      :", d.selected.join("/") || "(无)");
  console.log("  指示器 left:", d.indicatorVars?.left, " right:", d.indicatorVars?.right);
  console.log("  report    :", d.report.join(" | ") || "(空)");
  return d;
};

const r0 = await step("初始 value=a");
const r1 = await step("点击「乙」（原生点击）", () => window.__clickIdx(1));
const r2 = await step("外部改 state 但不 update（模拟现状）", () => window.__setValueNoUpdate("c"));
const r3 = await step("外部改 state 并 handle.update(props)", () => window.__setValue("c"));
const r4 = await step("handle.update 回 a", () => window.__setValue("a"));

// 断言
const ok1 = r1.selected.join() === "乙";
const ok2 = r2.selected.join() === "乙";       // 没 update → 指示器不动（复现 bug）
const ok3 = r3.selected.join() === "丙";       // update → 指示器跟随
const ok4 = r4.selected.join() === "甲";
console.log("\n=== 断言 ===");
console.log("  点击后指示器跟随           :", ok1 ? "PASS" : "FAIL");
console.log("  不回传时指示器不动（复现）  :", ok2 ? "PASS(复现)" : "FAIL");
console.log("  handle.update 后指示器跟随  :", ok3 ? "PASS" : "FAIL");
console.log("  再 update 回初始           :", ok4 ? "PASS" : "FAIL");
console.log("ERRORS:", errs.length ? errs : "(none)");
await b.close(); server.close();
