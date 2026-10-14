// 浏览器启动的统一入口。
//
// 为什么需要它（2026-10-14 脱敏）：
//   26 个脚本各自硬编码了一份 chromium 绝对路径，指向某台开发机的
//   %LOCALAPPDATA%\ms-playwright\ 下某个版本号目录。换机器必挂，且把开发机
//   的用户名写进了仓库。版本目录名（chromium-1243）也会随 playwright 升级漂移。
//
// 解析顺序（每一层都有理由）：
//   1. CHROME_PATH 环境变量——CI 或自定义安装位置的唯一正解。
//   2. playwright-core 自带解析——要求跑过 npx playwright install。
//   3. ms-playwright 缓存扫描——取版本号最大的那个 chromium，容忍升级漂移。
//
// 找不到就抛出带修复指令的错误，不静默回退到"猜一个路径"。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function exeNames() {
  return process.platform === "win32" ? ["chrome.exe", "headless_shell.exe"] : ["chrome", "headless_shell"];
}

function fromPlaywrightCore() {
  try {
    const pw = require("playwright-core");
    const p = pw.chromium?.executablePath?.();
    if (p && existsFile(p)) return p;
  } catch {}
  return null;
}

function fromCache() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
      : path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);

  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    // 版本号最大的优先：playwright 升级后目录名递增
    const dirs = entries
      .filter((e) => e.isDirectory() && /^chromium(_headless_shell)?-\d+$/.test(e.name))
      .map((e) => ({ name: e.name, n: Number(e.name.match(/-(\d+)$/)[1]) }))
      .sort((a, b) => b.n - a.n);

    for (const d of dirs) {
      for (const sub of ["chrome-win64", "chrome-linux", "chrome-mac", "chrome-headless-shell-win64", ""]) {
        for (const exe of exeNames()) {
          const p = path.join(root, d.name, sub, exe);
          if (existsFile(p)) return p;
        }
      }
    }
  }
  return null;
}

let cached = null;

/**
 * 解析出可用的 chromium 可执行文件绝对路径。找不到时抛错并附修复指令。
 * @returns {string}
 */
export function resolveChromium() {
  if (cached) return cached;

  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsFile(fromEnv)) {
    cached = fromEnv;
    return cached;
  }

  const fromCore = fromPlaywrightCore();
  if (fromCore) {
    cached = fromCore;
    return cached;
  }

  const fromDisk = fromCache();
  if (fromDisk) {
    cached = fromDisk;
    return cached;
  }

  throw new Error(
    [
      "找不到可用的 chromium。三选一：",
      "  1) 设 CHROME_PATH 指向已有的 chrome 可执行文件；",
      "  2) 在 tests/ 下跑 npm install，再跑 npx playwright install chromium；",
      "  3) 确认 ms-playwright 缓存目录存在（PLAYWRIGHT_BROWSERS_PATH 可覆盖）。",
    ].join("\n")
  );
}

/** 便捷启动：等价于 chromium.launch({ executablePath: resolveChromium() }) 的常用形态。 */
export async function launchChromium(chromium, opts = {}) {
  return chromium.launch({ executablePath: resolveChromium(), ...opts });
}
