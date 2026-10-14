import { hana } from "./sdk.js";
import { mountAppUi, appUi, appUiIcon } from "./app-ui.js";

/* 仓库自动索引 · 面板
 * 契约见 ui/CONTRACT.md。
 *
 * 三条纪律：
 * 1. 一个 id 只出现一次；一个区块只有一份 DOM，状态用 data-status 表达。
 * 2. 所有数字都来自服务端，页面不自造。刷新即真相。
 * 3. 官方控件走 mountAppUi，重渲染前必须 destroy（destroyAll 收口）。
 */

const POLL_MS = 1000;
const PREVIEW_LINES = 60;
const SEARCH_LIMIT = 30;

// 构建标识：顶栏显示，用于一眼分辨宿主当前服务的是哪一版。
// 每次实质改动后更新此值，并同步到安装目录（见 sync-repo-auto-index.ps1）。
const BUILD = "v0.2 · 2026-10-13 20:00";

// ── 元素访问唯一入口 ──────────────────────────────────
const byId = (id) => document.getElementById(id);
const block = (name) => document.querySelector(`[data-block="${name}"]`);
const setStatus = (name, st) => { const b = block(name); if (b) b.dataset.status = st; };

// ── 官方控件挂载收口 ─────────────────────────────────
// 一个宿主元素可以挂多个控件（如操作区一排按钮），所以按元素记一组句柄。
const handles = new Map(); // hostId -> [handle]

function remember(hostId, hd) {
  const arr = handles.get(hostId) || [];
  arr.push(hd);
  handles.set(hostId, arr);
}

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
    remember(hostId, hd);
    return hd;
  } catch (err) {
    console.warn("mountAppUi 失败", hostId, name, err?.code || err?.message);
    return null;
  }
}

// 挂进已有容器的子元素（一个容器放多个控件时用）
function mountInto(el, name, props) {
  if (!el) return null;
  try {
    return mountAppUi(el, name, props);
  } catch (err) {
    console.warn("mountAppUi 失败", name, err?.code || err?.message);
    return null;
  }
}

function clearMounts() {
  for (const hostId of [...handles.keys()]) killHost(hostId);
}

// 签名去重：轮询每秒都会跑一遍渲染，内容没变就不重挂控件，避免闪烁与丢状态。
const sigs = new Map();
function changed(key, sig) {
  if (sigs.get(key) === sig) return false;
  sigs.set(key, sig);
  return true;
}

// ── 宿主主题：官方控件靠这些 CSS 变量取色 ───────────────
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

// ── 状态 ────────────────────────────────────────────
const state = {
  repos: [],
  selected: null,
  detail: null,      // { repo, index }
  dataDir: "",
  detailState: "idle", // idle | loading | ok | fail
  tab: "overview",
  polling: null,
  // 关系视图（契约 §2）：数据只在切到关系页 / 切仓 / 点刷新时拉，tick 不碰。
  graphMode: "map",   // map | list
  graph: null,        // GET /repo/:id/graph 的响应体
  graphRepo: null,    // 缓存键：这份 graph 属于哪个仓
  graphLoading: false,
  graphError: null,
  graphHandle: null,  // 网图组件句柄，重渲染前 destroy
  graphMapMod: null,  // 动态 import 的模块；false 表示导入失败过
  graphMapUnavailable: null, // 组件未就绪/渲染失败时的降级提示文案
  showIsolated: false,
  collapsedGroups: new Set(["__isolated__"]), // 默认折叠「无关系」组
  unresolvedOpen: false, // 清单里 unresolved 明细是否展开
  expandedNodes: new Set(),
  nodeCache: new Map(),  // path -> GET /repo/:id/node 响应
  rowEls: null,          // 清单渲染时的 id -> 行元素，供局部展开
  nodeIndex: new Map(),  // id -> node，供跳转分组
  pendingFocus: null,    // 从网图点节点跳清单后要滚到的那一行
  graphRenderToken: 0,   // 异步渲染防竞态
};

