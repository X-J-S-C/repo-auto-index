# 交付单 · repo-auto-index 0.3.x · 2026-10-14

> 一张纸。上半说清改了什么、为什么，下半照着做就能验。
>
> 版本号：**0.3.0** 是链路卡本体（已发布）；**0.3.1** 是同日补上的交付块投递入口；
> **0.3.2** 把交付从「盲投」改成「去向可见」（目标会话行 + 切换跟随 + 跳过去看）。
> 拆成三个版本号而不覆写，因为「同版本不同字节」正是市场同步器会撞上的坑。

## 一、这一版给用户的新承诺

**索引链路从「看不见」变成「看得见」——六环逐环给证据，缺环直接给修复步骤。**

前一版（0.2.0）只有一张扫描报告卡，用户能知道「扫了多少文件、索引多少条」，但**不知道链断在哪**：
是没装 AOCI、装了没初始化、初始化了没写条目，还是写了但没建基线。四种情况在界面上长得一模一样，
都显示「未读到索引」。这一版把它们分开。

## 二、改动范围

```
repo-auto-index/index.js             +326   ← 链路六环、AOCI 状态读取、口径修正
repo-auto-index/manifest.json         +15   ← 第三张卡 + 第二个 messageRenderer
repo-auto-index/ui/chain.html         新增   ← 链路卡页面
repo-auto-index/ui/assets/chain.js    新增   ← 链路卡逻辑
repo-auto-index/ui/assets/chain.css   新增   ← 链路卡样式
repo-auto-index/ui/report.html       ±17   ← 右上留空（官方 card-guide §2）
repo-auto-index/ui/assets/report.css  ±13   ← 同上
repo-auto-index/ui/assets/report.js    ±5   ← 同上 + 口径
repo-auto-index/ui/assets/panel.js    ±18   ← 口径（有效行 → 条目）
tests/shoot-chain.mjs                 新增   ← 链路卡三态回归
tests/_bleed-check.mjs                新增   ← 右上留空机检
tests/_errors.mjs                     新增   ← 共享错误过滤器
tests/_contract-check.mjs             +39   ← 扩到全页两向
tests/fixture.json / projects-real.json ±10 ← 口径同步
tests/README.md、docs/*、README.md     文档
```

| # | 改动 | 为什么 | 怎么验的 |
|---|---|---|---|
| 1 | 新增链路体检卡（`chain.html`） | 六环逐环给状态、证据、来源文件 | `shoot-chain.mjs --chain=ok/partial/broken`，三态 `errors: (none)` |
| 2 | 新增 `GET /repo/:id/chain` | 读 `.aoci/` 那批文件，汇成六环 | 同上；`aoci` 实测对照 |
| 3 | 新增工具 `repo_index_chain` | 模型可调，回一张链路卡 | 静态校验通过；返回带 `details.card` |
| 4 | 修条目数口径（473 → 392） | 面板说 473、`aoci status` 说 392，两个数打架 | 见下「口径定案」 |
| 5 | 修报告卡右上压区 | 徽标压在官方规定的 100×40 留空区上 | `_bleed-check.mjs`，含反证 |
| 6 | 收紧回归的错误过滤器 | 原 `/favicon|404/` 太宽，真 404 会被吃掉 | `_errors` 反证：能报出真缺失资源 |
| 7 | 交付块扩到两张卡 | 链路卡原本没投递入口 | `probe-deliver-cards.mjs`，含反证 |
| 8 | 目标会话可见（0.3.2） | 原来只显示「已投递」，用户不知道送给了谁 | `probe-deliver-cards.mjs`，含反证 |
| 9 | 会话切换跟随 + 跳过去看（0.3.2） | `getActive` 只查一次，切了会话面板不跟 | 同上 |

## 三、口径定案（473 与 392）

同一条索引，两个数：

```
三文件合并、非空非 # 的行数  473   ← 旧口径（含 81 行 === 卷头）
name[TAG]: 形状的行数         392   ← aoci status 的 index_entries
                                ───
                                 81 = 卷头数
```

实测对照（示例仓库）：

```
aoci.code.txt   555 行 → 空 81 | # 1 | 卷头 81 | 条目 392 | 合并非空非# 473
aoci.meta.txt    20 行 → 全被 # 过滤
aoci.txt          7 行 → 全被 # 过滤
```

**取 392**，与 aoci 官方口径一致。旧数保留为 `entryLines` 字段，界面不再显示，供对照历史数字。

## 四、验收清单

### 前置

