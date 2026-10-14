# Repo Auto Index

A Hana v2 app (`manifestVersion: 2`). Kind: `full`.

The identity icon is declared by `icon` in the manifest and shipped in `assets/`. Keep the source image; Hana creates a display copy during installation. Large images are resized automatically, and small images only receive a clarity recommendation.

## SDK and validate

`index.js` imports the bundled local App SDK and uses `defineApp(async sdk => ...)`. Registration calls wait for the host acknowledgement; retain the returned receipt when later code must dispose a registration explicitly. The scaffold does not install packages or resolve imports from Hana's own `node_modules`.

Every declared card must have `face.image` pointing to a bundled, nonempty PNG/WebP/SVG under `ui/`. For `ui` and `full`, the scaffold copies the explicit `--cover` source into `ui/assets/`. Keep the declaration and file together when editing or packaging; a missing or invalid cover rejects the App. Tool-only Apps do not need a card cover.

## Validate

The scaffold has run static package validation. After editing, build if required, then run these commands from a Hana checkout:

```sh
node scripts/validate-app.mjs --dir /path/to/repo-auto-index --json
node scripts/validate-app.mjs --dir /path/to/repo-auto-index --smoke --json
```

Use `--archive /path/to/install.zip --json` to validate the final installation archive. Add `--smoke` when startup execution is part of the task: it starts a backend process and, for declared UI pages, an Electron runner. Static validation alone does not prove runtime behavior. UI packages use path-scoped relative assets and the App UI SDK.

## Startup arguments

This App declares no startup arguments. Add static `contributes.cliFlags` entries only when startup-time configuration is necessary; then start Hana with `hana serve -- --app.<id>.<flag>=<value>`.

## `minAppVersion` constraints

当前值 `1.0.16-beta`。它不是一个可以随手调低的装饰字段：

- 本 App 使用 `contributes.cards[].cardForm: "structural"`，该能力由校验器要求声明
  `minAppVersion >= "0.1017.0"`；低于此值时旧宿主会**静默忽略**这项声明。
- 调低前先复核 `ui/assets/app-ui.js` 所用官方控件的最低宿主版本。

## 与宿主运行位置的关系

本 App 以 **local 类型**安装：安装记录的 `source.path` 指向本源码目录，
但宿主运行时服务的是 `%HANA_HOME%\apps\<id>\`。
两份目录**不会自动同步**（2026-10-13 用受控实验定案：只在源码侧改一字节，
`extension_manager reload` 后安装目录仍是旧版）。改完源码必须跑：

```powershell
pwsh -File ../tools/sync.ps1          # 同步 + 复验
pwsh -File ../tools/sync.ps1 -Check   # 只校验，exit 0 双向一致 / 2 有漂移或有多余文件
```

**受服务文件 = App 根下全部文件**（`index.js` + `manifest.json` + `assets/` + `sdk/` + `ui/`），
没有白名单、没有例外。此前是写死的 6 文件白名单，后又改成「`ui/` 目录派生」，两次都不完整：
派生集漏了 `assets/` 与 `sdk/`（2026-10-14 受控实验定案，改这两个目录下的文件时 `-Check` 会报假的一致）。
`*.md` 现在不再静默过滤，而是报警——App 根下不放开发文档，一律放仓库根的 `docs/`。
详见 `AUDIT-2026-10-14.md`。

**同步后必须 reload，两件事都做齐才算真生效**（2026-10-13 实测定案）：
宿主有两套时钟——`ui/` 静态资源是**实时读盘**（改完立刻可取），
但**卡片注册表是装载时缓存**（实测 reload 前 `/api/apps/cards` 只返回 1 张卡，reload 后变 2 张）。
只同步不 reload 会得到「页面是新的、卡片注册还是旧的」这种半生效状态。

不要尝试把安装目录做成 junction/symlink：宿主明确拒绝
（`app package contribution root must be a non-symlink directory`）。
`extension_manager update` 对 local 源也不可用。

## Install

1. Use Hana Builder to import this local directory into an isolated development project.
2. Complete App Manager's review and read the actual installation result.
3. For production installation, give the validated package or local directory to App Manager. The manifest id is `repo-auto-index`.

## After you edit

Build changed sources, then explicitly reload through Builder or App Manager. Local-directory installs retain their source for reload. New permission requests require review; read the resulting state before continuing. Keep the source project separate from the disposable development environment.

## How the starter tool runs

The starter tool uses the declared name, without an automatic host prefix. The manifest requests `app/tools.expose-to-model`; after approval, enable the App for the intended Agent. Discover the current tool schema before calling it. The Agent's tool discovery mode determines whether the tool is listed directly or found through deferred discovery.

The full contract is in `APPS.md` / `APPS_EN.md`.
