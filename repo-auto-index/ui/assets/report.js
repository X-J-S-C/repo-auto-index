import { hana } from "./sdk.js";
import { mountAppUi, appUi } from "./app-ui.js";

/* 仓库自动索引 · 扫描报告卡
 * 一个页面就是一张能递出去的卡：一次扫描 = 一张报告卡。
 * 契约见 ui/CARD-DOCTRINE.md；本页与 ui/assets/panel.js 同源。
 *
 * 三条纪律（与面板一致）：
 * 1. 一个 id 只出现一次；一个区块只有一份 DOM，状态用 data-status 表达。
 * 2. 所有数字都来自服务端，页面不自造。刷新即真相。
 * 3. 官方控件走 mountAppUi，重渲染前必须 destroy（destroyAll 收口）。
 *
 * 本页与面板的两处差异，都来自「卡片」这个形态本身：
 * - 宿主不会把触发消息的 payload 传进 iframe（CARD-DOCTRINE §2.4），所以页面自取数据，
 *   并且不依赖 URL 参数也能工作（拿不到 repoId 就回退到最近更新的那条）。
 * - 卡片在聊天流里是 flexible 高度模式：流式布局，不写死高度，不撑 100vh。
 */

// 构建标识：从后端 /health 读真实版本，不手写。
//
// 为什么不写常量（2026-10-14）：这里曾写死 "report v0.1 · …"，
// 靠人记得更新就是靠不住，于是装新版时页脚还报旧版——
// 本来是防「版本不可辨」的东西，自己成了误导源。
// 后端版本从 manifest.json 读，那是打包时唯一的版本真相。
let appVersion = "";
function versionLabel() {
  return appVersion ? `v${appVersion}` : "版本未知";
}

// ── 元素访问唯一入口（照抄面板） ──────────────────────
const byId = (id) => document.getElementById(id);
const block = (name) => document.querySelector(`[data-block="${name}"]`);
const setStatus = (name, st) => { const b = block(name); if (b) b.dataset.status = st; };

// ── 官方控件挂载收口（照抄面板） ─────────────────────
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

function mountInto(el, name, props) {
  if (!el) return null;
  try {
    return mountAppUi(el, name, props);
  } catch (err) {
    console.warn("mountAppUi 失败", name, err?.code || err?.message);
    return null;
  }
}

function mountOrUpdate(hostId, name, props) {
  const host = byId(hostId);
  if (!host) return null;
  const arr = handles.get(hostId);
  const live = Array.isArray(arr) && arr.length === 1 ? arr[0] : null;
  if (live && typeof live.update === "function") {
    try { live.update(props); return live; } catch { /* 句柄已失效，回落重挂 */ }
  }
  return mount(hostId, name, props);
}

function clearMounts() {
  for (const hostId of [...handles.keys()]) killHost(hostId);
}

// 签名去重：避免重复渲染把已挂控件重挂掉。卡片不轮询，只防重复调用。
const sigs = new Map();
function changed(key, sig) {
  if (sigs.get(key) === sig) return false;
  sigs.set(key, sig);
  return true;
}

// ── 宿主主题（照抄面板） ────────────────────────────
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
 *  数据获取层  fetchReport()
 *
 *  ★★★ 此处等勘探结论定稿（CARD-DOCTRINE §3 的 V4） ★★★
 *
 *  卡片 iframe 调 App 自己后端路由（/api/apps/repo-auto-index/routes/...）走哪条
 *  鉴权通道，勘探任务正在验证，结论未知。结论到达前的兼容策略：按下面的候选
 *  通道顺序依次尝试，第一个成功的固定下来复用；全部失败则回退到内联 Mock。
 *  拿到 V4 结论后，这里只保留结论证明可用的那一条，其余删掉。
 *
 *  候选说明（页面由宿主挂在 /api/apps/repo-auto-index/ui/report.html）：
 *   - relative : 用相对路径拼 ../routes/ 与 ./../../routes/。前者从 ui/ 上一级
 *                进入 routes/，解析为 /api/apps/repo-auto-index/routes/；后者是
 *                任务书写明的字面形式，宿主挂载点不同的话可能命中。
 *   - sdk      : 走 hana.api.fetch("overview")。SDK 会带上宿主发的
 *                appSurfaceSession 凭据（ui-types.d.ts），若 V4 证明卡片 iframe
 *                带该参数，这条就是最终形态。
 *
 *  显式兼容：URL 上一般拿不到 repoId（宿主不传 payload）。拿不到就回退到
 *  「最近更新的那条」仓库，保证不依赖 URL 参数也能工作。若将来 V2 证明自定义
 *  字段能透传到 iframe，只保留 URL 分支、删掉回退即可。
 * ════════════════════════════════════════════════════════════════ */

