# 关系视图 · 接口冻结 v1

**本文件是唯一接口契约。三路子助手都以此为准，不得自行改字段名、改路径、改语义。**
如需变更，先回来改这份文件，再重新派活。

---

## 0. 已冻结的事实（实测，不是假设）

| 事实 | 值 | 出处 |
|---|---|---|
| 数据源 | 仓库根目录 `aoci.code.txt` | 后端 `readIndexFile` 三文件合并 |
| 对象总数 | 392 条 Entry | 实测 |
| R 关系边 | 319 条原始，**313 条可解析** | 实测 |
| R 目标基准路径 | 示例数据为 `C:/projects/atlas` | **实测三个候选定案，命中率 97.2%** |
| 解析质量 | 310 条按完整相对路径命中，3 条退化为按文件名，**0 条歧义** | 实测 |
| 无法解析 | 6 条（指向未被索引的图片） | 实测 |
| 孤立对象 | 154 条（无出边也无入边） | 实测 |
| Entry 格式 | `名称[TAG]: F:… \| R:… \| A:… \| S:…` | aoci.meta.txt |
| TAG 四字符 | `A层 B模块 C重要度 E规模` | aoci.meta.txt 字典 |

### ⚠️ 三个必须避开的坑

1. **基准路径不能猜**。取"所有目录的公共前缀"会得到一个过浅的目录，命中率 **0%**；假定为仓库根只命中 **0.9%**。必须按候选试算，选完整路径命中率最高的。
2. **标签是 4 位不是 5 位**。正则写 `[A-Z0-9]{5}` 会解析出 0 条。正确：`[A-Z0-9]{4,5}`。
3. **字段切分不能用 `split(" | ")`**。S 字段正文里可能含 `|`。必须用 `(?:^|\s\|\s)([FRAS]):\s*` 逐段定位。

### 字典（展示层用，取自 aoci.meta.txt）

```
A层：C共享基础 E入口边界 A应用编排 D领域逻辑 K算法计算 M中间件 P持久化 I集成适配
     R运行基础 L库与SDK F声明配置 O运维交付 T测试验证 S文档规范 X开发工具 Z其他
B模块：G跨域通用 U用户交互 B核心业务 D数据状态 I身份权限 N网络协议 M消息事件
     S安全隐私 C配置策略 O可观测性 R可靠性恢复 P性能资源 W流程调度 A分析智能
     H硬件设备 L本地化 V构建发布 Q质量保障 E扩展插件 Z其他
```

---

## 1. 后端接口（App 路由）

在 `index.js` 的 `sdk.routes.register` 里**新增两个只读路由**，不改动现有路由。

### `GET /repo/:id/graph`

返回整个关系图。**一次全量**，不做分页（392 节点规模可接受）。

```json
{
  "ok": true,
  "repo": "atlas-workspace",
  "volume": "aoci.code.txt",
  "root": "C:/projects/atlas",
  "generatedAt": "2026-10-13T10:20:00.000Z",
  "stats": {
    "nodes": 392,
    "edges": 313,
    "unresolved": 6,
    "isolated": 154,
    "byLayer": [["S", 213], ["F", 54]],
    "byModule": [["A", 135], ["U", 85]],
    "resolution": { "path": 310, "name": 3, "ambiguous": 0 }
  },
  "nodes": [
    {
      "id": "widgets/chess-duel-card/assets/engine/board.js",
      "name": "board.js",
      "dir": "widgets/chess-duel-card/assets/engine",
      "layer": "K", "module": "G", "importance": 7, "scale": "L",
      "F": "…", "R": "…", "A": "…", "S": "…",
      "inDeg": 28, "outDeg": 3
    }
  ],
  "edges": [
    { "from": "<node.id>", "to": "<node.id>" }
  ],
  "unresolved": ["_avatars/handoff-stream.png"]
}
```

**字段语义（不得改写）**

