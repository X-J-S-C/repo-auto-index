// 生成市场投稿用的截图。与 tests/ 的回归台分开：这里只出图，不做断言，
// 且把 mock SDK 的版本号换成真实版本（回归台用 0.0.0-mock 是刻意的，
// 那个值不该出现在对外材料里）。
//
// 用法：node market-shots.mjs   → 写入 docs/screenshots/
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const APP = path.join(repo, "repo-auto-index");
const OUT = path.join(repo, "docs", "screenshots");
fs.mkdirSync(OUT, { recursive: true });

const VERSION = JSON.parse(fs.readFileSync(path.join(APP, "manifest.json"), "utf8")).version;
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixture.json"), "utf8"));
const contract = JSON.parse(fs.readFileSync(path.join(here, "graph-contract.json"), "utf8"));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8",
};

// 状态注入：与 sweep.mjs 同源，这里只保留要出图的两态
const states = {
  ready: () => fixture,
  scanning: () => ({
    ...fixture,
    repos: fixture.repos.map((r) => ({
      ...r, status: "scanning", taskId: "task_demo_0001",
      startedAt: new Date(Date.now() - 42000).toISOString(), finishedAt: null,
      progress: { phase: "walk", total: 412, scanned: 903, dirCount: 58, denied: 0, capped: false },
    })),
  }),
};

// 六环的真实形状（对齐 index.js 的 buildChain 输出）
function ringsFor(r, idx) {
  return [
    { num: "01", name: "初始化", state: "ok", evidence: ".aoci/ 就位 · config v2 · zh-CN", source: ".aoci/config.json" },
    { num: "02", name: "清点", state: "ok", evidence: `${r.progress.total} 文件 · ${r.progress.dirCount} 目录 · ${r.progress.denied} 个读不到`, source: "dataDir/projects.json" },
    { num: "03", name: "基线", state: "ok", evidence: `${r.progress.scanned} 文件指纹`, source: ".aoci/baseline.json" },
    { num: "04", name: "索引", state: "ok", evidence: `${idx.entries} 条目 · ${idx.file} · 3 卷`, source: "aoci.txt / aoci.meta.txt / aoci.code.txt" },
    { num: "05", name: "核对", state: "ok", evidence: "账本无未决操作", source: ".aoci/verify_history/ + ledger.jsonl" },
    { num: "06", name: "检索", state: "ok", evidence: `${idx.entries} 条目可搜 · 只搜本仓，不跨仓`, source: "aoci 三文件合并文本" },
  ];
}

let current = states.ready();

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const name = path.basename(url);
  const json = (v) => { res.writeHead(200, { "content-type": MIME[".json"] }); res.end(JSON.stringify(v)); };

  // mock SDK：只把版本号换成真实版本，其余原样
  if (name === "sdk.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    return res.end(fs.readFileSync(path.join(here, "assets", "sdk.js"), "utf8").replace(/0\.0\.0-mock/g, VERSION));
  }
  if (name === "theme.css") {
    res.writeHead(200, { "content-type": MIME[".css"] });
    return res.end(fs.readFileSync(path.join(here, "assets", "theme.css")));
  }
  if (url === "/fixture.json") return json(current);
  if (url === "/graph-contract.json") return json(contract);
  if (url.endsWith("/graph")) return json({ ok: true, ...contract });

  // 后端路由探测（报告卡 / 链路卡走 ../routes/ 或 hana.api.fetch）
  if (url.includes("/routes/") || url.startsWith("/routes/")) {
    if (/\/health$/.test(url)) return json({ ok: true, app: "repo-auto-index", version: VERSION });
    if (/\/overview$/.test(url)) return json({ ok: true, dataDir: fixture.dataDir, repos: current.repos });
    if (/\/chain$/.test(url)) {
      const r = current.repos[0];
      if (!r) return json({ ok: true, chain: null });
      const idx = r.index || { entries: 0, file: "aoci.code.txt" };
      const rings = ringsFor(r, idx);
      return json({
        ok: true,
        chain: {
          repo: r.id, name: r.name, dir: r.dir, generatedAt: new Date().toISOString(), rings,
          summary: { total: rings.length, ok: rings.filter((x) => x.state === "ok").length, warn: 0, bad: 0, wait: 0, chainOk: true, repair: [] },
        },
      });
    }
    return json({ ok: true, repo: fixture.repos[0], index: fixture.repos[0].index, preview: fixture.indexPreview || [] });
  }

  // App 真源码优先
  const p = path.join(APP, "ui", url.replace(/^\/+/, ""));
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    return res.end(fs.readFileSync(p));
  }
  res.writeHead(404); res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: resolveChromium() });

async function shot(route, file, { state = "ready", actions = null, viewport = { width: 1440, height: 900 } } = {}) {
  current = states[state]();
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errs.push("PAGEERROR: " + String(e).slice(0, 200)));
  page.on("requestfailed", (r) => errs.push("REQFAIL: " + r.url().slice(0, 140)));
  await page.goto(`${base}/${route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  if (actions) await actions(page);
  // 卡片页的 body 是满高。量主容器的实际高度，把视口调到内容高度再截，
  // 这样既不留空白，也不会把内容裁掉。
  const rootH = await page.evaluate(() => {
    const el = document.getElementById("root") || document.body;
    const r = el.getBoundingClientRect();
    return Math.ceil(r.height + r.top);
  });
  const targetH = Math.min(Math.max(rootH, 240), 6000);
  await page.setViewportSize({ width: viewport.width, height: targetH });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(OUT, file) });
  const ver = await page.evaluate(() => document.body.innerText.match(/\bv?\d+\.\d+\.\d+[\w.-]*/)?.[0] || "(未显示)");
  const txtLen = await page.evaluate(() => document.body.innerText.trim().length);
  console.log(`  ${file.padEnd(28)} 版本: ${String(ver).padEnd(12)} 正文 ${txtLen} 字  ${errs.length ? "错误: " + errs.slice(0, 2).join(" | ") : "无错误"}`);
  await page.close();
}

console.log("=== 出图（真实版本 " + VERSION + "）===");
// 整页卡用宽视口；流内卡（报告卡 / 链路卡）用窄视口，贴近它在对话里的真实观感
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 900, height: 1000 };
await shot("panel.html", "01-panel-ready.png", { state: "ready", viewport: WIDE });
await shot("panel.html", "02-panel-scanning.png", { state: "scanning", viewport: WIDE });
await shot("report.html", "03-report.png", { viewport: NARROW });
await shot("chain.html", "04-chain.png", { viewport: NARROW });
await shot("panel.html", "05-relations.png", {
  viewport: WIDE,
  actions: async (page) => {
    const tab = page.locator('[role="tab"], button', { hasText: "关系" }).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(1600); }
  },
});

await browser.close();
server.close();
console.log("\n已写入 docs/screenshots/");
