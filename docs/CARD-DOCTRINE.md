# repo-auto-index 卡片化契约

> 状态：草案 v0.3 · 2026-10-13 · 由统筹会话冻结，执行交给子助手
> 上游依据：`APPS.md`（官方 v2 指南）、`bundle/index.js`（宿主实现）、`ui-contribution-points.js`（SDK 槽位表）

## 0. 这份文档的用途

把"Hana 的 App 要继承卡片即一切"这条设定，翻译成可执行、可验证的接口。子助手照此施工；执行中若发现本文档与真实证据冲突，**以证据为准并立刻上报**，不要按文档硬做。

## 1. 目标形态：扫描报告卡

**一次扫描 = 一张能递出去的卡。**

参考样板：Hana Agent Showcard 三条原则（回答变成应用 / 双方都改得动 / 能递出手）。

对 repo-auto-index 的具体含义：

| 原则 | 落地要求 |
|---|---|
| 回答变成应用 | 扫描完成不再只回文本或面板数字，落一张流内卡进对话 |
| 双方都改得动 | 卡上有可操作控件（重扫 / 搜索 / 打开面板）；模型能用 `ui_inspect` / `ui_action` 读它、点它 |
| 能递出手 | 卡能被钉到黑板、能拆窗（走宿主既有能力，不需 App 额外做） |

**面板不废。** 面板（`realization: "page"` 的整页卡）是工作台，管长期状态与批量操作；卡片是交付物，管单次产出。要的是从面板里**长出**卡片，不是把面板改成卡片。

**最小闭环优先。** 先做"一次扫描 → 一张报告卡"，把通路打通验证，再谈把索引/搜索/轨迹/关系四个视图都卡片化。

## 2. 已确认的宿主契约（附证据锚点）

以下每条都来自真实源码，不是推断。

### 2.1 工具结果如何带卡

工具 `execute` 返回 `{ content, details: { card: {...} } }`。宿主认出 `details.card` 后包装成 `plugin_card`。

- `Xon(t)`：判定 `t.details.card` 是否存在。`bundle/index.js` @5311550
- `Z_t(t, e)`：构造卡对象，盖 `pluginId`、`cardInstanceId`，`title` 缺省回退 `pluginId`。`bundle/index.js` @5311300 附近
- `bCr(t, e)`：`toolCallId` 存在时签发来源证明 `hanaAppCardSource`，否则删掉证明字段。`bundle/index.js` @5322600 附近
- 调用点：工具 execute 外包一层，`Xon(wt)` 为真才走 `Z_t` / `bCr`。`bundle/index.js` @5324241

### 2.2 `details.card` 字面量的字段白名单

来自 `plugin-stream-card-registry` 的校验函数（`bundle/index.js` @2697320 起）：

| 字段 | 类型 | 校验 |
|---|---|---|
| `cardType` | string | 必须是 `"iframe"` 或 `"webview"`；`Z_t` 里缺省补 `"iframe"` |
| `route` | string | 非空、必须以 `/` 开头 |
| `title` | string | 可省；有长度上限；trim 后为空回退 `pluginId` |
| `description` | string | 可省；有长度上限。**模型侧可见**：宿主把它 append 进可见文本（`bundle/index.js` @924562、@9129987） |
| `aspectRatio` | number | 可省；有限正数（注意是**数字**，不是 `"16:9"` 字符串，字符串写法只在 manifest 的卡字面量上） |
| `cardForm` | string | 可省；白名单词 |
| `titlebar` / `titleMode` | string | 可省；白名单词 |

**未知键**：`Z_t` 用 `s.pluginId = i` 就地改原对象、其余字段保留（`...y` 展开），所以自定义字段**在宿主侧不会被剥掉**。但它是否透传到 iframe 是**未验证项**，见 §3。

### 2.3 卡片的页面来源

- 写了 `route` 的黑板卡，iframe 指向 `/api/apps/<appId>/ui<route>`。APPS.md「贡献一张黑板卡」
- 流内卡带 `channel: "app"` 时**走同一条树**。APPS.md「贡献一张黑板卡」
- 页面来自 App 目录下的 `ui/` 静态树，路径出不了这棵树。APPS.md

