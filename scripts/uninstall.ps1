<#
.SYNOPSIS
    dsh-life-mode 卸载脚本。默认干跑，加 -Apply 才真删。

.DESCRIPTION
    按顺序做：
      1. 从 profile 的 package.json 里摘掉三个 bundle（先备份那份 json）
      2. 把记忆数据（memory/）挪到 ~/.dsh/life-mode-backups/<时间戳>/
      3. 删掉 ~/.dsh/life-mode

    记忆是你的东西，不会被真删，只是换个地方放着。要彻底清掉自己手删备份目录。

.PARAMETER Apply
    真的执行。不加就是干跑。

.PARAMETER KeepData
    不挪记忆数据，只摘 bundle 和删代码目录。
#>
[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$KeepData,
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'
$script:Problems = @()

function Say  ($m) { Write-Host "  $m" }
function Ok   ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "  [x]  $m" -ForegroundColor Red; $script:Problems += $m }
function Todo ($m) { Write-Host "  ->   $m" -ForegroundColor Cyan }

$Packages = @('dsh-life-mode-preset', 'dsh-life-mode-context', 'dsh-life-mode-memory')

Write-Host ''
Write-Host 'dsh-life-mode 卸载' -ForegroundColor White
Write-Host ('=' * 46)
if (-not $Apply) { Write-Host '  干跑模式：什么都不会动。' -ForegroundColor Yellow }
Write-Host ''

$dshHome = Join-Path $env:USERPROFILE '.dsh'
$Target = if ($InstallDir) { $InstallDir } else { Join-Path $dshHome 'life-mode' }
$Target = [System.IO.Path]::GetFullPath($Target)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $dshHome "life-mode-backups\$stamp"

# ---------------------------------------------------------------- 1. profile
Write-Host '[1/3] 摘掉 profile 里的 bundle 登记'

$profilesDir = Join-Path $dshHome 'profiles'
$profiles = @()
if (Test-Path $profilesDir) {
    $profiles = @(Get-ChildItem $profilesDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
}
if ($profiles.Count -eq 0) { Warn '没找到 profile，跳过这一步' }

foreach ($profile in $profiles) {
    $pkgPath = Join-Path $profile.FullName 'package.json'
    $raw = [System.IO.File]::ReadAllText($pkgPath)
    $pkg = $raw | ConvertFrom-Json

    $hitDeps = @()
    if ($pkg.dependencies) {
        foreach ($p in $Packages) {
            if ($pkg.dependencies.PSObject.Properties.Name -contains $p) { $hitDeps += $p }
        }
    }
    $hitBundles = @()
    if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
        $hitBundles = @($pkg.dsh.profile.bundles | Where-Object { $Packages -contains $_ })
    }

    if ($hitDeps.Count -eq 0 -and $hitBundles.Count -eq 0) {
        Say "$($profile.Name): 没有 life-mode 的登记，跳过"
        continue
    }

    Todo "$($profile.Name): 去掉 dependencies [$($hitDeps -join ', ')] / bundles [$($hitBundles -join ', ')]"

    if ($Apply) {
        if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
        Copy-Item $pkgPath (Join-Path $backupRoot "package.$($profile.Name).json") -Force

        foreach ($p in $hitDeps) { $pkg.dependencies.PSObject.Properties.Remove($p) }
        if ($hitBundles.Count -gt 0) {
            $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $Packages -notcontains $_ })
        }
        $json = $pkg | ConvertTo-Json -Depth 12
        [System.IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
        Ok "$($profile.Name) 已改（备份在 $backupRoot）"
    }
}

# ---------------------------------------------------------------- 2. 记忆数据
Write-Host ''
Write-Host '[2/3] 记忆数据'

$memDir = Join-Path $Target 'memory'
if (-not (Test-Path $memDir)) {
    Say '没有记忆目录，跳过'
}
elseif ($KeepData) {
    Warn '按 -KeepData 保留在原位；删代码目录时它会被一起删掉——请先自己拷走'
}
else {
    $memSize = 0
    Get-ChildItem $memDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $memSize += $_.Length }
    Todo "把 memory/（$([math]::Round($memSize / 1KB, 1)) KB）挪到 $backupRoot\memory"
    if ($Apply) {
        if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
        Copy-Item $memDir (Join-Path $backupRoot 'memory') -Recurse -Force
        Ok '记忆已备份'
    }
}

# ---------------------------------------------------------------- 3. 目录
Write-Host ''
Write-Host '[3/3] 删安装目录'

if (-not (Test-Path $Target)) {
    Say "$Target 不存在，跳过"
}
else {
    Todo "删 $Target"
    if ($Apply) {
        # 只删我们自己的目录，路径对不上就不动
        if ($Target -like '*\.dsh\life-mode' -or $Target -eq (Join-Path $dshHome 'life-mode')) {
            Remove-Item $Target -Recurse -Force
            Ok '已删除'
        }
        else {
            Fail "-Home 指向 $Target，不像 life-mode 目录，不敢删"
        }
    }
}

Write-Host ''
if ($script:Problems.Count -gt 0) {
    Write-Host '有问题没做完：' -ForegroundColor Red
    foreach ($p in $script:Problems) { Write-Host "  - $p" -ForegroundColor Red }
    exit 1
}

if ($Apply) {
    Write-Host '卸载完成。重启 DSH 生效。' -ForegroundColor Green
    Write-Host "记忆备份：$backupRoot" -ForegroundColor Cyan
}
else {
    Write-Host '还是干跑。确认后：' -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\uninstall.ps1`" -Apply" -ForegroundColor White
}
Write-Host ''
