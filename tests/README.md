# 验证台

离线渲染台与回归脚本。最初是一个独立于 App 的预览台，2026-10-13 收编进本仓库。

## 它做什么

起一个本地 HTTP 服务，用 `fixture.json` 当真数据，对同一份数据注入不同 `status` 得到六个状态，逐态截图并断言：**布局改动没有把任何一态改坏**。它不需要宿主、不需要真仓库，纯本地跑。

## 前置

```powershell
npm install          # 只依赖 playwright-core
```

Playwright 的 chromium 需要在脚本里指定的路径存在（见 `sweep.mjs` 的 `executablePath`）。

## 跑法

```powershell
node sweep.mjs after        # 六态：ready/scanning/canceled/error/empty/blocked
node sweep-tabs.mjs         # 页签互斥
node probe-tabs.mjs         # 页签指示器跟随
node sweep-relations.mjs    # 关系页
node probe-deliver.mjs      # 交付区块的兜底路径
node shoot-chain.mjs chain-ok.png 720 900 --chain=broken   # 链路卡三态
```

产出在 `out/<tag>/`：每态一张 PNG + 一份 `report.json`。**每态的 `errors` 必须是 `(none)`**，这是通过判据。
其余 `shoot-*.mjs` 的截图默认也落在 `out/`（例：`out/chain-shot.png`）。
`tests/*.png` 已在 `.gitignore` 里——截图是产出物，不入库，需要时重跑即可。

## 脚本清单

| 脚本 | 用途 |
|---|---|
| `sweep.mjs` | 六态主回归（每态断言 + 截图） |
| `sweep-tabs.mjs` / `probe-tabs.mjs` | 页签互斥与指示器位置 |
| `sweep-interact.mjs` | 交互态（轮询、窄屏、焦点） |
| `sweep-relations.mjs` / `shoot-relations.mjs` | 关系页与关系网 |
| `shoot-map.mjs` | 关系网图截图 |
| `shoot-report.mjs` | 报告卡各态截图 |
| `shoot-chain.mjs` | 链路体检卡三态截图（`--chain=ok|partial|broken`） |
| `probe-deliver.mjs` | 交付区块四种失败路径 |
| `probe-layout.mjs` | 布局探测 |
| `build-contract.mjs` | 从 HTML 与 JS 派生契约表 |
| **`_contract-check.mjs`** | **全页两向 + 面板三向：每张卡「id 唯一」「JS 引用必存在」，panel 额外比 `docs/CONTRACT.md` §2 表。exit 0 一致 / 2 有破裂** |
| **`_resolve.mjs`** | **静态服务器的双根解析：测试专属覆盖 → App 真源码 → 测试自有物。所有起服务的脚本都用它** |
| **`_no-local-copies.mjs`** | **守住「测试不持副本」这条约定：查同名文件与路径拼接，exit 0 干净 / 2 有副本** |
| **`_assets-closure.mjs`** | **从 manifest 的卡片 route 求 UI 资源引用闭包（含动态 import），用于发布包自检** |
| **`_bleed-check.mjs`** | **卡片右上留空区：官方 card-guide §2 要求顶部 100×40 不放文字与控件。只查流内卡（整页卡有自己的标题栏，不在此列）** |
| **`_privacy-check.mjs`** | **脱敏机检：查仓库与安装包里有没有本机身份痕迹（用户名、家目录、私有项目名）。见下方专节** |
| `_check.mjs` / `_check-index.mjs` | 早期检查脚本（保留备查） |

四个纯静态检查不需要浏览器与服务，跑起来是一秒钟的事：

```powershell
node _contract-check.mjs     # 契约与实现是否脱节
node _no-local-copies.mjs    # 有没有把前端副本又搬回来
node _assets-closure.mjs     # 卡片的资源引用有没有悬空
node _privacy-check.mjs      # 有没有本机身份痕迹
node _bleed-check.mjs        # 卡片右上有没有压到宿主控件区（要浏览器）
```

`_contract-check.mjs` 把 `CONTRACT.md` 自称的「唯一契约」变成**可复跑的判据**。
2026-10-13 的审计发现该文件与实现严重脱节（25 个 id 在 HTML 里不存在、26 个 HTML id 未被登记），
当时靠人眼比对；现在这类脱节会被脚本当场拦住。2026-10-14 扩到全页：
`docs/CONTRACT.md` §2 表只管面板（它管的就是面板），但「一个 id 只出现一次」
与「JS 引用的 id 必须存在」对每一张卡都成立，所以 panel 走三向、其余页面走两向。

## 卡片右上留空（官方硬规矩，2026-10-14 新增）

`~/.hanako/card-guide/guide.md` §2 原文：

