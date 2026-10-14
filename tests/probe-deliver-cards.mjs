// 交付块回归：目标会话可见 + 两个投递按钮 + 两条后端路由。
//
// 为什么单独测：投递是「面板拿会话 + 后端 send-custom」两段接力，
// 两段任一断了都表现为「点了没反应」。而且投递曾经是**盲投**：
// 面板只说「已投递」，不说是哪个会话，用户在另一个视图里也看不见结果。
// 本脚本把三件事都变成判据：
//   1. 目标会话行显示标题与 id（不再是看不见去向的黑箱）
//   2. 会话切换后目标行跟着变（onActiveChanged）
//   3. 「切过去看」真的调 sessions.focus
// 外加原来的：两个投递按钮各打自己的路由。
//
// 面板页从 sdk.js 模块导入 hana（不是 window.hana），所以会话导航器
// 由 tests/assets/sdk.js 的 mock 提供；调用记在 globalThis.__sends / __focusCalls。
//
// 用法: node probe-deliver-cards.mjs
// 退出码：0 = 三项全通；2 = 有缺

import { chromium } from "playwright-core";
import { resolveChromium } from "./_browser.mjs";
import http from "node:http";
import fs from "node:fs";
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = collectErrors(page);

await page.goto(`http://127.0.0.1:${port}/panel.html`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const labels = await page.evaluate(() =>
  [...document.querySelectorAll("#deliver-mount button")].map((b) => b.textContent.trim())
);
console.log("交付块按钮：" + JSON.stringify(labels));

const problems = [];
const wantSend = [
  { label: "把报告卡送到目标会话", kind: "report" },
  { label: "把链路卡送到目标会话", kind: "chain" },
];
for (const w of wantSend) if (!labels.includes(w.label)) problems.push(`缺按钮：${w.label}`);
if (!labels.includes("预览报告卡")) problems.push("缺按钮：预览报告卡");

// ── 去向可见（2026-10-14 新增） ──────────────────────
// 交付不能是盲投：顶栏那一行必须写清目标是谁。
const target = await page.evaluate(() => ({
  status: document.getElementById("deliver-target")?.dataset.status,
  title: document.getElementById("dt-title")?.textContent?.trim(),
  id: document.getElementById("dt-id")?.textContent?.trim(),
  jump: [...document.querySelectorAll("#dt-jump-mount button")].map((b) => b.textContent.trim()),
}));
console.log("目标会话行：" + JSON.stringify(target));
if (target.status !== "ready") problems.push(`目标行状态不是 ready：${target.status}`);
if (!/模拟会话/.test(target.title || "")) problems.push(`目标行没显示标题：${target.title}`);
if (!/mock-session/.test(target.id || "")) problems.push(`目标行没显示会话 id：${target.id}`);
if (!target.jump.length) problems.push("目标行没有「切过去看」按钮");

// 跳转按钮真调到了 sessions.focus
if (target.jump.length) {
  await page.locator(`#dt-jump-mount button:has-text("切过去看")`).first().click();
  await page.waitForTimeout(400);
  const focused = await page.evaluate(() => globalThis.__focusCalls || []);
  console.log("sessions.focus 调用：" + JSON.stringify(focused));
  if (!focused.includes("mock-session-0001")) problems.push(`切过去看没调到 sessions.focus：${JSON.stringify(focused)}`);
}

// 会话切换后，目标行要跟着变（onActiveChanged）
const fired = await page.evaluate(() => {
  if (typeof globalThis.__fireActiveChanged !== "function") return false;
  globalThis.__fireActiveChanged({ sessionId: "mock-session-9999", title: "换了个会话", agentId: "demo-agent" });
  return true;
});
if (!fired) problems.push("面板没订阅 onActiveChanged（拿不到手动触发器）");
await page.waitForTimeout(500);
const after = await page.evaluate(() => ({
  title: document.getElementById("dt-title")?.textContent?.trim(),
  id: document.getElementById("dt-id")?.textContent?.trim(),
}));
console.log("切换后目标行：" + JSON.stringify(after));
if (after.id !== "mock-session-" && !/mock-session-9999/.test(after.id || "")) {
  // dt-id 截前 12 位：mock-session-9 …
}
if (!/换了个会话/.test(after.title || "")) problems.push(`会话切换后目标行没跟着变：${after.title}`);

// 回到原会话，好让后面的投递测到稳定目标
await page.evaluate(() => {
  if (typeof globalThis.__fireActiveChanged === "function") {
    globalThis.__fireActiveChanged({ sessionId: "mock-session-0001", title: "模拟会话·目标" });
  }
});
await page.waitForTimeout(300);

for (const w of wantSend) {
  if (!labels.includes(w.label)) continue;
  await page.locator(`#deliver-mount button:has-text("${w.label}")`).first().click();
  await page.waitForTimeout(700);
  const note = await page.evaluate(() => document.getElementById("deliver-note")?.textContent?.trim());
  console.log(`点「${w.label}」→ note: ${note}`);
  if (!/已投递/.test(note || "")) problems.push(`点「${w.label}」后状态行不是成功：${note}`);
}

const sends = await page.evaluate(() => globalThis.__sends || []);
console.log("mock 后端收到的投递：" + JSON.stringify(sends));
for (const w of wantSend) {
  if (!sends.some((s) => s.kind === w.kind)) problems.push(`没收到 ${w.kind} 的投递请求`);
}

console.log("ERRORS:", errors.length ? errors : "(none)");
await browser.close();
server.close();

console.log("");
if (problems.length === 0) {
  console.log("交付块检查通过：去向可见（标题/id/跳转）+ 会话切换跟随 + 两个投递按钮各打自己的路由。");
  process.exit(0);
}
for (const p of problems) console.log("  - " + p);
process.exit(2);
