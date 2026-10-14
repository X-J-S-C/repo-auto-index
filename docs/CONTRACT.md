# repo-auto-index 面板 · 契约 v1

这份文件是面板的**唯一契约**。改代码前先改这里，改完这里再改代码。
它存在的理由：v0.1 的 55 个 DOM id 里有 49 个从未被脚本引用，六态各复制一份 DOM
导致 `querySelector` 只命中第一份（统计恒显 0），按钮点了没反应。
根因是**没有契约**——HTML 和 JS 各自演化，靠名字撞运气。

---

## 1. 三层结构

```
HTML（固定骨架，永不变形）
  └─ 每个区块一个容器 [data-block="<name>"]
       └─ 状态用 [data-status="empty|loading|scanning|ready|error|canceled"] 表达
            └─ JS 只填内容 / 只切 data-status，绝不增删区块容器

官方组件（app-ui.js）只挂载到 [data-mount] 的专属容器里，一个容器一个控件。
```

**硬规则**

1. 一个 id 在整份 HTML 里**只出现一次**。重复即错误。
2. 一个区块**只有一个** DOM 结构，状态用属性切换，**禁止**为六态各复制一份。
3. 脚本只通过 `byId()` 取元素；`querySelector` 只允许用于区块内部（限定在 `block(name)` 之下）。
4. 官方控件的挂载点用容器 id 的 `-mount` 后缀标注（实测未使用 `data-mount` 属性）；重渲染前必须 `destroy()`。

---

## 2. 区块与 id 总表（唯一真相）

结构事实（2026-10-13 由 `panel.html` 与 `panel.js` 双向核对生成）：
侧栏与详情均为**无名容器**，靠 class 定位；页签用 `[data-pane]` 互斥，区块用 `[data-block]` + `[data-status]`。
控件挂载点一律是 id 以 `-mount` 结尾的空容器，**没有** `data-mount` 属性。

| 区块 / 区域 | `data-block` | 容器 | 内部固定 id | 挂载点（`-mount`） |
|---|---|---|---|---|
| 顶栏 | — | `root`（带 `data-hana-app-ui` `data-status`） | `ov-stamp` `bar-hint` | `refresh-mount` |
| 整页错误 | — | `err-view`（`hidden` 切换） | `err-detail` `err-datadir` | `err-mount` |
| 空态 | — | `empty-view` | `add-status` | `empty-mount` `add-dir-mount` `add-name-mount` `add-submit-mount` |
| 侧栏汇总 | — | `summary` | — | — |
| 侧栏计数 | — | `.side-head` | `side-count` | — |
| 侧栏列表 | — | `repolist` | — | `add-inline-mount` |
| 主体 | — | `board` `detail` | — | — |
| B1 身份 | — | `.d-head` `.d-meta` | `id-name` `id-slug` `id-dir` `id-git` `id-git-row` `id-times` | `id-badge-mount` `copy-dir-mount` `copy-git-mount` |
| 页签 | — | `tabs-mount` | — | `tabs-mount` |
| B2 进度 | `progress` | `.block[data-block=progress]` | `progress-note` `progress-indet` `progress-counters` | `progress-actions` |
| B3 统计 | `stats` | 同上 | `stats-note` `stats-foot` | `stats-mount` |
| B4 操作 | `ops` | 同上 | — | `ops-mount` |
| B10 交付 | `deliver` | 同上 | `deliver-note` `deliver-foot` `deliver-target` `dt-title` `dt-id` `session-picker` `sp-count` `sp-list` | `deliver-mount` `dt-jump-mount` `dt-pick-mount` `sp-close-mount` `sp-filter-mount` |
| B5 索引 | `index` | 同上 | `index-time` `index-info` `index-foot` `index-guide` | `index-guide-mount` |
| B6 预览 | `preview` | 同上 | `preview-count` `preview-body` | `preview-actions` |
| B7 搜索 | `search` | 同上 | `scope-name` `search-q` `search-semantics` `search-results` | `search-submit-mount` |
| B8 轨迹 | `trace` | 同上 | `trace-path` `trace-body` | `trace-actions` |
| B9 关系 | `graph` | 同上 | `graph-note` `graph-view` | `graph-actions` `graph-mode-mount` |
| C 环境 | — | `sys` | `sys-datadir` `sys-write` `sys-task` `sys-perms` `sys-limits` | — |

五个页签由 `[data-pane]` 互斥：`overview` / `index` / `search` / `trace` / `relations`。
关系图内部结构与数据契约为独立文件 **`docs/GRAPH-CONTRACT.md`**（§1 解析、§2.5 冻结接口），本表只登记其容器。

