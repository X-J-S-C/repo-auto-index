// 版本显示一致性：卡片显示的版本必须来自后端，不能是手写常量。
//
// 为什么要有这个检查（2026-10-14）：
//   面板顶栏曾写死 const BUILD = "v0.2 · …" 当构建标识，注释还写着「每次实质改动
//   后更新此值」。但靠人记得更新就是靠不住：改了四次从没同步，于是装着 0.3.2 时
//   它还说 v0.2。**本来是防「版本不可辨」的东西，自己成了误导源**——比没有更糟，
//   因为没有的时候用户会去别处找证据，有假证据时他会信它。
//
//   现在版本从后端 /health 取（后端从 manifest.json 读，那是打包时唯一的版本真相）。
//   本脚本守两件事：
//     1. 前端源码里不得再出现手写的版本字符串常量；
//     2. 卡片渲染出的版本必须等于后端 /health 答的版本。
//
// 用法: node _version-check.mjs
// 退出码：0 = 一致；2 = 有手写常量或渲染版本与后端不符

import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "./_resolve.mjs";
import { collectErrors } from "./_errors.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, "..", "repo-auto-index", "ui");

const problems = [];

// ── 判据 1：源码里不得有手写版本常量 ──────────────────────
// 找形如 const BUILD = "v0.2 · 2026-10-13 21:50" 或
// const BUILD = "report v0.1 · …" 这类**带版本号**的字符串字面量。
// 允许注释里提到 BUILD（说明历史），允许 "版本未知" / "v${...}" 这类模板。
const HARDCODED = /const\s+BUILD\s*=\s*["'][^"']*\d+\.\d+/;
const files = fs.readdirSync(path.join(uiDir, "assets")).filter((f) => f.endsWith(".js"));
for (const f of files) {
  const src = fs.readFileSync(path.join(uiDir, "assets", f), "utf8");
  // 去掉行注释再查，免得注释里的历史说明被当成违规
  const code = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  if (HARDCODED.test(code)) {
    problems.push(`${f} 仍写着带版本号的手写常量 const BUILD = "…"（应改从后端取）`);
  }
}
console.log(`前端脚本 ${files.length} 个，扫手写版本常量：${problems.length ? "有" : "无"}`);

// ── 判据 2：渲染出的版本必须等于后端版本 ──────────────────
// 离线台喂一个已知版本，看页面显示的是不是它。
const FAKE_VERSION = "9.9.9-check";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const MOCK_SDK = `export const hana = {
  ready: async () => {},
  api: { url: (p) => p, fetch: async (p) => {
    if (p === "health") return { ok: true, json: async () => ({ ok: true, app: "repo-auto-index", version: "${FAKE_VERSION}" }) };
    if (p === "overview") return { ok: true, json: async () => ({ ok: true, dataDir: "X", repos: [] }) };
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
    res.end(MOCK_SDK);
    return;
  }
  const file = serveStatic(res, url, MIME);
  return file;
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = collectErrors(page);
await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const stamp = await page.evaluate(() => document.getElementById("ov-stamp")?.textContent?.trim());
console.log(`面板顶栏显示：${JSON.stringify(stamp)}（后端答 ${FAKE_VERSION}）`);
if (!stamp || !stamp.includes(FAKE_VERSION)) {
  problems.push(`面板顶栏没显示后端版本：显示 ${JSON.stringify(stamp)}，应为含 ${FAKE_VERSION} 的值`);
}
if (/v0\.2|v0\.1/.test(stamp || "")) {
  problems.push(`面板顶栏还挂着旧的硬编码版本：${stamp}`);
}

console.log("ERRORS:", errors.length ? errors : "(none)");
await browser.close();
server.close();

console.log("");
if (problems.length === 0) {
  console.log("版本显示检查通过：前端无手写版本常量，卡片显示的版本来自后端。");
  process.exit(0);
}
for (const p of problems) console.log("  - " + p);
process.exit(2);
