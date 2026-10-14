// 扫描报告卡的离线渲染验证台。
// 与 shoot.mjs 同源，但目标换成 ui/report.html。
//
// 关键：report.html / report.js / report.css 三个文件**直接从 App 源目录读**，
// 不是副本，所以这里画出来的就是真源。只有 sdk.js 用本渲染台的 mock
// （离线环境没有宿主，真 SDK 会因缺 appSurfaceSession 抛错），app-ui.js 用官方打包件。
//
// 用法: node shoot-report.mjs [outName] [width] [height]
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveStatic, testsRoot, appUiRoot } from "./_resolve.mjs";
import { collectErrors, NOISE_NOTE } from "./_errors.mjs";

const here = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));

const outName = process.argv[2] || "report-shot.png";
// 截图是产出物，默认写到 tests/out/（.gitignore 已覆盖），不污染 tests/ 根。
const outPath = outName.includes("/") || outName.includes("\\")
  ? path.resolve(here, outName)
  : path.join(here, "out", outName);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const W = Number(process.argv[3] || 720);
const H = Number(process.argv[4] || 900);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// URL → 本地文件。report.* 走 App 真源码（_resolve.mjs 已优先），
// fixture.json / theme.css 等测试自有物回退到测试目录。
// STATEFILE：--state=<s> 时，把 fixture.json 改写成指定状态再返回，用于多态渲染验证。
const STATE = (process.argv.find((a) => a.startsWith("--state=")) || "").slice(8);
// --nofeed：让 mock 后端所有数据请求返回 500，用于验证「真实通道全失败→内联样本」回退。
const NOFEED = process.argv.includes("--nofeed");

function fixtureVariant(raw) {
  if (!STATE) return raw;
  const fx = JSON.parse(raw);
  const r = fx.repos[0];
  r.status = STATE;
  if (STATE === "scanning") {
    r.progress = { phase: "walk", total: 512, scanned: 300, dirCount: 40, entries: null, capped: false };
    r.finishedAt = null; r.taskId = "task-demo"; r.index = null;
    fx.indexEntries = 190; fx.indexFile = "aoci.code.txt";
  } else if (STATE === "canceled") {
    r.progress = { phase: "walk", total: 233, scanned: 233, dirCount: 30, entries: 190, capped: false };
    r.finishedAt = null; r.index = { file: "aoci.code.txt", entries: 190, hasIndex: true };
    fx.indexEntries = 190; fx.indexFile = "aoci.code.txt";
  } else if (STATE === "error") {
    r.error = "EPERM: operation not permitted"; r.progress = {}; r.index = null;
    fx.indexEntries = 0; fx.indexFile = null;
  } else if (STATE === "empty") {
    fx.repos = [];
  }
  return JSON.stringify(fx);
}

function resolveFile(url) {
  const p = url.split("?")[0];
  if (p === "/") return path.join(appUiRoot, "report.html");
  return resolveStatic(p);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  // NOFEED：把 sdk.js 换成一个必失败的内联桩，只打死 sdk 通道，
  // 不动 fixture.json（mock SDK 自己在 import 时会读它）。
  if (NOFEED && url === "/assets/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end("export const hana={ready:async()=>{},api:{url:(p)=>p,fetch:async()=>{throw new Error('feed disabled for test')}},theme:{getSnapshot:async()=>({theme:'warm-paper',cssUrl:'./assets/theme.css'}),subscribe:()=>()=>{}},ui:{resize:()=>{}},cards:{open:async()=>({})},logger:{info(){},warn(){},error(){}}};");
    return;
  }
  if (url === "/fixture.json" && STATE) {
    const body = fixtureVariant(fs.readFileSync(path.join(testsRoot, "fixture.json"), "utf8"));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }
  const file = resolveFile(url);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end("nope"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
// 错误收集走共享模块：只放行 favicon 与卡片的后端通道探测两类已知噪音。
// 以前这里写的是 /favicon|404/，太宽——真资源缺了报 404 也会被吃掉。
const errors = collectErrors(page);

await page.goto(`http://127.0.0.1:${port}/report.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const diag = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  return {
    rootStatus: document.getElementById("root")?.dataset.status,
    name: t("rep-name"),
    slug: t("rep-slug"),
    badge: t("rep-badge-mount"),
    files: t("n-files"),
    entries: t("n-entries"),
    denied: t("n-denied"),
    time: t("k-time"),
    indexFile: t("k-index"),
    source: t("rep-source"),
    bodyHidden: document.getElementById("rep-body")?.hidden,
    centerHidden: document.getElementById("rep-center")?.hidden,
    note: document.getElementById("rep-note")?.hidden ? "(hidden)" : document.getElementById("rep-note")?.textContent?.trim(),
    rescanDisabled: document.querySelector("#act-rescan button")?.disabled,
    docHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
  };
});

console.log(JSON.stringify(diag, null, 2));
console.log("ERRORS:", errors.length ? errors : "(none)");
console.log(NOISE_NOTE);
await page.screenshot({ path: outPath, fullPage: true });
console.log("SHOT: " + outPath);
await browser.close();
server.close();