> For default chat cards, keep text, data graphics and controls out of the
top-right **100 × 40 CSS px** (width × height). Backgrounds and decorative
artwork may bleed into it; the rest of the top row is usable. On Chalkboard and
detached windows, respect actual host controls; this is not a universal limit.

**这条是宿主自己的规范，不是我们定的，也不是任何第三方技能的。**

`report.html` 曾经踩过：旧版把状态徽标放在右上（`.rh` 用 `justify-content: space-between`），
实测卡片宽 520 / 720 时徽标落在 x[420,520] / x[620,720]，正压在那块留空区上。
**只有窄屏才暴露** —— 900px 宽时不压，所以肉眼在宽窗口里看不见。

```powershell
node _bleed-check.mjs   # exit 0 干净 / 2 有压区
```

## 脱敏机检（2026-10-15 新增）

本仓库要公开发布，而它的测试数据最初是从一份真实知识库生成的。发布前那次
是手工查的（逐文件过 377 个），手工意味着下次可能忘了查。本脚本把那次判断变成判据。

```powershell
node _privacy-check.mjs                  # 查 App 目录（= 会进包的部分）
node _privacy-check.mjs --repo           # 查整个仓库（只算会提交的文件）
node _privacy-check.mjs --zip <path>     # 查一个已打好的包
node _privacy-check.mjs --words <file>   # 追加私有词表（每行一词，# 开头为注释）
```

**一条硬约束：脚本自身不得写死任何敏感词。**
它随公开仓库分发，若把用户名、项目名写进源码，检查器自己就成了泄漏源。
所以身份是**运行时从本机推导**的：当前用户名 + 本机所有用户目录名。
换一台机器跑，它查的就是那台机器的身份。

两个通用判据：

- 身份词按**词边界**匹配，避免短词（如三字母用户名）撞进随机串
- `C:\Users\<非占位名>` 形态；占位名白名单（`me` / `you` / `example` …）不计入

PNG 不只看元数据块，还把 IDAT 解压出来找长可打印串（真藏文本会留下长串）。

**反证已验证**：造了 5 类含痕迹的样本（文本路径、真串身份词、注释、二进制可打印串、
PNG 的 tEXt 块），全部被抓到，exit 2。一个从不报红的检查器等于没有检查器。

**误报处理**：`ui/assets/chain.js` 与 `report.js` 里的 `C:\Users\me\my-repo` 是
刻意写的示范占位（内联样本用），会被归入「占位名（不计入）」，不报红。

适用范围从 manifest 推导，不硬编码：只查**流内卡**（有 `route`、未声明
`realization: "page"`、不是 `siteNavEntry`）。整页卡（如 panel）有自己的页面
与宿主标题栏，它的顶栏按钮压区是正常布局，不算缺陷。

**反证已验证**：把 `report.html` 的徽标改回右上位，检查器在 420/520/620/720
四个宽度报红、900px 报干净；恢复后全绿。一个从不报红的检查器等于没有检查器。

## 注意：测试直接读 App 真源码，本地无副本
**2026-10-14 起，`tests/` 不再持有前端代码的任何拷贝。**

以前不是这样：`tests/assets/` 里放着一份 `ui/assets/` 的手抄副本，页面也有 `tests/panel.html` 副本。
手抄会漏，漏了就跑在旧代码上，绿灯失去意义。

现在静态服务器走 `_resolve.mjs`，**按优先级直读三个位置**：

| 优先级 | 位置 | 装什么 |
|---|---|---|
| 1 | `tests/assets/sdk.js`、`tests/assets/theme.css` | **测试专属**，不是副本。`sdk.js` 是 4379 字节的 mock（真 SDK 161706 字节），用来模拟无 SDK / 后端不可达等失败路径 |
| 2 | `repo-auto-index/ui/` | **App 真源码**。页面、样式、脚本、资源都从这里读 |
| 3 | `tests/` | 测试自有物：探针页（`probe-*.html` / `tabs-probe.html` / `test-map.html`）、`fixture.json`、`graph-contract.json` |

写新脚本时用这一行，不要自己拼路径：

```js
import { serveStatic } from "./_resolve.mjs";
const server = http.createServer((req, res) => { serveStatic(res, req.url, MIME); });
```

**这条约定有机检**，因为「删了」只是一次性动作，约定本身需要有人守：

```powershell
node _no-local-copies.mjs   # exit 0 干净 / 2 有副本或副本引用
```

它查两件事：`tests/` 下有没有与 `ui/` 同名的前端文件；`*.mjs` 里有没有指向 tests 目录的静态路径拼接。
受控实验已验证两类都能报出。
