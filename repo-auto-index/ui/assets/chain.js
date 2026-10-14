import { hana } from "./sdk.js";
import { mountAppUi, appUi } from "./app-ui.js";

/* 仓库自动索引 · 链路体检卡
 * 一次体检 = 一张能递出去的卡。契约见 ui/CARD-DOCTRINE.md；本页与 ui/assets/report.js 同源。
 *
 * 三条纪律（与面板、报告卡一致）：
 * 1. 一个 id 只出现一次；一个区块只有一份 DOM，状态用 data-* 表达。
 * 2. 所有数字都来自服务端，页面不自造。刷新即真相。
 * 3. 官方控件走 mountAppUi，重渲染前必须 destroy（killHost 收口）。
 *
 * 本卡特有的两件事：
 * - 六环的数据全部来自 GET /repo/:id/chain，后端读的是仓库里 .aoci/ 与 aoci 三文件。
 *   本 App 不产索引，只报告它长什么样；「打断」只长在真能停的那一环（清点）上。
 * - 不设右上角徽标：官方 card-guide §2 要求顶部 100x40 留空，徽标跟在标题后（左侧流向）。
 */

// 构建标识：从后端 /health 读真实版本，不手写（同 report.js 的说明：
// 手写常量靠人记得更新就是靠不住，自己会变成误导源）。
let appVersion = "";
function versionLabel() {
  return appVersion ? `v${appVersion}` : "版本未知";
}

// ── 元素访问唯一入口（照抄报告卡） ──────────────────
const byId = (id) => document.getElementById(id);

// ── 官方控件挂载收口 ────────────────────────────────
const handles = new Map();

function killHost(hostId) {
  const arr = handles.get(hostId);
  if (!arr) return;
  for (const hd of arr) { try { hd.destroy(); } catch {} }
  handles.delete(hostId);
}

function mount(hostId, name, props) {
  const host = byId(hostId);
  if (!host) return null;
  killHost(hostId);
  host.replaceChildren();
  try {
    const hd = mountAppUi(host, name, props);
    handles.set(hostId, [hd]);
    return hd;
  } catch (err) {
    console.warn("mountAppUi 失败", hostId, name, err?.code || err?.message);
    return null;
  }
}

// 签名去重：避免重复渲染把已挂控件重挂掉。
const sigs = new Map();
function changed(key, sig) {
  if (sigs.get(key) === sig) return false;
  sigs.set(key, sig);
  return true;
}

// ── 宿主主题（照抄报告卡） ──────────────────────────
async function applyHostTheme() {
  try {
    const snap = await hana.theme?.getSnapshot?.();
    const cssUrl = snap?.cssUrl;
    if (cssUrl) {
      const res = await fetch(cssUrl, { credentials: "same-origin" });
      if (res.ok) {
        const css = await res.text();
        let styleEl = document.querySelector("style[data-hana-theme-style]");
        if (!styleEl) {
          styleEl = document.createElement("style");
          styleEl.setAttribute("data-hana-theme-style", "");
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
      }
    }
    if (snap?.theme && /midnight|dark|deep-think/i.test(String(snap.theme))) {
      document.documentElement.style.colorScheme = "dark";
    }
  } catch {
    /* 主题拿不到不是错误，样式自己兜底 */
  }
}

/* ════════════════════════════════════════════════════════════════
 *  数据获取层
 *
 *  卡片 iframe 调后端走宿主签发的 surface 凭据（CARD-DOCTRINE §3 的 V4a/V4b
 *  已定案：卡片与面板同一条通道，卡片调后端不需要额外声明任何 manifest 能力）。
 *  按候选顺序尝试，第一个成功的固定下来复用；全部失败则回退到内联样本。
 *
 *  ⚠ 回退样本的字段形状必须与服务端一致（含 chain.rings / summary），
 *    否则样本本身会渲染出真实数据长不出来的样子，等于假证据。
 * ════════════════════════════════════════════════════════════════ */

const ROUTE_CANDIDATES = [
  {
    id: "relative",
    label: "相对路径 ../routes/",
    fetch: (path, init) => fetch(`../routes/${path}`, { credentials: "same-origin", ...(init || {}) }),
  },
  {
    id: "sdk",
    label: "hana.api.fetch",
    fetch: (path, init) => hana.api.fetch(path, init),
  },
];

// 从 URL 尝试取 repoId（宿主一般不传，拿不到就回退到最近更新的一条）。
function wantedRepoId() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get("repoId") || u.searchParams.get("repo") || "";
  } catch {
    return "";
  }
}