### 2.4 卡片自己取数据

> 宿主不会把触发这条消息的 payload 传进卡片 iframe。卡片继续走自己的 surface / storage / 后端路由读状态。

APPS.md「为自定义消息声明一张流内卡」。这条决定了：卡片必须**自取数据**，策划时要为此设计通路。

### 2.5 卡片回传与日志

- `hana.emit(name, payload?, to?)`：把用户操作送回所嵌会话并唤醒 agent。**只在 card slot 可用**，page / widget / settings 调用被拒。进模型要过 `app/session.start-turn` 授权。事件名 `^[a-z0-9][a-z0-9._-]{0,63}$`，payload ≤ 8KB，每分钟 ≤ 20 次。APPS.md「卡片回传」
- `hana.track(name, payload?)`：记进独立活动仓，不唤醒 agent。**只在 card slot 可用**。每分钟 ≤ 120 次。APPS.md「卡片安静日志」

### 2.6 面板按钮让卡片落进对话的路径

`contributes.messageRenderers` 把 `session:send-custom` 投递的短名映射到本 App **带 route** 的卡：

- 映射项：`{ customType, cardId }`。`customType` 不能含 `/`、不能自带 `app:` 前缀；`cardId` 必须指向带 `route` 的卡
- 只作用于 `display: true` 的自定义消息
- 宿主盖成 `app:<appId>/<短名>`

APPS.md「为自定义消息声明一张流内卡」。`session:send-custom` 是 `ctx.bus.request` 的公开动词；工具调用里可用 `context.callToken` 定位会话。APPS.md「操作会话」。

## 3. 待验证的空白（派给子助手）

### 已解决（recon-B，2026-10-13）

**V4a 已解决**：卡片 iframe 调后端路由，走两条通道任一：① 宿主登录态 ② 该 App 自己的 surface session（header `X-Hana-App-Surface-Session` / query `appSurfaceSession`）。卡片属于第 ② 条，宿主签发票据时一并铸票随 iframe URL 下发。用 `hana.api.fetch` 即可，面板已在用。

**V4b 已解决**：卡片页与面板页走**同一条**通道。**卡片调后端不需要额外声明任何 manifest `capabilities`**。现清单的 `app/resources.read` / `app/tasks.manage` / `app/tools.expose-to-model` 管的是别的三件事，与此无关。

**V6 已解决**：`session:send-custom` 参数 = 必填 `customType`（短名）+ `content`；可选 `triggerTurn` / `display` / `scope` / `sessionId`/`sessionPath`（或 `callToken`）/ `details`。`display: true` 是显式布尔，默认 false。宿主盖 `customType` 为 `app:<appId>/<短名>`。`messageRenderers` 形状 `{customType, cardId}`，`cardId` 必须指向带 `route` 的卡。

**V7 已解决（关键约束）**：后台任务**没有「当前会话」概念**，除非显式 `scope: "session"`。本项目扫描任务是 `scope: "app"` + `delivery: "none"`，run 里**拿不到 callToken**。App-scope 任务带 callToken 会被宿主**明确拒绝**。

### 由此确定的方案取舍（统筹决定）

落卡的凭据只有两个来源：**工具调用的 `callToken`**（模型发起）或**面板取得并交给后端的 `sessionId`**（用户发起）。二者互不覆盖。

| 方案 | 覆盖路径 | 新权限 | 决定 |
|---|---|---|---|
| **B · 工具调用返回时落卡** | 模型发起扫描 | **零** | **本轮必做** |
| **A · 面板按钮落卡** | 用户点面板 | `app/sessions.read` + `app/sessions.manage`（起回合再加 `app/session.start-turn`） | 待用户拍板 |
| C · 改 session-scoped 任务 | 两者 | 架构改动大，且触及资源令牌回收窗口 | 暂不做 |

**本轮先做 B**：零成本、零新权限，能立刻验证"扫描 → 卡片落进对话"这条通路是否成立。B 通了，A 只是换个凭据来源而已。

**关于 A 的诚实说明**：加权限会让用户下次装载时看到新的权限确认项。这是用户可见的变化，不擅自做，摆给用户拍板。

