# repo-auto-index 源码 → 宿主运行位置 同步器
#
# 为什么需要它（2026-10-13 实测定案）：
#   本 App 以 local 类型安装，安装记录 source.path 指向源码目录，
#   但宿主运行时服务的是 %HANA_HOME%\apps\repo-auto-index。两份曾靠手工复制维持，
#   漏一次或时机与刷新错开，面板就会显示旧版（表现为"有时新有时旧"）。
#
#   两条捷径已被平台明确拒绝，不要重试：
#     - 把安装目录做成 junction/symlink → reload 报
#       "app package contribution root must be a non-symlink directory"
#     - extension_manager update → 报 "was not installed from a market source"
#
# 用法：
#   pwsh -File tools/sync.ps1          # 同步 + 校验
#   pwsh -File tools/sync.ps1 -Check   # 只校验，不改动
#                                      #   exit 0 = 双向一致
#                                      #   exit 2 = 有漂移，或安装目录有多余文件

param([switch]$Check)

$ErrorActionPreference = 'Stop'

# 源码根 = 仓库下的 App 目录。
# 目录名必须等于 manifest 的 id（平台硬约束：id "repo-auto-index" does not match
# its directory name）。开发侧资产（docs/ tests/ tools/ .git）留在仓库根，不进安装目录。
$Source = Join-Path (Split-Path $PSScriptRoot -Parent) 'repo-auto-index'
$Target = Join-Path $env:USERPROFILE '.hanako\apps\repo-auto-index'

# 受服务文件 = App 根下的**全部**文件，无例外、无清单。
#
# 为什么是"全部"而不是白名单（2026-10-13 定案，2026-10-14 收紧）：
#   白名单会腐化：新增一个受服务文件就得记得回来改表，忘一次就静默出旧版——
#   这正是 graph-map.js 与 report.html/report.js/report.css 连续踩过的同一个坑。
#   改成按目录派生后，真理源从"人手维护的清单"换成"目录本身"，加文件即被服务。
#
#   2026-10-14 受控实验发现派生集还不完整，漏了两个目录（当时只收 index.js +
#   manifest.json + ui/）：
#     实验一：改 assets/icon.png 一个字节 → -Check 仍报"逐字节一致"（exit 0）
#     实验二：向 sdk/ 下某个文件追加一行 → 同样报"一致"
#   两句都是**假的断言**：安装目录里那两份并没有跟着变。assets/ 与 sdk/ 不是
#   开发侧资产，是 index.js 与 manifest 真实依赖的包内容（icon 被 manifest 引用、
#   sdk/app-contract/server-client.js 被 index.js import）。已收进全集。
#
#   一句可被证伪的断言，比一句宽泛的漂亮话危险得多。所以本脚本的主张就是
#   "App 根下全部文件在安装位置有逐字节相同的一份"，不留任何未覆盖的角落：
#   *.md 也不再静默过滤（那同样会构造出假的"一致"），改为在源码侧报警，
#   提醒开发文档应该放在仓库根的 docs/。
#
# 安全性依据：实测本机宿主的安装是整目录镜像复制（374 文件全 hash 相等、图标无
# 转码、sdk/ 357 文件零差异），因此覆盖这些文件不会弄坏宿主生成的副本。
# 若日后宿主改成"安装时生成派生副本"，assets/ 这一处需复核。

if (-not (Test-Path $Source)) { throw "源码目录不存在：$Source" }
if (-not (Test-Path $Target)) { throw "安装目录不存在：$Target" }

# 防呆：安装目录不该是链接（宿主会拒绝加载）
$tItem = Get-Item -LiteralPath $Target -Force
if ($tItem.LinkType) {
    throw "安装目录是 $($tItem.LinkType)，宿主会拒绝加载。先恢复为普通目录再跑本脚本。"
}