- [ ] App 版本 0.3.0 已装（`extension_manager reload id=repo-auto-index`）
- [ ] 已登记至少一个仓库

### 链路卡

| # | 操作 | 期望结果 | 通过? |
|---|---|---|---|
| 1 | 让 Agent 调 `repo_index_chain({repo:"<repo-id>"})` | 回一张链路卡落进对话，六环各有证据 | ☆ |
| 2 | 看卡上第六环之后 | 三权（知情/打断/查看）三格 | ☆ |
| 3 | 点任一环 | 展开显示来源文件 | ☆ |
| 4 | 登记一个没跑过 `aoci init` 的目录，再看 | 第 01 环红、02-06 灰，下方展开三步修复 | ☆ |
| 5 | 面板 → 交付块，点「把链路卡送到当前对话」 | 状态行报已投递，对话里出现链路卡 | ☆ |
| 6 | 点「把报告卡送到当前对话」 | 同上，且是报告卡不是链路卡 | ☆ |
| 7 | 看交付块上方那行「目标会话」 | 显示会话标题与 id，不是只写「已投递」 | ☆ |
| 8 | 在聊天里切到另一个会话，回看面板 | 目标行自动跟着变（不用手动刷新） | ☆ |
| 9 | 点「切过去看」 | 跳到那个会话，能亲眼核对卡落没落 | ☆ |

### 口径

| # | 操作 | 期望结果 | 通过? |
|---|---|---|---|
| 7 | 面板「索引」页 | 显示「条目数」= `aoci status` 的 `index_entries` | ☆ |
| 8 | 报告卡 | `索引条目` 与上面一致 | ☆ |
| 9 | 在终端跑 `aoci status --repo <仓库>` | 两个数相同 | ☆ |

### 外观

- [ ] 浅色主题正常
- [ ] 深色主题正常
- [ ] 窄屏（420px）下链路卡不横向溢出
- [ ] 右侧 100px 内没有文字或控件（`_bleed-check.mjs` 已机检）

## 五、验证证据

```powershell
node _no-local-copies.mjs    # EXIT=0
node _contract-check.mjs     # EXIT=0（全页两向 + 面板三向）
node _assets-closure.mjs     # EXIT=0（14 个资源，悬空 0）
node _bleed-check.mjs        # EXIT=0（2 张流内卡 × 5 个宽度）
node sweep.mjs after         # 六态 errors: (none)
node probe-deliver-cards.mjs # EXIT=0（两个投递按钮 + 两条路由，含反证）
node shoot-chain.mjs chain-ok.png 720 900 --chain=broken   # errors: (none)
```

## 六、遗留

- **「AOCI 装没装」读不出来**。App 没有 `app/process.spawn`，跑不了 `aoci --version`；
  而连接器配置在宿主自己的数据目录下，宿主拒绝与 HANA_HOME 重叠的读根。所以链路卡不设「环境」环，
  改为在缺索引时把「装 AOCI」写进修复步骤。**要读出这一环，得开子进程权限**，那是产品取舍，未做。
- **`.aoci/drafts/` 里的草稿不是待办**。17 个 candidate 文件涉及的 317 个唯一文件名**全部**在索引里，
  是已应用的凭据。`aoci status` 自己说 `reports_pending: 0`。曾误判为欠账，已核清。
- **截图是产出物，不入库**。`shoot*.mjs` 默认写到 `tests/out/`，`.gitignore` 加了 `/tests/*.png`；
  需要对比基线时重跑即可（`_bleed-check.mjs` 与六态回归都能随时再生成）。
- **旧口径数据已同步**：`tests/fixture.json` 与 `projects-real.json` 里的 `entries` 从 473 改成 392，
  另存 `entryLines: 473`，免得回归跑的是旧口径。
- **链路卡的投递路径已补齐**（2026-10-14 当日完成）：
  - 工具路径（模型调 `repo_index_chain` → 回 `details.card`）：**代码已就位，未做真机调用核实**。
    已验证的是：`index.js` 能过 ESM 硬校验、`details.card` 字面量符合 CARD-DOCTRINE §2.2 白名单、
    三态离线渲染无错。**「真的落进对话」这件事得你装完点一下才算数**。
  - 面板投递按钮：**已做**。交付块现在有两个投递入口（报告卡 / 链路卡）
    加一个预览入口，后端路由泛化为 `POST /<kind>/send`（kind = report | chain）。
    两条路径共用同一段投递逻辑，差异只有 customType 与正文引子。
    回归 `probe-deliver-cards.mjs` 覆盖，含反证（摘掉一条路由必报红）。