function pickRepo(repos, sourceNote) {
  const want = wantedRepoId();
  if (want) {
    const hit = repos.find((r) => r.id === want || r.dir === want || r.name === want);
    if (hit) return { repo: hit, how: "url" };
    sourceNote.push(`URL 指定 repoId=${want} 未命中，回退到最近更新`);
  }
  const sorted = [...repos].sort((a, b) =>
    Date.parse(b.finishedAt || b.updatedAt || 0) - Date.parse(a.finishedAt || a.updatedAt || 0));
  return { repo: sorted[0] || null, how: "recent" };
}

async function fetchJson(channel, path, init) {
  const res = await channel.fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

// 取链路：先 overview 拿列表，再 chain 拿六环。
// 「答了但是空」与「答不了」分开：overview 正常但 repos 为空是成功的 live 结果。
async function readChainVia(channel) {
  const notes = [];
  // 顺手取一次真实版本；取不到不致命（页脚写「版本未知」）。
  if (!appVersion) {
    try {
      const h = await fetchJson(channel, "health");
      appVersion = h?.version || "";
    } catch { /* 拿不到就留空 */ }
  }
  const overview = await fetchJson(channel, "overview");
  const repos = Array.isArray(overview?.repos) ? overview.repos : [];
  if (!repos.length) return { repos: [], repo: null, chain: null, notes };

  const { repo, how } = pickRepo(repos, notes);
  if (how === "recent") notes.push("未从 URL 取到 repoId，已回退到最近更新的一条");
  let chain = null;
  if (repo) {
    try {
      const r = await fetchJson(channel, `repo/${encodeURIComponent(repo.id)}/chain`);
      chain = r?.chain || null;
    } catch (err) {
      notes.push(`链路读取失败：${err?.message || err}`);
    }
  }
  return { repos, repo, chain, notes };
}

// 内联样本：形状取自 index.js 的 buildChain 真实输出。
// 只在所有真实通道都失败时使用，页脚明确标注「样本」，不冒充真相。
//
// 用示范名与示范路径（example-repo / C:\Users\me\my-repo），不用任何本机实名路径：
// 这个文件会随包分发给别人，写死某台的用户名与目录名等于把一个真实机器的
// 目录结构带出去。数字保留真实量级，好让样例看着不是虚构。
function mockChain() {
  const repo = { id: "example-repo", name: "示例仓库", dir: "C:\\Users\\me\\my-repo", status: "done", progress: { phase: "done", total: 740, scanned: 815, dirCount: 76, denied: 0, entries: 392, entryLines: 473, capped: false }, finishedAt: "2026-10-13T12:00:33.914Z", updatedAt: "2026-10-13T12:00:33.927Z" };
  const rings = [
    { num: "01", name: "初始化", state: "ok", evidence: ".aoci/ 就位 · config v2 · zh-CN · 托管范围 production", source: ".aoci/config.json" },
    { num: "02", name: "清点", state: "ok", evidence: "740 文件 · 76 目录 · 0 个读不到", source: "dataDir/projects.json" },
    { num: "03", name: "基线", state: "ok", evidence: "426 文件指纹 · 2026-10-08T14:17:36Z", source: ".aoci/baseline.json" },
    { num: "04", name: "索引", state: "ok", evidence: "392 条目 · aoci.code.txt 121.9 KB · 3 卷", source: "aoci.txt / aoci.meta.txt / aoci.code.txt" },
    { num: "05", name: "核对", state: "warn", evidence: "上次核对 20261008T141749Z · 已隔 6 天 · 账本 55 条操作", source: ".aoci/verify_history/ + ledger.jsonl" },
    { num: "06", name: "检索", state: "ok", evidence: "392 条目可搜 · 只搜本仓，不跨仓", source: "aoci 三文件合并文本" },
  ];
  return {
    repos: [repo],
    repo,
    chain: {
      repo: repo.id, name: repo.name, dir: repo.dir, generatedAt: new Date().toISOString(),
      rings,
      summary: { total: 6, ok: 4, warn: 1, bad: 0, wait: 0, chainOk: false, repair: [] },
    },
    notes: ["所有真实通道均失败，当前显示的是内联样本（形状同 index.js 的真实输出）"],
  };
}

let resolvedChannel = null;

async function fetchChain() {
  const tried = [];
  const channels = resolvedChannel
    ? [resolvedChannel, ...ROUTE_CANDIDATES.filter((c) => c.id !== resolvedChannel.id)]
    : ROUTE_CANDIDATES;

  for (const channel of channels) {
    try {
      const data = await readChainVia(channel);
      if (!Array.isArray(data.repos)) throw new Error("overview 响应里没有 repos");
      resolvedChannel = channel;
      return { ...data, source: { kind: "live", channel: channel.id, label: channel.label, tried } };
    } catch (err) {
      tried.push(`${channel.label}：${err?.message || err}`);
    }
  }
  return { ...mockChain(), source: { kind: "mock", channel: "mock", label: "内联样本", tried } };
}

// ── 状态 ────────────────────────────────────────────
const state = { data: null, loading: false };

// ── 渲染：身份 ──────────────────────────────────────
const STATE_LABEL = { ok: "链路完整", warn: "有待办", bad: "链断了", wait: "等上游" };
function tone(state, summary) {
  if (!summary) return "mute";
  if (summary.bad > 0) return "bad";
  if (summary.warn > 0) return "warn";
  if (summary.ok === summary.total) return "ok";
  return "mute";
}

function renderHead(data) {
  const repo = data.repo;
  const chain = data.chain;
  byId("ch-name").textContent = chain?.name || repo?.name || "—";
  byId("ch-slug").textContent = repo?.id ? `（${repo.id}）` : "";
  byId("ch-dir").textContent = chain?.dir || repo?.dir || "";
  byId("ch-dir").title = chain?.dir || repo?.dir || "";

  const host = byId("ch-badge-mount");
  if (!host) return;
  const s = chain?.summary;
  const sig = `${repo?.id}|${s?.ok}|${s?.warn}|${s?.bad}|${s?.wait}`;
  if (!changed("badge", sig)) return;
  killHost("ch-badge-mount");
  host.replaceChildren();
  if (!s) return;
  const sp = document.createElement("span");
  sp.className = `badge b-${tone(repo?.status, s)}`;
  sp.textContent = `${STATE_LABEL[tone(repo?.status, s)] || ""} ${s.ok}/${s.total}`;
  host.appendChild(sp);
}

// ── 渲染：六环 ──────────────────────────────────────
// 每环一行：点号 · 序 · 名 · 证据。点击展开全文与来源文件。
function renderRings(chain) {
  const host = byId("rings");
  if (!host) return;
  const rings = chain?.rings || [];
  const sig = rings.map((r) => `${r.num}${r.state}${r.evidence}`).join("|");
  if (!changed("rings", `${chain?.generatedAt}|${sig}`)) return;

  host.replaceChildren();
  for (const r of rings) {
    const row = document.createElement("div");
    row.className = "ring";
    row.dataset.s = r.state;
    row.tabIndex = 0;
    row.title = r.source ? `来源：${r.source}` : "";

    const dot = document.createElement("span"); dot.className = "dot";
    const num = document.createElement("span"); num.className = "rnum"; num.textContent = r.num;
    const name = document.createElement("span"); name.className = "rname"; name.textContent = r.name;
    if (r.cancellable) {
      const cut = document.createElement("span"); cut.className = "rcut"; cut.textContent = "可打断";
      name.appendChild(cut);
    }
    const evi = document.createElement("span"); evi.className = "revi"; evi.textContent = r.evidence;

    row.append(dot, num, name, evi);
    // 来源文件默认藏起来，展开时才显示（默认一行放不下，也不该抢证据的位）。
    if (r.source) {
      const src = document.createElement("span");
      src.className = "rsrc mono";
      src.textContent = `来源：${r.source}`;
      src.hidden = true;
      row.appendChild(src);
    }

    const toggle = () => {
      const open = row.dataset.open === "1";
      row.dataset.open = open ? "0" : "1";
      if (src) src.hidden = open;
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });

    host.appendChild(row);
  }
}

