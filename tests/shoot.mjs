// 离线渲染台：起一个静态服务，用 playwright 把面板画出来并截图。
// 用法: node shoot.mjs [outName] [width] [height]
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const outName = process.argv[2] || "shot.png";
// 截图是产出物，默认写到 tests/out/（.gitignore 已覆盖），不污染 tests/ 根。
const outPath = outName.includes("/") || outName.includes("\\")
  ? path.resolve(root, outName)
  : path.join(root, "out", outName);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const W = Number(process.argv[3] || 1440);
const H = Number(process.argv[4] || 900);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  serveStatic(res, req.url, MIME);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const errors = collectErrors(page);

await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
console.log("ROOT: " + root);
console.log("STATUS: " + (await page.title()));
console.log("BODY HEAD: " + (await page.evaluate(() => document.body.innerHTML.slice(0, 300))));
await page.screenshot({ path: outPath, fullPage: true });

// 也把 DOM 状态吐出来，检查六态堆叠
const diag = await page.evaluate(() => {
  const states = [...document.querySelectorAll(".state")].map((n) => ({
    block: n.closest("[data-block]")?.dataset.block || "(page)",
    cls: n.className,
    hidden: n.hidden,
  }));
  const visible = states.filter((s) => !s.hidden);
  return {
    rootState: document.getElementById("root")?.dataset.state,
    boardHidden: document.getElementById("board")?.hidden,
    visibleStates: visible,
    totalStates: states.length,
    reposText: document.getElementById("repolist")?.innerText?.slice(0, 400),
    detailText: document.getElementById("detail")?.innerText?.slice(0, 900),
  };
});

console.log(JSON.stringify(diag, null, 2));
console.log("ERRORS:", errors.length ? errors : "(none)");
await browser.close();
server.close();
