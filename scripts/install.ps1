<#
.SYNOPSIS
    dsh-life-mode 安装脚本：准备文件系统。默认干跑，加 -Apply 才真写。

.DESCRIPTION
    这个脚本只做三件事，不碰 DSH 的 profile 配置：
      1. 检查环境（DSH 目录、node、profile）
      2. 把仓库拷到 ~/.dsh/life-mode，填好 @NODE@ / @HOME@ 占位符
      3. 装记忆层需要的那个 npm 包（-NoMemory 可跳过）

    把 bundle 注册进 DSH 要走 plugin_manager，那是 agent 的活，见 INSTALL.md。

.PARAMETER Apply
    真的写盘。不加就是干跑，只报告会做什么。

.PARAMETER NoMemory
    不装记忆层（不跑 npm install），只装上下文字段和预设。

.PARAMETER InstallDir
    安装目录，默认 ~/.dsh/life-mode。

.PARAMETER Force
    目标目录已存在也继续（会覆盖代码文件，保留 memory/ 和 persona/）。
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$NoMemory,
    [switch]$Force,
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'
$script:Problems = @()
$script:Actions  = @()

function Say  ($m) { Write-Host "  $m" }
function Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "  [x]  $m" -ForegroundColor Red; $script:Problems += $m }
function Todo ($m) { $script:Actions += $m; Write-Host "  ->   $m" -ForegroundColor Cyan }

Write-Host ''
Write-Host 'dsh-life-mode 安装' -ForegroundColor White
Write-Host ('=' * 46)
if (-not $Apply) { Write-Host '  干跑模式：什么都不会写。确认没问题后加 -Apply 再跑一次。' -ForegroundColor Yellow }
Write-Host ''

# ---------------------------------------------------------------- 1. 环境
Write-Host '[1/4] 检查环境'

$dshHome = Join-Path $env:USERPROFILE '.dsh'
if (-not (Test-Path $dshHome)) {
    Fail "找不到 $dshHome —— 这台机器上没装过 DSH？"
    Write-Host ''
    Write-Host '停在这里。先让 DSH 跑起来一次，再回来装。' -ForegroundColor Red
    exit 1
}
Ok "DSH 目录 $dshHome"

$profilesDir = Join-Path $dshHome 'profiles'
$profiles = @()
if (Test-Path $profilesDir) {
    $profiles = @(Get-ChildItem $profilesDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
}
if ($profiles.Count -eq 0) {
    Fail '找不到任何 DSH profile（.dsh/profiles/*/package.json）'
}
elseif ($profiles.Count -eq 1) {
    Ok "profile: $($profiles[0].Name)"
}
else {
    Warn "有 $($profiles.Count) 个 profile：$($profiles.Name -join ', ')"
    Say '   注册 bundle 的时候要指定是哪一个。'
}

$node = $null
$nodeCandidates = @()
$runtimes = Join-Path $dshHome 'dsh-runtimes'
if (Test-Path $runtimes) {
    $nodeCandidates += @(Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'dependencies\node\bin\node.exe' } |
        Where-Object { Test-Path $_ })
}
$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) { $nodeCandidates += $pathNode.Source }

if ($nodeCandidates.Count -gt 0) {
    $node = $nodeCandidates[0]
    Ok "node: $node"
}
else {
    Fail '找不到 node.exe（DSH 自带运行时和 PATH 里都没有）'
}

$npm = $null
if ($node) {
    $npmLocal = Join-Path (Split-Path $node) 'npm.cmd'
    $npmSystem = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
    if (Test-Path $npmLocal) { $npm = $npmLocal }
    elseif (Test-Path $npmSystem) { $npm = $npmSystem }
    if ($npm) { Ok "npm: $npm" }
    elseif (-not $NoMemory) { Warn '找不到 npm.cmd，记忆层装不了（可以用 -NoMemory 只装核心）' }
}

# 源码目录：脚本在 <repo>/scripts 里
$source = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $source 'bundles\life-context\index.js'))) {
    Fail "源码目录不像 dsh-life-mode：$source"
}
else {
    Ok "源码 $source"
}

# ---------------------------------------------------------------- 2. 目标
Write-Host ''
Write-Host '[2/4] 准备安装目录'

$Target = if ($InstallDir) { $InstallDir } else { Join-Path $dshHome 'life-mode' }
$Target = [System.IO.Path]::GetFullPath($Target)
Say "目标 $Target"

$exists = Test-Path $Target
if ($exists -and -not $Force) {
    Warn '目标目录已存在。加 -Force 会覆盖代码，但保留 memory/ 和 persona/'
}
elseif (-not $exists) {
    Todo "创建 $Target"
}

$repoFiles = Get-ChildItem $source -Directory | Where-Object { $_.Name -notin @('.git', 'node_modules', 'scripts', 'docs') }
foreach ($d in $repoFiles) { Todo "拷贝 $($d.Name)/" }
Todo '拷贝 README / INSTALL / LICENSE'
if (-not $NoMemory) { Todo "在 $Target\memory 装 @modelcontextprotocol/server-memory" }
Todo '把 memory-mcp/cordis.patch.yml 里的 @NODE@ / @HOME@ 换成真实路径'
Todo '把 config.json 的 memory 段指向新目录'

