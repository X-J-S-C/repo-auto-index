/* 关系网图渲染组件 · repo-auto-index
   单文件、零外部依赖（不引 CDN / npm / d3），纯 Canvas 2D 实现。
   只导出两个符号，接口按 ui/GRAPH-CONTRACT.md §2.5 冻结，不得改动字段名与签名：

     export function renderGraphMap(container, graph, options) -> handle
     export function focusNode(handle, nodeId) -> boolean

   设计要点：
   1. 布局一次性算完（力导向固定 300 次迭代），之后只做「相机」变换，不逐帧重算。
   2. 孤岛（inDeg===0 && outDeg===0）默认不画，由 options.showIsolated 控制。
   3. 颜色全部来自宿主主题 CSS 变量（--accent / --text-muted / --border …），
      层级色阶由 --accent 的 HSL 旋转派生，不写死色值（兜底值仅为变量缺失时保底）。
   4. 支持滚轮缩放、指针拖拽平移、点击节点回调、悬停高亮。
   5. 代码标识符一律英文；注释用中文。 */

'use strict';

/* ────────────────────────────── 小工具 ────────────────────────────── */

// 确定性伪随机数（mulberry32）：保证同一份数据每次布局一致，便于回归与截图。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 把任意 CSS 颜色字符串解析成 [r,g,b]；解析不出返回 null。
// 兼容 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()（getComputedStyle 常见输出）。
function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^#([0-9a-fA-F]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [clamp(p[0], 0, 255), clamp(p[1], 0, 255), clamp(p[2], 0, 255)];
    }
  }
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

function withAlpha(rgb, a) {
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
}

/* ────────────────────────────── 字典（契约 §0） ────────────────────────────── */

// A 层（第 1 位 TAG）：共享基础 / 入口边界 / …
const LAYER_NAMES = {
  C: '共享基础', E: '入口边界', A: '应用编排', D: '领域逻辑', K: '算法计算',
  M: '中间件', P: '持久化', I: '集成适配', R: '运行基础', L: '库与 SDK',
  F: '声明配置', O: '运维交付', T: '测试验证', S: '文档规范', X: '开发工具', Z: '其他',
};

// B 模块（第 2 位 TAG）
const MODULE_NAMES = {
  G: '跨域通用', U: '用户交互', B: '核心业务', D: '数据状态', I: '身份权限',
  N: '网络协议', M: '消息事件', S: '安全隐私', C: '配置策略', O: '可观测性',
  R: '可靠性恢复', P: '性能资源', W: '流程调度', A: '分析智能', H: '硬件设备',
  L: '本地化', V: '构建发布', Q: '质量保障', E: '扩展插件', Z: '其他',
};

function layerLabel(code) {
  return LAYER_NAMES[code] || code || '未分类';
}
function moduleLabel(code) {
  return MODULE_NAMES[code] || code || '未分类';
}

/* ────────────────────────────── 主题取色 ────────────────────────────── */

// 读宿主主题变量。兜底值只在变量缺失时生效，与 panel.css 的 var(--x, 兜底) 同一策略。
function readTheme(root) {
  const cs = getComputedStyle(root || document.documentElement);
  const pick = (name, fb) => {
    const v = cs.getPropertyValue(name);
    return v && v.trim() ? v.trim() : fb;
  };
  return {
    accent: pick('--accent', '#537D96'),
    text: pick('--text', '#1b1b1d'),
    muted: pick('--text-muted', '#8a857c'),
    border: pick('--border', '#EAEAEA'),
    bg: pick('--bg-card', pick('--bg', '#FFFFFF')),
  };
}