| 字段 | 含义 | 硬要求 |
|---|---|---|
| `node.id` | 仓内相对路径（相对 `root`） | **边只引用 id**，不再用文件名 |
| `node.name` | 文件名（含扩展名） | 展示用 |
| `node.dir` | 相对 root 的目录 | 展示用 |
| `node.layer` / `module` | TAG 第 1、2 位 | 单字符码，字典在 §0 |
| `node.importance` | TAG 第 3 位 | **转成 number**，不是字符串 |
| `node.scale` | TAG 第 4 位 | 单字符 |
| `node.F/R/A/S` | 四个字段原文 | 原样返回，**不改写、不截断** |
| `node.inDeg` / `outDeg` | 入度 / 出度 | 后端算好，前端不重算 |
| `edge.from` / `to` | 均为 `node.id` | 两端必须都能在 `nodes` 里找到 |
| `unresolved` | 对不上的 R 目标原文数组 | 单独列出，**不混进 edges** |

**解析规则（后端唯一实现）**

```
基准 root：候选集合 = [公共前缀, 公共前缀的父目录, 各 dir 前 5 个]
          选「按完整路径命中率最高」者（示例数据实测 = C:/projects/atlas）
边的目标解析顺序：
  1) root + "/" + v 能命中某 Entry 的完整路径  → how=path
  2) 否则按文件名唯一匹配                      → how=name
  3) 多候选 → how=name-ambiguous（实测为 0）
  4) 全不中 → 计入 unresolved，不生成边
```

### `GET /repo/:id/node?path=<仓内相对路径>`

返回单个对象的详情 + 它的出边与入边（含对端摘要）。列表视图点开一项时用。

```json
{
  "ok": true,
  "node": { "…同 graph.nodes[] 的元素…" },
  "out": [ { "id": "…", "name": "…", "layer": "F", "module": "E", "F": "…" } ],
  "in":  [ { "id": "…", "name": "…", "layer": "S", "module": "A", "F": "…" } ]
}
```

`out` / `in` 每项是**对端摘要**（id/name/layer/module/F 五个字段），不是完整节点。
`path` 参数是 `node.id` 的值。找不到返回 `404`。

---

## 2. 前端接口（面板）

### 新增页签

在现有四页签（概览/索引/搜索/轨迹）后**追加第五个**：`关系`。

`TABS` 数组加一项：`{ value: "relations", label: "关系" }`，并在 `panel.html` 加：

```html
<div class="pane" data-pane="relations" hidden>
  <div class="block" data-block="graph" data-status="empty">
    <div class="block-head">
      <span class="bh-title">关系</span>
      <span id="graph-note" class="bh-note"></span>
      <div id="graph-actions" class="bh-actions"></div>
    </div>
    <div class="tabs-bar" id="graph-mode-mount"></div>
    <div id="graph-view"></div>
  </div>
</div>
```

### 两种模式（两种都要）

用官方 `Tabs` 做二级切换，挂在 `graph-mode-mount`：

```js
mount("graph-mode-mount", "Tabs", {
  items: [
    { value: "map", label: "关系网" },
    { value: "list", label: "清单" },
  ],
  value: state.graphMode,          // "map" | "list"，默认 "map"
  onChange: (v) => { state.graphMode = v; renderGraph(); },
});
```

### 数据获取（前端唯一入口）

```js
async function loadGraph() {
  const id = state.selected;
  if (!id) return;
  if (state.graph?.repo === id) return;      // 已缓存
  state.graph = await getJson(`repo/${encodeURIComponent(id)}/graph`);
}
```

缓存键是 `repo`。切换仓库时作废。**不要**在轮询 `tick()` 里重新拉 graph（关系不随扫描变），只在切仓/刷新时拉。

### 关系网（map）

- 渲染 392 个节点 + 313 条边。
- **孤岛（`inDeg===0 && outDeg===0`）默认折叠**：网图里不画，改为图下方一行 `另有 154 个对象没有关系 [展开]`，点开才加入。
- 节点半径映射 `inDeg+outDeg`；颜色映射 `layer`（用 §0 字典）。
- 必须有：缩放、拖拽、点击节点 → 切到清单模式并定位到该对象。
- 单文件实现，**不引入外部 CDN 依赖**（App 静态资源限定包内）。

