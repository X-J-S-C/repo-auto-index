// 新人第一次用的回归：缺索引时面板必须给得出下一步。
//
// 为什么单独测（2026-10-14）：用户问「新人第一次用怎么用」，实拍发现面板只写
// 「未读到索引：可能不存在，也可能存在但读取失败」——把三种完全不同的处境
// （没装 AOCI / 装了没写条目 / 文件读失败）混成一句，新人看完不知道要装什么。
//
// 本脚本用两个合成仓库分别覆盖两种处境，逐条核文案：
//   ① 没初始化（没有 .aoci/config.json）→ 必须出现「装 AOCI-CODE」与三步指引
//   ② 已初始化但没条目           → 必须说明「条目由 Agent 写」，不该再让用户去装
//
// 用法: node probe-newcomer.mjs
// 退出码：0 = 两种处境都给得出正确下一步；2 = 有一种含糊或指错

import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import path from "node:path";
import { serveStatic } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function repoOf(id, name) {
  return {
    id, name, dir: `C:\\Users\\me\\projects\\${id}`, gitUrl: null,
    status: "done",
    progress: { phase: "done", total: 43, scanned: 51, dirCount: 8, denied: 0, entries: 0, entryLines: 0, capped: false },
    taskId: null, error: null,
    registeredAt: "2026-10-14T09:00:00.000Z", updatedAt: "2026-10-14T09:00:03.000Z",
    finishedAt: "2026-10-14T09:00:03.000Z",
    index: { file: null, files: [], entries: 0, entryLines: 0, hasIndex: false },
  };
}

// 每个 case 一个状态：aociInit 决定后端答什么
const CASES = [
  { file: "fresh.md", id: "fresh-repo", name: "刚克隆的仓库", aociInit: false },
  { file: "inited.md", id: "inited-repo", name: "已初始化待写条目", aociInit: true },
];

const problems = [];

for (const cs of CASES) {
  const REPO = repoOf(cs.id, cs.name);
  const MOCK = `export const hana = {
    ready: async () => {},
    api: { url: (p) => p, fetch: async (p) => {
      if (p === "health") return { ok: true, json: async () => ({ ok: true, app: "repo-auto-index", version: "0.3.3" }) };
      if (p === "overview") return { ok: true, json: async () => ({ ok: true, dataDir: "X", repos: ${JSON.stringify([REPO])} }) };
      if (p.startsWith("repo/")) return { ok: true, json: async () => ({ ok: true, repo: ${JSON.stringify(REPO)}, aociInit: ${cs.aociInit}, index: { file: null, entries: 0, hasIndex: false, preview: [] } }) };
      return { ok: true, json: async () => ({ ok: true }) };
    } },
    theme: { getSnapshot: async () => ({ theme: "warm-paper", cssUrl: "./assets/theme.css" }), subscribe: () => () => {} },
    ui: { resize: () => {} }, cards: { open: async () => ({}) }, toast: { show: () => {} },
    sessions: { getActive: async () => null, onActiveChanged: () => () => {}, focus: async () => ({}) },
    logger: { info() {}, warn() {}, error() {} },
  };`;

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/assets/sdk.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(MOCK);
      return;
    }
    serveStatic(res, url, MIME);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const browser = await chromium.launch({
    executablePath: resolveChromium(),
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = collectErrors(page);
  await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // 切到「索引」页签（默认是概览）
  const tabs = await page.$$('[data-pane]');
  await page.evaluate(() => {
    // 直接把索引页显出来：离线台没有真实页签交互依赖也要核文案
    document.querySelectorAll('[data-pane]').forEach((el) => { el.hidden = el.dataset.pane !== "index"; });
  });
  await page.waitForTimeout(400);

  const guide = await page.evaluate(() => {
    const box = document.getElementById("index-guide");
    const mount = document.getElementById("index-guide-mount");
    return {
      hidden: box?.hidden,
      text: (mount?.textContent || "").replace(/\s+/g, " ").trim(),
      steps: [...document.querySelectorAll(".guide-steps li")].map((li) => li.textContent.trim()),
    };
  });

  console.log(`\n[${cs.id}] aociInit=${cs.aociInit}`);
  console.log(`  指引可见: ${!guide.hidden}`);
  console.log(`  文案: ${guide.text.slice(0, 160)}`);
  console.log(`  步骤: ${JSON.stringify(guide.steps)}`);
  console.log(`  ERRORS: ${errors.length ? JSON.stringify(errors) : "(none)"}`);

  if (guide.hidden) problems.push(`[${cs.id}] 缺索引时没有显示指路区`);

  if (cs.aociInit === false) {
    if (!/装 AOCI-CODE/.test(guide.text)) problems.push(`[${cs.id}] 没告诉用户要装 AOCI-CODE`);
    if (guide.steps.length < 3) problems.push(`[${cs.id}] 三步指引不齐（只有 ${guide.steps.length} 步）`);
    if (!/aoci init/.test(guide.text)) problems.push(`[${cs.id}] 没提 aoci init`);
  } else {
    if (/装 AOCI-CODE/.test(guide.text)) problems.push(`[${cs.id}] 已初始化的仓库不该再让用户去装 AOCI`);
    if (!/Agent/.test(guide.text)) problems.push(`[${cs.id}] 没说清条目由 Agent 写`);
  }
  // 两种处境都不许再出现旧的含糊话
  if (/可能不存在，也可能存在但读取失败/.test(guide.text)) {
    problems.push(`[${cs.id}] 仍是那句含糊的旧文案`);
  }

  await browser.close();
  server.close();
}

console.log("");
if (problems.length === 0) {
  console.log("新人指引检查通过：两种处境各自给得出正确的下一步，无含糊文案。");
  process.exit(0);
}
for (const p of problems) console.log("  - " + p);
process.exit(2);