// 由主题 accent 的 HSL 派生层级色阶：色相均匀铺开，饱和/明度落在克制区间。
// 这样 14 个层级彼此可辨，又都带着主题色的调子，且没有硬编码色值。
function buildLayerColors(accentStr, layers) {
  const base = parseColor(accentStr) || [83, 125, 150];
  const hsl = rgbToHsl(base[0], base[1], base[2]);
  const h0 = hsl[0];
  const s0 = clamp(hsl[1], 0.26, 0.52);
  const map = {};
  const n = Math.max(layers.length, 1);
  layers.forEach((code, i) => {
    const h = h0 + (i * 360) / n;
    const l = 0.50 + (i % 3) * 0.06;
    const rgb = hslToRgb(h, s0, clamp(l, 0.4, 0.68));
    map[code] = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  });
  return map;
}

/* ────────────────────────────── 力导向布局 ────────────────────────────── */

// 对核心节点（非孤岛）跑固定迭代次数的力导向。返回 id -> [x,y]。
// n≈238、迭代 300 次，一次性算完；之后不再重算，保证流畅。
function layoutForce(nodes, edges, seed) {
  const n = nodes.length;
  const pos = new Map();
  if (n === 0) return pos;

  const rnd = mulberry32(seed);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const R = Math.sqrt(n) * 32; // 初始撒点半径

  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const r = R * Math.sqrt(rnd());
    x[i] = Math.cos(a) * r;
    y[i] = Math.sin(a) * r;
  }

  const index = new Map();
  for (let i = 0; i < n; i++) index.set(nodes[i].id, i);

  const links = [];
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
  }

  // 理想边长 k：由「可用面积 / 节点数」估计
  const area = R * R * Math.PI * 1.5;
  const k = Math.sqrt(area / n);

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let temp = R * 0.32;
  const ITER = 300;

  for (let it = 0; it < ITER; it++) {
    dx.fill(0);
    dy.fill(0);

    // 斥力：任意两点相互排斥，f = k^2 / d
    for (let i = 0; i < n; i++) {
      const xi = x[i], yi = y[i];
      for (let j = i + 1; j < n; j++) {
        let vx = xi - x[j];
        let vy = yi - y[j];
        let d2 = vx * vx + vy * vy;
        if (d2 < 1e-6) {
          vx = (rnd() - 0.5) * 0.2;
          vy = (rnd() - 0.5) * 0.2;
          d2 = vx * vx + vy * vy + 1e-6;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d;
        const ux = vx / d, uy = vy / d;
        dx[i] += ux * f; dy[i] += uy * f;
        dx[j] -= ux * f; dy[j] -= uy * f;
      }
    }

    // 引力：有边相连的节点被弹簧拉近，f = d^2 / k
    for (let li = 0; li < links.length; li++) {
      const a = links[li][0], b = links[li][1];
      let vx = x[a] - x[b];
      let vy = y[a] - y[b];
      const d = Math.sqrt(vx * vx + vy * vy) || 0.01;
      const f = (d * d) / k;
      const ux = vx / d, uy = vy / d;
      dx[a] -= ux * f; dy[a] -= uy * f;
      dx[b] += ux * f; dy[b] += uy * f;
    }

    // 向心力（防止飞散）+ 按当前温度限步（退火）
    const pull = k * 0.10;
    for (let i = 0; i < n; i++) {
      const cd = Math.sqrt(x[i] * x[i] + y[i] * y[i]) || 1;
      dx[i] -= (x[i] / cd) * pull;
      dy[i] -= (y[i] / cd) * pull;
      const dl = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1e-6;
      const step = Math.min(dl, temp);
      x[i] += (dx[i] / dl) * step;
      y[i] += (dy[i] / dl) * step;
    }

    temp *= 0.985;
    if (temp < 0.02) break;
  }

  for (let i = 0; i < n; i++) pos.set(nodes[i].id, [x[i], y[i]]);
  packComponents(pos, nodes, links);
  return pos;
}