// ── 工具 ────────────────────────────────────────────
async function getJson(path, init) {
  const res = await hana.api.fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function relTime(iso) {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 0) return "刚刚";
  if (secs < 60) return secs + " 秒前";
  const m = Math.floor(secs / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

function dur(secs) {
  if (secs < 60) return secs + " 秒";
  return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
}

// 状态 → 官方 Badge tone（Badge 在 app-ui 里叫 ListRow 的 meta 用，这里用自定义 span）
const STATE_LABEL = {
  scanning: "扫描中", done: "就绪", canceled: "已打断", error: "出错", idle: "未登记",
};

// 两个子标记（态内徽标）
function badgesFor(r) {
  const p = r.progress || {};
  const out = [];
  if (r.status === "done" && (p.denied ?? 0) > 0) out.push({ k: "warn", t: `受阻 ${p.denied}` });
  if (r.status === "done" && p.capped) out.push({ k: "warn", t: "触顶 20000" });
  if (r.status === "scanning" && p.phase === "done") out.push({ k: "hot", t: "可疑" });
  return out;
}

function stateClass(r) {
  if (r.status === "done") return "s-ready";
  if (r.status === "scanning") return "s-scanning";
  if (r.status === "canceled") return "s-canceled";
  if (r.status === "error") return "s-error";
  return "s-canceled";
}

function repoOf(id) { return state.repos.find((r) => r.id === id) || null; }
function selectedRepo() { return repoOf(state.selected); }

// 有效行数：实时优先，其次快照
function entriesOf(r) {
  const d = state.detail;
  if (d?.repo?.id === r.id && d.index && typeof d.index.entries === "number") return d.index.entries;
  if (typeof r.index?.entries === "number") return r.index.entries;
  return null;
}

// ── A 侧栏 ──────────────────────────────────────────
function renderSide() {
  const box = byId("repolist");
  box.replaceChildren();
  byId("side-count").textContent = state.repos.length ? `${state.repos.length} 个` : "";

  if (!state.repos.length) {
    const p = document.createElement("p");
    p.className = "side-empty";
    p.textContent = "还没有登记仓库";
    box.appendChild(p);
    return;
  }

  for (const r of state.repos) {
    const p = r.progress || {};
    const item = document.createElement("button");
    item.type = "button";
    item.className = "p-item";
    item.setAttribute("aria-current", String(r.id === state.selected));

    const l1 = document.createElement("span");
    l1.className = "p-line1";
    const nm = document.createElement("span");
    nm.className = "p-name";
    nm.textContent = r.name || r.id;
    nm.title = r.dir || "";
    const badge = document.createElement("span");
    badge.className = "badge " + stateClass(r);
    badge.textContent = STATE_LABEL[r.status] || r.status || "未知";
    l1.append(nm, badge);
    for (const b of badgesFor(r)) {
      const sp = document.createElement("span");
      sp.className = "badge " + (b.k === "hot" ? "w-hot" : "w-warm");
      sp.textContent = b.t;
      l1.appendChild(sp);
    }

    const l2 = document.createElement("span");
    l2.className = "p-line2";
    const nums = document.createElement("span");
    nums.className = "p-nums";
    if (r.status === "scanning") nums.textContent = `已扫描 ${p.scanned ?? 0}`;
    else if (r.status === "done") nums.textContent = filesText(r) + " · " + entriesText(r);
    else if (r.status === "canceled") nums.textContent = `部分 ${p.total ?? 0}（下限）`;
    else if (r.status === "error") nums.textContent = "未获得";
    else nums.textContent = "—";
    const clock = document.createElement("span");
    clock.className = "p-clock";
    clock.textContent = relTime(r.finishedAt || r.updatedAt);
    clock.title = r.finishedAt || r.updatedAt || "";
    l2.append(nums, clock);

    item.append(l1, l2);
    item.addEventListener("click", () => selectRepo(r.id));
    box.appendChild(item);
  }
}

function filesText(r) {
  const p = r.progress || {};
  if ((p.denied ?? 0) > 0) return `${p.total ?? 0}（受阻，非全仓）`;
  if (p.capped) return `≥ ${p.total ?? 0}（触顶）`;
  return `${p.total ?? 0} 文件`;
}

function entriesText(r) {
  const e = entriesOf(r);
  return e == null ? "索引 —" : `索引 ${e} 行`;
}

function renderSummary() {
  const box = byId("summary");
  box.replaceChildren();
  if (!state.repos.length) return;
  const counts = { done: 0, scanning: 0, canceled: 0, error: 0 };
  let trustworthy = 0;
  let files = 0;
  for (const r of state.repos) {
    if (counts[r.status] != null) counts[r.status] += 1;
    const p = r.progress || {};
    if (r.status === "done" && !(p.denied > 0) && !p.capped) { trustworthy += 1; files += p.total ?? 0; }
  }
  const l1 = document.createElement("div");
  l1.className = "s-total";
  l1.textContent = `${state.repos.length} 个仓`;
  const l2 = document.createElement("div");
  l2.className = "s-counts";
  const parts = [];
  if (counts.done) parts.push(`就绪 ${counts.done}`);
  if (counts.scanning) parts.push(`扫描 ${counts.scanning}`);
  if (counts.canceled) parts.push(`打断 ${counts.canceled}`);
  if (counts.error) parts.push(`出错 ${counts.error}`);
  l2.textContent = parts.join(" · ") || "—";
  const l3 = document.createElement("div");
  l3.className = "s-counts";
  const skipped = state.repos.length - trustworthy;
  l3.textContent = skipped
    ? `合计 ${files} 文件（另有 ${skipped} 个仓未计入：受阻/触顶/打断/出错）`
    : `合计 ${files} 文件`;
  box.append(l1, l2, l3);
}

// ── B1 身份 ─────────────────────────────────────────
function renderIdentity(r) {
  byId("id-name").textContent = r?.name || r?.id || "—";
  byId("id-slug").textContent = r?.id || "";
  byId("id-dir").textContent = r?.dir || "（目录缺失，请重新登记）";
  byId("id-dir").title = r?.dir || "";

  const gitRow = byId("id-git-row");
  if (r?.gitUrl) { gitRow.hidden = false; byId("id-git").textContent = r.gitUrl; }
  else gitRow.hidden = true;

  byId("id-times").textContent = r
    ? `登记 ${relTime(r.registeredAt)} · 更新 ${relTime(r.updatedAt)}`
    : "";

  if (r) {
    const tone = r.status === "done" ? "ok" : r.status === "error" ? "bad" : r.status === "scanning" ? "warn" : "mute";
    if (changed("id-badge", r.status)) {
      killHost("id-badge-mount");
      const host = byId("id-badge-mount");
      host.replaceChildren();
      const sp = document.createElement("span");
      sp.className = `badge b-${tone}`;
      sp.textContent = STATE_LABEL[r.status] || r.status;
      host.appendChild(sp);
    }
    if (changed("copy-dir", "1")) {
      mount("copy-dir-mount", "Button", {
        children: "复制", size: "sm", variant: "ghost",
        disabled: !r.dir,
        onClick: () => copyText(r.dir, "目录路径已复制"),
      });
    }
    if (r.gitUrl && changed("copy-git", "1")) {
      mount("copy-git-mount", "Button", {
        children: "复制", size: "sm", variant: "ghost",
        onClick: () => copyText(r.gitUrl, "gitUrl 已复制"),
      });
    }
  }
}

async function copyText(text, okMsg) {
  if (!text) return;
  try {
    await hana.clipboard?.writeText?.(text);
    hana.toast?.show?.({ message: okMsg, tone: "success" });
  } catch {
    try { await navigator.clipboard.writeText(text); } catch {}
  }
}

// ── B2 进度 + 打断 ──────────────────────────────────
function renderProgress(r) {
  const st = !r ? "empty" : r.status;
  setStatus("progress", r ? (r.status === "done" ? "ready" : r.status) : "empty");

  const note = byId("progress-note");
  const indet = byId("progress-indet");
  const counters = byId("progress-counters");
  counters.replaceChildren();
  indet.hidden = true;

  if (!r) {
    note.textContent = "";
    mountNote(counters, "尚未开始扫描");
    setStatus("progress", "empty");
    return;
  }

  const p = r.progress || {};

  if (r.status === "scanning") {
    const started = r.startedAt ? new Date(r.startedAt).getTime() : null;
    const secs = started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : null;
    note.textContent = `扫描中${secs != null ? ` · 已运行 ${dur(secs)}` : ""}${r.taskId ? ` · 任务 ${r.taskId.slice(0, 12)}` : ""}`;
    indet.hidden = false;
    addCounter(counters, "已扫描条目", p.scanned ?? 0, "文件 + 目录");
    addCounter(counters, "已发现文件", p.total ?? 0, "扫描结束前不是终值");
    addCounter(counters, "目录", p.dirCount ?? 1, "根计入 1；无扩展名文件可能误判");
    addCounter(counters, "读不到", "结束才知", "list 失败的目录数");
    if (changed("progress-actions", r.id)) {
      mount("progress-actions", "Button", {
        children: "打断扫描", variant: "danger", size: "sm", iconLeft: appUiIcon("failure"),
        onClick: () => doCancel(r.id),
      });
    }
    return;
  }

  if (r.status === "done") {
    note.textContent = `上次扫描完成 ${relTime(r.finishedAt)}`;
    setStatus("progress", "ready");
    return;
  }
  if (r.status === "canceled") {
    note.textContent = "已打断 · 计数为部分值，denied 未统计";
    setStatus("progress", "canceled");
    return;
  }
  if (r.status === "error") {
    note.textContent = "进度数据不可用";
    setStatus("progress", "error");
    return;
  }
  setStatus("progress", "empty");
}

function mountNote(host, text) {
  const p = document.createElement("p");
  p.className = "block-empty";
  p.textContent = text;
  host.appendChild(p);
}

function addCounter(host, label, value, hint) {
  const d = document.createElement("div");
  d.className = "counter";
  const l = document.createElement("span"); l.className = "counter-label"; l.textContent = label;
  const v = document.createElement("span");
  // 非数字值（如“结束才知”）用小字，避免大字把版面撞歪
  const numeric = typeof value === "number" || /^[\d\s≥（）部分下\-—]+$/.test(String(value));
  v.className = "counter-value mono" + (numeric ? "" : " counter-text");
  v.textContent = String(value);
  const h = document.createElement("span"); h.className = "counter-hint"; h.textContent = hint || "";
  d.append(l, v, h);
  host.appendChild(d);
}

// ── B3 统计 ─────────────────────────────────────────
function renderStats(r) {
  const host = byId("stats-mount");
  const foot = byId("stats-foot");
  const note = byId("stats-note");

  if (!r) {
    setStatus("stats", "empty");
    note.textContent = "";
    foot.textContent = "";
    if (changed("stats-mount", "empty")) { killHost("stats-mount"); host.replaceChildren(); mountNote(host, "未清点"); }
    return;
  }

  const p = r.progress || {};
  const e = entriesOf(r);

  let fileV, dirV, deniedV, entryV, st, footText;
  if (r.status === "scanning") {
    st = "scanning";
    fileV = `已发现 ${p.total ?? 0}`;
    dirV = String(p.dirCount ?? 0);
    deniedV = "结束才知";
    entryV = "扫描结束后才读";
    footText = "有效行 = 三个 aoci 文件合并后，去掉空行与 # 开头的注释行之后的行数。不是语义条目数。";
  } else if (r.status === "done") {
    st = "ready";
    fileV = (p.denied > 0) ? `${p.total ?? 0}（受阻，非全仓）` : p.capped ? `≥ ${p.total ?? 0}（触顶 20000）` : String(p.total ?? 0);
    dirV = String(p.dirCount ?? 0);
    deniedV = String(p.denied ?? 0);
    entryV = e == null ? "—" : String(e);
    footText = "有效行 = 三个 aoci 文件合并后，去掉空行与 # 开头的注释行之后的行数。不是语义条目数。语义条目由 Agent 经 aoci 链路创作，插件只清点。";
  } else if (r.status === "canceled") {
    st = "canceled";
    fileV = `部分 ${p.total ?? 0}（下限）`;
    dirV = `部分 ${p.dirCount ?? 0}（下限）`;
    deniedV = "未统计";
    entryV = e == null ? "—" : String(e);
    footText = "已打断：文件数与目录数只是清点到那一刻的下限，denied 在打断分支不入库。";
  } else if (r.status === "error") {
    st = "error";
    fileV = "未获得";
    dirV = "—"; deniedV = "—"; entryV = "—";
    footText = "扫描出错，本次没有可用清点结果。";
  } else {
    st = "empty";
    fileV = "—"; dirV = "—"; deniedV = "—"; entryV = "—";
    footText = "未清点。";
  }

  setStatus("stats", st);
  note.textContent = r.status === "done" && p.denied > 0 ? "本次有目录读不到，数字只覆盖能读到的部分" : "";
  const sig = `${st}|${fileV}|${dirV}|${deniedV}|${entryV}`;
  if (changed("stats-mount", sig)) {
    killHost("stats-mount");
    host.replaceChildren();
    // 官方 Grid 的 minColumnWidth 实测不生效（永远 2 列），统计四数自己控列。
    const grid = document.createElement("div");
    grid.className = "stat-grid";
    host.appendChild(grid);
    const cell = (label, value, hint) => {
      const d = document.createElement("div");
      d.className = "stat-cell";
      const l = document.createElement("span"); l.className = "stat-label"; l.textContent = label;
      const v = document.createElement("span"); v.className = "stat-value mono"; v.textContent = value;
      d.append(l, v);
      if (hint) { const h = document.createElement("span"); h.className = "stat-hint"; h.textContent = hint; d.appendChild(h); }
      grid.appendChild(d);
    };
    cell("文件", fileV, "progress.total");
    cell("目录", dirV, "progress.dirCount");
    cell("读不到", deniedV, "progress.denied");
    cell("索引有效行", entryV, "index.entries");
  }
  foot.textContent = footText;
}

// ── B4 索引文件 ─────────────────────────────────────
function renderIndex(r) {
  const host = byId("index-info");
  host.replaceChildren();
  const time = byId("index-time");
  const foot = byId("index-foot");

  if (!r) { setStatus("index", "empty"); time.textContent = ""; mountNote(host, "未读到索引"); return; }

  const snap = r.index;
  const d = state.detail;
  const live = d?.repo?.id === r.id ? d.index : null;

  const addRow = (k, v) => {
    const row = document.createElement("div");
    row.className = "kv-row";
    const kk = document.createElement("span"); kk.className = "kv-k"; kk.textContent = k;
    const vv = document.createElement("span"); vv.className = "kv-v mono"; vv.textContent = v;
    row.append(kk, vv); host.appendChild(row);
  };

  if (r.status === "scanning") {
    setStatus("index", "scanning");
    time.textContent = "";
    mountNote(host, "扫描结束后才读索引");
    foot.textContent = "";
    return;
  }

  if (live && live.hasIndex) {
    setStatus("index", "ready");
    const names = (live.files && live.files.length ? live.files : [live.file]).filter(Boolean);
    time.textContent = `实时读取于 ${relTime(new Date().toISOString())}`;
    addRow("主索引", live.file || "—");
    addRow("合并来源", names.join(" → ") || "—");
    addRow("有效行", String(live.entries ?? "—"));
    foot.textContent = "有效行 = 三个 aoci 文件合并后，去掉空行与 # 开头的注释行之后的行数。不是语义条目数。只查仓库根目录，不递归子目录。";
    return;
  }

  if (snap && snap.hasIndex) {
    setStatus("index", "canceled");
    time.textContent = `快照 ${relTime(r.finishedAt || r.updatedAt)}`;
    addRow("快照索引", snap.file || "—");
    addRow("有效行", String(snap.entries ?? "—"));
    foot.textContent = "本次未读到索引，下面是上次扫描时的快照，可能已经过期（文件被删、改名或读取失败都会这样）。";
    return;
  }

  setStatus("index", "empty");
  time.textContent = "";
  mountNote(host, "未读到索引：可能不存在，也可能存在但读取失败");
  foot.textContent = "只查仓库根目录下的 aoci.code.txt / aoci.meta.txt / aoci.txt，不递归子目录。";
}

// ── B5 预览 ─────────────────────────────────────────
function renderPreview(r) {
  const body = byId("preview-body");
  const count = byId("preview-count");
  const d = state.detail;
  const live = d?.repo?.id === r?.id ? d.index : null;

  byId("preview-actions").replaceChildren();

  if (!r) { setStatus("preview", "empty"); count.textContent = ""; body.textContent = "未读到索引"; return; }

  if (r.status === "scanning") {
    setStatus("preview", "scanning");
    count.textContent = "";
    body.textContent = "未读索引（扫描结束后才读）";
    return;
  }

  if (live && live.hasIndex) {
    const lines = live.preview || [];
    setStatus("preview", "ready");
    count.textContent = lines.length >= PREVIEW_LINES
      ? `前 ${PREVIEW_LINES} 条有效行（已过滤空行与注释），共 ${live.entries ?? "?"} 行`
      : `前 ${lines.length} 条有效行（已过滤空行与注释）`;
    body.textContent = lines.join("\n");
    mount("preview-actions", "Button", {
      children: "复制全部", size: "sm", variant: "secondary",
      onClick: () => copyText(lines.join("\n"), "预览已复制"),
    });
    return;
  }

  const snap = r.index;
  if (snap && snap.hasIndex) {
    setStatus("preview", "canceled");
    count.textContent = `上次快照 ${relTime(r.finishedAt || r.updatedAt)}`;
    body.textContent = (snap.preview || []).join("\n") || "（快照无预览）";
    return;
  }

  setStatus("preview", "empty");
  count.textContent = "";
  body.textContent = "未读到索引，没有可预览的内容";
}

// ── B6 搜索 ─────────────────────────────────────────
function renderSearch(r, keepInput = true) {
  const q = byId("search-q");
  byId("scope-name").textContent = r ? `本仓：${r.name || r.id}` : "";
  const results = byId("search-results");

  const canSearch = !!r && r.status !== "scanning" && (state.detail?.index?.hasIndex ?? r.index?.hasIndex);
  mount("search-submit-mount", "Button", {
    children: "搜", size: "sm", variant: "primary",
    disabled: !canSearch,
    onClick: () => doSearch(),
  });
  if (!keepInput) q.value = "";

  if (!r) { setStatus("search", "empty"); results.replaceChildren(); return; }
  if (r.status === "scanning") {
    setStatus("search", "scanning");
    renderSearchPlaceholder("索引正在被扫描，稍后再搜（可搜，但可能未更新）");
    return;
  }
  if (!canSearch) {
    setStatus("search", "empty");
    renderSearchPlaceholder("本仓还没有可搜的索引");
    return;
  }
  setStatus("search", "ready");
  if (!results.childElementCount) renderSearchPlaceholder("输入关键词");
}

function renderSearchPlaceholder(text) {
  const results = byId("search-results");
  results.replaceChildren();
  const p = document.createElement("p");
  p.className = "search-empty";
  p.textContent = text;
  results.appendChild(p);
}

async function doSearch() {
  const q = byId("search-q").value.trim();
  const id = state.selected;
  if (!id) return;
  if (!q) { renderSearchPlaceholder("输入关键词"); return; }
  const results = byId("search-results");
  results.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "search-empty";
  loading.textContent = "搜索中…";
  results.appendChild(loading);

  try {
    const body = await getJson(`repo/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`);
    const r = repoOf(id);
    const hits = body.hits || [];
    const node = document.createDocumentFragment();

    const h4 = document.createElement("h4");
    h4.className = "search-title";
    h4.textContent = hits.length >= SEARCH_LIMIT
      ? `「${q}」命中 至少 ${hits.length} 行（已截断至上限 ${SEARCH_LIMIT}，请细化关键词）`
      : `「${q}」命中 ${hits.length} 行`;
    node.appendChild(h4);

    if (!hits.length) {
      const p = document.createElement("p");
      p.className = "search-empty";
      p.textContent = body.file ? "在本仓索引里没有搜到。" : "本仓还没有可搜的索引。";
      node.appendChild(p);
    } else {
      for (const it of hits) {
        const row = document.createElement("div");
        row.className = "search-hit";
        const ln = document.createElement("span");
        ln.className = "hit-line";
        ln.textContent = `第 ${it.line} 行`;
        const tx = document.createElement("span");
        tx.className = "hit-tx";
        tx.textContent = it.text || "";
        row.append(ln, tx);
        node.appendChild(row);
      }
      const foot = document.createElement("p");
      foot.className = "foot-note";
      foot.textContent = "行号是三个 aoci 文件合并后的虚拟文档行号；行内容最多显示 240 字符。";
      node.appendChild(foot);
    }
    results.replaceChildren(node);
    setStatus("search", "ready");
    r; // 保留引用，便于将来加高亮
  } catch (err) {
    results.replaceChildren();
    const p = document.createElement("p");
    p.className = "search-error";
    p.textContent = `搜失败：${err?.message || err}`;
    results.appendChild(p);
    setStatus("search", "error");
  }
}

// ── B7 轨迹 ─────────────────────────────────────────
async function renderTrace(r) {
  const body = byId("trace-body");
  const pathEl = byId("trace-path");
  const file = r ? `${state.dataDir}/traces/${r.id}.jsonl` : "";
  pathEl.textContent = file;
  if (r && changed("trace-actions", r.id)) {
    mount("trace-actions", "Button", {
      children: "复制路径", size: "sm", variant: "ghost",
      onClick: () => copyText(file, "轨迹路径已复制"),
    });
  }

  if (!r) { setStatus("trace", "empty"); body.textContent = "尚未开始过扫描"; return; }

  if (r.status === "scanning") {
    setStatus("trace", "scanning");
    body.textContent = "轨迹正在追加，扫完再看";
    return;
  }
  if (r.status === "error") setStatus("trace", "error");

  try {
    const data = await getJson(`repo/${encodeURIComponent(r.id)}/trace?tail=200`);
    const lines = data.lines || [];
    if (!lines.length) {
      setStatus("trace", "empty");
      body.textContent = "尚未开始过扫描";
      return;
    }
    if (r.status !== "error") setStatus("trace", "ready");
    body.textContent = lines
      .map((l) => (l.ev ? `${l.at || ""} ${l.ev}${l.dir ? " " + l.dir : ""}${l.n != null ? ` (${l.n})` : ""}${l.error ? " ERR " + l.error : ""}` : JSON.stringify(l)))
      .join("\n");
  } catch (err) {
    setStatus("trace", "error");
    body.textContent = `轨迹不可读：${err?.message || err}`;
  }
}

// ── B8 操作 ─────────────────────────────────────────
function renderOps(r) {
  const host = byId("ops-mount");

  if (!r) {
    setStatus("ops", "empty");
    if (changed("ops-mount", "empty")) { killHost("ops-mount"); host.replaceChildren(); mountNote(host, "未选中仓库"); }
    return;
  }

  if (r.status === "scanning") {
    setStatus("ops", "scanning");
    // 扫描态下打断钮已在「扫描」区，这里不重复；只占位说明
    if (changed("ops-mount", "scr-" + r.id)) {
      killHost("ops-mount");
      host.replaceChildren();
      mountNote(host, "扫描进行中，打断请用上方「扫描」区的红色按钮。");
    }
    return;
  }

  setStatus("ops", r.status === "error" ? "error" : r.status === "canceled" ? "canceled" : "ready");
  const sig = `ops|${r.id}|${r.status}|${state.detailState}|${state.dataDir}`;
  if (!changed("ops-mount", sig)) return;

  killHost("ops-mount");
  host.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "ops-row";
  host.appendChild(wrap);

  const mk = (label, variant, fn) => {
    const holder = document.createElement("span");
    wrap.appendChild(holder);
    mountInto(holder, "Button", { children: label, variant, size: "sm", onClick: fn });
  };

  mk("重新扫描", "primary", () => doRescan(r.id));
  mk("复制目录路径", "ghost", () => copyText(r.dir, "目录路径已复制"));
  mk("打开登记表", "ghost", () => copyText(`${state.dataDir}/projects.json`, "登记表路径已复制"));

  const p = document.createElement("p");
  p.className = "foot-note";
  p.textContent = "删仓：暂不支持面板删除；删仓即删注册，不碰源目录。";
  host.appendChild(p);
}

// ── C 环境 ──────────────────────────────────────────
function renderSys() {
  const sys = byId("sys");
  sys.hidden = !state.repos.length;
  byId("sys-datadir").textContent = `${state.dataDir}/projects.json`;
  const last = state.repos.map((r) => r.updatedAt).filter(Boolean).sort().pop();
  byId("sys-write").textContent = last ? relTime(last) : "—";
  const scanningRepo = state.repos.find((r) => r.status === "scanning");
  byId("sys-task").textContent = scanningRepo?.taskId ? `${scanningRepo.taskId.slice(0, 16)}…` : "空闲";
  const denied = state.repos.reduce((n, r) => n + (r.progress?.denied || 0), 0);
  byId("sys-perms").textContent = denied > 0
    ? `${denied} 个目录列举失败 → 检查 设置 → 应用 → App 权限（app/resources.read）`
    : "app/resources.read 已放行";
  byId("sys-limits").textContent = "上限 20000 文件 · 每 200 条目落盘 · 排除 23 类目录与点文件";
}

// ── 关系视图（契约 §2 / §2.5） ─────────────────────
// 展示层字典（取自 aoci.meta.txt，见 GRAPH-CONTRACT §0）。
const LAYER_NAMES = {
  C: "共享基础", E: "入口边界", A: "应用编排", D: "领域逻辑", K: "算法计算",
  M: "中间件", P: "持久化", I: "集成适配", R: "运行基础", L: "库与 SDK",
  F: "声明配置", O: "运维交付", T: "测试验证", S: "文档规范", X: "开发工具", Z: "其他",
};
const MODULE_NAMES = {
  G: "跨域通用", U: "用户交互", B: "核心业务", D: "数据状态", I: "身份权限",
  N: "网络协议", M: "消息事件", S: "安全隐私", C: "配置策略", O: "可观测性",
  R: "可靠性恢复", P: "性能资源", W: "流程调度", A: "分析智能", H: "硬件设备",
  L: "本地化", V: "构建发布", Q: "质量保障", E: "扩展插件", Z: "其他",
};
const layerLabel = (c) => (c ? `${c} · ${LAYER_NAMES[c] || "未知"}` : "未标层");
const moduleLabel = (c) => (c ? `${c} · ${MODULE_NAMES[c] || "未知"}` : "未标模块");

function summarize(text, n = 64) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t || t === "-") return "—";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 缓存作废：切仓 / 点刷新时调。关系不随扫描变，但用户明确要求刷新时重拉。
function invalidateGraph() {
  state.graph = null;
  state.graphRepo = null;
  state.graphError = null;
  state.graphMapUnavailable = null;
  state.expandedNodes.clear();
  state.nodeCache.clear();
  state.rowEls = null;
  state.nodeIndex = new Map();
  state.pendingFocus = null;
  state.collapsedGroups = new Set(["__isolated__"]);
  if (state.graphHandle) { try { state.graphHandle.destroy(); } catch {} state.graphHandle = null; }
}

// 唯一数据入口：只在切到关系页 / 切仓 / 刷新时拉，tick 不碰（契约 §2）。
async function ensureGraph() {
  const id = state.selected;
  if (!id) return;
  if (state.graphRepo === id && state.graph) { renderGraph(); return; }
  if (state.graphLoading) return;
  state.graphLoading = true;
  state.graphError = null;
  renderGraphNote();
  setStatus("graph", "loading");
  renderGraph();
  try {
    const body = await getJson(`repo/${encodeURIComponent(id)}/graph`);
    if (state.selected !== id) return; // 期间切了仓，丢弃
    state.graph = body;
    state.graphRepo = id;
    state.nodeIndex = new Map((body.nodes || []).map((n) => [n.id, n]));
  } catch (err) {
    if (state.selected !== id) return;
    state.graph = null;
    state.graphRepo = null;
    state.graphError = err?.message || String(err);
  } finally {
    state.graphLoading = false;
    if (state.selected === id) renderGraph();
  }
}

function renderGraphNote() {
  const note = byId("graph-note");
  if (!note) return;
  if (state.graphLoading) { note.textContent = "读取中…"; return; }
  if (state.graphError) { note.textContent = "读取失败"; return; }
  const s = state.graph?.stats;
  if (!s) { note.textContent = ""; return; }
  const bits = [`${s.nodes ?? "?"} 对象`, `${s.edges ?? "?"} 条关系`];
  if (s.isolated != null) bits.push(`${s.isolated} 无关系`);
  if (s.unresolved) bits.push(`${s.unresolved} 未解析`);
  note.textContent = bits.join(" · ");
}

// 二级切换（官方 Tabs）。降级切到清单时重挂以反映选中项。
function renderGraphModeTabs() {
  if (!changed("graph-mode-mount", state.graphMode)) return;
  mount("graph-mode-mount", "Tabs", {
    items: [
      { value: "map", label: "关系网" },
      { value: "list", label: "清单" },
    ],
    value: state.graphMode,
    onChange: (v) => {
      state.graphMode = v;
      // 用户主动切回网图：清掉降级标记，重试 import
      if (v === "map") { state.graphMapMod = null; state.graphMapUnavailable = null; }
      renderGraph();
    },
  });
}

function renderGraph() {
  const host = byId("graph-view");
  if (!host) return;

  // 离开网图：销毁组件句柄（契约：重渲染前 destroy）
  if (state.graphMode !== "map" && state.graphHandle) {
    try { state.graphHandle.destroy(); } catch {}
    state.graphHandle = null;
  }
  // 组件未就绪 → 强制清单模式（降级，不让面板报错）
  if (state.graphMapUnavailable && state.graphMode === "map") state.graphMode = "list";

  renderGraphModeTabs();
  renderGraphNote();

  if (!state.selected) { host.dataset.mode = "none"; setStatus("graph", "empty"); host.replaceChildren(msgEl("未选中仓库")); return; }
  if (state.graphLoading) { host.dataset.mode = "loading"; setStatus("graph", "loading"); host.replaceChildren(skeletonEl()); return; }
  if (state.graphError) {
    host.dataset.mode = "error"; setStatus("graph", "error");
    host.replaceChildren(errBox(`关系数据读取失败：${state.graphError}`));
    return;
  }
  const g = state.graph;
  if (!g) { host.dataset.mode = "empty"; setStatus("graph", "empty"); host.replaceChildren(msgEl("尚无关系数据")); return; }
  if (!g.nodes || !g.nodes.length) { host.dataset.mode = "empty"; setStatus("graph", "empty"); host.replaceChildren(msgEl("本仓没有可显示的关系对象")); return; }

  host.dataset.mode = state.graphMode;
  if (state.graphMode === "list") renderGraphList(g);
  else renderGraphMap(g);
}

// —— 网图模式 ——
function renderGraphMap(g) {
  const host = byId("graph-view");
  if (state.graphHandle) { try { state.graphHandle.destroy(); } catch {} state.graphHandle = null; }
  host.replaceChildren();
  setStatus("graph", "ready");

  const banner = state.graphMapUnavailable ? degradeEl(state.graphMapUnavailable) : null;
  if (banner) host.appendChild(banner);

  const token = ++state.graphRenderToken;
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  host.appendChild(stage);

  (async () => {
    let mod = state.graphMapMod;
    if (!mod) {
      try {
        mod = await import("./graph-map.js");
        state.graphMapMod = mod;
      } catch (err) {
        state.graphMapMod = null;
        state.graphMapUnavailable = `关系网组件（graph-map.js）尚未就绪：${err?.message || err}`;
        if (token === state.graphRenderToken) { state.graphMode = "list"; renderGraph(); }
        return;
      }
    }
    if (token !== state.graphRenderToken || state.graphMode !== "map") return;
    // B 路悬置：组件用 clientWidth/Height 量尺寸，隐藏容器首帧为空。
    // 只在关系页可见时挂载；并等容器拿到非零尺寸再交给组件。
    if (state.tab !== "relations") return;
    if (!(await waitForSize(stage))) {
      if (token !== state.graphRenderToken) return;
      state.graphMapUnavailable = "关系网容器没有可测量的尺寸";
      state.graphMode = "list";
      renderGraph();
      return;
    }
    if (token !== state.graphRenderToken || state.graphMode !== "map") return;
    if (!mod || typeof mod.renderGraphMap !== "function") {
      state.graphMapUnavailable = "关系网组件未导出 renderGraphMap";
      if (token === state.graphRenderToken) { state.graphMode = "list"; renderGraph(); }
      return;
    }
    let handle;
    try {
      handle = mod.renderGraphMap(stage, g, {
        showIsolated: state.showIsolated ?? false,
        onSelectNode: (nid) => focusInList(nid),
      });
    } catch (err) {
      state.graphMapUnavailable = `关系网渲染失败：${err?.message || err}`;
      if (token === state.graphRenderToken) { state.graphMode = "list"; renderGraph(); }
      return;
    }
    if (token !== state.graphRenderToken || state.graphMode !== "map") {
      try { handle?.destroy?.(); } catch {}
      return;
    }
    state.graphHandle = handle;

    // 诚实数字：组件实际画了多少
    const st = handle?.stats;
    if (st) {
      const foot = document.createElement("p");
      foot.className = "foot-note";
      foot.textContent = `实际绘制 ${st.drawn ?? "?"} 个对象 · ${st.edges ?? "?"} 条关系${st.hidden != null ? ` · 折叠 ${st.hidden} 个无关系对象` : ""}`;
      host.appendChild(foot);
    }

    // 孤岛折叠提示行（契约 §2）
    const isoCount = g.stats?.isolated ?? 0;
    if (isoCount > 0) {
      const line = document.createElement("div");
      line.className = "graph-iso-note";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mini-btn";
      b.textContent = state.showIsolated
        ? "收起无关系对象"
        : `另有 ${isoCount} 个对象没有关系 [展开]`;
      b.addEventListener("click", () => { state.showIsolated = !state.showIsolated; renderGraph(); });
      line.appendChild(b);
      host.appendChild(line);
    }
  })();
}

// —— 清单模式 ——
function renderGraphList(g) {
  const host = byId("graph-view");
  host.replaceChildren();
  setStatus("graph", "ready");
  state.rowEls = new Map();
  if (state.graphHandle) { try { state.graphHandle.destroy(); } catch {} state.graphHandle = null; }

  if (state.graphMapUnavailable) host.appendChild(degradeEl(state.graphMapUnavailable));

  const nodes = g.nodes || [];
  const deg = (n) => (n.inDeg || 0) + (n.outDeg || 0);
  const groupKey = (n) => ((n.inDeg ?? 0) === 0 && (n.outDeg ?? 0) === 0) ? "__isolated__" : (n.layer || "Z");

  const groups = new Map();
  const isolated = [];
  for (const n of nodes) {
    if (groupKey(n) === "__isolated__") { isolated.push(n); continue; }
    const k = groupKey(n);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }

  // 从网图跳过来时，确保目标所在组展开
  if (state.pendingFocus) {
    const target = state.nodeIndex.get(state.pendingFocus);
    if (target) state.collapsedGroups.delete(groupKey(target));
  }

  const frag = document.createDocumentFragment();

  // unresolved 必须显示（诚实性）
  const unList = g.unresolved || g.unresolvedSamples || [];
  const unCount = g.stats?.unresolved ?? unList.length;
  if (unCount > 0) frag.appendChild(unresolvedEl(unCount, unList));

  // 层分组：按组内总度数降序（最热闹的层在前）
  const ordered = [...groups.entries()]
    .map(([k, arr]) => [k, arr.slice().sort((a, b) => deg(b) - deg(a))])
    .sort((a, b) => {
      const sa = a[1].reduce((s, n) => s + deg(n), 0);
      const sb = b[1].reduce((s, n) => s + deg(n), 0);
      return sb - sa || b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });

  for (const [k, arr] of ordered) frag.appendChild(groupEl(k, layerLabel(k), arr));

  // 孤岛单独一组，默认折叠
  if (isolated.length) {
    isolated.sort((a, b) => a.name.localeCompare(b.name));
    frag.appendChild(groupEl("__isolated__", `无关系（${isolated.length}）`, isolated));
  }

  host.appendChild(frag);

  // 定位（网图点击跳来 / 边列表点对端）
  if (state.pendingFocus) {
    const id = state.pendingFocus;
    state.pendingFocus = null;
    const el = state.rowEls.get(id);
    if (el) {
      el.classList.add("rel-row-flash");
      el.scrollIntoView({ block: "center" });
      setTimeout(() => el.classList.remove("rel-row-flash"), 1400);
      toggleNodeRow(id, el);
    }
  }
}

function groupEl(key, title, arr) {
  const wrap = document.createElement("div");
  wrap.className = "rel-group";
  const collapsed = state.collapsedGroups.has(key);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "rel-group-head";
  head.setAttribute("aria-expanded", String(!collapsed));
  const caret = document.createElement("span"); caret.className = "rel-caret"; caret.textContent = collapsed ? "▸" : "▾";
  const t = document.createElement("span"); t.className = "rel-group-title"; t.textContent = title;
  const c = document.createElement("span"); c.className = "rel-group-count mono"; c.textContent = String(arr.length);
  head.append(caret, t, c);

  const body = document.createElement("div");
  body.className = "rel-group-body";
  body.hidden = collapsed;
  for (const n of arr) body.appendChild(nodeRow(n));

  head.addEventListener("click", () => {
    const isCollapsed = state.collapsedGroups.has(key);
    if (isCollapsed) state.collapsedGroups.delete(key); else state.collapsedGroups.add(key);
    body.hidden = !isCollapsed;
    head.setAttribute("aria-expanded", String(isCollapsed));
    caret.textContent = isCollapsed ? "▾" : "▸";
  });

  wrap.append(head, body);
  return wrap;
}

function nodeRow(n) {
  const row = document.createElement("div");
  row.className = "rel-row";
  row.dataset.id = n.id;
  row.dataset.open = "false";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "rel-row-main";
  const name = document.createElement("span"); name.className = "rel-name"; name.textContent = n.name || n.id; name.title = n.id || "";
  const dir = document.createElement("span"); dir.className = "rel-dir mono"; dir.textContent = n.dir || ""; dir.title = n.dir || "";
  const f = document.createElement("span"); f.className = "rel-f"; f.textContent = summarize(n.F);
  const dg = document.createElement("span"); dg.className = "rel-deg mono"; dg.textContent = `入 ${n.inDeg ?? 0} / 出 ${n.outDeg ?? 0}`;
  main.append(name, dir, f, dg);
  main.addEventListener("click", () => toggleNodeRow(n.id, row));

  const detail = document.createElement("div");
  detail.className = "rel-detail";
  detail.hidden = true;

  row.append(main, detail);
  state.rowEls.set(n.id, row);
  return row;
}

async function toggleNodeRow(id, row) {
  const detail = row.querySelector(".rel-detail");
  if (!detail) return;
  const open = row.dataset.open === "true";
  if (open) {
    row.dataset.open = "false";
    detail.hidden = true;
    state.expandedNodes.delete(id);
    return;
  }
  row.dataset.open = "true";
  detail.hidden = false;
  state.expandedNodes.add(id);
  if (detail.dataset.loaded === "true") return;

  detail.replaceChildren(msgEl("读取节点…"));
  const repo = state.selected;
  const key = `${repo}|${id}`;
  try {
    let data = state.nodeCache.get(key);
    if (!data) {
      data = await getJson(`repo/${encodeURIComponent(repo)}/node?path=${encodeURIComponent(id)}`);
      state.nodeCache.set(key, data);
    }
    if (row.dataset.open !== "true") return; // 期间被收起
    detail.replaceChildren(nodeDetailEl(data));
    detail.dataset.loaded = "true";
  } catch (err) {
    detail.replaceChildren(errBox(`节点读取失败：${err?.message || err}`));
  }
}

function nodeDetailEl(data) {
  const n = data.node || {};
  const wrap = document.createElement("div");
  wrap.className = "rel-detail-body";

  const meta = document.createElement("div");
  meta.className = "rel-detail-meta mono";
  meta.textContent = [n.id, layerLabel(n.layer), moduleLabel(n.module),
    n.importance != null ? `重要度 ${n.importance}` : "", n.scale ? `规模 ${n.scale}` : ""].filter(Boolean).join(" · ");
  wrap.appendChild(meta);

  for (const [k, v] of [["F", n.F], ["R", n.R], ["A", n.A], ["S", n.S]]) {
    const row = document.createElement("div");
    row.className = "rel-field";
    const kk = document.createElement("span"); kk.className = "rel-field-k"; kk.textContent = k;
    const vv = document.createElement("span"); vv.className = "rel-field-v";
    vv.textContent = (v && v !== "-") ? v : "—";
    row.append(kk, vv);
    wrap.appendChild(row);
  }

  wrap.appendChild(edgeSection("出边", data.out));
  wrap.appendChild(edgeSection("入边", data.in));
  return wrap;
}

function edgeSection(title, items) {
  const sec = document.createElement("div");
  sec.className = "rel-edges";
  const h = document.createElement("div");
  h.className = "rel-edges-title";
  h.textContent = `${title}（${items?.length || 0}）`;
  sec.appendChild(h);
  if (!items || !items.length) {
    const p = document.createElement("p"); p.className = "rel-edges-empty"; p.textContent = "无";
    sec.appendChild(p);
    return sec;
  }
  const list = document.createElement("div");
  list.className = "rel-edge-list";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rel-edge";
    b.title = it.id || "";
    const nm = document.createElement("span"); nm.className = "rel-edge-name"; nm.textContent = it.name || it.id;
    const tag = document.createElement("span"); tag.className = "rel-edge-tag mono"; tag.textContent = `${it.layer || "?"}${it.module || ""}`;
    const f = document.createElement("span"); f.className = "rel-edge-f"; f.textContent = summarize(it.F, 48);
    b.append(nm, tag, f);
    b.addEventListener("click", (e) => { e.stopPropagation(); focusInList(it.id); });
    list.appendChild(b);
  }
  sec.appendChild(list);
  return sec;
}

