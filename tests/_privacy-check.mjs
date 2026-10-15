// 脱敏机检：查仓库与安装包里有没有本机的身份痕迹。
//
// 为什么需要它（2026-10-15）：
//   这个仓库要公开发布，而它的测试数据曾经是从某个真实知识库生成的。
//   人眼扫一遍不够——App 目录里有 377 个文件，其中 sdk/ 就有 357 个。
//   发布前那次是手工查的，手工意味着"下次可能忘了查"。
//   本脚本把那次判断做成可复跑的判据。
//
// 设计上的一条硬约束：**脚本自身不得写死任何敏感词**。
//   它随公开仓库分发，若把用户名、项目名写进源码，检查器自己就成了泄漏源。
//   所以身份是**运行时从本机推导**的：当前用户名、家目录、本机所有用户目录名。
//   换一台机器跑，它查的就是那台机器的身份。要补自己的私有词表，见下方 --words。
//
// 用法：
//   node _privacy-check.mjs                # 查 App 目录（= 会进包的部分）
//   node _privacy-check.mjs --repo         # 查整个仓库
//   node _privacy-check.mjs --zip <path>   # 查一个已打好的包
//   node _privacy-check.mjs --words <file> # 追加私有词表（每行一词，# 开头为注释）
// 退出码：0 = 干净；2 = 发现命中

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require0 = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appDir = path.join(repoRoot, "repo-auto-index");

// ── 身份：从本机推导，不写死 ────────────────────────────────
function machineIdentities() {
  const ids = new Set();
  try {
    const u = os.userInfo().username;
    if (u && u.length >= 2) ids.add(u);
  } catch {}

  // 本机上真实存在的用户目录名 = 真人用户名
  const usersRoot = process.platform === "win32"
    ? path.join(process.env.SystemDrive || "C:", "Users")
    : "/home";
  try {
    for (const name of fs.readdirSync(usersRoot)) {
      // 排除系统目录与文件（如 desktop.ini）
      if (/^(Public|Default|Default User|All Users|WDAGUtilityAccount|Shared)$/i.test(name)) continue;
      if (name.includes(".")) continue;              // desktop.ini 之类
      if (name.length < 2) continue;
      // 只收目录
      try { if (!fs.statSync(path.join(usersRoot, name)).isDirectory()) continue; } catch { continue; }
      ids.add(name);
    }
  } catch {}

  return [...ids].sort();
}

// 允许出现的占位路径段：文档与样本里刻意用的假名
const PLACEHOLDER = new Set([
  "me", "you", "user", "username", "yourname", "your-name", "name", "someone",
  "example", "sample", "test", "demo", "public", "shared", "your_user", "youruser",
]);

// ── 文本/二进制判定 ────────────────────────────────────────
const TEXT_EXT = /\.(js|mjs|cjs|ts|json|html|css|md|txt|yml|yaml|ps1|sh|py|svg|map|LEGAL)$/i;

function looksText(buf) {
  const head = buf.slice(0, 8192);
  return !head.includes(0);
}

// 从 PNG 里取出「可写文本」的区域：元数据块 + 解压后的像素数据
function pngTextRegions(buf) {
  const out = [];
  if (buf.length < 8 || buf.toString("latin1", 1, 4) !== "PNG") return null;
  let off = 8;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (["tEXt", "iTXt", "zTXt"].includes(type)) {
      out.push({ where: type, text: data.toString("latin1") });
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    off += 12 + len;
  }
  // 像素数据：只取解压后 ≥6 字符的可打印串（真藏文本才会留下长串）
  if (idat.length) {
    try {
      const raw = zlib.inflateSync(Buffer.concat(idat));
      const runs = [];
      let cur = [];
      for (const b of raw) {
        if (b >= 0x20 && b < 0x7f) cur.push(b);
        else { if (cur.length >= 6) runs.push(Buffer.from(cur).toString("latin1")); cur = []; }
      }
      if (cur.length >= 6) runs.push(Buffer.from(cur).toString("latin1"));
      for (const r of runs) out.push({ where: "IDAT", text: r });
    } catch { /* 解压失败就不看像素 */ }
  }
  return out;
}

// ── 扫描 ──────────────────────────────────────────────────
function walk(root) {
  const out = [];
  (function rec(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p); else out.push(p);
    }
  })(root);
  return out;
}

// 只列「会被提交的文件」：跟踪中的 + 未跟踪但未被忽略的。
// 仓库模式下用这个，避免把 gitignore 的临时产物（测试截图、本地脚本）算进来，
// 那些本来就不会随仓库分发。
function gitVisibleFiles(root) {
  const { execFileSync } = require0("node:child_process");
  const run = (a) => {
    try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); }
    catch { return null; }
  };
  const tracked = run(["ls-files"]);
  if (tracked === null) return null;              // 不是 git 仓库，回退到遍历
  const untracked = run(["ls-files", "--others", "--exclude-standard"]) || [];
  return [...new Set([...tracked, ...untracked])].map((r) => path.join(root, r));
}