function Get-RelFiles([string]$root) {
    Get-ChildItem -LiteralPath $root -Recurse -File -Force |
        ForEach-Object { $_.FullName.Substring($root.Length + 1) -replace '/', '\' }
}

$Files = Get-RelFiles $Source | Sort-Object -Unique
$InstFiles = Get-RelFiles $Target | Sort-Object -Unique

# 开发文档误落在 App 根下时报警（不静默过滤，也不静默搬运）
$strayDocs = $Files | Where-Object { $_ -like '*.md' }
if ($strayDocs) {
    Write-Host "  [提醒] App 根下有开发文档，按仓库约定应放 docs/：$($strayDocs -join ', ')" -ForegroundColor Magenta
}

$drift = @()
$copied = @()

foreach ($rel in $Files) {
    $s = Join-Path $Source $rel
    $t = Join-Path $Target $rel

    $sHash = (Get-FileHash $s).Hash
    $tHash = if (Test-Path $t) { (Get-FileHash $t).Hash } else { '' }

    if ($sHash -eq $tHash) { Write-Host "  [一致] $rel" -ForegroundColor Green; continue }

    if ($Check) {
        $sShort = $sHash.Substring(0, 12)
        $tShort = if ($tHash) { $tHash.Substring(0, 12) } else { '(缺失)' }
        Write-Host "  [漂移] $rel  源码=$sShort 安装=$tShort" -ForegroundColor Yellow
        $drift += $rel
        continue
    }

    $dir = Split-Path $t -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item -LiteralPath $s -Destination $t -Force

    if ((Get-FileHash $t).Hash -eq $sHash) {
        Write-Host "  [已同步] $rel" -ForegroundColor Cyan
        $copied += $rel
    } else {
        Write-Host "  [失败] $rel 复制后哈希仍不一致" -ForegroundColor Red
        exit 1
    }
}

# 反向核对：安装目录里源码侧没有的文件。
#
# 为什么这也要非零退出（2026-10-14，经独立复核后收紧）：
#   同步是单向的（只拷源码→安装），删过的文件不会从安装目录消失。
#   于是宿主静态树里可能留着一个源码已经不存在的旧文件，而 -Check 报 exit 0。
#   那仍是机器可见的假绿灯：CI / 交付脚本只看退出码就会放行。
#   所以「一致」的完整含义包含双向：源码有的一定在、安装多的必须被看见。
#
# 但仍不自动删除：安装目录里也可能有宿主自己写的文件，删了会出事。
# 非零退出的语义是「此处有人需要看一眼」，不是「脚本自己处理」。
$extra = $InstFiles | Where-Object { $Files -notcontains $_ }

Write-Host ""
if ($Check) {
    if ($extra.Count -gt 0) {
        Write-Host "安装目录多出 $($extra.Count) 个源码侧没有的文件（不自动处理，请人工判断）：" -ForegroundColor Magenta
        $extra | ForEach-Object { Write-Host "  [多出] $_" -ForegroundColor Magenta }
    }
    if ($drift.Count -eq 0 -and $extra.Count -eq 0) {
        Write-Host "校验通过：源码侧 $($Files.Count) 个受服务文件在安装位置逐字节一致，且安装目录无多余文件。" -ForegroundColor Green
        exit 0
    }
    if ($drift.Count -eq 0) {
        Write-Host "源码侧 $($Files.Count) 个受服务文件均一致，但安装目录有 $($extra.Count) 个多出文件（见上）。" -ForegroundColor Magenta
        Write-Host "这可能是删过的旧文件没从安装目录消失（同步是单向的），也可能是宿主自己写的。看一眼再定。" -ForegroundColor Magenta
        exit 2
    }
    Write-Host "发现 $($drift.Count) 个文件漂移（宿主正服务旧版）：$($drift -join ', ')" -ForegroundColor Yellow
    Write-Host "跑不带 -Check 的命令同步。" -ForegroundColor Yellow
    exit 2
}

if ($extra.Count -gt 0) {
    Write-Host "安装目录多出 $($extra.Count) 个源码侧没有的文件（本脚本不删）：$($extra -join ', ')" -ForegroundColor Magenta
}

if ($copied.Count -eq 0) {
    Write-Host "无需同步：$($Files.Count) 个受服务文件两处一致。" -ForegroundColor Green
} else {
    Write-Host "同步完成：$($copied.Count) 个文件已更新（共 $($Files.Count) 个受服务文件）。" -ForegroundColor Green
    Write-Host "下一步：调 extension_manager reload（id=repo-auto-index），宿主才会抓取新的 ui/ 快照。" -ForegroundColor Green
}