function unresolvedEl(count, list) {
  const box = document.createElement("div");
  box.className = "rel-unresolved";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "rel-unresolved-head";
  const caret = document.createElement("span"); caret.className = "rel-caret"; caret.textContent = state.unresolvedOpen ? "▾" : "▸";
  const t = document.createElement("span"); t.textContent = `${count} 个 R 目标指向未索引的对象`;
  head.append(caret, t);
  const body = document.createElement("div");
  body.className = "rel-unresolved-body";
  body.hidden = !state.unresolvedOpen;
  if (!list.length) {
    const p = document.createElement("p"); p.className = "rel-edges-empty"; p.textContent = "（后端未返回明细）";
    body.appendChild(p);
  } else {
    for (const s of list) {
      const code = document.createElement("code");
      code.textContent = s;
      body.appendChild(code);
    }
    if (list.length < count) {
      const p = document.createElement("p"); p.className = "rel-edges-empty"; p.textContent = `（共 ${count} 条，列出前 ${list.length} 条）`;
      body.appendChild(p);
    }
  }
  head.addEventListener("click", () => {
    state.unresolvedOpen = !state.unresolvedOpen;
    body.hidden = !state.unresolvedOpen;
    caret.textContent = state.unresolvedOpen ? "▾" : "▸";
  });
  box.append(head, body);
  return box;
}

