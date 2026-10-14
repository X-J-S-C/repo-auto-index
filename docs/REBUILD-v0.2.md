# repo-auto-index 面板 v0.2 · 重建记录

**日期**：2026-10-13
**触发**：面板排版未达官方标准，要求改用官方 SDK 组件、参照现成优雅方案。
**结论**：根因不是"审美不到位"，是**契约缺失**。上一版（v0.1）55 个 DOM id 里 49 个从未被脚本引用，六态各复制一份 DOM 导致 `querySelector` 只命中第一份。本版重建契约并接通官方组件。

---

## 1. 上一版的三个结构性缺陷（实测证据）

### 缺陷一：DOM 与 JS 的契约破了
扫过 panel.html 全部 id，与 panel.js 实际引用的做交叉比对（离线台 `panel.js` 静态引用扫描）：

| id | 在 HTML | 被 js 引用 |
|---|---|---|
| `rescan-btn` `rescan-btn-err` `rescan-btn-can` | 有 | **无** |
| `cancel-btn` `cancel-btn-2` | 有 | **无** |
| `add-submit` `add-submit-inline` | 有 | **无** |
| `copy-dir-btn` `copy-dir-btn-err` `copy-dir-btn-can` | 有 | **无** |
| `open-registry-btn` ×3 | 有 | **无** |
| `copy-preview-btn` `copy-trace-btn` ×3 | 有 | **无** |
| `sys-*`（7 个） | 有 | **无** |

脚本只绑了 6 个事件（`refresh` `search-form` `search-q` `add-btn` + 两处动态）。**`add-btn` 在 HTML 里根本不存在**，所以空态的"登记并扫描"从来点不动。`rescan-btn` 是 B8 操作区唯一出口，也没绑——重扫按钮点了没反应。

### 缺陷二：`querySelector` 撞车 → 统计恒显 0
详情区为六种状态各复制了一份完整 DOM。同名类出现次数：

```
.id-name  ×4    .id-slug  ×4    .id-dir  ×8
[data-stat="total"]  ×4    .ii-file  ×2
```

`renderStats()` 用 `block.querySelector('[data-stat="total"]')` 取元素——**永远命中第一份**（`state-loading` 那一份，值恒为 0）。页面上看得见的那份永远不被填。这就是"统计显示 0"的机制，与数据无关。

### 缺陷三：六态切换不完整
`setState()` 只处理 `progress` / `stats` / `identity` 三块；`index` / `preview` / `trace` / `ops` / `search` 各自散落另一套分支。`search` 块调 `setState("search","empty")` 只切 `.state` 子元素，而 `#search-form`、`.search-semantics` 是它的**兄弟节点**，不在切换范围内 → 搜索表单在"空态"下仍然可见。

---

## 2. 官方组件的真相（推翻了 v0.1 的判断）

`@hana/app-sdk/components` 是 **React** 组件库，而 Hana v2 页面默认是**无构建的手写 HTML**。这一层落差就是"美术映射两度失败"的真实原因——v0.1 做的是"照抄官方 CSS 观感"，从未接通组件本身。

但 SKILL `hana-app-creator` 第 465 行给出了**无构建挂载路径**：

```js
import { mountAppUi, appUi, appUiIcon } from "./app-ui.js";
mountAppUi(el, "Button", { children: "x", variant: "primary", onClick });
```

本版已实测：**23 个控件全部可挂**，且**没有 shadow DOM**（渲染成普通 DOM，antd 系类名 + CSS-in-JS），因此自有 CSS 可以正常配合：

```
Button IconButton TextInput TextArea Checkbox Select Toggle NumberInput
SettingsRow SettingsSection SettingsStack Inline Grid SaveButton
VerificationButton ContextMenu DropdownMenu Tooltip ListRow Tabs
EmptyState Busy ErrorState
```

### 实测踩到的两个坑（已规避）
1. **`Tabs` 的 prop 是 `items`**，不是 `tabs`。传 `tabs` 会抛 `Cannot read properties of undefined (reading 'map')`。
   正确形状：`{ items: [{ value, label }], value, onChange }`
