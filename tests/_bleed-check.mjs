// 卡片版式硬规则检查：顶部右上 100×40 留空区。
//
// 依据（官方宿主契约，不是我们自己定的）：
//   ~/.hanako/card-guide/guide.md §2
//   "For default chat cards, keep text, data graphics and controls out of the
//    top-right 100 × 40 CSS px (width × height). Backgrounds and decorative
//    artwork may bleed into it; the rest of the top row is usable."
//
// 为什么要有这个检查（2026-10-14）：
//   报告卡曾把状态徽标放在右上（.rh 用 justify-content: space-between），
//   实测卡片宽 520 / 720 时徽标落在 x[420,520] / x[620,720] —— 正压在那块留空区上，
//   会和宿主自己的控件叠。当时没人发现，因为没有量过。
//   本脚本把「没压区」变成一条可复跑的判据，不再靠眼睛。
//
// 判据：卡片内任何**承载文字或控件**的元素，其 bbox 不得与
//       [viewportWidth - 100, viewportWidth] × [0, 40] 相交。
//       根容器与页脚的整块背景不算（它们只是背景，guide 明文允许 bleed）。
//
// 适用范围从 manifest 推导，不硬编码：
//   guide 原文限定 "For default chat cards"，且补充 "On Chalkboard and detached
//   windows, respect actual host controls; this is not a universal limit."
//   所以只查**流内卡**（有 route、未声明 realization: "page" 的卡）。
//   整页卡（realization: "page"，如 panel）有自己的页面与宿主标题栏，不在此列，
//   它的顶栏按钮压区是正常布局，不是缺陷。
//
// 用法: node _bleed-check.mjs
// 退出码：0 = 所有流内卡在多个宽度下都干净；2 = 有元素压区

import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveStatic, appUiRoot } from "./_resolve.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

// 离线台：sdk.js 用桩（离线无宿主），其余全部直读 App 真源码。
const MOCK_SDK = `export const hana = {
  ready: async () => {},
  api: { url: (p) => p, fetch: async () => { throw new Error("offline"); } },
  theme: { getSnapshot: async () => ({ theme: "warm-paper", cssUrl: "./assets/theme.css" }), subscribe: () => () => {} },
  ui: { resize: () => {} }, cards: { open: async () => ({}) }, toast: { show: () => {} },
  logger: { info() {}, warn() {}, error() {} },
};`;

const REPO = {
  id: "atlas-workspace", name: "Atlas Workspace", dir: "C:\\projects\\atlas-workspace",
  status: "done", progress: { phase: "done", total: 746, dirCount: 77, denied: 0, entries: 392, capped: false },
  finishedAt: "2026-10-13T12:00:33.914Z", updatedAt: "2026-10-13T12:00:33.927Z",
  index: { file: "aoci.code.txt", entries: 392, hasIndex: true },
};
const CHAIN = {
  repo: REPO.id, name: REPO.name, dir: REPO.dir, generatedAt: new Date().toISOString(),
  rings: [
    { num: "01", name: "初始化", state: "ok", evidence: ".aoci/ 就位 · config v2", source: ".aoci/config.json" },
    { num: "02", name: "清点", state: "ok", evidence: "746 文件 · 77 目录", source: "dataDir/projects.json" },
    { num: "03", name: "基线", state: "ok", evidence: "426 文件指纹", source: ".aoci/baseline.json" },
    { num: "04", name: "索引", state: "ok", evidence: "392 条目", source: "aoci 三文件" },
    { num: "05", name: "核对", state: "warn", evidence: "已隔 6 天", source: ".aoci/verify_history/" },
    { num: "06", name: "检索", state: "ok", evidence: "392 条目可搜", source: "aoci 三文件" },
  ],
  summary: { total: 6, ok: 5, warn: 1, bad: 0, wait: 0, chainOk: false, repair: [] },
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const json = (obj) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (url === "/assets/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(MOCK_SDK);
    return;
  }
  if (url === "/routes/overview") return json({ ok: true, dataDir: "X", repos: [REPO] });
  if (url.endsWith("/chain")) return json({ ok: true, chain: CHAIN });
  if (url.startsWith("/routes/repo/")) return json({ ok: true, repo: REPO, index: REPO.index, preview: [] });
  if (url.startsWith("/routes/")) return json({ ok: true });

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

// 从 manifest 取流内卡：有 route、且不是 realization: "page" 的整页卡。
const manifest = JSON.parse(fs.readFileSync(path.join(appUiRoot, "..", "manifest.json"), "utf8"));
const cards = manifest?.contributes?.cards || [];
const streamCards = cards.filter((c) => c.route && c.realization !== "page" && !c.siteNavEntry);
const PAGES = streamCards.map((c) => c.route.replace(/^\//, ""));
const wholePages = cards.filter((c) => c.route && !PAGES.includes(c.route.replace(/^\//, ""))).map((c) => c.route);

if (!PAGES.length) {
  console.log("manifest 里没有流内卡，本检查无事可做。");
  process.exit(0);
}
console.log(`流内卡 ${PAGES.length} 张（查右上留空）：${PAGES.join(", ")}`);
console.log(`整页卡 ${wholePages.length} 张（不在本检查范围，宿主自己管标题栏）：${wholePages.join(", ") || "无"}`);
console.log("");

const WIDTHS = [420, 520, 620, 720, 900];
const problems = [];

for (const page of PAGES) {
  for (const w of WIDTHS) {
    const p = await browser.newPage({ viewport: { width: w, height: 900 } });
    try {
      await p.goto(`http://127.0.0.1:${port}/${page}`, { waitUntil: "networkidle" });
      await p.waitForTimeout(700);
      const hits = await p.evaluate(() => {
        const vw = window.innerWidth;
        const zone = { x0: vw - 100, x1: vw, y0: 0, y1: 40 };
        // 只查承载内容的最内层元素：有直接文字节点，或本身是控件/挂载点。
        const carriers = [];
        for (const el of document.querySelectorAll("body *")) {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          if (el.hidden) continue;
          const direct = [...el.childNodes].some(
            (n) => n.nodeType === 3 && n.textContent.trim().length > 0
          );
          const isControl = /^(BUTTON|INPUT|SELECT|TEXTAREA|A|svg)$/i.test(el.tagName);
          if (!direct && !isControl) continue;
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          const ox = b.x < zone.x1 && b.x + b.width > zone.x0;
          const oy = b.y < zone.y1 && b.y + b.height > zone.y0;
          if (ox && oy) {
            carriers.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              cls: (el.className || "").toString().slice(0, 30),
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 28),
              box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
            });
          }
        }
        return carriers;
      });
      if (hits.length) {
        problems.push({ page, w, hits });
        console.log(`[压区] ${page} @ ${w}px`);
        for (const h of hits) {
          console.log(`        <${h.tag}${h.id ? "#" + h.id : ""}> "${h.text}" bbox=${JSON.stringify(h.box)}`);
        }
      } else {
        console.log(`[清洁] ${page} @ ${w}px`);
      }
    } finally {
      await p.close();
    }
  }
}

await browser.close();
server.close();

console.log("");
if (problems.length === 0) {
  console.log(`右上留空区检查通过：${PAGES.length} 张卡 × ${WIDTHS.length} 个宽度，无文字或控件压区。`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 处压区（官方 card-guide §2 要求右上 100×40 留空）。`);
process.exit(2);
