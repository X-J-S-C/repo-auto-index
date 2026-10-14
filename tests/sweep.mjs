// 六态扫描台：对同一份真数据注入不同 status，逐态截图 + 断言，
// 用来在本地证明布局改动没有把任何一态改坏。不进插件包。
// 用法: node sweep.mjs before|after
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const tag = process.argv[2] || "shot";
const outDir = path.join(root, "out", tag);
fs.mkdirSync(outDir, { recursive: true });

const base = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));

const STATES = {
  ready: () => base,
  scanning: () => ({
    ...base,
    repos: base.repos.map((r) => ({
      ...r,
      status: "scanning",
      taskId: "task_demo_0001",
      startedAt: new Date(Date.now() - 42000).toISOString(),
      finishedAt: null,
      progress: { phase: "walk", total: 412, scanned: 903, dirCount: 58, denied: 0, capped: false },
    })),
  }),
  canceled: () => ({
    ...base,
    repos: base.repos.map((r) => ({
      ...r,
      status: "canceled",
      taskId: null,
      startedAt: null,
      finishedAt: null,
      progress: { phase: "walk", total: 305, scanned: 640, dirCount: 41 },
    })),
  }),
  error: () => ({
    ...base,
    repos: base.repos.map((r) => ({
      ...r,
      status: "error",
      taskId: null,
      startedAt: null,
      finishedAt: null,
      error: "app_resource_call_token_invalid: 资源调用令牌已失效",
      progress: { phase: "walk", total: 88, scanned: 140, dirCount: 12, denied: 0 },
    })),
  }),
  empty: () => ({ ...base, repos: [] }),
  blocked: () => ({
    ...base,
    repos: base.repos.map((r) => ({
      ...r,
      progress: { ...r.progress, denied: 7 },
    })),
  }),
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png",
};

let current = base;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/fixture.json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(current)); return;
  }
  serveStatic(res, req.url, MIME);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});

const report = [];
for (const [name, make] of Object.entries(STATES)) {
  current = make();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // 错误收集走共享模块。以前这里是 /favicon|404/，太宽：
  // 真资源缺了报 404 也会被吃掉，等于给判据截了个洞。
  const errs = collectErrors(page);
  await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const diag = await page.evaluate(() => {
    const vis = [...document.querySelectorAll("[data-when], .state")]
      .filter((n) => !n.hidden && n.offsetParent !== null)
      .map((n) => (n.closest("[data-block]")?.dataset.block || "page") + ":" + (n.dataset.when || n.className));
    // 检查有没有该有内容却是空的槽位
    const empties = [];
    for (const sel of [".id-name", ".id-slug", ".id-dir", '[data-stat="total"]', '[data-stat="entries"]', ".preview-count", ".ii-file", ".track-persist"]) {
      const n = document.querySelector(sel);
      if (n && !n.textContent.trim()) empties.push(sel);
      if (!n) empties.push(sel + " (缺失)");
    }
    return {
      root: document.getElementById("root")?.dataset.state,
      boardHidden: document.getElementById("board")?.hidden,
      visible: vis,
      empties,
      searchFormVisible: !!document.getElementById("search-form") && document.getElementById("search-form").offsetParent !== null,
      repolist: (document.getElementById("repolist")?.innerText || "").slice(0, 240),
      detail: (document.getElementById("detail")?.innerText || "").replace(/\n+/g, " | ").slice(0, 700),
    };
  });
  await page.screenshot({ path: path.join(outDir, name + ".png"), fullPage: true });
  report.push({ state: name, errors: errs, ...diag });
  await page.close();
}

fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
for (const r of report) {
  console.log(`\n=== ${r.state} ===`);
  console.log("  root:", r.root, "| boardHidden:", r.boardHidden, "| searchFormVisible:", r.searchFormVisible);
  console.log("  visible:", r.visible.join(", ") || "(none)");
  console.log("  emptySlots:", r.empties.join(", ") || "(none)");
  console.log("  list:", r.repolist);
  console.log("  detail:", r.detail);
  console.log("  errors:", r.errors.length ? r.errors : "(none)");
}
await browser.close();
server.close();