2. **`Grid` 的 `minColumnWidth` 不生效**，永远铺 2 列（源码未接该 prop）。统计四数改为自有 `.stat-grid` 控制列数。

---

## 3. 本版的做法

- **契约先行**：`docs/CONTRACT.md` 列出全部 id 与区块，改代码前先改契约。校验方式：`tests/_contract-check.mjs`（三向比对，exit 0 一致 / 2 有破裂）。
- **一个 id 只出现一次**：脚本经 `byId()` 取元素，`querySelector` 只在区块内使用。
- **一个区块一份 DOM**：状态用 `data-status` 属性表达，不再复制六份。
- **官方组件承担全部交互件**：按钮、输入、页签、空态、错误态都用 `mountAppUi`。
- **挂载生命周期收口**：`mount()` 先 `destroy` 再挂；轮询用签名去重（`changed()`）避免每秒重挂造成闪烁与丢焦点。
- **主题跟随宿主**：读 `hana.theme.getSnapshot().cssUrl` 注入宿主主题样式，官方控件据此取色。

---

## 4. 离线验证台（可复验）

位置：一个独立于 App 的离线渲染台目录。

用真数据（从 `app-data/repo-auto-index/projects.json` + aoci 三文件生成 `fixture.json`）离线渲染，不碰桌面端、不需要真人当测试员。

| 脚本 | 作用 |
|---|---|
| `sweep.mjs before\|after` | 六态逐个渲染 + 断言 + 截图（ready/scanning/canceled/error/empty/blocked） |
| `sweep-tabs.mjs` | 四个页签逐个切换 + 截图 + 搜索实测 |
| `sweep-interact.mjs` | 按钮真实性、页签切换、轮询下焦点保持、窄屏溢出 |
| `diagnose.mjs` | 逐个控件挂载探测，定位崩溃源 |
| `probe-layout.mjs` | 实测官方 Grid / ListRow / Tabs 的布局行为 |

### 验证结果（全部通过）

**六态**（`node sweep.mjs after`）：
```
ready     errors: none   数字 740 / 76 / 0 / 473
scanning  errors: none   903 条目 / 412 文件 / 58 目录 / 结束才知
canceled  errors: none   部分 305（下限）/ 部分 41 / 未统计
error     errors: none   未获得 / — / — / —
empty     errors: none   整页空态 + 登记表单
blocked   errors: none   740（受阻，非全仓）/ 7
```

**页签**（`node sweep-tabs.mjs`）：
```
概览/索引/搜索/轨迹 四页签切换正常
索引页：主索引 aoci.code.txt · 392 条目（实时读取；合并行为 473，含 81 行 `===` 卷头）
预览页：8488 字符真实内容
轨迹页：6032 字符（真 trace 尾 200 行）
搜索「aoci」：命中 7 行（与真后端昨晚结果一致）
```

**交互**（`node sweep-interact.mjs`）：
```
1) 重新扫描按钮    => 发出 /rescan 请求 ✓
2) 复制目录路径    => 事件绑定 ✓
3) 页签切换        => 四个 pane 正确互斥 ✓
4) 轮询中搜索框    => 焦点=search-q，值="aoci" 未丢 ✓
5) 窄屏 420px      => scrollWidth=420=clientWidth，不溢出 ✓
```

**控件探测**（`node diagnose.mjs`）：Tabs / Grid / ListRow / Button / EmptyState / ErrorState / TextInput / IconButton 全部 `ok`。

---

## 5. 未做的事（诚实交代）

- 桌面端真机未装本版（离线台验证完毕，待覆盖安装后刷新确认）。
- `Tabs` 的分段控件是全宽样式，用 CSS 限宽成 420px；宿主 minAppVersion 变化时需复核。
- 跟踪到的宿主主题注入依赖 `hana.theme.getSnapshot().cssUrl` 存在；拿不到时走兜底色，不报错。
