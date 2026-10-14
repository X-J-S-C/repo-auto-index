仓库自动索引 0.4.0。

## 这一版给用户的新承诺

第一次用的人知道下一步做什么；老手能在面板里直接挑要投给哪个会话。

## 一、新人指路

面板「索引」页原来只写「未读到索引：可能不存在，也可能存在但读取失败」，
把三种完全不同的处境混成一句：

- 没装 AOCI（仓库里没有 .aoci/）
- 装了、init 了，但 Agent 还没写条目
- 文件在，但读取失败

新人的下一步在这三种下完全不同。现在按 .aoci/config.json 在不在分开说：

- 没初始化 → 三步指引：装 AOCI-CODE → aoci init / aoci scan → 重启 Agent 让条目落地
- 已初始化但没条目 → 说明条目由 Agent 写，不再让用户去装

预览页同步改了文案。

## 二、面板会话选择器

交付块新增「选会话」：展开列出会话，本仓的排在前面（cwd 匹配，左侧有色条），
可过滤、可设为目标、可跳过去看。

手动点过「设为目标」之后进「已指定」模式，在聊天里切会话不会再覆盖它。

**一个实测结论**：官方文档 APPS.md:832 说 `session:list` 只能看到归属自己的会话，
实测不是——本机拿回 364 条全部会话（其中 178 条 cwd 在本仓）。宿主实现按
scope=all + app/sessions.read 放行。这一版的功能就建立在这个实测结论上。

## 三、写测试时抓到两个真 bug

两条都是「看起来会工作、实际不会」的类型：

- APP_UI_SCOPE_REQUIRED：挂官方 Button 时行还没插进 DOM，按钮那一刻没有
  data-hana-app-ui 祖先。改为先插入再挂。
- 过滤不生效：mountAppUi 是异步渲染，挂完立刻 querySelector 拿到 null，
  监听器绑到了空上。改用事件委托。

## 校验

- archive.sha256: 89b1e63cd241fbacbbd0211f0068f8d006c4cf7deaad16c869e4733bc7666414
- 官方静态校验：0 error / 1 warning（DYNAMIC_DEPENDENCIES_NOT_PROVEN）
- 离线回归：23 项（5 个静态机检 + 18 个浏览器脚本），全部 errors: (none)
- 新增 probe-newcomer.mjs / probe-session-picker.mjs，各含反证
- minAppVersion: 1.0.16-beta

## 已知遗漏

- 「本仓优先」的排序在真后端，离线台的 mock 走硬编码顺序，那条排序靠真机实测覆盖
- 会话选择器上限 200 条（本机 364 条已超，本仓优先排序后截断）