// 从网图/边列表跳到清单并定位
function focusInList(id) {
  if (!id) return;
  state.graphMode = "list";
  state.pendingFocus = id;
  renderGraphModeTabs();
  renderGraph();
}

// —— 关系区小工具 ——
function msgEl(text) {
  const p = document.createElement("p");
  p.className = "block-empty";
  p.textContent = text;
  return p;
}
function errBox(text) {
  const p = document.createElement("p");
  p.className = "rel-error";
  p.textContent = text;
  return p;
}
function degradeEl(text) {
  const d = document.createElement("p");
  d.className = "rel-degrade";
  d.textContent = `${text}（已自动切到清单模式）`;
  return d;
}
function skeletonEl() {
  const d = document.createElement("div");
  d.className = "rel-skeleton";
  for (let i = 0; i < 5; i++) d.appendChild(document.createElement("span"));
  return d;
}

// 等容器拿到非零尺寸（最多等几帧）。隐藏→可见的 reflow 可能滞后一帧。
function waitForSize(el, tries = 12) {
  return new Promise((resolve) => {
    let n = 0;
    const check = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) { resolve(true); return; }
      if (++n >= tries) { resolve(el.clientWidth > 0 && el.clientHeight > 0); return; }
      requestAnimationFrame(check);
    };
    check();
  });
}

