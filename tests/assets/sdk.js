/* 离线渲染台的 mock SDK —— 只用于在浏览器里把 panel.js 画出来看，
   不进插件包。它复刻 hana.api.fetch / hana.theme / hana.ready 的形状，
   数据来自同目录 fixture.json（由真 projects.json + 真 aoci 文件生成）。 */

const fixture = await (await fetch("./fixture.json")).json();

// 关系图真数据（由 build-contract.mjs 从真 aoci.code.txt 生成）。
// 契约 §1 的响应形状与冻结文件有两处偏差：冻结文件叫 unresolvedSamples、且没有 repo 字段。
// 这里按契约 §1 补上 repo、并把 unresolvedSamples 映射为 unresolved，同时保留原名以兼容。
const graphData = await (await fetch("./graph-contract.json")).json();
const _nodeById = new Map(graphData.nodes.map((n) => [n.id, n]));
const _outAdj = new Map();
const _inAdj = new Map();
for (const e of graphData.edges) {
  if (!_outAdj.has(e.from)) _outAdj.set(e.from, []);
  _outAdj.get(e.from).push(e.to);
  if (!_inAdj.has(e.to)) _inAdj.set(e.to, []);
  _inAdj.get(e.to).push(e.from);
}
const _brief = (nid) => {
  const n = _nodeById.get(nid);
  if (!n) return null;
  return { id: n.id, name: n.name, layer: n.layer, module: n.module, F: n.F };
};

function json(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function route(path) {
  try { (globalThis.__calls ||= []).push(path); } catch {}
  const [p, qs] = path.split("?");
  const q = new URLSearchParams(qs || "");
  const seg = p.split("/").filter(Boolean);

  if (p === "health") return json({ ok: true, app: "repo-auto-index", version: "0.0.0-mock" });

  // 投递路由（面板交付块 → 后端转发）。真后端在 index.js 按 :kind 分支，
  // mock 同样分：两条路各自回不同的 entryId，好让回归能分辨到底是哪条被调到。
  // 调用记录写进 globalThis.__sends，供探针脚本核对。
  const send = p.match(/^(report|chain)\/send$/);
  if (send) {
    try { (globalThis.__sends ||= []).push({ kind: send[1] }); } catch {}
    return json({ ok: true, entryId: `mock-${send[1]}-entry`, mode: "append", pending: false });
  }

  // 会话列表（面板的选择器用）：三条，两条属于仓库、一条不属于，
  // 好让回归能核「本仓的排前面」与「不属于本仓的也在列表里」。
  if (/^repo\/[^/]+\/sessions$/.test(p)) {
    const sessions = [
      { sessionId: "mock-in-repo-1", title: "本仓会话一", cwd: "C:\\projects\\atlas-workspace", inRepo: true, modified: "2026-10-14T10:00:00Z", messageCount: 12 },
      { sessionId: "mock-in-repo-2", title: "本仓会话二", cwd: "C:\\projects\\atlas-workspace\\sub", inRepo: true, modified: "2026-10-14T09:00:00Z", messageCount: 5 },
      { sessionId: "mock-other", title: "别的仓的会话", cwd: "C:\\projects\\other-repo", inRepo: false, modified: "2026-10-14T11:00:00Z", messageCount: 3 },
    ];
    return json({ ok: true, repo: "atlas-workspace", repoDir: sessions[0].cwd, total: sessions.length, matched: 2, sessions });
  }

  if (p === "overview") {
    return json({ ok: true, dataDir: fixture.dataDir, repos: fixture.repos });
  }

  if (seg[0] === "repo" && seg[1]) {    const id = decodeURIComponent(seg[1]);
    const repo = fixture.repos.find((r) => r.id === id);
    if (!repo) return json({ ok: false, error: "找不到该仓库" }, false, 404);

    if (seg[2] === "search") {
      const kw = (q.get("q") || "").toLowerCase();
      const limit = Math.min(Math.max(Number(q.get("limit")) || 20, 1), 100);
      const hits = [];
      for (const item of fixture.indexLines) {
        if (hits.length >= limit) break;
        if (String(item.t).toLowerCase().includes(kw)) hits.push({ line: item._n, text: String(item.t).slice(0, 240) });
      }
      return json({ ok: true, repo: id, file: fixture.indexFile, hits, total: hits.length });
    }

    if (seg[2] === "graph") {
      return json({
        ok: true,
        repo: id,
        volume: graphData.volume,
        root: graphData.root,
        generatedAt: graphData.generatedAt,
        stats: graphData.stats,
        nodes: graphData.nodes,
        edges: graphData.edges,
        unresolved: graphData.unresolved || graphData.unresolvedSamples || [],
        unresolvedSamples: graphData.unresolvedSamples || graphData.unresolved || [],
      });
    }

    if (seg[2] === "node") {
      const path = q.get("path") || "";
      const node = _nodeById.get(path);
      if (!node) return json({ ok: false, error: "找不到该节点" }, false, 404);
      const out = (_outAdj.get(path) || []).map(_brief).filter(Boolean);
      const inc = (_inAdj.get(path) || []).map(_brief).filter(Boolean);
      return json({ ok: true, node, out, in: inc });
    }

    if (seg[2] === "trace") {
      return json({ ok: true, repo: id, file: fixture.traceFile, lines: fixture.traceLines, total: fixture.traceLines.length });
    }

    return json({
      ok: true,
      repo,
      // aociInit 与真后端同形：真后端看 .aoci/config.json 在不在。
      // fixture 的真数据里这个仓库已初始化，所以回 true。
      aociInit: true,
      index: {
        file: fixture.indexFile,
        entries: fixture.indexEntries,
        hasIndex: true,
        preview: fixture.indexPreview,
      },
    });
  }

  return json({ ok: false, error: `mock 未实现路由：${p}` }, false, 404);
}

export const hana = {
  ready: async () => {},
  api: {
    url: (p) => `./mock-api/${p}`,
    fetch: async (p, init) => {
      const method = (init?.method || "GET").toUpperCase();
      try { (globalThis.__calls ||= []).push(`${method} ${p}`); } catch {}
      return route(p, init);
    },
  },
  theme: { getSnapshot: async () => ({ theme: "warm-paper", cssUrl: "./assets/theme.css" }), subscribe: () => () => {} },
  ui: { resize: () => {} },
  assets: { url: (p) => `./assets/${p}` },
  // 会话导航器：面板交付块靠它拿目标会话（显示去向、投递、跳过去看）。
  // mock 回一个固定会话（带 title —— 真正的 getActive 会答 title，
  // 以前只取了 sessionId，去向就对用户不可见了），并实现订阅与跳转，
  // 好让「会话切换时目标行跟着变」这条也能在离线台验。
  sessions: {
    getActive: async () => ({ sessionId: "mock-session-0001", title: "模拟会话·目标", agentId: "demo-agent", sessionPath: "mock/path.jsonl" }),
    onActiveChanged: (cb) => {
      // 真宿主会在会话切换时回调；这里暴露一个手动触发器给回归用。
      globalThis.__fireActiveChanged = (next) => cb({ previous: null, current: next, timestamp: Date.now() });
      return () => { delete globalThis.__fireActiveChanged; };
    },
    focus: async ({ sessionId }) => {
      (globalThis.__focusCalls ||= []).push(sessionId);
      return { ok: true };
    },
  },
  cards: { open: async () => ({ cardInstanceId: "mock-card" }) },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