### 清单（list）

- 按 `layer` 分组（用字典中文名），组内按 `inDeg+outDeg` 降序。
- 每行显示：`名称` · `dir` · `F` 摘要 · `入 N / 出 M`。
- 点开一项 → 调 `/repo/:id/node?path=…` → 展开显示 `F/R/A/S` 全文 + **出边列表** + **入边列表**（点对端可跳转）。
- 孤岛单独一组，标题 `无关系（154）`，默认折叠。

### 契约要点（前端）

- 所有数字来自 `/graph`，**前端不重算** inDeg/outDeg。
- `unresolved` 必须显示出来（诚实性）：图下方一行 `6 个 R 目标指向未索引的对象`，可展开看原文。
- 面板其余部分（六态、官方控件挂载、签名去重）规则不变，见 `docs/CONTRACT.md`。

---

## 2.5 网图组件接口（B 路交付，C 路调用）

B 路产出单文件 `ui/assets/graph-map.js`，**只导出两个符号**，C 路照此调用：

```js
// 挂载/重绘。容器由 C 路提供，B 路不碰容器之外的 DOM。
// 返回一个句柄，供 C 路在切换仓库/模式时销毁。
export function renderGraphMap(container, graph, options) { … return handle; }

// 可选：让 C 路从外部高亮/定位某个节点（清单里点一行 → 图上聚焦）
export function focusNode(handle, nodeId) { … }
```

**参数契约**

| 参数 | 类型 | 说明 |
|---|---|---|
| `container` | `HTMLElement` | C 路给的容器，B 路只往里面画 |
| `graph` | `object` | 就是 `GET /repo/:id/graph` 的响应体，**字段名不得改动** |
| `options.showIsolated` | `boolean` | 是否把孤岛画进图，默认 `false` |
| `options.onSelectNode` | `(nodeId) => void` | 点节点时回调，C 路用它切到清单模式 |
| `options.maxNodes` | `number` | 安全阀，超过时聚合，默认 `400` |

**handle 契约**

| 方法/字段 | 说明 |
|---|---|
| `handle.destroy()` | 幂等销毁，解绑所有监听、清空容器 |
| `handle.setShowIsolated(bool)` | 切换孤岛显示 |
| `handle.stats` | `{ drawn, hidden, edges }` 实际画了多少，供 C 路显示诚实数字 |

**B 路硬要求**

1. **零外部依赖**：不引 CDN、不引 npm 包。纯 DOM + Canvas 或 SVG，自包含。
2. **渲染 392 节点不卡**：力导向迭代要有上限，或改用预计算布局（分层环形/网格）。
3. **孤岛默认不画**，由 `options.showIsolated` 控制。
4. 必须有缩放与拖拽；点击节点触发 `onSelectNode`。
5. 颜色取宿主主题变量（`--accent` 等），不写死色值。

---

| 路 | 负责 | 交付物 | 验收 |
|---|---|---|---|
| A | 后端解析 | `index.js` 两个新路由 + 解析函数 | `node --check` 过；对真文件跑出 392/313/310/6/154 |
| B | 关系网图 | `ui/assets/graph-map.js` | 392 节点可渲染；孤岛折叠；无外部依赖 |
| C | 清单 + 接线 | `panel.html` / `panel.js` / `panel.css` 增补 | 五页签可切；点节点能跳；零脚本报错 |

**验收证据要求（三路共同）**：每条结论附可复现命令或截图，不接受"应该没问题"。

---

## 4. 离线验证台

位置：一个独立于 App 的离线渲染台目录。

| 文件 | 用途 |
|---|---|
| `build-contract.mjs` | 从真 aoci.code.txt 生成 `graph-contract.json`（基准+解析+统计的参考实现） |
| `graph-contract.json` | 冻结的真数据（392/313/310/6/154） |
| `sweep.mjs` / `sweep-tabs.mjs` / `sweep-interact.mjs` | 六态 / 页签 / 交互回归 |

**A 路的实现必须与 `build-contract.mjs` 的输出逐字段对齐**（同一份真文件，同样 392/313/310/6/154）。
