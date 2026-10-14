import { defineApp } from "./sdk/app-contract/server-client.js";
import fs from "node:fs/promises";
import path from "node:path";

export const name = "repo-auto-index";

/**
 * 仓库自动索引 — 一仓一索引，可打断，可视化一等公民。
 *
 * 设计（照场记板的路子）：
 * 1. 状态活在纯文件里：dataDir/projects.json + 每仓一段 task 进度。
 *    宿主升级不影响，人和 Agent 都能直接读、直接备份。
 * 2. 只追加、不编造：插件自己只做结构扫描（文件清点 + 现有 aoci.txt 清点），
 *    语义条目（F/R/A/S）永远由 Agent 经 AOCI 链路创作，插件只跟踪进度、
 *    只做隔离展示，绝不替模型写认知。
 * 3. 可打断：每次扫描都建一个 App task，面板上有显眼的打断按钮，
 *    扫描循环每批检查取消旗，停了就是停了，状态落盘为 canceled。
 * 4. 一仓一索引：每个仓库的索引就是它目录下的 .aoci/ + aoci.txt，
 *    插件不建大库、不跨仓混检。删仓即删注册，不碰源目录。
 *
 * 已知边界（v0.1）：
 * - 克隆由 Agent/宿主执行（git 在宿主侧），插件只登记已存在的目录。
 *   传 gitUrl 且目录不存在时，返回一句可复制的克隆指令，不假装自己克隆了。
 * - 语义索引（调模型写条目）走现有 aoci / aoci-cua 连接器，插件不私自调模型。
 */

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", "coverage",
  "tmp", "uploads", "backup", "backups", "artifacts", ".output",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".tox", ".nox", "htmlcov", ".aoci",
]);
const SCAN_FILE_CAP = 20000;
const PROGRESS_EVERY = 200;

const cancelled = new Map();

function asText(text) {
  return { content: [{ type: "text", text }] };
}

// ── 流内报告卡 ──────────────────────────────────────────────
// 工具 execute 返回 { content, details: { card } } 后，宿主自动把它包装成 iframe 卡
// 落进对话（Xon 判定 details.card → Z_t 盖 pluginId/cardInstanceId → bCr 签来源证明，
// 见 ui/CARD-DOCTRINE.md §2.1）。卡字面量的字段白名单见 §2.2：cardType 必须
// "iframe"/"webview"，route 非空且以 "/" 开头，aspectRatio 是数字不是字符串。
// route 指向本 App 的 ui/report.html；卡片自取数据（宿主不传触发消息的 payload，§2.4），
// 所以这里只声明「卡是什么」，不复述某一次扫描的具体数字。description 模型侧可见
// （宿主会 append 进可见文本），所以写清它的语义价值，而不是重复 content。
const REPORT_CARD = Object.freeze({
  cardType: "iframe",
  route: "/report.html",
  title: "扫描报告",
  description:
    "扫描报告卡：状态、文件数、索引条目数、读不到的目录数、上次扫描时间都在卡上，点开即可核对；卡上有重扫入口，批量操作可转到面板。",
  aspectRatio: 1.6,
});

// 链路卡：一次体检 = 一张能递出去的卡。
// 与 REPORT_CARD 同一形状（CARD-DOCTRINE §2.2 白名单），只换 route 与标题。
// 卡片自取数据（§2.4），所以这里只声明「卡是什么」。
const CHAIN_CARD = Object.freeze({
  cardType: "iframe",
  route: "/chain.html",
  title: "链路体检",
  description:
    "索引链路体检卡：六环（初始化/清点/基线/索引/核对/检索）逐环列出状态、证据与来源文件，可溯源到 .aoci 下哪一个文件；缺环时直接给修复步骤。只读，本 App 不产索引。",
  aspectRatio: 1.5,
});

// 给工具的成功返回附上一张报告卡。文字 content 保留（模型仍然读它），卡片走
// details.card，由宿主包装。每个调用展开一层，避免共享同一对象引用。
function withReportCard(text) {
  return {
    content: [{ type: "text", text }],
    details: { card: { ...REPORT_CARD } },
  };
}

function withChainCard(text) {
  return {
    content: [{ type: "text", text }],
    details: { card: { ...CHAIN_CARD } },
  };
}

function bufLikeToText(v) {
  try {
    if (typeof v === "string") return v;
    if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) return Buffer.from(v).toString("utf8");
    if (v && typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (typeof v.content === "string") return v.content;
      if (v.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data).toString("utf8");
      if (Array.isArray(v.data) && v.data.every((x) => typeof x === "number")) {
        return Buffer.from(v.data).toString("utf8");
      }
      if (typeof v.data === "string" && v.data.length) {
        try { return Buffer.from(v.data, "base64").toString("utf8"); } catch {}
      }
    }
  } catch {}
  return null;
}

function toText(res) {
  if (res == null) return null;
  if (typeof res === "string") return res;
  if (res instanceof Uint8Array) return Buffer.from(res).toString("utf8");
  if (res && typeof res === "object") {
    for (const k of ["content", "text", "data", "body"]) {
      const t = bufLikeToText(res[k]);
      if (typeof t === "string" && t.length) return t;
    }
    const t = bufLikeToText(res);
    if (typeof t === "string" && t.length) return t;
  }
  return null;
}

function slugOf(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[\\/:\s]+/g, "-")
    .replace(/[^a-z0-9\-_.\u4e00-\u9fff]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "repo";
}

function normPath(p) {
  return String(p || "").replace(/\\/g, "/");
}

function localRef(abs) {
  return { kind: "local-file", path: normPath(abs) };
}

function findRepo(repos, ref) {
  if (!ref) return null;
  return (
    repos.find((r) => r.id === ref) ||
    repos.find((r) => r.dir === ref) ||
    repos.find((r) => normPath(r.dir) === normPath(ref)) ||
    repos.find((r) => r.name === ref) ||
    null
  );
}

function asList(res) {
  if (res == null) return null;
  if (Array.isArray(res)) return res;
  if (typeof res !== "object") return null;
  for (const k of ["entries", "items", "files", "children", "results"]) {
    if (Array.isArray(res[k])) return res[k];
  }
  return null;
}

function entryName(e) {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    for (const k of ["name", "path", "file", "title"]) {
      if (typeof e[k] === "string") return e[k].split("/").pop();
    }
  }
  return "";
}

function entryIsDir(e) {
  if (e && typeof e === "object") {
    for (const k of ["isDirectory", "isDir", "directory", "dir"]) {
      if (typeof e[k] === "boolean") return e[k];
    }
    if (typeof e.type === "string") {
      if (/dir/i.test(e.type)) return true;
      if (/file/i.test(e.type)) return false;
    }
  }
  const n = entryName(e);
  return n !== "" && !n.includes(".");
}