// ── 渲染：缺环修复 ──────────────────────────────────
function renderFix(chain) {
  const box = byId("fix");
  const list = byId("fix-list");
  const steps = chain?.summary?.repair || [];
  if (!box || !list) return;
  if (!steps.length) { box.hidden = true; return; }
  box.hidden = false;
  if (!changed("fix", steps.join("|"))) return;
  list.replaceChildren();
  for (const s of steps) {
    const li = document.createElement("li");
    // 把 <code> 段单独渲染：步骤文本用反引号标出命令
    const parts = String(s).split(/(`[^`]+`)/g);
    for (const p of parts) {
      if (/^`[^`]+`$/.test(p)) {
        const c = document.createElement("code");
        c.textContent = p.slice(1, -1);
        li.appendChild(c);
      } else if (p) {
        li.appendChild(document.createTextNode(p));
      }
    }
    list.appendChild(li);
  }
}

// ── 渲染：操作 ──────────────────────────────────────
function renderActions(data) {
  const repo = data.repo;
  const scanning = repo?.status === "scanning";
  const sig = `${repo?.id}|${repo?.status}`;
  if (changed("act-rescan", sig)) {
    mount("act-rescan", "Button", {
      children: scanning ? "打断" : "重新清点",
      variant: scanning ? "danger" : "primary",
      size: "sm",
      onClick: () => (scanning ? doCancel(repo?.id) : doRescan(repo?.id)),
    });
  }
  if (changed("act-panel", "panel")) {
    mount("act-panel", "Button", {
      children: "打开面板", variant: "secondary", size: "sm",
      onClick: () => openPanel(),
    });
  }
}

