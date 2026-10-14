// 链路体检卡的离线渲染验证台。
// 与 shoot-report.mjs 同源，目标换成 ui/chain.html。
//
// 关键：chain.html / chain.js / chain.css 三个文件**直接从 App 源目录读**（_resolve.mjs
// 已把 ui/ 排在最前），画出来的就是真源。sdk.js 用本渲染台的 mock（离线没有宿主）。
//
// 数据从哪来：卡片按候选通道取 /routes/overview 与 /routes/repo/:id/chain
// （见 chain.js 的 ROUTE_CANDIDATES）。本台直接答这两个路径，喂可控数据，
// 不动 App 自己的后端——测的是「给定后端答案，卡片画成什么样」。
//
// 用法: node shoot-chain.mjs [outName] [width] [height] [--chain=ok|broken|partial]
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveStatic, appUiRoot } from "./_resolve.mjs";
import { collectErrors, NOISE_NOTE } from "./_errors.mjs";

const here = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const outName = process.argv[2] || "chain-shot.png";
// 截图是产出物，默认写到 tests/out/（.gitignore 已覆盖），不污染 tests/ 根。
// 传了带目录的路径就按传的来（便于对比基线）。
const outPath = outName.includes("/") || outName.includes("\\")
  ? path.resolve(here, outName)
  : path.join(here, "out", outName);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const W = Number(process.argv[3] || 720);
const H = Number(process.argv[4] || 900);
const MODE = (process.argv.find((a) => a.startsWith("--chain=")) || "--chain=ok").slice(8);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// ── 可控数据 ────────────────────────────────────────────
// 三种形态：ok（六环全绿）、partial（核对超期，第 05 环 warn）、broken（缺 .aoci，断在初始化）
const REPO = {
  id: "atlas-workspace",
  name: "Atlas Workspace",
  dir: "C:\\projects\\atlas-workspace",
  status: "done",
  progress: { phase: "done", total: 746, scanned: 822, dirCount: 77, denied: 0, entries: 392, entryLines: 473, capped: false },
  finishedAt: "2026-10-13T12:00:33.914Z",
  updatedAt: "2026-10-13T12:00:33.927Z",
  index: { file: "aoci.code.txt", entries: 392, entryLines: 473, hasIndex: true },
};

function ringsFor(mode) {
  const base = [
    { num: "01", name: "初始化", state: "ok", evidence: ".aoci/ 就位 · config v2 · zh-CN · 托管范围 production", source: ".aoci/config.json" },
    { num: "02", name: "清点", state: "ok", evidence: "746 文件 · 77 目录 · 0 个读不到", source: "dataDir/projects.json" },
    { num: "03", name: "基线", state: "ok", evidence: "426 文件指纹 · 2026-10-08T14:17:36Z", source: ".aoci/baseline.json" },
    { num: "04", name: "索引", state: "ok", evidence: "392 条目 · aoci.code.txt 121.9 KB · 3 卷", source: "aoci.txt / aoci.meta.txt / aoci.code.txt" },
    { num: "05", name: "核对", state: "ok", evidence: "上次核对 20261008T141749Z · 已隔 0 天 · 账本 55 条操作", source: ".aoci/verify_history/ + ledger.jsonl" },
    { num: "06", name: "检索", state: "ok", evidence: "392 条目可搜 · 只搜本仓，不跨仓", source: "aoci 三文件合并文本" },
  ];
  if (mode === "partial") {
    base[4] = { num: "05", name: "核对", state: "warn", evidence: "上次核对 20261008T141749Z · 已隔 6 天 · 账本 55 条操作", source: ".aoci/verify_history/ + ledger.jsonl" };
  }
  if (mode === "broken") {
    const wait = ["02", "03", "04", "05", "06"];
    return base.map((r) =>
      r.num === "01"
        ? { ...r, state: "bad", evidence: ".aoci/ 不存在，这个仓库还没跑过 aoci init" }
        : { ...r, state: "wait", evidence: r.num === "02" ? "还没清点过" : "上游未到，无从读取" }
    );
  }
  return base;
}

function chainFor(mode) {
  const rings = ringsFor(mode);
  const summary = {
    total: rings.length,
    ok: rings.filter((r) => r.state === "ok").length,
    warn: rings.filter((r) => r.state === "warn").length,
    bad: rings.filter((r) => r.state === "bad").length,
    wait: rings.filter((r) => r.state === "wait").length,
    chainOk: rings.every((r) => r.state === "ok"),
    repair: rings.some((r) => r.state === "bad")
      ? [
          "装 AOCI-CODE：取 github.com/aoci-spec/aoci-code 的 Release 包，放到一个固定路径",
          "在仓库里初始化并扫描：aoci init → aoci scan",
          "重启 Agent，让它按 AOCI 的流程把条目写出来",
        ]
      : [],
  };
  return { repo: REPO.id, name: REPO.name, dir: REPO.dir, generatedAt: new Date().toISOString(), rings, summary };
}

// mock SDK：离线没有宿主，真 SDK 会因缺 appSurfaceSession 抛错。
// 注意 hana.api.fetch 要抛错，让卡片走「relative」通道（本台答 /routes/*）。
const MOCK_SDK = `export const hana = {
  ready: async () => {},
  api: { url: (p) => p, fetch: async () => { throw new Error("offline: sdk channel disabled"); } },
  theme: { getSnapshot: async () => ({ theme: "warm-paper", cssUrl: "./assets/theme.css" }), subscribe: () => () => {} },
  ui: { resize: () => {} },
  cards: { open: async () => ({}) },
  toast: { show: () => {} },
  logger: { info() {}, warn() {}, error() {} },
};`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);

  if (url === "/assets/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(MOCK_SDK);
    return;
  }
  // 卡片按 ../routes/<path> 取数据（chain.html 在根，故解析为 /routes/<path>）
  if (url === "/routes/overview") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, dataDir: "C:\\hana\\.hana\\app-data\\repo-auto-index", repos: [REPO] }));
    return;
  }
  if (url.startsWith("/routes/repo/") && url.endsWith("/chain")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, chain: chainFor(MODE) }));
    return;
  }
  if (url.startsWith("/routes/")) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const file = url === "/" ? path.join(appUiRoot, "chain.html") : resolveStatic(url);
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
const errors = collectErrors(page);

await page.goto(`http://127.0.0.1:${port}/chain.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const diag = await page.evaluate(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim();
  const rings = [...document.querySelectorAll(".ring")].map((el) => ({
    s: el.dataset.s,
    txt: el.textContent.replace(/\s+/g, " ").trim().slice(0, 90),
  }));
  return {
    rootStatus: document.getElementById("root")?.dataset.status,
    chainMode: document.getElementById("ch-body")?.dataset.mode || null,
    name: t("ch-name"),
    slug: t("ch-slug"),
    badge: t("ch-badge-mount"),
    dir: t("ch-dir"),
    ringCount: rings.length,
    rings,
    fixHidden: document.getElementById("fix")?.hidden,
    fixSteps: [...document.querySelectorAll("#fix-list li")].map((li) => li.textContent.trim()),
    source: t("ch-source"),
    bodyHidden: document.getElementById("ch-body")?.hidden,
    centerHidden: document.getElementById("ch-center")?.hidden,
    docHeight: document.documentElement.scrollHeight,
  };
});

console.log(JSON.stringify(diag, null, 2));
console.log("ERRORS:", errors.length ? errors : "(none)");
console.log(NOISE_NOTE);
await page.screenshot({ path: outPath, fullPage: true });
console.log("SHOT: " + outPath);
await browser.close();
server.close();