// 分量打包：力导向只管「分量内」的形，分量之间没有引力会被斥力推散。
// 这里先求连通分量，把每个分量绕自身质心收紧，再按圆打包铺开，保证全景紧凑。
function packComponents(pos, nodes, links) {
  const n = nodes.length;
  if (n === 0) return;
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(nodes[i].id, i);

  // 并查集
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const [a, b] of links) union(a, b);

  // 分组
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = groups.get(r) || [];
    arr.push(i);
    groups.set(r, arr);
  }

  // 每个分量：质心 + 包围半径，并把点移到以质心为原点
  const comps = [];
  for (const idxs of groups.values()) {
    let cx = 0, cy = 0;
    for (const i of idxs) { const p = pos.get(nodes[i].id); cx += p[0]; cy += p[1]; }
    cx /= idxs.length; cy /= idxs.length;
    let rad = 0;
    for (const i of idxs) {
      const p = pos.get(nodes[i].id);
      p[0] -= cx; p[1] -= cy;
      const d = Math.sqrt(p[0] * p[0] + p[1] * p[1]);
      if (d > rad) rad = d;
    }
    comps.push({ idxs, cx, cy, rad: Math.max(rad, 6) });
  }
  comps.sort((a, b) => b.rad - a.rad); // 大分量先放，小的填缝

  const gap = 34; // 分量之间的最小净距
  const placed = [];
  for (const comp of comps) {
    const need = comp.rad + gap;
    let px = 0, py = 0;
    if (placed.length) {
      // 螺旋搜索：从已有范围外沿逐步向外找不重叠的落点
      let found = false;
      for (let step = 1; step <= 4000 && !found; step++) {
        const ang = step * 2.399963;           // 黄金角，均匀铺开
        const rad = Math.sqrt(step) * (need * 0.62);
        const tx = Math.cos(ang) * rad;
        const ty = Math.sin(ang) * rad;
        let ok = true;
        for (const p of placed) {
          const ddx = tx - p.x, ddy = ty - p.y;
          if (ddx * ddx + ddy * ddy < (need + p.rad) * (need + p.rad)) { ok = false; break; }
        }
        if (ok) { px = tx; py = ty; found = true; }
      }
    }
    placed.push({ x: px, y: py, rad: comp.rad });
    for (const i of comp.idxs) {
      const p = pos.get(nodes[i].id);
      p[0] += px; p[1] += py;
    }
  }
}

/* ────────────────────────────── 孤岛分簇布局常量 ────────────────────────────── */
// 簇内点间距、每簇上限、簇与核心的净距（均为世界坐标单位）。
const ISO_SPACING = 13;
const ISO_MAX_PER_CLUSTER = 16;
const ISO_GAP = 18;

// 孤岛没有边，力导向会把它们甩成一团。这里按 layer 分簇（126 个 S 层会再切成子簇），
// 簇内黄金角紧凑铺点，簇中心贴核心外圈排布。
// 关键：簇的径向宽度很小（几十个世界单位），远小于核心 span，
// 所以即使展开，核心的缩放基准也不被拉大。
function layoutIsolatedClusters(isolatedNodes, coreBounds) {
  const result = new Map();
  const n = isolatedNodes.length;
  if (n <= 0) return result;

  let cx = 0, cy = 0, halfW = 400, halfH = 300;
  if (coreBounds) {
    cx = (coreBounds.minX + coreBounds.maxX) / 2;
    cy = (coreBounds.minY + coreBounds.maxY) / 2;
    halfW = Math.max((coreBounds.maxX - coreBounds.minX) / 2, 150);
    halfH = Math.max((coreBounds.maxY - coreBounds.minY) / 2, 150);
  }

  // 按 layer 分组，再切成不超过 ISO_MAX_PER_CLUSTER 的子簇，避免单层过大变成一整团
  const byLayer = new Map();
  for (const nd of isolatedNodes) {
    const arr = byLayer.get(nd.layer) || [];
    arr.push(nd);
    byLayer.set(nd.layer, arr);
  }
  const clusters = [];
  for (const arr of byLayer.values()) {
    for (let i = 0; i < arr.length; i += ISO_MAX_PER_CLUSTER) {
      clusters.push(arr.slice(i, i + ISO_MAX_PER_CLUSTER));
    }
  }
  clusters.sort((a, b) => b.length - a.length);

  clusters.forEach((members, ci) => {
    const m = members.length;
    const clusterR = ISO_SPACING * Math.sqrt(m) * 0.58 + 5;
    // 簇中心：沿核心外圈椭圆均匀分布，使各簇外缘落在同一个薄带里
    const angle = (ci / clusters.length) * Math.PI * 2 - Math.PI / 2;
    const rx = halfW + ISO_GAP + clusterR;
    const ry = halfH + ISO_GAP + clusterR;
    const ccx = cx + Math.cos(angle) * rx;
    const ccy = cy + Math.sin(angle) * ry;
    // 簇内：黄金角螺旋，紧凑成圆盘
    for (let i = 0; i < m; i++) {
      const r = clusterR * Math.sqrt((i + 0.5) / m);
      const a = i * 2.399963;
      result.set(members[i].id, [ccx + Math.cos(a) * r, ccy + Math.sin(a) * r]);
    }
  });

  return result;
}