const args = process.argv.slice(2);
const wantRepo = args.includes("--repo");
const zipIdx = args.indexOf("--zip");
const wordsIdx = args.indexOf("--words");

// 私有词表：只在本机存在，不入库
let extraWords = [];
if (wordsIdx >= 0 && args[wordsIdx + 1]) {
  try {
    extraWords = fs.readFileSync(args[wordsIdx + 1], "utf8")
      .split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
  } catch (e) { console.error(`读不到词表：${e.message}`); process.exit(1); }
}

// 解包目标
let scanRoot, cleanup = null;
if (zipIdx >= 0 && args[zipIdx + 1]) {
  const zip = path.resolve(args[zipIdx + 1]);
  if (!fs.existsSync(zip)) { console.error(`找不到包：${zip}`); process.exit(1); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-scan-"));
  const { execFileSync } = await import("node:child_process");
  execFileSync("tar", ["-xf", zip, "-C", tmp]);
  scanRoot = tmp;
  cleanup = tmp;
} else {
  scanRoot = wantRepo ? repoRoot : appDir;
}

const ids = machineIdentities();
console.log("=== 脱敏机检 ===");
console.log(`  扫描目标: ${scanRoot === repoRoot ? "整个仓库" : scanRoot === appDir ? "App 目录（会进包的部分）" : scanRoot}`);
console.log(`  本机身份词（运行时推导）: ${ids.join(", ")}`);
if (extraWords.length) console.log(`  私有词表: ${extraWords.length} 个词`);
console.log("");

const files = wantRepo ? (gitVisibleFiles(repoRoot) || walk(repoRoot)) : walk(scanRoot);
console.log(`扫描 ${files.length} 个文件`);
const hits = [];      // 真命中
const notes = [];     // 假阳性说明（分类后不计入）

for (const f of files) {
  const rel = path.relative(scanRoot, f).replace(/\\/g, "/");
  let buf;
  try { buf = fs.readFileSync(f); } catch { continue; }

  // 收集「该文件里算数的那部分文本」
  let haystacks = [];
  const png = /\.png$/i.test(rel) ? pngTextRegions(buf) : null;

  if (png) {
    haystacks = png.map((r) => ({ text: r.text, where: r.where }));
  } else if (TEXT_EXT.test(rel) || looksText(buf)) {
    haystacks = [{ text: buf.toString("utf8"), where: "text" }];
  } else {
    // 其它二进制：只看长可打印串
    const runs = [];
    let cur = [];
    for (const b of buf) {
      if (b >= 0x20 && b < 0x7f) cur.push(b);
      else { if (cur.length >= 6) runs.push(Buffer.from(cur).toString("latin1")); cur = []; }
    }
    haystacks = runs.map((r) => ({ text: r, where: "binary-string" }));
  }

  for (const { text, where } of haystacks) {
    for (const id of ids) {
      // 身份词按「词边界」匹配，避免短词撞进随机串
      const re = new RegExp(`(^|[^A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "g");
      let m;
      while ((m = re.exec(text))) {
        const ctx = text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/[\r\n]+/g, " ");
        hits.push({ rel, id, where, ctx });
        if (hits.length > 200) break;
      }
    }
    // 私有词表：同样按词边界
    for (const w of extraWords) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "g");
      let m;
      while ((m = re.exec(text))) {
        const ctx = text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/[\r\n]+/g, " ");
        hits.push({ rel, id: w, where, ctx });
        if (hits.length > 200) break;
      }
    }

    // 通用判据：C:\Users\<非占位名> 形态
    const pathRe = /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)/g;
    let pm;
    while ((pm = pathRe.exec(text))) {
      const seg = pm[1];
      if (PLACEHOLDER.has(seg.toLowerCase())) {
        notes.push(`${rel}  ${pm[0]}  → 占位名（合法）`);
      } else {
        hits.push({ rel, id: seg, where, ctx: text.slice(Math.max(0, pm.index - 40), pm.index + 80).replace(/[\r\n]+/g, " ") });
      }
    }
  }
}

if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });

// ── 报告 ──────────────────────────────────────────────────
if (notes.length) {
  const uniq = [...new Set(notes)];
  console.log(`\n占位名（不计入）：${uniq.length} 处`);
  for (const n of uniq.slice(0, 5)) console.log(`  ${n}`);
}

if (hits.length) {
  console.log(`\n发现 ${hits.length} 处命中：\n`);
  const byFile = new Map();
  for (const h of hits) {
    const a = byFile.get(h.rel) || [];
    a.push(h);
    byFile.set(h.rel, a);
  }
  for (const [rel, list] of byFile) {
    console.log(`  ${rel}  (${list.length})`);
    for (const h of list.slice(0, 3)) {
      console.log(`      [${h.id}] @${h.where}: …${h.ctx.slice(0, 140)}…`);
    }
  }
  console.log(`\n[FAIL] ${hits.length} 处命中，需处理。`);
  process.exit(2);
}

console.log("\n[PASS] 未发现本机身份痕迹。");
process.exit(0);
