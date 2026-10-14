# 仓库自动索引（repo-auto-index）

Hana v2 App。一仓一索引，克隆即登记扫描，随时可打断，本仓隔离查看。

语义条目仍走 AOCI 链路由 Agent 创作，本 App 只做清点、进度与隔离展示。

## 它解决什么

AOCI 给模型维护一份跨任务复用的系统理解。这份理解会**腐化**：代码改了、索引没跟上，模型就会拿着旧认知干活，而腐化是不可见的。本 App 把它变成可读的数字——一个仓库被扫了多少文件、索引有多少条目、哪些目录读不到、上次扫描是什么时候。

## 仓库结构

```
repo-auto-index/                ← git 仓库根（开发侧）
├── README.md
├── .gitignore
├── docs/                       # 开发文档与契约
├── tools/                      # 同步器
├── tests/                      # 验证资产（离线渲染台与回归脚本）
│   └── assets/                 # 仅两个测试专属文件（sdk.js mock、theme.css）
└── repo-auto-index/            # ← App 本体，source.path 指这里
    ├── index.js                # App 后端：路由、工具、扫描任务
    ├── manifest.json           # v2 清单：卡片声明、权限、消息渲染器
    ├── assets/icon.png         # App 图标
    ├── sdk/                    # vendored：Hana App SDK 完整副本
    └── ui/                     # 前端（被宿主直接服务）
        ├── panel.html          # 面板页（整页卡）
        ├── report.html         # 扫描报告卡（流内卡）
        ├── chain.html          # 链路体检卡（流内卡）
        └── assets/             # 前端资源
```

**前端资源只有一处**：`repo-auto-index/ui/`。回归脚本直接读它，`tests/` 下不再有任何副本
（历史与机制见「已知隐患 2」）。

**App 目录名必须等于 manifest 的 `id`**（平台硬约束：否则校验器报 `id ... does not match its directory name`）。所以内层目录叫 `repo-auto-index` 而不是 `app`。

**App 本体与开发侧资产分开**：宿主的 `install` 是**整目录镜像复制**，`source.path` 指哪就把哪整份拷进 `.hanako/apps/<id>/`。把仓库根当作 App 根，会把 `.git` 与 `tests/node_modules` 一起拷进去。

**App 根下不放开发文档**：宿主服务整个 App 目录，开发文档一律放仓库根的 `docs/`。
（这条以前写作「`ui/` 下不放 `.md`」，2026-10-14 改成覆盖整个 App 根。）

## 许可

MIT，见 [LICENSE](LICENSE)。

## vendored 说明

`sdk/` 与 `ui/assets/` 下的 `app-ui.*` 是 Hana 官方 App SDK 的完整副本，随仓库入库以保证「克隆即可运行」。它们由平台生成，**不要手改**；升级 Hana 后如 SDK 有变动，整目录替换。

## 开发与部署

本 App 以 `local` 类型安装。宿主运行时服务的是 `%HANA_HOME%\apps\repo-auto-index`，源码在本仓库。两者由 `tools/sync.ps1` 保持同步（脚本从自身位置推源码根，换机不用改路径）。

```powershell
pwsh -File tools/sync.ps1          # 同步源码 → 宿主运行位置，并逐字节校验
pwsh -File tools/sync.ps1 -Check   # 只校验，不改动（exit 0 双向一致 / 2 有漂移或有多余文件）
```

**受服务文件 = App 根下的全部文件**（`index.js` + `manifest.json` + `assets/` + `sdk/` + `ui/`），没有白名单、没有例外。

此前它是一张写死的 6 文件白名单，后来改成「`ui/` 目录派生」。两次都不完整：白名单踩过
`graph-map.js` 与 `report.*` 的静默过期，派生集漏了 `assets/` 与 `sdk/`——改这两个目录下
任何文件，`sync.ps1 -Check` 都会报「逐字节一致」，而安装位置那份其实没变。
2026-10-14 用受控实验定案并补全（详见 `docs/AUDIT-2026-10-14.md`）。

**App 根下不放开发文档**（`*.md` 一律放仓库根的 `docs/`）。这条现在有机制保障：`sync.ps1` 会对
App 根下出现的 `.md` 报警并报为漂移，不再静默过滤——静默过滤同样会构造出假的「一致」。