// ===== GRAPH-PARSE-BEGIN =====
// 关系图解析（A 路 · 只读）。唯一实现，对齐 ui/GRAPH-CONTRACT.md §1 与离线参考
// build-contract.mjs。纯函数：只吃「索引正文」，不碰 sdk / fs，便于离线自证。
// 三个坑（契约 §0）：
//   1) 基准路径不能猜，按候选试算取完整路径命中率最高者；
//   2) TAG 是 4 位（A层+B模块+C重要度+E规模），正则用 [A-Z0-9]{4,5}；
//   3) 字段切分不能用 split(' | ')，S 正文可能含 |，用 /(?:^|\s\|\s)([FRAS]):\s*/g 逐段定位。
function parseGraphEntries(text) {
  const entries = [];
  if (!text) return entries;
  let dir = "";
  for (const l0 of String(text).split(/\r?\n/)) {
    const l = l0.replace(/^\uFEFF/, "");
    if (!l.trim()) continue;
    const seg = l.match(/^=+(.+?)=+$/);
    if (seg) { dir = seg[1].replace(/\\/g, "/").replace(/\/+$/, ""); continue; }
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/^(.+?)\[([A-Z0-9]{4,5})\]:\s*(.*)$/);
    if (!m) continue;
    const body = m[3];
    const re = /(?:^|\s\|\s)([FRAS]):\s*/g;
    const marks = []; let mm;
    while ((mm = re.exec(body))) marks.push({ k: mm[1], s: re.lastIndex, at: mm.index });
    const f = {};
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].at : body.length;
      f[marks[i].k] = body.slice(marks[i].s, end).trim();
    }
    entries.push({
      name: m[1].trim(), dir, tag: m[2],
      layer: m[2][0], module: m[2][1], importance: m[2][2], scale: m[2][3],
      F: f.F || "", R: f.R || "", A: f.A || "", S: f.S || "",
    });
  }
  return entries;
}

function buildGraph(text, meta = {}) {
  const entries = parseGraphEntries(text);

  // 基准 root：候选 = [公共前缀, 公共前缀的父目录, 各 dir 前 5 个]，取命中率最高者。
  const dirs = [...new Set(entries.map((e) => e.dir))];
  let common = dirs[0] || "";
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const scoreRoot = (root) => {
    const set = new Set(entries.map((e) => e.dir + "/" + e.name));
    let hit = 0, tot = 0;
    for (const e of entries) {
      if (!e.R || e.R === "-") continue;
      for (const t of e.R.split(",")) {
        const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
        if (!v) continue;
        tot++;
        if (set.has(root + "/" + v)) hit++;
      }
    }
    return tot ? hit / tot : 0;
  };
  const rootCandidates = [common, common.replace(/[^/]*$/, "").replace(/\/+$/, ""), ...dirs.slice(0, 5)];
  let root = common, best = -1;
  for (const c of [...new Set(rootCandidates)]) {
    const s = scoreRoot(c);
    if (s > best) { best = s; root = c; }
  }

  // 仓内相对路径 = 稳定 id（边只引用 id）。
  for (const e of entries) {
    e.rel = (e.dir.slice(root.length).replace(/^\/+/, "") + "/" + e.name).replace(/^\/+/, "");
    e.id = e.rel;
    e.path = e.dir + "/" + e.name;
  }
  const byRel = new Map(entries.map((e) => [e.rel, e]));
  const byName = new Map();
  for (const e of entries) { const a = byName.get(e.name) || []; a.push(e); byName.set(e.name, a); }

  // 边：root+v 完整路径 → path；否则文件名唯一 → name；多候选 → name-ambiguous；全不中 → unresolved。
  const edges = [];
  const unresolved = [];
  for (const e of entries) {
    if (!e.R || e.R === "-") continue;
    for (const t of e.R.split(",")) {
      const v = t.trim().replace(/^(code|database):/, "").replace(/\\/g, "/");
      if (!v) continue;
      let to = null, how = null;
      if (byRel.has(v)) { to = byRel.get(v); how = "path"; }
      else {
        const cands = byName.get(v.split("/").pop()) || [];
        if (cands.length === 1) { to = cands[0]; how = "name"; }
        else if (cands.length > 1) { to = cands[0]; how = "name-ambiguous"; }
      }
      if (to) edges.push({ from: e.id, to: to.id, how });
      else unresolved.push(v);
    }
  }

  // 度数由后端算好，前端不重算。
  const inDeg = new Map(), outDeg = new Map();
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
  }
  const isolated = entries.filter((e) => !inDeg.has(e.id) && !outDeg.has(e.id));

  const nodes = entries.map((e) => ({
    id: e.id,
    name: e.name,
    dir: e.dir.slice(root.length) || "/",
    layer: e.layer,
    module: e.module,
    importance: Number(e.importance) || 0,
    scale: e.scale,
    F: e.F,
    R: e.R,
    A: e.A,
    S: e.S,
    inDeg: inDeg.get(e.id) || 0,
    outDeg: outDeg.get(e.id) || 0,
  }));

  return {
    repo: meta.repo || null,
    volume: meta.volume || "aoci.code.txt",
    root,
    generatedAt: new Date().toISOString(),
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      unresolved: unresolved.length,
      isolated: isolated.length,
      byLayer: Object.entries(nodes.reduce((a, n) => (a[n.layer] = (a[n.layer] || 0) + 1, a), {})),
      byModule: Object.entries(nodes.reduce((a, n) => (a[n.module] = (a[n.module] || 0) + 1, a), {})),
      resolution: {
        path: edges.filter((e) => e.how === "path").length,
        name: edges.filter((e) => e.how === "name").length,
        ambiguous: edges.filter((e) => e.how === "name-ambiguous").length,
      },
    },
    nodes,
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    unresolved,
  };
}
// ===== GRAPH-PARSE-END =====