// ── 页签 ────────────────────────────────────────────
const TABS = [
  { value: "overview", label: "概览" },
  { value: "index", label: "索引" },
  { value: "search", label: "搜索" },
  { value: "trace", label: "轨迹" },
  { value: "relations", label: "关系" },
];

function renderTabs() {
  if (!changed("tabs-mount", "1")) { applyTab(); return; }
  mount("tabs-mount", "Tabs", {
    items: TABS,
    value: state.tab,
    onChange: (v) => { state.tab = v; applyTab(); },
  });
  applyTab();
}
function applyTab() {
  for (const p of document.querySelectorAll("[data-pane]")) {
    p.hidden = p.dataset.pane !== state.tab;
  }
  // 关系图懒加载：只有切到关系页才拉，且只在切仓/刷新时作废。
  if (state.tab === "relations") ensureGraph();
}

// ── 动作 ────────────────────────────────────────────
async function doCancel(id) {
  try {
    await getJson(`repo/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  } catch (err) {
    // 409 说明已经不在扫描中，不是失败
    if (!/409|不在扫描/.test(String(err?.message))) console.warn("打断请求:", err?.message);
  }
  await refresh();
  startPolling();
}

async function doRescan(id) {
  try {
    // 同步阻塞：这里故意不 await 结果来驱动界面，交给轮询
    getJson(`repo/${encodeURIComponent(id)}/rescan`, { method: "POST" }).catch(() => {});
  } catch {}
  await new Promise((r) => setTimeout(r, 250));
  await refresh();
  startPolling();
}

async function doAdd(dir, name) {
  const d = String(dir || "").trim();
  if (!d) return;
  const statusEl = byId("add-status");
  statusEl.hidden = false;
  statusEl.textContent = "登记中…";
  try {
    const body = await getJson("repo/add", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: d, name: String(name || "").trim() || undefined }),
    });
    statusEl.textContent = body?.repo?.id ? `已登记 ${body.repo.id}，扫描已启动` : "已受理";
    if (body?.repo?.id) state.selected = body.repo.id;
    await refresh();
    startPolling();
  } catch (err) {
    statusEl.textContent = `登记失败：${err?.message || err}`;
  }
}

// ── 轮询 ────────────────────────────────────────────
function startPolling() {
  if (state.polling) return;
  state.polling = setInterval(tick, POLL_MS);
}

function stopPolling() {
  if (state.polling) { clearInterval(state.polling); state.polling = null; }
}

async function tick() {
  try {
    const body = await getJson("overview");
    state.repos = body.repos || [];
    state.dataDir = body.dataDir || state.dataDir;
    renderSide();
    renderSummary();
    const r = selectedRepo();
    if (r) {
      renderProgress(r);
      renderSys();
      const stillMine = state.detail?.repo?.id === r.id;
      if (stillMine) { renderStats(r); renderIndex(r); renderPreview(r); }
    }
    if (!state.repos.some((x) => x.status === "scanning")) stopPolling();
  } catch { /* 单次轮询失败不打断 */ }
}

// ── 选中 ────────────────────────────────────────────
async function selectRepo(id) {
  if (state.selected === id) return;
  state.selected = id;
  state.detail = null;
  state.detailState = "loading";
  invalidateGraph(); // 切仓：关系图缓存作废
  renderSide();
  await loadDetail();
}

async function loadDetail() {
  const id = state.selected;
  if (!id) return;
  const r0 = repoOf(id);
  renderIdentity(r0);
  renderProgress(r0);
  renderStats(r0);
  renderIndex(r0);
  renderPreview(r0);
  renderSearch(r0, false);
  renderOps(r0);
  renderSys();

  try {
    const body = await getJson(`repo/${encodeURIComponent(id)}`);
    if (state.selected !== id) return;
    state.detail = body;
    state.detailState = "ok";
  } catch (err) {
    state.detailState = "fail";
  }
  const r = repoOf(id);
  renderIdentity(r);
  renderProgress(r);
  renderStats(r);
  renderIndex(r);
  renderPreview(r);
  renderSearch(r, false);
  renderOps(r);
  renderSys();
  renderTrace(r);
  if (state.tab === "relations") ensureGraph();
}

// ── 全量刷新 ────────────────────────────────────────
async function refresh() {
  byId("root").dataset.status = "loading";
  byId("err-view").hidden = true;
  byId("empty-view").hidden = true;
  byId("board").hidden = true;
  sigs.clear();
  invalidateGraph(); // 点刷新：关系图缓存作废（关系不随扫描变，但用户明确要求刷新时重拉）

  let body;
  try {
    body = await getJson("overview");
  } catch (err) {
    byId("root").dataset.status = "error";
    byId("err-view").hidden = false;
    byId("err-detail").textContent = err?.message || String(err);
    byId("err-datadir").textContent = state.dataDir ? `dataDir: ${state.dataDir}` : "";
    mount("err-mount", "ErrorState", {
      title: "overview 请求失败",
      message: "后端 /overview 没能返回数据。",
      action: appUi("Button", { children: "重试", size: "sm", variant: "primary", onClick: () => refresh() }),
    });
    return;
  }

  state.repos = body.repos || [];
  state.dataDir = body.dataDir || "";

  if (!state.repos.length) {
    byId("root").dataset.status = "empty";
    byId("empty-view").hidden = false;
    renderAddForm();
    return;
  }

  byId("root").dataset.status = "ready";
  byId("board").hidden = false;

  if (!state.repos.some((r) => r.id === state.selected)) {
    state.selected = state.repos[0].id;
    state.detail = null;
  }

  renderSide();
  renderSummary();
  renderSys();
  renderTabs();
  await loadDetail();

  if (state.repos.some((r) => r.status === "scanning")) startPolling();
}

function renderAddForm() {
  if (!changed("empty-mount", "1")) return;
  mount("empty-mount", "EmptyState", {
    title: "还没有登记仓库",
    description: "一仓一索引，不跨仓。语义索引走 aoci / aoci-cua 链路，插件只清点。",
  });
  mount("add-dir-mount", "TextInput", {
    label: "目录路径", placeholder: "C:\\Users\\me\\my-repo",
  });
  mount("add-name-mount", "TextInput", {
    label: "名称（可选）", placeholder: "留空则用目录名",
  });
  mount("add-submit-mount", "Button", {
    children: "登记并扫描", variant: "primary",
    onClick: () => {
      const dir = document.querySelector("#add-dir-mount input")?.value || "";
      const name = document.querySelector("#add-name-mount input")?.value || "";
      doAdd(dir, name);
    },
  });
  mount("add-inline-mount", "Button", {
    children: "＋ 登记新仓", size: "sm", variant: "secondary",
    onClick: () => showInlineAdd(),
  });
}

let inlineAddShown = false;
function showInlineAdd() {
  if (inlineAddShown) return;
  inlineAddShown = true;
  const host = byId("add-inline-mount");
  const box = document.createElement("div");
  box.className = "inline-add";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "search-input mono";
  input.placeholder = "目录路径…";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini-btn";
  btn.textContent = "登记";
  btn.addEventListener("click", () => doAdd(input.value, ""));
  box.append(input, btn);
  host.appendChild(box);
}

// ── 启动 ────────────────────────────────────────────
byId("search-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); doSearch(); }
});

await applyHostTheme();
await hana.ready();

// 顶栏构建标识：宿主服务的是哪一版，看这里。
const stampEl = byId("ov-stamp");
if (stampEl) stampEl.textContent = BUILD;

// 注意顺序：顶栏刷新钮必须在 clearMounts 之后挂，否则被当成残留句柄销毁。
clearMounts();
mount("refresh-mount", "Button", {
  children: "刷新", size: "sm", variant: "ghost",
  onClick: () => refresh(),
});
await refresh();