const ROUTE_CANDIDATES = [
  {
    id: "relative",
    label: "相对路径 ../routes/",
    fetch: (path, init) => fetch(`../routes/${path}`, { credentials: "same-origin", ...(init || {}) }),
  },
  {
    id: "relative-literal",
    label: "相对路径 ./../../routes/",
    fetch: (path, init) => fetch(`./../../routes/${path}`, { credentials: "same-origin", ...(init || {}) }),
  },
  {
    id: "sdk",
    label: "hana.api.fetch",
    fetch: (path, init) => hana.api.fetch(path, init),
  },
];

// 从 URL 尝试取 repoId。拿不到返回空串。见上面「显式兼容」。
function wantedRepoId() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get("repoId") || u.searchParams.get("repo") || "";
  } catch {
    return "";
  }
}

// 选一条仓库：先认 URL 上的 repoId，认不到就取最近更新的那条。
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

// 通过某条候选通道取一个 JSON。响应非 ok 或 ok:false 都算失败。
async function fetchJson(channel, path, init) {
  const res = await channel.fetch(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

// 走一条通道把 report 取全：先 overview 拿列表，再 repo/:id 拿索引明细。
// 注意：“答了但是空”与“答不了”必须分开。overview 正常返回但 repos 为空，
// 是一个成功的 live 结果（应渲染空态），不能当作通道失败回退到样本。
// 只有请求本身失败（网络/非 2xx/ok:false）才抛错、轮到下一条候选通道。
async function readReportVia(channel) {
  const notes = [];
  // 顺手取一次真实版本。取不到不致命：getJson 抛错就留着空值，
  // 页脚会写「版本未知」而不是猜。
  if (!appVersion) {
    try {
      const h = await fetchJson(channel, "health");
      appVersion = h?.version || "";
    } catch { /* 拿不到就留空 */ }
  }
  const overview = await fetchJson(channel, "overview");
  const repos = Array.isArray(overview?.repos) ? overview.repos : [];
  if (!repos.length) return { repos: [], repo: null, detail: null, dataDir: overview?.dataDir || "", notes };

  const { repo, how } = pickRepo(repos, notes);
  if (how === "recent") notes.push("未从 URL 取到 repoId，已回退到最近更新的一条");
  let detail = null;
  if (repo) {
    try {
      detail = await fetchJson(channel, `repo/${encodeURIComponent(repo.id)}`);
    } catch (err) {
      notes.push(`仓库明细读取失败：${err?.message || err}（索引数退回快照）`);
    }
  }
  return { repos, repo, detail, dataDir: overview?.dataDir || "", notes };
}

// 内联样本：形状取自 index.js 的真实写入逻辑（finishedAt / progress / index）。
// 只在所有真实通道都失败时使用，页脚会明确标注「样本」，不冒充真相。
//
// 用示范路径（C:\Users\me\my-repo 这种），不用任何本机实名路径：
// 这个文件会随包分发给别人，写死某台的用户名与目录名等于把一个真实机器
// 的目录结构带出去。数字保留真实量级，好让样例看着不是虚构。
function mockReport() {
  const repo = {
    id: "example-repo",
    name: "示例仓库",
    dir: "C:\\Users\\me\\my-repo",
    gitUrl: null,
    status: "done",
    progress: { phase: "done", total: 740, scanned: 815, dirCount: 76, denied: 0, entries: 392, entryLines: 473, capped: false },
    taskId: null,
    error: null,
    registeredAt: "2026-10-12T12:15:53.931Z",
    updatedAt: "2026-10-13T13:54:14.222Z",
    startedAt: "2026-10-13T13:54:13.088Z",
    finishedAt: "2026-10-13T13:54:14.221Z",
    index: { file: "aoci.code.txt", files: ["aoci.code.txt", "aoci.meta.txt", "aoci.txt"], entries: 392, entryLines: 473, hasIndex: true },
  };
  return {
    repos: [repo],
    repo,
    detail: { ok: true, repo, index: { file: "aoci.code.txt", entries: 392, entryLines: 473, hasIndex: true, preview: [] } },
    dataDir: "<HANA_HOME>/app-data/repo-auto-index",
    notes: ["所有真实通道均失败，当前显示的是内联样本（形状同 index.js 的真实记录）"],
  };
}

// 记住成功的通道，后续动作（重扫）复用同一条，避免每次重试四条通道。
let resolvedChannel = null;

async function fetchReport() {
  const tried = [];
  const channels = resolvedChannel
    ? [resolvedChannel, ...ROUTE_CANDIDATES.filter((c) => c.id !== resolvedChannel.id)]
    : ROUTE_CANDIDATES;

  for (const channel of channels) {
    try {
      const data = await readReportVia(channel);
      // 拿回 repos 数组就算这条通道通了，哪怕它是空的。
      if (!Array.isArray(data.repos)) throw new Error("overview 响应里没有 repos");
      resolvedChannel = channel;
      return { ...data, source: { kind: "live", channel: channel.id, label: channel.label, tried } };
    } catch (err) {
      tried.push(`${channel.label}：${err?.message || err}`);
    }
  }
  return { ...mockReport(), source: { kind: "mock", channel: "mock", label: "内联样本", tried } };
}

// ── 状态 ────────────────────────────────────────────
const state = {
  report: null,   // fetchReport 的返回
  loading: false,
};

// ── 展示：从 report 里安全取值（数字只来自服务端） ──────
const STATE_LABEL = {
  scanning: "扫描中", done: "就绪", canceled: "已打断", error: "出错", idle: "未登记",
};
function stateTone(s) {
  return s === "done" ? "ok" : s === "error" ? "bad" : s === "scanning" ? "warn" : "mute";
}

// 索引条目数：明细优先，其次快照，其次 repo.index。任何一处为数字才采用。
// 口径与 aoci status 的 index_entries 一致：只算 name[TAG]: 形状的行。
// hasIndex 明确为 false 时不报数（避免把“没有索引”显示成 0 行）。
function entriesOf(repo, detail) {
  const d = detail?.index;
  if (d && typeof d.entries === "number" && d.hasIndex !== false) return d.entries;
  if (repo?.index && repo.index.hasIndex === false) return null;
  if (typeof repo?.index?.entries === "number") return repo.index.entries;
  if (typeof repo?.progress?.entries === "number") return repo.progress.entries;
  return null;
}

function relTime(iso) {
  if (!iso) return "—";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return "—";
  if (secs < 0) return "刚刚";
  if (secs < 60) return secs + " 秒前";
  const m = Math.floor(secs / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.floor(h / 24) + " 天前";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${relTime(iso)}）`;
}

// 文件数：受阻 / 触顶时给出口径，与面板一致，不加戏。
function filesCell(repo) {
  const p = repo.progress || {};
  if (repo.status === "scanning") return { v: String(p.total ?? 0), h: "扫描结束前不是终值" };
  if (repo.status === "canceled") return { v: `部分 ${p.total ?? 0}`, h: "下限值，被打断" };
  if (repo.status === "error") return { v: "—", h: "未获得" };
  if ((p.denied ?? 0) > 0) return { v: String(p.total ?? 0), h: "受阻，非全仓" };
  if (p.capped) return { v: `≥ ${p.total ?? 0}`, h: "触顶 20000" };
  return { v: String(p.total ?? 0), h: "" };
}

function deniedCell(repo) {
  const p = repo.progress || {};
  if (repo.status === "scanning") return { v: "?", h: "结束才知" };
  if (repo.status === "canceled") return { v: "?", h: "未统计" };
  if (repo.status === "error") return { v: "—", h: "未获得" };
  const n = p.denied ?? 0;
  return { v: String(n), h: n > 0 ? "list 失败的目录" : "全部可读" };
}

function noteFor(repo) {
  if (!repo) return "";
  if (repo.status === "scanning") return "扫描进行中，数字会继续增长。到面板可以打断。";
  if (repo.status === "canceled") return "已打断：计数只是清点到那一刻的下限，denied 不入库。可点重扫。";
  if (repo.status === "error") return repo.error ? `上次扫描出错：${repo.error}` : "上次扫描出错，进度数据不可用。可点重扫。";
  if ((repo.progress?.denied ?? 0) > 0) return "有目录读不到，文件数是可读部分，不是全仓。";
  return "";
}

// ── 渲染 ────────────────────────────────────────────

function renderBadge(repo) {
  const host = byId("rep-badge-mount");
  if (!host) return;
  if (!repo) { killHost("rep-badge-mount"); host.replaceChildren(); return; }
  const tone = stateTone(repo.status);
  if (!changed("badge", repo.status)) return;
  killHost("rep-badge-mount");
  host.replaceChildren();
  const sp = document.createElement("span");
  sp.className = `badge b-${tone}`;
  sp.textContent = STATE_LABEL[repo.status] || repo.status || "未知";
  host.appendChild(sp);
}

function renderBody(data) {
  const repo = data.repo;
  byId("rep-name").textContent = repo?.name || repo?.id || "—";
  byId("rep-slug").textContent = repo?.id ? `（${repo.id}）` : "";
  byId("rep-dir").textContent = repo?.dir || "";
  byId("rep-dir").title = repo?.dir || "";

  const files = filesCell(repo);
  byId("n-files").textContent = files.v;
  byId("h-files").textContent = files.h;

  const e = entriesOf(repo, data.detail);
  byId("n-entries").textContent = e == null ? "—" : String(e);
  byId("h-entries").textContent = e == null
    ? (repo?.status === "scanning" ? "扫描结束后才读" : "还没有索引")
    : "name[TAG]: 行数，与 aoci status 同口径";

  const denied = deniedCell(repo);
  byId("n-denied").textContent = denied.v;
  byId("h-denied").textContent = denied.h;

  const idxName = data.detail?.index?.file || repo?.index?.file || "";
  const hasIndex = data.detail?.index?.hasIndex ?? repo?.index?.hasIndex;
  byId("k-time").textContent = fmtTime(repo?.finishedAt || repo?.updatedAt);
  byId("k-index").textContent = idxName || (hasIndex === false ? "（还没有 aoci 文件）" : "—");

  const note = byId("rep-note");
  const text = noteFor(repo);
  note.textContent = text;
  note.hidden = !text;

  setStatus("stats", repo?.status === "done" ? "ready" : (repo?.status || "empty"));
  renderBadge(repo);
  renderActions(repo);
  renderSource(data.source);
}

// 「来路」一行：哪条地址答的、还是回退到了样本。为了可溯源。
function renderSource(source) {
  const el = byId("rep-source");
  if (!el) return;
  const parts = [`版本 ${versionLabel()}`];
  if (source?.kind === "live") parts.push(`数据源：${source.label}`);
  else parts.push("数据源：内联样本（真实通道不可用）");
  if (source?.tried?.length) parts.push(`试过：${source.tried.join("；")}`);
  el.textContent = parts.join(" · ");
}

function renderActions(repo) {
  const scanning = repo?.status === "scanning";
  if (changed("act-rescan", `${repo?.id}|${repo?.status}`)) {
    mount("act-rescan", "Button", {
      children: "重扫",
      variant: "primary",
      size: "sm",
      disabled: scanning,
      onClick: () => doRescan(repo?.id),
    });
  }
  if (changed("act-panel", "panel")) {
    mount("act-panel", "Button", {
      children: "打开面板",
      variant: "secondary",
      size: "sm",
      onClick: () => openPanel(),
    });
  }
}

// 整页空 / 错
function renderCenter(kind, title, message, detail) {
  byId("rep-body").hidden = true;
  byId("rep-center").hidden = false;
  byId("root").dataset.status = kind;
  byId("center-detail").textContent = detail || "";
  byId("center-detail").hidden = !detail;
  if (!changed("center", `${kind}|${title}|${message}`)) return;
  mount("center-mount", kind === "error" ? "ErrorState" : "EmptyState", {
    title,
    description: message,
    action: kind === "error"
      ? appUi("Button", { children: "重试", size: "sm", variant: "primary", onClick: () => refresh() })
      : undefined,
  });
}

// ── 动作 ────────────────────────────────────────────

async function doRescan(id) {
  if (!id) return;
  const host = byId("act-rescan");
  killHost("act-rescan");
  host.replaceChildren();
  mountNote(host, "已发出重扫…");
  try {
    // 复用取数成功的那条通道；POST rescan 是同步阻塞，返回即终态。
    const channel = resolvedChannel || ROUTE_CANDIDATES[0];
    await fetchJson(channel, `repo/${encodeURIComponent(id)}/rescan`, { method: "POST" });
  } catch (err) {
    if (!/409|正在扫描/.test(String(err?.message))) {
      console.warn("重扫请求:", err?.message);
    }
  }
  await refresh();
}

async function openPanel() {
  try {
    // 打开本 App 的另一张卡（面板）。APPS.md「打开本 App 的另一张卡」。
    await hana.cards?.open?.("panel");
  } catch (err) {
    console.warn("打开面板失败:", err?.message || err);
    hana.toast?.show?.({ message: "打开面板失败，可从侧栏进入", tone: "error" });
  }
}

function mountNote(host, text) {
  const p = document.createElement("p");
  p.className = "block-empty";
  p.textContent = text;
  host.appendChild(p);
}

// ── 刷新 ────────────────────────────────────────────
async function refresh() {
  if (state.loading) return;
  state.loading = true;
  byId("root").dataset.status = "loading";
  try {
    state.report = await fetchReport();
  } finally {
    state.loading = false;
  }
  const data = state.report;
  if (!data?.repos?.length) {
    renderCenter("empty", "还没有登记仓库", "一仓一索引。到面板登记一个已存在的目录，或让 Agent 调 repo_index_add。");
    return;
  }
  if (!data.repo) {
    renderCenter("error", "拿不到仓库数据", "后端返回了列表但没有可用的条目。", data.source?.tried?.join("\n"));
    return;
  }
  byId("rep-center").hidden = true;
  byId("rep-body").hidden = false;
  byId("root").dataset.status = "ready";
  sigs.clear();
  renderBody(data);
}

// ── 启动 ────────────────────────────────────────────
await applyHostTheme();
await hana.ready();
clearMounts();
await refresh();