# ---------------------------------------------------------------- 3. 动手
Write-Host ''
$writing = if ($Apply) { '' } else { '（干跑，跳过）' }
Write-Host "[3/4] 写盘$writing"

if ($Apply) {
    if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target -Force | Out-Null }

    # 保护用户资产：memory/ 和 persona/ 不覆盖
    $keep = @('memory', 'persona')
    $copyDirs = Get-ChildItem $source -Directory | Where-Object { $_.Name -notin @('.git', 'node_modules') }
    foreach ($d in $copyDirs) {
        $dest = Join-Path $Target $d.Name
        if ($keep -contains $d.Name -and (Test-Path $dest)) {
            Say "跳过 $($d.Name)/（已存在，保留你的内容）"
            continue
        }
        Copy-Item $d.FullName $dest -Recurse -Force
    }
    foreach ($f in 'README.md', 'README.en.md', 'INSTALL.md', 'LICENSE', 'AGENTS.md', 'CHANGELOG.md') {
        $p = Join-Path $source $f
        if (Test-Path $p) { Copy-Item $p (Join-Path $Target $f) -Force }
    }
    Ok '代码已拷好'

    # 占位符替换
    $patch = Join-Path $Target 'bundles\memory-mcp\cordis.patch.yml'
    if ((Test-Path $patch) -and $node) {
        $raw = [System.IO.File]::ReadAllText($patch)
        $raw = $raw.Replace('@NODE@', $node).Replace('@HOME@', $Target)
        [System.IO.File]::WriteAllText($patch, $raw, (New-Object System.Text.UTF8Encoding $false))
        Ok '占位符已替换'
    }

    # 记忆层
    $memDir = Join-Path $Target 'memory'
    if (-not $NoMemory -and $npm) {
        if (-not (Test-Path $memDir)) { New-Item -ItemType Directory -Path $memDir -Force | Out-Null }
        Say 'npm install @modelcontextprotocol/server-memory（这里会联网）'
        Push-Location $memDir
        try {
            & $npm install '@modelcontextprotocol/server-memory' --no-audit --no-fund --loglevel=error
            if ($LASTEXITCODE -ne 0) { Fail "npm install 失败（exit $LASTEXITCODE）" }
        }
        finally { Pop-Location }
        foreach ($f in 'memory.jsonl', 'meta.jsonl') {
            $p = Join-Path $memDir $f
            if (-not (Test-Path $p)) { New-Item -ItemType File -Path $p | Out-Null }
        }
        if (-not (Test-Path (Join-Path $memDir 'backups'))) { New-Item -ItemType Directory -Path (Join-Path $memDir 'backups') -Force | Out-Null }
        Ok '记忆层就位'
    }

    # config.json 指向新目录
    $cfgPath = Join-Path $Target 'bundles\life-context\config.json'
    if ((Test-Path $cfgPath) -and -not $NoMemory -and $node) {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfg | Add-Member -NotePropertyName memory -NotePropertyValue ([pscustomobject]@{
            node   = $node
            server = Join-Path $memDir 'node_modules\@modelcontextprotocol\server-memory\dist\index.js'
            file   = Join-Path $memDir 'memory.jsonl'
        }) -Force
        $cfg | Add-Member -NotePropertyName autoWrite -NotePropertyValue $true -Force
        $cfg | Add-Member -NotePropertyName graph -NotePropertyValue (Join-Path $memDir 'memory.jsonl') -Force
        $cfg | Add-Member -NotePropertyName meta -NotePropertyValue (Join-Path $memDir 'meta.jsonl') -Force
        $json = $cfg | ConvertTo-Json -Depth 8
        [System.IO.File]::WriteAllText($cfgPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
        Ok 'config.json 已指向新目录'
    }
}
else {
    Say '（以上是计划，没有真的执行）'
}

# ---------------------------------------------------------------- 4. 收尾
Write-Host ''
Write-Host '[4/4] 下一步'

if ($script:Problems.Count -gt 0) {
    Write-Host ''
    Write-Host '有阻断性问题，先别往下走：' -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host "  - $p" -ForegroundColor Red }
    Write-Host ''
    Write-Host '没写任何东西，装之前的状态没变。' -ForegroundColor Yellow
    exit 1
}

$linkBase = 'link:' + ($Target.Replace('\', '/'))
Write-Host '  接下来让 DSH 里的 agent 跑这几步（见 INSTALL.md）：'
Write-Host ''
Write-Host "    1) plugin_manager install_bundle  target = $linkBase/bundles/life-preset"
Write-Host "    2) plugin_manager install_bundle  target = $linkBase/bundles/life-context"
if (-not $NoMemory) {
    Write-Host "    3) plugin_manager install_bundle  target = $linkBase/bundles/memory-mcp"
}
$lastStep = if (-not $NoMemory) { '4)' } else { '3)' }
Write-Host "    $lastStep 重启 DSH，新建会话时选「生活模式」"
Write-Host ''
if (-not $Apply) {
    Write-Host '现在还是干跑。确认无误后：' -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\install.ps1`" -Apply" -ForegroundColor White
    Write-Host ''
}