**V3 已解决（统筹独立发现）**：surface slot 白名单为 `["card", "function-panel", "settings", "slot"]`，定义在 App 自己的 `ui/assets/sdk.js`（函数 `hasConfirmedAdvancedAppSurface`）。流内卡是 `"card"`。另外 `sdk.js` 的 `readSurfaceSession` 从 **iframe URL 的 query** 取 `appSurfaceSession`，这证明宿主会往 iframe URL 追加 query——对 V1/V2 是有利线索。

### 已解决（recon-A，2026-10-13）

**V1 已解决**：流内卡 iframe src 形态 = `/api/apps/<appId>/ui/_surface/<token>/<route>`，并附 query `appSurfaceSession` / `hana-asset-base` / `hana-app-surface-id`。桌面端 `iframe.src` 直接绑 hook 返回的 `iframeSrc`。（hook 内部拼接字符串因压缩取不出，但服务端构造已确证，形态一致。）

**V2 已解决（关键）**：`details.card` 上的自定义字段**到不了 iframe**。服务端投影保留（展开语法），但渲染层入参白名单只拈固定字段（`pluginId` / `cardType` / `route` / `title` / `description` / `aspectRatio` / `cardForm` / `titlebar`），自定义字段在这一步被丢弃。APPS.md 也明文：宿主不把 payload 传进卡片 iframe。

**→ 由此定案：卡片必须自取数据。** 已由 impl-A 的卡片实现满足（走 `/overview` + `/repo/:id`）。不要往 `details.card` 里塞 `repoId` 当数据通道，它到不了。

**V3 已解决**：流内卡 slot = `"card"`。白名单 `["card", "settings", "function-panel", "slot"]`。

**V5 已解决**：APPS.md **没有**针对 `details.card` 本身的版本门槛。只有成分字段有（`structural`/`titleMode` 需 0.1017.0、`pageIcon` 0.1020.0、服务引用 0.1023.0）。**都不超 `1.0.16-beta`，minAppVersion 不必上调。**

**统筹补充（决定可行性的一环）**：卡片页在流内卡里用 `hana.api.fetch` 调后端路由**成立**。理由：`APP_UI_SURFACE_PATH_RE = /^\/api\/apps\/([^/]+)\/ui(?:\/|$)/` 只匹配前缀，卡片实际 pathname 是 `/api/apps/repo-auto-index/ui/_surface/<token>/report.html`，`_surface/<token>` 那一段不影响 appId 解析。`appSurfaceSession` 已在 URL query 里。

### 勘探已完成，无遗留阻塞。

## 4. 文件所有权（防写冲突）

执行阶段按文件切分，每个文件只有一个所有者：

| 子任务 | 独占文件 |
|---|---|
| 卡片页面 | `ui/report.html`、`ui/assets/report.js`、`ui/assets/report.css`（全新） |
| 后端与清单 | `index.js`、`manifest.json` |
| 面板入口 | `ui/panel.html`、`ui/assets/panel.js` |
| 文档 | `docs/CARD-DOCTRINE.md`（统筹侧）、各自 `FINDINGS.md` |

共享契约（如工具返回的 `details.card` 形状、卡片页面路径、后端报告路由的名字）在执行前由统筹侧冻结，任何一方不得单方面改。

## 5. 验收标准

改动后必须全部通过，缺一不算完成：

1. 静态校验：`validate-app.mjs --dir` → `ok:true`，0 error
2. 六态回归：`ready` / `scanning` / `canceled` / `error` / `empty` / `blocked` 全部 `errors: (none)`
3. 页签回归：五个页签正确互斥，指示器跟随（含关系页二级切换）
4. 搜索回归：`aoci` 仍能命中
5. 新能力：卡真的落到对话里，能点，能钉
6. 源码与安装目录逐字节一致（跑同步器 `-Check` exit=0）
7. 全部结论附证据锚点（文件 + 行号/偏移），不接受软性自述

## 6. 不做的事

- 不改 `publisher` 署名、不改市场登记状态（待用户拍板）
- 不擅自上调 `minAppVersion`（若 V5 证明必需，先上报再定）
- 不动 `--smoke` UI 段（已知环境问题，非 App 缺陷）