> 上表里出现过的 id，就是脚本允许触碰的全部。新加 id 必须同时加进这张表。
> 校验方式：把 `panel.html` 的全部 `id="…"`、`panel.js` 的全部 `byId("…")`、本表逐项三向比对，任何一侧多出或少掉即视为契约破裂。

---

## 3. 数据来源与口径（不得改写）

| 字段 | 来源 | 口径 |
|---|---|---|
| `repos[]` | `GET /overview` | 真相源是 `dataDir/projects.json` |
| `progress.total` | 同上 | **已发现文件数**，扫描结束前不是终值。不是分母 |
| `progress.scanned` | 同上 | 已处理条目 = 文件 + 目录，与 total 不同口径 |
| `progress.dirCount` | 同上 | 根计入 1；无扩展名文件可能被误判为目录 |
| `progress.denied` | 同上 | 只在 done 分支落盘；canceled 分支丢失 |
| `index.entries` | `GET /repo/:id` | 三文件里 `name[TAG]:` 形状的行数，即**条目数**，与 `aoci status` 的 `index_entries` 同口径 |
| `index.entryLines` | 同上 | 三文件合并后**非空非 `#`** 的行数（旧口径，含 `===` 卷头）。仅供对照历史数字，界面不显示 |
| `hits[].line` | `GET /repo/:id/search` | **合并虚拟文档**行号，禁止写成 `aoci.code.txt:N` |

**禁止的派生指标**：完成度百分比（没有分母）、索引覆盖率（行数 ÷ 文件数无意义）。

---

## 4. 六态定义（每块独立判定，不共享全局态）

| 态 | 判定 | 视觉 |
|---|---|---|
| `empty` | 无数据可显示 | 说清"没有 X"，给下一步动作 |
| `loading` | 请求在飞 | 骨架灰条；**禁止**用 0 或上一轮的值冒充 |
| `scanning` | `status === "scanning"` | 不确定条 + 计数器 + 红色打断钮 |
| `ready` | `status === "done"` | 终值 + 口径脚注 |
| `error` | `status === "error"` 或 HTTP `ok:false` | 赭红块 + 原始 error + 重扫出口 |
| `canceled` | `status === "canceled"` | 计数全标"部分/下限" |

**态内徽标（不是第七态）**

- `受阻`：`done && denied > 0` → 数字不是全仓真值
- `触顶`：`capped === true` → 数字是下限
- `可疑`：`scanning && phase === "done"` → 幻影扫描

---

## 5. 官方组件挂载规则

```js
import { mountAppUi, appUi, appUiIcon } from "./app-ui.js";

// 一个容器一个控件；重渲染前 destroy
function mount(el, name, props) {
  const handle = mountAppUi(el, name, props);
  handles.set(el, handle);
  return handle;
}
function remount(el, name, props) {
  handles.get(el)?.destroy();
  return mount(el, name, props);
}
```

可用控件（v0.0.0，实测 23 个）：
`Button` `IconButton` `TextInput` `TextArea` `Checkbox` `Select` `Toggle` `NumberInput`
`SettingsRow` `SettingsSection` `SettingsStack` `Inline` `Grid` `SaveButton`
`VerificationButton` `ContextMenu` `DropdownMenu` `Tooltip` `ListRow` `Tabs`
`EmptyState` `Busy` `ErrorState`

图标：`appUiIcon("chevron" | "check" | "loading" | "failure")`

**必须**：容器祖先带 `data-hana-app-ui`，否则抛 `APP_UI_SCOPE_REQUIRED`。
**必须**：不要挂到 `<body>` / `<html>`，否则抛 `APP_UI_SCOPE_ROOT_INVALID`。

---

## 6. 验收清单（每一条都要能在离线台复现）

1. 六态逐个渲染，无堆叠、无空槽位、无脚本报错。
2. 每个数字旁可追溯到"从哪来、什么时候采的、什么条件下不可信"。
3. 扫描态恒有红色打断钮；全页**零**百分比进度条。
4. 点得动的按钮必须真的绑了事件（对照 §2 表逐个点）。
5. 搜索输入框在轮询中不丢焦点、不丢输入。
6. 窄屏（< 760px）单列，不横向溢出。
7. 交付块（`deliver`）两个入口都在，且每条失败路径都有可读提示：无 `hana.sessions.getActive`、`APP_SESSION_SURFACE_UNSUPPORTED`、无选中会话、后端无投递路由（404），四种情况各自给出不同文案，不静默。
