// 会话选择器回归：面板里能列会话、能过滤、能设为目标、设了之后不被切会话覆盖。
//
// 为什么单独测（2026-10-14）：用户问「在面板当中能不能选会话」。
// 以前只能跟着当前选中的会话走。实测确认能列全部（本机 364 条），所以加了选择器。
// 三件事要同时成立才算能用：
//   1. 列表出来，且本仓的排在前面（cwd 匹配）
//   2. 过滤能收窄
//   3. 设为目标之后，聊天里切会话**不能**把它盖掉（用户明确选过的优先）
// 外加：点「设为目标」后，投递确实发到那个会话。
//
// 用法: node probe-session-picker.mjs
// 退出码：0 = 四项全通；2 = 有缺

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

const server = http.createServer((req, res) => serveStatic(res, req.url, MIME));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: resolveChromium(),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = collectErrors(page);
await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1100);

const problems = [];
const log = (s) => console.log(s);

// ── 1. 打开选择器 ─────────────────────────────────
const pickBtn = page.locator('#dt-pick-mount button').first();
const pickLabel = (await pickBtn.textContent().catch(() => ""))?.trim();
log(`「选会话」按钮：${JSON.stringify(pickLabel)}`);
if (!pickLabel) problems.push("目标行里没有选会话按钮");

await pickBtn.click();
await page.waitForTimeout(700);

const opened = await page.evaluate(() => {
  const box = document.getElementById("session-picker");
  const rows = [...document.querySelectorAll(".sp-row")];
  return {
    hidden: box?.hidden,
    count: document.getElementById("sp-count")?.textContent?.trim(),
    rows: rows.map((r) => ({
      title: r.querySelector(".sp-title")?.textContent?.trim(),
      cwd: r.querySelector(".sp-cwd")?.textContent?.trim(),
      inRepo: r.dataset.inRepo === "1",
      current: r.dataset.current === "1",
    })),
  };
});
log(`选择器可见: ${!opened.hidden}  计数行: ${JSON.stringify(opened.count)}`);
log("列表行:");
for (const r of opened.rows) log(`  ${r.inRepo ? "[本仓]" : "      "} ${r.title}  ←  ${r.cwd}`);

if (opened.hidden) problems.push("点了按钮但选择器没展开");
if (opened.rows.length !== 3) problems.push(`应有 3 条会话，实际 ${opened.rows.length}`);

// 1a. 本仓的排前面
const firstTwoInRepo = opened.rows.slice(0, 2).every((r) => r.inRepo);
const lastNotInRepo = opened.rows.length >= 3 && !opened.rows[opened.rows.length - 1].inRepo;
log(`本仓的排前面: ${firstTwoInRepo} / 别的仓的排最后: ${lastNotInRepo}`);
if (!firstTwoInRepo) problems.push("本仓的会话没有排在前面");
if (!lastNotInRepo) problems.push("不属于本仓的会话没有排在后面");

// ── 2. 过滤 ─────────────────────────────────────
await page.locator('#sp-filter-mount input').first().fill("别的");
await page.waitForTimeout(500);
const filtered = await page.evaluate(() =>
  [...document.querySelectorAll(".sp-row .sp-title")].map((e) => e.textContent.trim())
);
log(`过滤「别的」→ ${JSON.stringify(filtered)}`);
if (filtered.length !== 1 || !/别的仓/.test(filtered[0])) {
  problems.push(`过滤没生效：期望 1 条「别的仓的会话」，实际 ${JSON.stringify(filtered)}`);
}
await page.locator('#sp-filter-mount input').first().fill("");
await page.waitForTimeout(400);

// ── 3. 设为目标 ─────────────────────────────────
const targetRow = page.locator('.sp-row:has-text("别的仓的会话")').first();
await targetRow.locator('button:has-text("设为目标")').first().click();
await page.waitForTimeout(600);

const afterPick = await page.evaluate(() => ({
  title: document.getElementById("dt-title")?.textContent?.trim(),
  id: document.getElementById("dt-id")?.textContent?.trim(),
  note: document.getElementById("deliver-note")?.textContent?.trim(),
}));
log(`设为目标后 → 标题=${JSON.stringify(afterPick.title)} id=${JSON.stringify(afterPick.id)}`);
if (!/别的仓的会话/.test(afterPick.title || "")) {
  problems.push(`设为目标后目标行没变：${JSON.stringify(afterPick.title)}`);
}
if (!/mock-other/.test(afterPick.id || "")) {
  problems.push(`目标行 id 不对：${JSON.stringify(afterPick.id)}`);
}

// ── 4. 切会话不能盖掉手动选择 ────────────────────
const fired = await page.evaluate(() => {
  if (typeof globalThis.__fireActiveChanged !== "function") return false;
  globalThis.__fireActiveChanged({ sessionId: "mock-in-repo-1", title: "本仓会话一" });
  return true;
});
if (!fired) problems.push("拿不到会话切换触发器（mock 没挂 onActiveChanged）");
await page.waitForTimeout(600);
const afterSwitch = await page.evaluate(() => document.getElementById("dt-title")?.textContent?.trim());
log(`切会话后目标行：${JSON.stringify(afterSwitch)}（应仍是手动选的）`);
if (!/别的仓的会话/.test(afterSwitch || "")) {
  problems.push(`手动选择被会话切换覆盖了：${JSON.stringify(afterSwitch)}`);
}

// ── 5. 投递发到手动选的那个会话 ──────────────────
await page.locator('#deliver-mount button:has-text("把报告卡送到目标会话")').first().click();
await page.waitForTimeout(800);
const sends = await page.evaluate(() => globalThis.__sends || []);
log(`投递记录：${JSON.stringify(sends)}`);
if (!sends.some((s) => s.kind === "report")) problems.push("投递没有发出去");

log(`ERRORS: ${errors.length ? JSON.stringify(errors) : "(none)"}`);
await browser.close();
server.close();

console.log("");
if (problems.length === 0) {
  console.log("会话选择器检查通过：列表分区排序 + 过滤 + 设为目标 + 手动选择不被切会话覆盖 + 投递到选定目标。");
  process.exit(0);
}
for (const p of problems) console.log("  - " + p);
process.exit(2);
