// 脱敏机检的反证：造含痕迹的样本，确认 _privacy-check.mjs 真会报红。
//
// 为什么要有它：一个从不报红的检查器等于没有检查器。这条在本仓库有先例——
// _bleed-check.mjs 的反证（把徽标改回右上位，看它在 420/520/620/720 报红、
// 900px 报干净）写在 README 里，同样是为了证明检查器有效而非摆设。
//
// 用法：node _privacy-check-negative.mjs
// 退出码：0 = 5/5 全抓到；2 = 有漏网（检查器需加强）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..", "repo-auto-index");
const PROBE = path.join(appDir, "__neg_probe__");

// 造一张带 tEXt 块的最小 PNG（1×1 灰度）。用来验证元数据块里的文本会被查到。
function pngWithText(text) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const body = Buffer.concat([t, data]);
    let c = ~0;
    for (const b of body) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 0;
  const tEXt = Buffer.concat([Buffer.from("Comment\0", "latin1"), Buffer.from(text, "latin1")]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("tEXt", tEXt), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

// 身份词不写死：取当前用户名拼样本，这样脚本本身不含敏感词
const ME = (() => { try { return os.userInfo().username; } catch { return "probeuser"; } })();

const cases = [
  { name: "文本里写死真实路径", file: "leak-path.json", content: JSON.stringify({ dir: `C:\\Users\\${ME}\\Documents\\Somewhere` }, null, 2) },
  { name: "身份词出现在真串里", file: "leak-name.js", content: `const author = "${ME}";\nconst home = "C:/Users/${ME}";\n` },
  { name: "注释里提到身份", file: "leak-comment.md", content: `# 说明\n\n这份索引来自 ${ME} 的知识库。\n` },
  { name: "二进制里的可打印串", file: "leak.bin", content: Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(`C:\\Users\\${ME}\\secret.txt`, "latin1"), Buffer.from([0, 255, 254])]) },
  { name: "PNG 元数据块藏文本", file: "leak.png", content: pngWithText(`Author: ${ME}  home: C:\\Users\\${ME}`) },
];

fs.rmSync(PROBE, { recursive: true, force: true });
fs.mkdirSync(PROBE, { recursive: true });

console.log("=== 脱敏机检的反证 ===");
console.log(`  样本身份词取自本机当前用户（不写死）\n`);

let caught = 0;
try {
  for (const c of cases) {
    for (const f of fs.readdirSync(PROBE)) fs.rmSync(path.join(PROBE, f), { force: true });
    fs.writeFileSync(path.join(PROBE, c.file), c.content);

    const r = spawnSync(process.execPath, [path.join(here, "_privacy-check.mjs")], { cwd: here, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const hit = out.includes("[FAIL]");
    if (hit) caught++;
    console.log(`  ${hit ? "✓ 抓到" : "✗ 漏掉"}  ${c.name}（exit ${r.status}）`);
  }
} finally {
  fs.rmSync(PROBE, { recursive: true, force: true });
}

console.log(`\n${caught}/${cases.length} 例被抓到`);
if (caught !== cases.length) {
  console.log("[FAIL] 有漏网，_privacy-check.mjs 需要加强。");
  process.exit(2);
}
console.log("[PASS] 检查器有效：每类痕迹都会报红。");
process.exit(0);