export default defineApp(async (sdk) => {
  const dataDir = sdk.dataDir;
  const reposPath = path.join(dataDir, "projects.json");

  async function ensureDataDir() {
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      await sdk.logger.warn(`repo-auto-index：dataDir 无法创建（${err?.message || err}）`);
    }
  }

  async function readRepos() {
    try {
      const raw = await fs.readFile(reposPath, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data?.repos) ? data.repos : [];
    } catch {
      return [];
    }
  }

  async function writeRepos(repos) {
    await ensureDataDir();
    const tmp = `${reposPath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, "utf8");
    await fs.rename(tmp, reposPath);
  }

  async function patchRepo(id, patch) {
    const repos = await readRepos();
    const next = repos.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r));
    await writeRepos(next);
    return next.find((r) => r.id === id) || null;
  }

  async function dirExists(dir) {
    try {
      const res = await sdk.resources.stat(localRef(dir));
      return true;
    } catch (err) {
      const code = String(err?.code || err?.name || "");
      if (/ENOENT|NOT_FOUND|NO_SUCH/i.test(code)) return false;
      return null;
    }
  }

  function tracePath(repoId) {
    return path.join(dataDir, "traces", `${repoId}.jsonl`);
  }

  async function trace(repoId, obj) {
    try {
      await fs.mkdir(path.join(dataDir, "traces"), { recursive: true });
      await fs.appendFile(tracePath(repoId), `${JSON.stringify({ at: new Date().toISOString(), ...obj })}\n`, "utf8");
    } catch {}
  }

  async function listDir(abs) {
    try {
      const res = await sdk.resources.list(localRef(abs));
      const list = asList(res);
      return { items: Array.isArray(list) ? list : [], error: null };
    } catch (err) {
      const msg = `${err?.code || err?.name || "error"}: ${err?.message || err}`;
      await sdk.logger.warn(`repo-auto-index：list 失败 ${abs}（${msg}）`);
      return { items: [], error: msg };
    }
  }

  async function listDirRaw(abs) {
    const res = await sdk.resources.list(localRef(abs));
    return res;
  }

  async function readOneFile(abs) {
    try {
      const res = await sdk.resources.read(localRef(abs));
      const text = toText(res);
      if (typeof text === "string" && text.length) return text;
    } catch (err) {
      await sdk.logger.warn(`repo-auto-index：读文件失败 ${abs}（${err?.message || err}）`);
    }
    return null;
  }

  async function readIndexFile(dir) {
    const base = normPath(dir).replace(/\/+$/, "");
    const parts = [];
    const files = [];
    for (const name of ["aoci.code.txt", "aoci.meta.txt", "aoci.txt"]) {
      const text = await readOneFile(`${base}/${name}`);
      if (text != null) {
        parts.push(text);
        files.push(name);
      }
    }
    if (!parts.length) return { name: null, text: null, files: [] };
    const firstWithEntries = files.find((f) => f !== "aoci.txt") || files[0];
    return { name: firstWithEntries, text: parts.join("\n"), files };
  }

  // 条目数：只数 name[TAG]: 形状的行，与 aoci status 的 index_entries 同一口径。
  //
  // 2026-10-14 改口径。旧实现数的是「三文件合并后非空非 # 的行数」，把 81 行卷头
  // （===目录===）也算了进去，于是同一个仓库面板说 473、`aoci status` 说 392，
  // 两个数并排出现让人不知道该信哪个。实测三者对照：
  //   合并非空非# 473 = 条目 392 + 卷头 81
  // 改后只认条目行，面板与 aoci 报同一个数。旧数字若要追溯，看 index.entryLines。
  function countIndexEntries(text) {
    if (!text) return 0;
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/^\uFEFF/, "").trim();
      if (!t || t.startsWith("#")) continue;      // 空行与注释
      if (/^=+.+=+$/.test(t)) continue;            // 卷头
      if (/^.+?\[[A-Z0-9]{4,5}\]:\s/.test(t)) n += 1; // 条目
    }
    return n;
  }

  // 旧口径（合并非空非 # 的行数）。只在需要对照历史数字时用，界面不再显示它。
  function countMergedLines(text) {
    if (!text) return 0;
    let n = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.replace(/^\uFEFF/, "").trim();
      if (!t || t.startsWith("#")) continue;
      n += 1;
    }
    return n;
  }

  // ── AOCI 认知资产读取（只读；本 App 不产索引，只报告它长什么样） ──────
  //
  // 定位：本 App 是 AOCI 生态的查看器。索引由 aoci CLI 建骨架、由 Agent 写条目，
  // 这里只读它留下的文件，把「链路走到哪一步」摊给用户看。读的全是被登记仓库
  // 目录下的文件，走已有的 app/resources.read，不新增任何权限、不起子进程。
  //
  // 因此有一件事读不出来：AOCI 装没装。那要看 ~/.hanako 下的连接器配置，而宿主
  // 拒绝与 HANA_HOME 重叠的读根。所以卡片不设「环境」环，改为在缺索引时把
  // 「装 AOCI」写进修复步骤——说不清的事不写。
  async function readJsonFile(abs) {
    const text = await readOneFile(abs);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function listNames(abs) {
    const { items, error } = await listDir(abs);
    if (error) return null;
    return items.map(entryName).filter(Boolean).sort();
  }

  // 把 `20261008T141749Z` 这种 verify 快照名还原成 ISO 时刻；认不出返回 null。
  function verifyStampToIso(name) {
    const m = String(name || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }

  // 只读汇总一个仓库的 AOCI 状态。每一项都注明它来自哪个文件，便于溯源。
  async function readAociState(dir) {
    const base = normPath(dir).replace(/\/+$/, "");
    const cfg = await readJsonFile(`${base}/.aoci/config.json`);
    const baseline = await readJsonFile(`${base}/.aoci/baseline.json`);
    const idx = await readIndexFile(dir);
    const verifyNames = await listNames(`${base}/.aoci/verify_history`);
    const govNames = await listNames(`${base}/.aoci/governance`);
    const txNames = await listNames(`${base}/.aoci/transactions/history`);

    let ledgerOps = 0;
    let ledgerLast = null;
    const ledgerText = await readOneFile(`${base}/.aoci/ledger.jsonl`);
    if (ledgerText) {
      const rows = ledgerText.split("\n").map((l) => l.trim()).filter(Boolean);
      ledgerOps = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        try {
          const j = JSON.parse(rows[i]);
          if (j && j.op) { ledgerLast = { ts: j.ts || null, op: j.op, result: j.result || null }; break; }
        } catch { /* 坏行跳过 */ }
      }
    }

    const baselineFiles = baseline && baseline.files && typeof baseline.files === "object"
      ? Object.keys(baseline.files).length
      : null;
    const lastVerify = verifyNames && verifyNames.length ? verifyNames[verifyNames.length - 1] : null;

    return {
      base,
      initialized: !!cfg,
      config: cfg
        ? {
            version: cfg.version ?? null,
            locale: cfg.locale || null,
            indexPath: cfg.index_path || null,
            profile: cfg.managed_scope?.profile || null,
          }
        : null,
      index: {
        name: idx.name,
        files: idx.files || [],
        entries: idx.name ? countIndexEntries(idx.text) : 0,
        entryLines: idx.text ? countMergedLines(idx.text) : 0,
        bytes: idx.text ? Buffer.byteLength(idx.text, "utf8") : 0,
      },
      baseline: baseline
        ? {
            files: baselineFiles,
            createdAt: baseline.created_at || null,
            updatedAt: baseline.updated_at || null,
          }
        : null,
      verify: lastVerify ? { count: verifyNames.length, last: lastVerify, at: verifyStampToIso(lastVerify) } : null,
      governance: {
        receipts: govNames ? govNames.length : null,
        transactions: txNames ? txNames.length : null,
      },
      ledger: { ops: ledgerOps, last: ledgerLast },
    };
  }

  // 链路六环。每环：状态 + 一句证据 + 证据来源文件。
  // 状态四态：ok（就绪）/ warn（该看一眼）/ bad（缺这一环）/ wait（上游没到，等）
  //   全 ok     → 这条仓库的索引链路完整
  //   任一 bad  → 链路断了，卡上直接给修复步骤
  //
  // 「清点」是唯一可打断的一环：它跑在本 App 自己的任务里。索引与基线由 aoci /
  // Agent 写，本 App 只报告、不代为按下——打断权长在本 App 真能停的东西上。
  function buildChain(repo, aoci) {
    const p = repo.progress || {};
    const init = aoci.initialized;
    const hasIndex = aoci.index.entries > 0;
    const hasBaseline = !!aoci.baseline;

    const staleDays = (iso) => {
      if (!iso) return null;
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return null;
      return Math.floor((Date.now() - t) / 86400000);
    };

    const rings = [];
    const push = (num, name, state, evidence, source, extra = {}) =>
      rings.push({ num, name, state, evidence, source, ...extra });

    // 01 初始化
    push(
      "01",
      "初始化",
      init ? "ok" : "bad",
      init
        ? `.aoci/ 就位 · config v${aoci.config?.version ?? "?"} · ${aoci.config?.locale || "?"} · 托管范围 ${aoci.config?.profile || "?"}`
        : ".aoci/ 不存在，这个仓库还没跑过 aoci init",
      ".aoci/config.json"
    );

    // 02 清点（本 App 自己跑的，唯一可打断的一环）
    const scanState =
      repo.status === "scanning" ? "warn"
      : repo.status === "error" ? "bad"
      : repo.status === "done" ? "ok"
      : repo.status === "canceled" ? "warn"
      : "wait";
    const scanEvidence =
      repo.status === "scanning" ? `正在清点 · 已发现 ${p.total ?? 0} 个 · 随时可打断`
      : repo.status === "error" ? `上次清点出错：${repo.error || "原因见面板"}`
      : (p.total ?? 0) > 0
        ? `${p.total ?? 0} 文件 · ${p.dirCount ?? 0} 目录 · ${p.denied ?? 0} 个读不到${p.capped ? " · 触顶 20000" : ""}`
        : "还没清点过";
    push("02", "清点", scanState, scanEvidence, "dataDir/projects.json", { cancellable: repo.status === "scanning" });

    // 03 基线
    const baselineState = hasBaseline ? "ok" : init ? "warn" : "wait";
    push(
      "03",
      "基线",
      baselineState,
      hasBaseline
        ? `${aoci.baseline.files ?? "?"} 文件指纹 · ${aoci.baseline.updatedAt || aoci.baseline.createdAt || "时间未知"}`
        : init ? "还没有基线，跑 aoci scan 建立" : "上游未到，无从建立",
      ".aoci/baseline.json"
    );

    // 04 索引
    const indexState = hasIndex ? "ok" : init ? "warn" : "wait";
    push(
      "04",
      "索引",
      indexState,
      hasIndex
        ? `${aoci.index.entries} 条目 · ${aoci.index.name} ${(aoci.index.bytes / 1024).toFixed(1)} KB · ${aoci.index.files.length} 卷`
        : init ? "索引是空的，条目由 Agent 经 AOCI 链路写" : "上游未到，无从读取",
      "aoci.txt / aoci.meta.txt / aoci.code.txt"
    );

    // 05 核对（verify 快照 + 操作账本末条）
    const vDays = staleDays(aoci.verify?.at || aoci.baseline?.updatedAt);
    const verifyState = !hasBaseline ? "wait" : aoci.verify ? (vDays != null && vDays > 7 ? "warn" : "ok") : "warn";
    const verifyEvidence = aoci.verify
      ? `上次核对 ${aoci.verify.last}${vDays != null ? ` · 已隔 ${vDays} 天` : ""} · 账本 ${aoci.ledger.ops} 条操作`
      : aoci.ledger.last
        ? `没有 verify 快照 · 账本最近一条 ${aoci.ledger.last.op}（${aoci.ledger.last.ts || "时间未知"}）`
        : "还没有核对记录";
    push("05", "核对", verifyState, verifyEvidence, ".aoci/verify_history/ + ledger.jsonl");

    // 06 检索
    push(
      "06",
      "检索",
      hasIndex ? "ok" : "wait",
      hasIndex ? `${aoci.index.entries} 条目可搜 · 只搜本仓，不跨仓` : "还没有可搜的内容",
      "aoci 三文件合并文本"
    );

    const broken = rings.filter((r) => r.state === "bad");
    const warn = rings.filter((r) => r.state === "warn");
    return {
      repo: repo.id,
      name: repo.name,
      dir: aoci.base,
      generatedAt: new Date().toISOString(),
      rings,
      summary: {
        total: rings.length,
        ok: rings.filter((r) => r.state === "ok").length,
        warn: warn.length,
        bad: broken.length,
        wait: rings.filter((r) => r.state === "wait").length,
        chainOk: broken.length === 0 && warn.length === 0,
        // 缺索引时给的修复步骤。写在这里是为了让卡片与工具读数同源，不各写一份。
        repair: broken.length
          ? [
              "装 AOCI-CODE：取 github.com/aoci-spec/aoci-code 的 Release 包，放到一个固定路径",
              "在仓库里初始化并扫描：aoci init → aoci scan",
              "重启 Agent，让 it 按 AOCI 的流程把条目写出来",
            ]
          : [],
      },
    };
  }

  function joinChild(dirAbs, name) {
    const base = normPath(dirAbs).replace(/\/+$/, "");
    return `${base}/${name}`;
  }

  async function walkCount(dir, onTick, isCancelled, repoId) {
    let total = 0;
    let scanned = 0;
    let dirCount = 1;
    let denied = 0;
    const stack = [normPath(dir).replace(/\/+$/, "")];
    const seen = new Set(stack);
    await trace(repoId, { ev: "walk-start", dir: stack[0] });
    while (stack.length) {
      if (isCancelled()) return { total, scanned, dirCount, denied, stopped: true };
      if (total >= SCAN_FILE_CAP) return { total, scanned, dirCount, denied, stopped: false, capped: true };
      const cur = stack.pop();
      const { items, error } = await listDir(cur);
      if (error) {
        denied += 1;
        await trace(repoId, { ev: "list-denied", dir: cur, error });
        continue;
      }
      await trace(repoId, { ev: "list-ok", dir: cur, n: items.length, first: items.slice(0, 3).map((e) => JSON.stringify(e).slice(0, 160)) });
      for (const it of items) {
        const nm = entryName(it);
        if (!nm) continue;
        if (nm.startsWith(".") && nm !== ".aoci") continue;
        if (EXCLUDE_DIRS.has(nm)) continue;
        const child = joinChild(cur, nm);
        if (seen.has(child)) continue;
        seen.add(child);
        if (entryIsDir(it)) {
          stack.push(child);
          dirCount += 1;
        } else {
          total += 1;
        }
        scanned += 1;
        if (scanned % PROGRESS_EVERY === 0) onTick(total, scanned);
        if (total >= SCAN_FILE_CAP) return { total, scanned, dirCount, denied, stopped: false, capped: true };
      }
    }
    return { total, scanned, dirCount, denied, stopped: false };
  }

  async function runScan(repoId, taskId) {
    const repos = await readRepos();
    const repo = repos.find((r) => r.id === repoId);
    if (!repo) return;
    const isCancelled = () => cancelled.get(repoId)?.cancelled === true;
    const startedAt = new Date().toISOString();
    await patchRepo(repoId, { status: "scanning", taskId, error: null, startedAt });
    try {
      await sdk.tasks.update(taskId, { progress: { repoId, phase: "walk", scanned: 0, total: 0 } });
    } catch {
      /* 进度写不上不算失败 */
    }
    const onTick = (total, scanned) => {
      patchRepo(repoId, { progress: { phase: "walk", total, scanned } }).catch(() => {});
      sdk.tasks.update(taskId, { progress: { repoId, phase: "walk", total, scanned } }).catch(() => {});
    };
    const walk = await walkCount(repo.dir, onTick, isCancelled, repoId);
    if (isCancelled() || walk.stopped) {
      await patchRepo(repoId, { status: "canceled", taskId: null, progress: { phase: "walk", total: walk.total, scanned: walk.scanned, dirCount: walk.dirCount } });
      try {
        await sdk.tasks.complete(taskId, { repoId, status: "canceled", total: walk.total });
      } catch {}
      return;
    }
    const idx = await readIndexFile(repo.dir);
    const entries = countIndexEntries(idx.text);
    const entryLines = countMergedLines(idx.text);
    if (isCancelled()) {
      await patchRepo(repoId, { status: "canceled", taskId: null });
      try {
        await sdk.tasks.complete(taskId, { repoId, status: "canceled" });
      } catch {}
      return;
    }
    await patchRepo(repoId, {
      status: "done",
      taskId: null,
      finishedAt: new Date().toISOString(),
      progress: { phase: "done", total: walk.total, scanned: walk.scanned, dirCount: walk.dirCount, denied: walk.denied, entries, entryLines, capped: !!walk.capped },
      index: { file: idx.name, files: idx.files || [], entries, entryLines, hasIndex: !!idx.name },
    });
    try {
      await sdk.tasks.complete(taskId, { repoId, status: "done", total: walk.total, entries });
    } catch {}
  }

  // 注意：必须在工具 execute / 路由 handler 的当次调用里 await 扫完再返回。
  // execute 返回后宿主回收当次资源调用令牌，后台继续 list/read 会全报
  // app_resource_call_token_invalid（trace 已实证：顶层一次 OK，子目录全拒）。
  // 所以这里只建任务不自启，由调用方 await runScan，保证所有 resources.*
  // 都发生在令牌有效窗口内。任务仅做进度投影与打断旗，不做鉴权载体。
  async function startScan(repoId, opts = {}) {
    const callToken = opts.callToken || null;
    cancelled.set(repoId, { cancelled: false });
    let task = null;
    try {
      task = await sdk.tasks.create({
        label: `扫描仓库 ${repoId}`,
        handlerKey: "repo-scan",
        input: { repoId },
        scope: "app",
        delivery: "none",
        chipVisibility: "show",
        metadata: { repoId, kind: "repo-auto-index-scan" },
        ...(callToken ? { callToken } : {}),
      });
    } catch (err) {
      cancelled.delete(repoId);
      await patchRepo(repoId, { status: "error", error: `建任务失败：${err?.message || err}` });
      return null;
    }
    cancelled.get(repoId).taskId = task.taskId;
    if (!opts.detached) {
      try {
        await runScan(repoId, task.taskId);
      } catch (err) {
        await patchRepo(repoId, { status: "error", taskId: null, error: String(err?.message || err) });
        try {
          await sdk.tasks.fail(task.taskId, String(err?.message || err));
        } catch {}
      }
    } else {
      runScan(repoId, task.taskId).catch(async (err) => {
        await patchRepo(repoId, { status: "error", taskId: null, error: String(err?.message || err) });
        try {
          await sdk.tasks.fail(task.taskId, String(err?.message || err));
        } catch {}
      });
    }
    return task;
  }

  try {
    await sdk.tasks.registerHandler("repo-scan", {
      run: async (ctx) => {
        const repoId = ctx?.input?.repoId || ctx?.input?.repo;
        if (!repoId) return { ok: false, error: "缺少 repoId" };
        if (ctx?.taskId) await runScan(String(repoId), ctx.taskId);
        return { ok: true };
      },
      abort: async (taskId) => {
        for (const [repoId, v] of cancelled.entries()) {
          if (v.taskId === taskId) v.cancelled = true;
        }
      },
    });
  } catch (err) {
    await sdk.logger.warn(`repo-auto-index：任务处理器注册失败，本轮扫描走直跑模式（${err?.message || err}）`);
  }

  // ── 工具面：给模型调的那一半 ──────────────────────────────

  await sdk.tools.register({
    name: "repo_index_add",
    description:
      "登记一个仓库并开始自动清点。传入已存在的本地目录；同一目录重复登记会更新而不是新增。返回扫描任务与索引现状。",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "仓库本地绝对路径" },
        name: { type: "string", description: "显示名，默认取目录名" },
        gitUrl: { type: "string", description: "可选：目录还不存在时，返回可复制的克隆指令" },
      },
      required: ["dir"],
    },
    // 写本 App 自己的 dataDir（登记表）并起一个扫描任务，不碰用户文件。
    // APPS.md：未标只读的其余声明默认进审阅；这两支只动自己的 dataDir，
    // 显式声明为 routine 以免每轮都被审阅。
    sessionPermission: { auto: "allow" },
    execute: async (args) => {
      const dir = String(args?.dir ?? "").trim();
      if (!dir) return asText("dir 为空。");
      const exists = await dirExists(dir);
      if (exists === false && String(args?.gitUrl ?? "").trim()) {
        const url = String(args.gitUrl).trim();
        return asText(
          [`目录还不存在，插件没有私自克隆。先在宿主侧跑：`, ``, `  git clone ${url} "${dir}"`, ``, `克隆完再调一次 repo_index_add({ dir: "${dir}" })。`].join("\n")
        );
      }
      if (exists === false) return asText(`目录不存在：${dir}。如果是新仓库，先 clone，再登记。`);
      if (exists === null) return asText(`没能确认 ${dir} 的实情（可能是权限没批）。先到 设置→应用→App 权限 里给本 App 放行 app/resources.read，再试。`);
      const id = slugOf(path.basename(dir.replace(/[\\/]+$/, "")));
      const repos = await readRepos();
      const existing = repos.find((r) => normPath(r.dir) === normPath(dir));
      const record = {
        id: existing?.id || id,
        name: String(args?.name ?? "").trim() || existing?.name || path.basename(dir),
        dir,
        gitUrl: String(args?.gitUrl ?? "").trim() || existing?.gitUrl || null,
        status: "scanning",
        progress: { phase: "walk", total: 0, scanned: 0 },
        taskId: existing?.taskId || null,
        error: null,
        registeredAt: existing?.registeredAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const next = existing ? repos.map((r) => (r.id === existing.id ? record : r)) : [...repos, record];
      await writeRepos(next);
      const task = await startScan(record.id);
      const idx = await readIndexFile(dir);
      const lines = [
        `已登记：${record.name}（${record.id}）`,
        `目录：${record.dir}`,
        task ? `扫描任务已启动：${task.taskId}（面板上有打断按钮，随时可停）` : "扫描任务没建起来，状态里有原因。",
        idx.name ? `现有索引：${idx.name}，约 ${countIndexEntries(idx.text)} 条` : "该目录下还没有 aoci.txt，语义索引走 aoci / aoci-cua 链路补。",
      ];
      // 同上：扫完顺手落一张报告卡。这里所有 resources.* 都已在 startScan
      // 同步跑完，返回处不再有任何资源调用，附卡不会踩到令牌回收窗口
      // （index.js 顶部注释的约束仍然成立）。
      return withReportCard(lines.join("\n"));
    },
  });

  await sdk.tools.register({
    name: "repo_index_debug",
    description: "诊断：看一个目录经 resources.list 回来的原始形状（只取前 5 条），用来定位扫描只扫顶层之类的问题。",
    parameters: {
      type: "object",
      properties: { dir: { type: "string", description: "要看的目录绝对路径" } },
      required: ["dir"],
    },
    // 纯读：只 list 目录拿形状，不写任何东西。
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      const dir = String(args?.dir ?? "").trim();
      if (!dir) return asText("dir 为空。");
      try {
        const raw = await listDirRaw(dir);
        const list = asList(raw) || [];
        const sample = list.slice(0, 5).map((e) => JSON.stringify(e).slice(0, 300));
        const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : (Array.isArray(raw) ? ["<array>"] : [typeof raw]);
        return asText([`目录：${dir}`, `顶层 keys：${keys.join(", ")}`, `条数：${list.length}`, ...sample.map((s, i) => `#${i}: ${s}`)].join("\n"));
      } catch (err) {
        return asText(`list 失败：${err?.message || err}`);
      }
    },
  });

  await sdk.tools.register({
    name: "repo_index_list",
    description: "列出已登记的仓库：一仓一行，含状态、文件数、索引条数。",
    parameters: { type: "object", properties: {} },
    // 纯读：只读自己的 dataDir 登记表。
    sessionPermission: { readOnly: true },
    execute: async () => {
      const repos = await readRepos();
      if (!repos.length) return asText("还没有登记任何仓库。用 repo_index_add 登记第一个。");
      return asText(
        repos
          .map((r) => {
            const p = r.progress || {};
            const idx = r.index?.entries ?? "?";
            return `${r.name}（${r.id}） [${r.status}] 文件约 ${p.total ?? "?"} · 索引 ${idx} 条 · ${r.dir}`;
          })
          .join("\n")
      );
    },
  });

  await sdk.tools.register({
    name: "repo_index_status",
    description: "看一个仓库的索引现状：状态、进度、任务、索引文件、错误。",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "仓库 id、目录或显示名" } },
      required: ["repo"],
    },
    // 纯读：读登记表与仓库里的 aoci 索引文件。
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      const repos = await readRepos();
      const repo = findRepo(repos, String(args?.repo ?? "").trim());
      if (!repo) return asText(`找不到仓库：${args?.repo}。先用 repo_index_list 看看有哪些。`);
      const idx = await readIndexFile(repo.dir);
      // 返回一张报告卡：语义上正是「给我看看现状」，内容文字保留给模型，
      // 卡片由宿主包装成流内卡落进对话（CARD-DOCTRINE §2.1/§2.2）。
      return withReportCard(
        [
          `${repo.name}（${repo.id}） [${repo.status}]`,
          `目录：${repo.dir}`,
          `进度：${JSON.stringify(repo.progress || {})}`,
          repo.taskId ? `任务：${repo.taskId}` : "任务：无（空闲）",
          idx.name ? `索引：${idx.name}，约 ${countIndexEntries(idx.text)} 条` : "索引：还没有 aoci.txt",
          repo.error ? `错误：${repo.error}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      );
    },
  });

  await sdk.tools.register({
    name: "repo_index_chain",
    description:
      "体检一个仓库的索引链路：六环（初始化/清点/基线/索引/核对/检索）逐环给状态与证据，缺环时给修复步骤。只读，回一张链路卡。",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "仓库 id、目录或显示名" } },
      required: ["repo"],
    },
    // 纯读：只读本 App 的登记表与被登记仓库目录下的 .aoci/ 与 aoci 三文件。
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      const repos = await readRepos();
      const repo = findRepo(repos, String(args?.repo ?? "").trim());
      if (!repo) return asText(`找不到仓库：${args?.repo}。先用 repo_index_list 看看有哪些。`);
      const aoci = await readAociState(repo.dir);
      const chain = buildChain(repo, aoci);
      const icon = { ok: "✓", warn: "!", bad: "✗", wait: "·" };
      const lines = [
        `链路体检：${chain.name}（${repo.id}） · ${chain.summary.ok}/${chain.summary.total} 环就绪`,
        `目录：${chain.dir}`,
        "",
        ...chain.rings.map((r) => `${icon[r.state]} ${r.num} ${r.name}  ${r.evidence}`),
      ];
      if (chain.summary.repair.length) {
        lines.push("", "断在这一环，修复三步：", ...chain.summary.repair.map((s, i) => `  ${i + 1}. ${s}`));
      }
      return withChainCard(lines.join("\n"));
    },
  });

  await sdk.tools.register({
    name: "repo_index_cancel",
    description: "打断一个仓库正在跑的扫描。停了就是停了，状态落盘为 canceled，可随时重扫。",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: "仓库 id、目录或显示名" } },
      required: ["repo"],
    },
    // 只改本 App 自己的 dataDir 状态并停掉自己起的任务，不碰用户文件。
    sessionPermission: { auto: "allow" },
    execute: async (args) => {
      const repos = await readRepos();
      const repo = findRepo(repos, String(args?.repo ?? "").trim());
      if (!repo) return asText(`找不到仓库：${args?.repo}`);
      // 缺口 J 对齐：只在 scanning 态才打断，否则回绝且不覆写状态
      if (repo.status !== "scanning") {
        return asText(`无需打断：${repo.name} 当前状态为 ${repo.status}，不在扫描中。`);
      }
      cancelled.set(repo.id, { cancelled: true, taskId: repo.taskId });
      if (repo.taskId) {
        try {
          await sdk.tasks.cancel(repo.taskId, "用户打断");
        } catch {}
        try {
          await sdk.tasks.abort(repo.taskId, "用户打断");
        } catch {}
      }
      await patchRepo(repo.id, { status: "canceled", taskId: null });
      return asText(`已打断：${repo.name}。随时可以重扫。`);
    },
  });

  await sdk.tools.register({
    name: "repo_index_search",
    description:
      "只搜一个仓库自己的索引（它目录下的 aoci.txt 系列），不跨仓。返回命中的行，附行号。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库 id、目录或显示名" },
        keyword: { type: "string", description: "关键词" },
        limit: { type: "number", description: "最多返回行数，默认 20" },
      },
      required: ["repo", "keyword"],
    },
    // 纯读：只读本仓的 aoci 索引文本。
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      const repos = await readRepos();
      const repo = findRepo(repos, String(args?.repo ?? "").trim());
      if (!repo) return asText(`找不到仓库：${args?.repo}`);
      const keyword = String(args?.keyword ?? "").trim();
      if (!keyword) return asText("keyword 为空。");
      const idx = await readIndexFile(repo.dir);
      if (!idx.text) return asText(`${repo.name} 还没有可搜的索引文件（aoci.txt 系列）。`);
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      const lower = keyword.toLowerCase();
      const hits = [];
      const lines = idx.text.split("\n");
      for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
        if (lines[i].toLowerCase().includes(lower)) hits.push(`L${i + 1}: ${lines[i].slice(0, 220)}`);
      }
      if (!hits.length) return asText(`在 ${repo.name} 的 ${idx.name} 里没有搜到「${keyword}」。`);
      return asText([`${repo.name} · ${idx.name} · 命中 ${hits.length} 行（只搜本仓）：`, ...hits].join("\n"));
    },
  });

  // ── 后端路由：给面板看的那一半 ────────────────────────────

  // 读自身版本号。
  //
  // 为什么要从文件读而不是手写在代码里（2026-10-14）：
  //   前端曾有个手写常量 const BUILD = "v0.2 · …" 当构建标识，用来分辨
  //   宿主服务的是哪一版。但它靠人记得更新——改了 index.js / manifest /
  //   panel.html / panel.css 四次，从没回来同步它，于是它自己变成了假证据：
  //   明明装着 0.3.2，面板顶栏还说 v0.2。加标识本来就是为了防「版本不可辨」，
  //   结果它成了误导源。
  //   现在改成从 manifest.json 读 —— 那是打包时唯一的版本真相，不可能与它不符。
  // 安装目录只读，这里只读不写；读不到就回 null，前端显示空值而不是猜。
  let cachedVersion;
  async function readAppVersion() {
    if (cachedVersion !== undefined) return cachedVersion;
    try {
      const raw = await fs.readFile(new URL("./manifest.json", import.meta.url), "utf8");
      cachedVersion = JSON.parse(raw)?.version || null;
    } catch (err) {
      await sdk.logger.warn(`repo-auto-index：读 manifest 版本失败（${err?.message || err}）`);
      cachedVersion = null;
    }
    return cachedVersion;
  }

  // 会话列表：给面板的目标选择器用。
  //
  // 为什么要它（2026-10-14）：实测确认 scope:"all" + app/sessions.read 能列全部
  // 会话（本机实测 364 条全回来），带 title / sessionId / cwd / agentId。
  // 而官方文档 APPS.md:832 写的是「session:list 同样只看得到归属自己的会话」——
  // **文档与实现不一致，以实测为准**。探针记录见 docs/AUDIT-2026-10-14.md。
  //
  // 排序：先按「是不是当前仓库的」分组（cwd 落在该仓库目录下），再按最近活动。
  // 理由：一仓一索引，用户找会话时最可能想要的就是这个仓库相关的那些。
  //
  // 放在 app 作用域（不在 routes.register 回调里）：一是让 apply 时的自检也能调，
  // 二是路由只做一层包装，逻辑只有一份。
  async function listSessionsForRepo(repo) {
    let sessions = [];
    try {
      const res = await sdk.bus.request("session:list", { scope: "all", lifecycle: "active" });
      sessions = Array.isArray(res?.sessions) ? res.sessions : [];
    } catch (err) {
      // 列不出来就如实报，不假装空列表。面板会显示原因。
      return { ok: false, error: `列会话失败：${err?.message || err}`, needsPermission: /sessions\.read/i.test(String(err?.message || err)) };
    }

    const repoDir = normPath(repo.dir).replace(/\/+$/, "").toLowerCase();
    const inRepo = (s) => {
      const wd = normPath(s?.cwd || "").replace(/\/+$/, "").toLowerCase();
      return !!wd && (wd === repoDir || wd.startsWith(`${repoDir}/`));
    };

    const list = sessions
      .map((s) => ({
        sessionId: s.sessionId || null,
        title: s.title || "（无标题会话）",
        cwd: s.cwd || null,
        agentId: s.agentId || null,
        modified: s.modified || null,
        messageCount: typeof s.messageCount === "number" ? s.messageCount : null,
        inRepo: inRepo(s),
      }))
      .filter((s) => !!s.sessionId)
      .sort((a, b) => {
        if (a.inRepo !== b.inRepo) return a.inRepo ? -1 : 1;
        return Date.parse(b.modified || 0) - Date.parse(a.modified || 0);
      });

    return {
      ok: true,
      repo: repo.id,
      repoDir: repo.dir,
      total: list.length,
      matched: list.filter((s) => s.inRepo).length,
      sessions: list.slice(0, 200),   // 上限 200 条，够用且不让面板一次扛太多
    };
  }

  await sdk.routes.register((app) => {
    // /health 带真实版本号：前端拿它当构建标识，不再自己手写。
    app.get("/health", async (c) => c.json({ ok: true, app: "repo-auto-index", version: await readAppVersion() }));

    app.get("/overview", async (c) => {
      try {
        const repos = await readRepos();
        return c.json({ ok: true, dataDir, repos });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.get("/repo/:id/sessions", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        return c.json(await listSessionsForRepo(repo));
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.get("/repo/:id/chain", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const aoci = await readAociState(repo.dir);
        return c.json({ ok: true, chain: buildChain(repo, aoci), aoci });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.get("/repo/:id", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const idx = await readIndexFile(repo.dir);
        // 区分「没初始化」与「初始化了但没条目」——这两种处境下用户该做的事不同,
        // 面上一句含糊话等于没说。只多看一个文件：.aoci/config.json 在不在。
        const aociCfg = await readJsonFile(`${normPath(repo.dir).replace(/\/+$/, "")}/.aoci/config.json`);
        // 预览行与条目数同口径：都去掉空行、注释与 === 卷头，免得预览里有、计数里没有。
        const lines = (idx.text || "")
          .split(/\r?\n/)
          .map((l) => l.replace(/^\uFEFF/, ""))
          .filter((l) => {
            const t = l.trim();
            return t && !t.startsWith("#") && !/^=+.+=+$/.test(t);
          });
        return c.json({
          ok: true,
          repo,
          // aociInit：这个仓库跑过 aoci init 吗。拿不到就是 false（文件不在），
          // 不报错——初始化与否本来就是“有无该文件”这一件事实。
          aociInit: !!aociCfg,
          index: {
            file: idx.name,
            entries: countIndexEntries(idx.text),
            entryLines: countMergedLines(idx.text),
            hasIndex: !!idx.name,
            preview: lines.slice(0, 60),
          },
        });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.get("/repo/:id/search", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const q = String(c.req.query("q") || "").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
        if (!q) return c.json({ ok: true, repo: repo.id, hits: [], total: 0 });
        const idx = await readIndexFile(repo.dir);
        if (!idx.text) return c.json({ ok: true, repo: repo.id, file: null, hits: [], total: 0 });
        const hits = [];
        const lines = idx.text.split("\n");
        for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
          if (lines[i].toLowerCase().includes(q)) hits.push({ line: i + 1, text: lines[i].slice(0, 240) });
        }
        return c.json({ ok: true, repo: repo.id, file: idx.name, hits, total: hits.length });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.post("/repo/add", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const dir = String(body?.dir || "").trim();
        if (!dir) return c.json({ ok: false, error: "dir 为空" }, 400);
        const exists = await dirExists(dir);
        if (exists === false) return c.json({ ok: false, error: `目录不存在：${dir}，先 clone 再登记` }, 400);
        if (exists === null) return c.json({ ok: false, error: "没能确认目录实情，可能是 app/resources.read 没放行" }, 403);
        const id = slugOf(path.basename(dir.replace(/[\\/]+$/, "")));
        const repos = await readRepos();
        const existing = repos.find((r) => normPath(r.dir) === normPath(dir));
        const record = {
          id: existing?.id || id,
          name: String(body?.name || "").trim() || existing?.name || path.basename(dir),
          dir,
          status: "scanning",
          progress: { phase: "walk", total: 0, scanned: 0 },
          taskId: existing?.taskId || null,
          error: null,
          registeredAt: existing?.registeredAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const next = existing ? repos.map((r) => (r.id === existing.id ? record : r)) : [...repos, record];
        await writeRepos(next);
        const task = await startScan(record.id);
        return c.json({ ok: true, repo: { ...record, taskId: task?.taskId || null } });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    // 缺口 J 修：只在 scanning 态才打断；终态打断请求直接回绝，不覆写状态。
    app.post("/repo/:id/cancel", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        if (repo.status !== "scanning") {
          return c.json({ ok: false, error: `该仓库不在扫描中（当前 ${repo.status}），无需打断` }, 409);
        }
        cancelled.set(repo.id, { cancelled: true, taskId: repo.taskId });
        if (repo.taskId) {
          try { await sdk.tasks.cancel(repo.taskId, "用户打断"); } catch {}
          try { await sdk.tasks.abort(repo.taskId, "用户打断"); } catch {}
        }
        const updated = await patchRepo(repo.id, { status: "canceled", taskId: null });
        return c.json({ ok: true, repo: updated });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    // 缺口 A 修：先落盘 scanning 再同步扫，消灭幻影扫描态。
    app.post("/repo/:id/rescan", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        if (repo.status === "scanning") {
          return c.json({ ok: false, error: "该仓库正在扫描中，先打断再重扫" }, 409);
        }
        await patchRepo(repo.id, {
          status: "scanning",
          taskId: null,
          error: null,
          startedAt: new Date().toISOString(),
          progress: { phase: "walk", total: 0, scanned: 0, dirCount: 1 },
        });
        const task = await startScan(repo.id);
        if (!task) return c.json({ ok: false, error: "建任务失败，看日志" }, 500);
        const after = await patchRepo(repo.id, { taskId: task.taskId });
        // startScan 是同步阻塞：返回时扫描已结束，after 即终态。
        return c.json({ ok: true, repo: after, taskId: task.taskId });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    // ── A 路：关系图（只读）。契约见 ui/GRAPH-CONTRACT.md §1 ──
    app.get("/repo/:id/graph", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const idx = await readIndexFile(repo.dir);
        const graph = buildGraph(idx.text, { repo: repo.id, volume: idx.name || "aoci.code.txt" });
        return c.json({ ok: true, ...graph });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    app.get("/repo/:id/node", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const rawPath = String(c.req.query("path") || "").trim();
        if (!rawPath) return c.json({ ok: false, error: "缺少 path 参数" }, 400);
        const idx = await readIndexFile(repo.dir);
        const graph = buildGraph(idx.text, { repo: repo.id, volume: idx.name || "aoci.code.txt" });
        const byId = new Map(graph.nodes.map((n) => [n.id, n]));
        let want = rawPath;
        try { want = decodeURIComponent(rawPath); } catch {}
        const node = byId.get(rawPath) || byId.get(want);
        if (!node) return c.json({ ok: false, error: "找不到该对象" }, 404);
        const brief = (n) => ({ id: n.id, name: n.name, layer: n.layer, module: n.module, F: n.F });
        const out = [];
        const inn = [];
        for (const e of graph.edges) {
          if (e.from === node.id) { const p = byId.get(e.to); if (p) out.push(brief(p)); }
          if (e.to === node.id) { const p = byId.get(e.from); if (p) inn.push(brief(p)); }
        }
        return c.json({ ok: true, node, out, in: inn });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    // 缺口 H 修：读 trace 尾部，供面板对账。
    app.get("/repo/:id/trace", async (c) => {
      try {
        const repos = await readRepos();
        const repo = findRepo(repos, c.req.param("id"));
        if (!repo) return c.json({ ok: false, error: "找不到该仓库" }, 404);
        const tail = Math.min(Math.max(Number(c.req.query("tail")) || 200, 1), 1000);
        const file = tracePath(repo.id);
        let lines = [];
        try {
          const raw = await fs.readFile(file, "utf8");
          lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).slice(-tail);
        } catch {
          return c.json({ ok: true, repo: repo.id, file, lines: [], total: 0 });
        }
        const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
        return c.json({ ok: true, repo: repo.id, file, lines: parsed, total: parsed.length });
      } catch (err) {
        return c.json({ ok: false, error: err?.message || String(err) }, 500);
      }
    });

    // ── 投递：把一张卡送进当前对话（面板按钮 → 后端转发） ──────────
    //
    // 两张流内卡（扫描报告 report / 链路体检 chain）共用这一段，靠 :kind 区分：
    // 正文、customType、trace 事件名三者按 kind 取，其余（拿会话、send-custom、
    // 回包判据）完全一致。
    //
    // 为什么不复制成两个路由：两张卡的投递机制是同一件事，复制会把
    // 「entryId 为 null 不算失败」这类**已经对照实验定过案**的判据抄成两份，
    // 以后改一份忘一份，就又多一处两个真相源。差异只有三行数据，就只留三行差异。
    //
    // 凭据来自面板：面板页用 hana.sessions.getActive() 拿到当前会话 id 交给这里。
    // 后端用该 id + scope:"all" 调 session:send-custom；本 App 与目标会话常不属同一
    // 归属，跨归属要 scope:"all" + app/sessions.manage（FINDINGS-B V6/V7）。
    // display:true 必须显式传，否则 messageRenderers 不把消息映射成流内卡（V6）。
    // triggerTurn:false：会话空闲时只记历史、不惊动模型；若会话正在流式，消息仍会
    // 排进当前回合（V6 判据），故清单里一并声明了 app/session.start-turn。
    // 回包的 entryId 原样透传给面板；拿不到就如实报错，不静默成功。
    //
    // 向后兼容：旧的 /report/send 保留为别名，面板旧版仍在调它。
    const CARD_KINDS = {
      report: {
        customType: "scan-report",
        traceEvent: "report-send",
        // 正文只写一行引子，细节住进卡里。理由：投到「正在生成」的会话时，
        // 消息会排进当前回合并作为回合输入呈现；正文如果逐行罗列七个字段，
        // 就会与卡片内容重复，看起来像囧话。一个字数据够点开卡就行。
        intro: (repo, idx) =>
          `扫描报告：${repo.name}（${repo.id}） · ${repo.status} · ${repo.progress?.total ?? "?"} 文件 · 索引 ${idx.name ? countIndexEntries(idx.text) : 0} 条`,
      },
      chain: {
        customType: "index-chain",
        traceEvent: "chain-send",
        intro: (repo, idx, chain) =>
          `链路体检：${repo.name}（${repo.id}） · ${chain.summary.ok}/${chain.summary.total} 环就绪 · 索引 ${idx.name ? countIndexEntries(idx.text) : 0} 条`,
      },
    };

    async function sendCardToSession(kind, body) {
      const spec = CARD_KINDS[kind];
      if (!spec) return { status: 400, json: { ok: false, error: `未知的卡类型：${kind}` } };

      const sessionId = String(body?.sessionId || "").trim();
      const repoId = String(body?.repoId || "").trim();
      if (!sessionId) return { status: 400, json: { ok: false, error: "缺少 sessionId：面板没拿到当前会话" } };
      if (!repoId) return { status: 400, json: { ok: false, error: "缺少 repoId" } };

      const repos = await readRepos();
      const repo = findRepo(repos, repoId);
      if (!repo) return { status: 404, json: { ok: false, error: `找不到仓库：${repoId}` } };

      const idx = await readIndexFile(repo.dir);
      let chain = null;
      if (kind === "chain") {
        const aoci = await readAociState(repo.dir);
        chain = buildChain(repo, aoci);
      }
      const content = [spec.intro(repo, idx, chain), repo.error ? `错误：${repo.error}` : ""]
        .filter(Boolean)
        .join("\n");

      // SDK 暴露的是 sdk.sessions.sendCustom(input)，它转发到 ctx.bus.request(
      // "session:send-custom", input)（server-client.js 的 APP_SDK_BUS_METHODS +
      // bindOperations）。优先用封装（错误转化更规整）；万一此环境未暴露该封装，
      // 回落裸总线，两条通道都指向同一 verb。
      const payload = {
        customType: spec.customType,
        content,
        display: true,
        triggerTurn: false,
        sessionId,
        scope: "all",
      };
      const res =
        typeof sdk.sessions?.sendCustom === "function"
          ? await sdk.sessions.sendCustom(payload)
          : await sdk.bus.request("session:send-custom", payload);
      // 回包形状：{ ok, mode, customType, entryId, sessionId?, sessionRef? }。
      // entryId 可以为 null，而且那不是失败——2026-10-13 对照实验定案：
      //   投空闲会话 → { ok:true, entryId:"2f6d0e8f" }，消息当场落成一条 custom 条目
      //   投正在流式的会话 → entryId 为 null，消息排进当前回合，尚未落成独立条目
      // 所以判定成功用 ok，不用 entryId 的有无。entryId 缺失只说明它还没定形，
      // 不代表没送进去。把它当失败报 502 是误判。
      if (!res?.ok) {
        return { status: 502, json: { ok: false, error: `投递未成功：宿主回 ${JSON.stringify(res ?? null)}` } };
      }
      const entryId = typeof res.entryId === "string" && res.entryId ? res.entryId : null;
      await trace(repo.id, {
        ev: spec.traceEvent,
        sessionId: String(sessionId).slice(0, 12),
        entryId: entryId || `(pending:${res.mode || "?"})`,
      });
      return { status: 200, json: { ok: true, entryId, mode: res.mode ?? null, pending: entryId === null } };
    }

    for (const kind of ["report", "chain"]) {
      app.post(`/${kind}/send`, async (c) => {
        try {
          const body = await c.req.json().catch(() => ({}));
          const { status, json } = await sendCardToSession(kind, body);
          return c.json(json, status);
        } catch (err) {
          return c.json({ ok: false, error: err?.message || String(err) }, 500);
        }
      });
    }
  });

  await sdk.logger.info(`仓库自动索引已就绪 · dataDir=${dataDir}`);
});