/* ────────────────────────────── 主组件 ────────────────────────────── */

// handle -> 内部状态。用 WeakMap 存，避免往 handle 上挂私有字段，也便于 focusNode 取用。
const HANDLE_STATE = new WeakMap();

/**
 * 挂载 / 重绘关系网图。只往 container 内画，不碰容器之外的 DOM。
 * @param {HTMLElement} container 容器
 * @param {object} graph GET /repo/:id/graph 的响应体（字段名不得改动）
 * @param {object} [options] { showIsolated=false, onSelectNode, maxNodes=400 }
 * @returns {{destroy:Function,setShowIsolated:Function,stats:{drawn:number,hidden:number,edges:number}}}
 */
export function renderGraphMap(container, graph, options) {
  if (!container || !container.appendChild) {
    throw new Error('renderGraphMap: container 不是有效元素');
  }
  const opt = options || {};
  const maxNodes = Number.isFinite(opt.maxNodes) ? opt.maxNodes : 400;

  const g = graph || {};
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rawEdges = Array.isArray(g.edges) ? g.edges : [];

  // ── 归一化节点：补齐可能缺失的度数字段（后端已算好，这里只兜底，不改变语义）
  const nodeById = new Map();
  const allNodes = rawNodes.map((n) => {
    const node = {
      id: n.id,
      name: n.name || String(n.id || '').split('/').pop() || '',
      dir: n.dir || '',
      layer: n.layer || 'Z',
      module: n.module || 'Z',
      importance: Number(n.importance) || 0,
      scale: n.scale || '',
      inDeg: Number(n.inDeg) || 0,
      outDeg: Number(n.outDeg) || 0,
      degree: 0,
      isolated: false,
    };
    node.degree = node.inDeg + node.outDeg;
    node.isolated = node.inDeg === 0 && node.outDeg === 0;
    nodeById.set(node.id, node);
    return node;
  });

  // 若后端未给度数，用边现算一次（只为兜底，契约要求前端不重算，正常不会走到）
  const anyDegree = allNodes.some((n) => n.degree > 0);
  if (!anyDegree && rawEdges.length) {
    for (const n of allNodes) { n.inDeg = 0; n.outDeg = 0; }
    for (const e of rawEdges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (a) a.outDeg++;
      if (b) b.inDeg++;
    }
    for (const n of allNodes) {
      n.degree = n.inDeg + n.outDeg;
      n.isolated = n.degree === 0;
    }
  }

  const coreNodes = allNodes.filter((n) => !n.isolated);
  const isolatedNodes = allNodes.filter((n) => n.isolated);

  // 只保留两端都在图里的边（契约保证如此，这里再防一手）
  const edges = rawEdges.filter((e) => nodeById.has(e.from) && nodeById.has(e.to));

  // ── 布局：核心一次算好；孤岛按环形铺点
  const positions = layoutForce(coreNodes, edges, 20261013);
  let coreBounds = null;
  if (positions.size) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [, p] of positions) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    coreBounds = { minX, minY, maxX, maxY };
  }
  const isolatedPos = layoutIsolatedClusters(isolatedNodes, coreBounds);
  for (const [id, p] of isolatedPos) positions.set(id, p);

  // 孤岛相对核心包围盒的实际外伸量（挂载时一次算好，与 showIsolated 无关）。
  // fitView 用它预留环带：折叠/展开都预留同宽，两态缩放完全一致，
  // 既不会展开时把核心挤小，也不会因为用最坏常量而白白浪费画布。
  let isoReach = 0;
  if (coreBounds && isolatedPos.size) {
    for (const [, p] of isolatedPos) {
      isoReach = Math.max(
        isoReach,
        coreBounds.minX - p[0],
        p[0] - coreBounds.maxX,
        coreBounds.minY - p[1],
        p[1] - coreBounds.maxY
      );
    }
    if (isoReach < 0) isoReach = 0;
    isoReach += 6; // 节点半径 + 少量余量
  }

  // ── DOM：容器内一个自适应画布 + 一个图例浮层（destroy 时一并移除）
  const prevPosition = container.style.position;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;overflow:hidden;' +
    'background:transparent;user-select:none;touch-action:none;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;';
  wrap.appendChild(canvas);

  const legend = document.createElement('div');
  legend.style.cssText =
    'position:absolute;left:10px;top:10px;max-width:46%;pointer-events:none;' +
    'display:flex;flex-wrap:wrap;gap:2px 10px;font:11px/1.5 system-ui,"Microsoft YaHei",sans-serif;' +
    'color:var(--text-muted,#8a857c);opacity:.92;';
  wrap.appendChild(legend);

  const hint = document.createElement('div');
  hint.style.cssText =
    'position:absolute;right:10px;bottom:8px;pointer-events:none;' +
    'font:11px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:var(--text-muted,#8a857c);opacity:.75;';
  hint.textContent = '滚轮缩放 · 拖拽平移 · 点击节点';
  wrap.appendChild(hint);

  container.appendChild(wrap);

  const ctx = canvas.getContext('2d');

  // ── 状态
  const state = {
    wrap,
    canvas,
    ctx,
    container,
    prevPosition,
    nodeById,
    allNodes,
    coreNodes,
    isolatedNodes,
    edges,
    positions,
    options: opt,
    maxNodes,
    showIsolated: !!opt.showIsolated,
    isoReach: isoReach,
    theme: readTheme(container),
    layerColors: {},
    drawnIds: new Set(),
    drawnEdges: [],
    visibleNodes: [],
    view: { scale: 1, tx: 0, ty: 0 },
    needsFit: true,
    hoverId: null,
    focusId: null,
    destroyed: false,
    raf: 0,
    ro: null,
    dragging: false,
    downX: 0,
    downY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
    stats: { drawn: 0, hidden: 0, edges: 0 },
  };
  HANDLE_STATE.set(container, state); // 备用（container 可能被复用）

  // ── 层级色阶：按数据中实际出现的层级排序后派生
  const presentLayers = [];
  const seenLayer = new Set();
  for (const n of allNodes) {
    if (!seenLayer.has(n.layer)) { seenLayer.add(n.layer); presentLayers.push(n.layer); }
  }
  state.layerColors = buildLayerColors(state.theme.accent, presentLayers);

  const accentRgb = parseColor(state.theme.accent) || [83, 125, 150];
  const borderRgb = parseColor(state.theme.border) || parseColor(state.theme.muted) || [200, 200, 200];
  const mutedRgb = parseColor(state.theme.muted) || [138, 133, 124];
  const textRgb = parseColor(state.theme.text) || [27, 27, 29];

  function nodeRadius(node) {
    // 孤岛统一小半径，减少外圈散点感；核心按度映射
    if (node.isolated) return 2.6;
    return clamp(3 + Math.sqrt(node.degree) * 1.7, 3, 15);
  }

  // ── 计算当前应画哪些节点 / 边，并刷新 stats
  function recomputeDrawable() {
    let visible = state.showIsolated ? allNodes.slice() : coreNodes.slice();
    visible.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));

    let drawn = visible;
    if (visible.length > maxNodes) drawn = visible.slice(0, maxNodes);

    const ids = new Set(drawn.map((n) => n.id));
    const de = edges.filter((e) => ids.has(e.from) && ids.has(e.to));

    state.visibleNodes = drawn;
    state.drawnIds = ids;
    state.drawnEdges = de;
    state.stats.drawn = drawn.length;
    state.stats.hidden = allNodes.length - drawn.length;
    state.stats.edges = de.length;
  }

  // ── 视图自适应：缩放基准永远是「核心节点」，孤岛不参与
  // 为了不让展开后的孤岛簇被视口裁掉，四边预留一个固定宽的环带（ISO_MAX_REACH）。
  // 关键：无论孤岛折叠还是展开，预留宽度相同，所以两态缩放完全一致，
  // 展开孤岛不会把核心缩小（视觉重心始终在中心）。
  function fitView() {
    const w = wrap.clientWidth || 1;
    const h = wrap.clientHeight || 1;
    const nodes = state.visibleNodes;
    if (!nodes.length) {
      state.view = { scale: 1, tx: w / 2, ty: h / 2 };
      return;
    }
    // 度量集：优先用可见的非孤岛；若被截断，退回全量核心节点
    let measureList = nodes.filter((n) => !n.isolated);
    if (!measureList.length) measureList = state.coreNodes.slice();
    if (!measureList.length) measureList = nodes; // 极端情况：全是孤岛，兜底

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of measureList) {
      const p = state.positions.get(n.id);
      if (!p) continue;
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    if (!Number.isFinite(minX)) { state.view = { scale: 1, tx: w / 2, ty: h / 2 }; return; }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const hx = Math.max((maxX - minX) / 2, 1);
    const hy = Math.max((maxY - minY) / 2, 1);
    // 环带宽度（世界单位）：挂载时算好的实际外伸量，折叠/展开预留同宽
    const ring = state.isoReach;
    const pad = 40;
    const availW = Math.max(w - pad * 2, 40);
    const availH = Math.max(h - pad * 2, 40);
    const scale = clamp(Math.min(availW / (2 * (hx + ring)), availH / (2 * (hy + ring))), 0.05, 8);
    state.view = { scale, tx: w / 2 - cx * scale, ty: h / 2 - cy * scale };
  }

  // ── 绘制
  function draw() {
    if (state.destroyed) return;
    const w = wrap.clientWidth || 0;
    const h = wrap.clientHeight || 0;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (state.needsFit) { fitView(); state.needsFit = false; }

    const { scale, tx, ty } = state.view;
    const sx = (v) => v * scale + tx;
    const sy = (v) => v * scale + ty;

    // 连线：先画，压在最底层
    const edgeColor = withAlpha(borderRgb, 0.55);
    ctx.lineWidth = 1;
    ctx.strokeStyle = edgeColor;
    ctx.beginPath();
    for (const e of state.drawnEdges) {
      const a = state.positions.get(e.from);
      const b = state.positions.get(e.to);
      if (!a || !b) continue;
      ctx.moveTo(sx(a[0]), sy(a[1]));
      ctx.lineTo(sx(b[0]), sy(b[1]));
    }
    ctx.stroke();

    // 节点
    const labels = [];
    for (const n of state.visibleNodes) {
      const p = state.positions.get(n.id);
      if (!p) continue;
      const px = sx(p[0]);
      const py = sy(p[1]);
      if (px < -40 || py < -40 || px > w + 40 || py > h + 40) continue; // 视口裁剪
      const r = nodeRadius(n) * Math.max(scale, 0.35);
      const isHover = n.id === state.hoverId;
      const isFocus = n.id === state.focusId;

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = state.layerColors[n.layer] || withAlpha(mutedRgb, 0.8);
      ctx.fill();

      if (n.isolated) {
        // 孤岛：虚线描边区分
        ctx.save();
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = withAlpha(mutedRgb, 0.9);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = withAlpha(textRgb, 0.22);
        ctx.stroke();
      }

      if (isHover || isFocus) {
        ctx.beginPath();
        ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = withAlpha(accentRgb, isFocus ? 1 : 0.85);
        ctx.stroke();
      }

      // 标签：度数高的枢纽 + 悬停/聚焦节点
      if (n.degree >= 5 || isHover || isFocus) labels.push([px, py, r, n]);
    }

    // 标签（避免互相压盖：已放置区域做简单占位判断）
    ctx.textBaseline = 'middle';
    ctx.font = '11px system-ui,"Microsoft YaHei",sans-serif';
    const placed = [];
    labels.sort((a, b) => b[3].degree - a[3].degree);
    for (const [px, py, r, n] of labels) {
      const isHi = n.id === state.hoverId || n.id === state.focusId;
      const label = n.name;
      const tw = ctx.measureText(label).width;
      const lx = px + r + 4;
      const ly = py;
      const box = [lx - 1, ly - 7, lx + tw + 1, ly + 7];
      if (!isHi) {
        let overlap = false;
        for (const b of placed) {
          if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { overlap = true; break; }
        }
        if (overlap) continue;
      }
      placed.push(box);
      if (isHi) {
        // 高亮标签给个底色，避免压在线上看不清
        ctx.fillStyle = withAlpha(parseColor(state.theme.bg) || [255, 255, 255], 0.82);
        ctx.fillRect(box[0] - 2, box[1] - 1, box[2] - box[0] + 4, box[3] - box[1] + 2);
      }
      ctx.fillStyle = isHi ? withAlpha(textRgb, 1) : withAlpha(mutedRgb, 0.95);
      ctx.fillText(label, lx, ly);
    }
  }

  function scheduleDraw() {
    if (state.raf || state.destroyed) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      draw();
    });
  }

  // ── 图例（随层级出现，展示色阶含义）
  function renderLegend() {
    const frag = document.createDocumentFragment();
    for (const code of presentLayers) {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap;';
      const dot = document.createElement('span');
      dot.style.cssText =
        'width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:' +
        (state.layerColors[code] || 'var(--text-muted,#8a857c)') + ';';
      const txt = document.createElement('span');
      txt.textContent = code + ' ' + layerLabel(code);
      item.appendChild(dot);
      item.appendChild(txt);
      frag.appendChild(item);
    }
    legend.textContent = '';
    legend.appendChild(frag);
  }

  // ── 命中测试：返回鼠标下的节点（后画的在上，倒序遍历）
  function hitTest(mx, my) {
    const { scale, tx, ty } = state.view;
    const list = state.visibleNodes;
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const p = state.positions.get(n.id);
      if (!p) continue;
      const px = p[0] * scale + tx;
      const py = p[1] * scale + ty;
      const r = nodeRadius(n) * Math.max(scale, 0.35) + 3;
      const ddx = mx - px;
      const ddy = my - py;
      if (ddx * ddx + ddy * ddy <= r * r) return n;
    }
    return null;
  }

  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return [ev.clientX - rect.left, ev.clientY - rect.top];
  }

  // ── 事件：滚轮缩放（以指针为锚点）
  function onWheel(ev) {
    ev.preventDefault();
    const [mx, my] = localPoint(ev);
    const { scale, tx, ty } = state.view;
    const factor = Math.pow(1.0015, -ev.deltaY);
    const next = clamp(scale * factor, 0.05, 12);
    if (next === scale) return;
    // 保持指针下的世界坐标不动
    const wx = (mx - tx) / scale;
    const wy = (my - ty) / scale;
    state.view = { scale: next, tx: mx - wx * next, ty: my - wy * next };
    scheduleDraw();
  }

  function onPointerDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const [mx, my] = localPoint(ev);
    state.dragging = true;
    state.moved = false;
    state.downX = mx;
    state.downY = my;
    state.lastX = mx;
    state.lastY = my;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
  }

  function onPointerMove(ev) {
    const [mx, my] = localPoint(ev);
    if (state.dragging) {
      const ddx = mx - state.lastX;
      const ddy = my - state.lastY;
      if (Math.abs(mx - state.downX) + Math.abs(my - state.downY) > 4) state.moved = true;
      state.view.tx += ddx;
      state.view.ty += ddy;
      state.lastX = mx;
      state.lastY = my;
      scheduleDraw();
      return;
    }
    const hit = hitTest(mx, my);
    const id = hit ? hit.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    if (id !== state.hoverId) {
      state.hoverId = id;
      scheduleDraw();
    }
  }

  function onPointerUp(ev) {
    if (!state.dragging) return;
    state.dragging = false;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
    if (state.moved) return; // 拖拽过，不算点击
    const [mx, my] = localPoint(ev);
    const hit = hitTest(mx, my);
    if (hit && typeof opt.onSelectNode === 'function') {
      try { opt.onSelectNode(hit.id); } catch (err) { console.error('[graph-map] onSelectNode 抛错:', err); }
    }
  }

  function onPointerLeave() {
    if (state.hoverId !== null) {
      state.hoverId = null;
      scheduleDraw();
    }
    if (!state.dragging) canvas.style.cursor = 'grab';
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  // ── 尺寸变化重绘
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { state.needsFit = true; scheduleDraw(); });
    ro.observe(wrap);
    state.ro = ro;
  } else {
    state.onResize = () => { state.needsFit = true; scheduleDraw(); };
    window.addEventListener('resize', state.onResize);
  }

  // ── 初始化
  state.__draw = draw;        // 供 focusNode 直接触发重绘
  state.__fit = () => { state.needsFit = true; };
  recomputeDrawable();
  renderLegend();
  state.needsFit = true;
  draw();

  // ── handle
  const handle = {
    get stats() {
      return { drawn: state.stats.drawn, hidden: state.stats.hidden, edges: state.stats.edges };
    },
    setShowIsolated(flag) {
      if (state.destroyed) return;
      const next = !!flag;
      if (next === state.showIsolated) return;
      state.showIsolated = next;
      recomputeDrawable();
      state.needsFit = true;
      scheduleDraw();
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
      if (state.ro) { state.ro.disconnect(); state.ro = null; }
      if (state.onResize) { window.removeEventListener('resize', state.onResize); state.onResize = null; }
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      HANDLE_STATE.delete(container);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      // 还原容器原有 position（仅在确实是我们改过时）
      if (container.style.position === 'relative' && prevPosition === '') {
        container.style.position = '';
      }
    },
  };

  // focusNode 需要拿到 handle，这里把 state 也挂上，便于外部查找
  state.handle = handle;
  HANDLE_STATE.set(handle, state);

  return handle;
}

/**
 * 从外部定位 / 高亮某个节点（清单点一行 → 图上聚焦）。
 * @param {object} handle renderGraphMap 返回的句柄
 * @param {string} nodeId 目标 node.id
 * @returns {boolean} 是否命中并定位成功（节点不存在或当前未画出时返回 false）
 */
export function focusNode(handle, nodeId) {
  const state = handle && HANDLE_STATE.get(handle);
  if (!state || state.destroyed) return false;
  if (!state.drawnIds.has(nodeId)) return false;
  const p = state.positions.get(nodeId);
  if (!p) return false;

  const w = state.wrap.clientWidth || 1;
  const h = state.wrap.clientHeight || 1;
  const scale = clamp(Math.max(state.view.scale, 1.2), 0.05, 12);
  state.view = { scale, tx: w / 2 - p[0] * scale, ty: h / 2 - p[1] * scale };
  state.focusId = nodeId;
  state.hoverId = nodeId;
  state.needsFit = false;      // 定位后不要重新自适应，否则会跳回全景
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
  // 直接同步重绘（renderGraphMap 初始化时把 draw 挂到 state.__draw 上）
  if (typeof state.__draw === 'function') state.__draw();
  return true;
}
