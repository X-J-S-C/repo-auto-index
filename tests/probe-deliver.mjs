// 交付区块交互探测：验证「把报告卡送到当前对话」与「预览报告卡」两条入口的
// 全部兜底路径都给出明确提示（不静默）。本文件是离线台新增物，不进插件包。
//
// 手法：静态台照常 serve 渲染台目录；只对 /assets/sdk.js 这个响应做内存改写，
// 按场景注入 hana.sessions / hana.cards 桩（不落盘、不改任何已有文件）。
// 用法: node probe-deliver.mjs
import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { serveStatic } from "./_resolve.mjs";

const root = path.resolve(process.cwd());
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png"};
const realSdk = fs.readFileSync(path.join(root, "assets", "sdk.js"), "utf8");

// 场景：每项给出一段追加到 mock sdk.js 末尾的代码，以及 page.route 拦截表。
const SCENARIOS = {
  "S1 无 sessions API": { inject: "", routes: {} },
  "S2 getActive 抛 SURFACE_UNSUPPORTED": {
    inject: `hana.sessions = { getActive: async () => { const e = new Error("APP_SESSION_SURFACE_UNSUPPORTED"); e.code = "APP_SESSION_SURFACE_UNSUPPORTED"; throw e; } };`,
    routes: {},
  },
  "S3 getActive 返回 null": {
    inject: `hana.sessions = { getActive: async () => null };`,
    routes: {},
  },
  "S4 取到会话 + 后端 404": {
    inject: `hana.sessions = { getActive: async () => ({ sessionId: "sess_demo_123456", sessionPath: "/p", title: "t", agentId: "a" }) };
      (() => { const o = hana.api.fetch; hana.api.fetch = async (p, init) => String(p).includes("report/send") ? { ok: false, status: 404, json: async () => ({ ok: false, error: "not found" }), text: async () => "" } : o(p, init); })();`,
    routes: {},
  },
  "S5 取到会话 + 投递成功": {
    inject: `hana.sessions = { getActive: async () => ({ sessionId: "sess_demo_123456", sessionPath: "/p", title: "t", agentId: "a" }) };
      (() => { const o = hana.api.fetch; hana.api.fetch = async (p, init) => String(p).includes("report/send") ? { ok: true, status: 200, json: async () => ({ ok: true, entryId: "entry_demo_987654" }), text: async () => "" } : o(p, init); })();`,
    routes: {},
  },
  "S6 预览报告卡成功": {
    inject: `hana.cards = { open: async (id) => ({ cardInstanceId: "card_demo", existing: false, detached: false, asked: id }) };`,
    routes: {},
  },
  "S7 预览报告卡无 API": { inject: "", routes: {} },
};

let inject = "";
let routes = {};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/assets/sdk.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(inject ? `${realSdk}\n${inject}\n` : realSdk);
    return;
  }
  serveStatic(res, req.url, MIME);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const b = await chromium.launch({ executablePath: resolveChromium() });

const clickByText = (page, hostId, text) => page.evaluate(({ hostId, text }) => {
  const btns = [...document.querySelectorAll(`#${hostId} button`)];
  const hit = btns.find((n) => (n.textContent || "").trim() === text);
  if (!hit) return false;
  hit.click();
  return true;
}, { hostId, text });

const results = [];
for (const [name, sc] of Object.entries(SCENARIOS)) {
  inject = sc.inject; routes = sc.routes;
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  for (const [glob, fn] of Object.entries(routes)) await page.route(glob, fn);

  await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  // 等交付区块两个按钮出现
  const ready = await page.waitForSelector("#deliver-mount button", { timeout: 4000 }).then(() => true).catch(() => false);

  let note = "";
  if (ready) {
    if (/S6|S7/.test(name)) await clickByText(page, "deliver-mount", "预览报告卡");
    else await clickByText(page, "deliver-mount", "把报告卡送到当前对话");
    await page.waitForTimeout(600);
    note = await page.evaluate(() => document.getElementById("deliver-note")?.textContent || "");
  }
  results.push({ name, buttonsReady: ready, note, errors: errs });
  await page.close();
}

for (const r of results) {
  console.log(`\n=== ${r.name} ===`);
  console.log("  buttonsReady:", r.buttonsReady);
  console.log("  deliver-note:", r.note || "(空)");
  console.log("  errors:", r.errors.length ? r.errors : "(none)");
}
await b.close(); server.close();