**同步之后必须 reload，两件事都做齐才算真生效。** 宿主有两套时钟：`ui/` 静态资源实时读盘，但**卡片注册表是装载时缓存**（实测 reload 前 `/api/apps/cards` 只返回 1 张卡，reload 后变 2 张）。只同步不 reload 会得到「页面是新的、卡片注册还是旧的」这种半生效状态。

```powershell
extension_manager reload id=repo-auto-index
```

**两条捷径已被平台明确拒绝，不要重试**：把安装目录做成 junction/symlink（报 `app package contribution root must be a non-symlink directory`）；`extension_manager update`（报 `was not installed from a market source`）。

## 验证

```powershell
# 官方静态校验（--dir 指 App 本体，不是仓库根）
node <hana-checkout>/scripts/validate-app.mjs --dir repo-auto-index --json

# 同步器双向校验（源码 ↔ 安装位置）
pwsh -File tools/sync.ps1 -Check

# 六态回归（离线渲染台）
cd tests
node _no-local-copies.mjs           # 测试侧没有前端副本
node _contract-check.mjs            # 契约（全页两向 + 面板三向）
node _assets-closure.mjs            # 卡片资源闭包无悬空
node _bleed-check.mjs               # 流内卡右上不压宿主管控区
node sweep.mjs after                # 每态须 errors: (none)
node shoot-chain.mjs chain-ok.png 720 900 --chain=broken   # 链路卡三态
```

验证台说明见 `tests/README.md`。

## 本轮审计（2026-10-14）

复核「验证脚本说的话是否可信」，发现并修掉两处**机器可见的假绿灯**，并根治一处双真理源：

1. 同步器托管集漏了 `assets/` 与 `sdk/`，改这两个目录下任何文件，`-Check` 仍报「逐字节一致」。
2. 安装目录有多余文件时 `-Check` 仍 `exit 0`，CI 只看退出码就会放行。
3. 测试侧持有前端手抄副本，改源码后回归可能跑在旧代码上。**副本已整目录删除**，
   测试改为直读 App 真源码（`tests/_resolve.mjs`），并有 `_no-local-copies.mjs` 守约定。

旧源码目录与旧同步器已删除（删前全量比对 + 备份）。

完整证据链、复现步骤、独立复核意见与处理见 **`docs/AUDIT-2026-10-14.md`**。

## 权限

| 权限词 | 用途 |
|---|---|
| `app/resources.read` | 读索引文件 |
| `app/tasks.manage` | 扫描任务管理 |
| `app.tools.expose-to-model` | 把工具暴露给模型 |
| `app/sessions.read` | 读当前会话（投递报告卡用） |
| `app/sessions.manage` | 跨归属投递消息 |
| `app/session.start-turn` | 投递可能起模型回合时 |

新增权限会触发用户复核，这是设计使然：**Agent 不能替用户批准权限**。

## 已知隐患

### 1. 旧源码目录已清理（2026-10-14 完成）

迁移前的源码曾在另一个目录下（381 文件），
旁边还有一份旧同步器 `sync-repo-auto-index.ps1`（`$Source` 指着旧源码，一跑就拿旧代码
覆盖安装目录）。**两者已于 2026-10-14 删除**，删前做过全量逐文件比对与备份：

| 维度 | 结果 |
|---|---|
| 新仓库独有 | **0 个**（旧源码没有任何东西是新仓库缺的） |
| 旧源码独有 | **7 个，全部是文档**，与新仓库 `docs/` 下同名文件逐字节一致 |
| 同名内容不同 | 仅 `ui/assets/panel.js`，旧的是更早的草稿 |
| 备份 | 迁移前的源码目录全量备份（381 文件，逐文件校验 0 差异） |

即：**删除不丢信息**，且有备份可回。

### 2. tests/ 本地副本已根治（2026-10-14 完成）

`tests/assets/` 里曾有一份 `ui/assets/` 的手抄副本，改前端后忘记手抄，回归就会测到旧代码。

**现已根治**：副本整目录删除，测试服务器走 `tests/_resolve.mjs` 直接读 App 真源码，
真理源回到一处。约定有机检（`tests/_no-local-copies.mjs`）。

受控实验：往真源码 `ui/assets/panel.js` 追加一行标记 → 解析器指向的文件立刻包含该标记
（以前读副本时不会）。

详见 `docs/AUDIT-2026-10-14.md` §3、§4。