async function doRescan(repoId) {
  if (!repoId) return;
  try {
    const channel = resolvedChannel || ROUTE_CANDIDATES[0];
    await fetchJson(channel, `repo/${encodeURIComponent(repoId)}/rescan`, { method: "POST" });
    await refresh();
  } catch (err) {
    hana.toast?.show?.({ message: `重扫失败：${err?.message || err}`, tone: "error" });
  }
}

async function doCancel(repoId) {
  if (!repoId) return;
  try {
    const channel = resolvedChannel || ROUTE_CANDIDATES[0];
    await fetchJson(channel, `repo/${encodeURIComponent(repoId)}/cancel`, { method: "POST" });
    await refresh();
  } catch (err) {
    hana.toast?.show?.({ message: `打断失败：${err?.message || err}`, tone: "error" });
  }
}

// 行首不许出现 "打开" 二字之外的内部标识；失败给一句人话。
async function openPanel() {
  try {
    await hana.cards?.open?.("panel");
  } catch {
    hana.toast?.show?.({ message: "打开面板失败，可从侧栏进入", tone: "error" });
  }
}

// ── 渲染：来路（可溯源） ────────────────────────────
function renderSource(source, notes) {
  const el = byId("ch-source");
  if (!el) return;
  const parts = [versionLabel()];
  if (source?.kind === "live") parts.push(`数据源：${source.label}`);
  else parts.push("数据源：内联样本（真实通道不可用）");
  if (notes?.length) parts.push(...notes);
  el.textContent = parts.join(" · ");
}

// ── 整页态：空 / 错 ────────────────────────────────
function renderCenter(kind, title, detail) {
  byId("ch-body").hidden = true;
  const box = byId("ch-center");
  box.hidden = false;
  const host = byId("center-mount");
  if (!changed("center", `${kind}|${title}`)) return;
  killHost("center-mount");
  host.replaceChildren();
  try {
    mountAppUi(host, kind === "error" ? "ErrorState" : "EmptyState", {
      title,
      description: detail || "",
      ...(kind === "error" ? { onRetry: () => refresh() } : {}),
    });
  } catch {
    // 官方组件不可用时的兜底：纯文本，不静默
    const p = document.createElement("p");
    p.textContent = detail ? `${title} — ${detail}` : title;
    host.appendChild(p);
  }
}

// ── 主流程 ──────────────────────────────────────────
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await fetchChain();
    state.data = data;
    byId("root").dataset.status = data.source.kind === "live" ? "ready" : "error";

    if (!data.repos.length) {
      renderCenter("empty", "还没有登记仓库", "一仓一索引。到面板登记一个已存在的目录，或让 Agent 调 repo_index_add。");
      return;
    }
    if (!data.chain) {
      renderCenter("error", "读不到链路", data.notes?.join("；") || "后端没答出六环，看看面板是否正常。");
      return;
    }

    byId("ch-center").hidden = true;
    byId("ch-body").hidden = false;
    renderHead(data);
    renderRings(data.chain);
    renderFix(data.chain);
    renderActions(data);
    renderSource(data.source, data.notes);
  } finally {
    state.loading = false;
  }
}

// 启动
(async () => {
  await applyHostTheme();
  try {
    await hana.ready();
  } catch {
    /* 独立打开时没有宿主，通道探测会走内联样本 */
  }
  await refresh();
})();
