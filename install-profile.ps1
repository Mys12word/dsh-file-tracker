# 把本插件装进一个 DSH profile：link 依赖 + bundle + node_modules junction。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\install-profile.ps1 [-ProfileName desktop]
param(
  [string]$ProfileName = 'desktop'
)
$ErrorActionPreference = 'Stop'

$pkgName = 'dsh-file-tracker'
$pluginRoot = if ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'plugins' } else { Join-Path $HOME '.dsh' | Join-Path -ChildPath 'plugins' }
$pluginDir = Join-Path $pluginRoot $pkgName
$profileDir = Join-Path (Join-Path $HOME '.dsh') 'profiles' | Join-Path -ChildPath $ProfileName
$pkgJson = Join-Path $profileDir 'package.json'

if (!(Test-Path $pluginDir)) { throw "找不到插件目录：$pluginDir" }
if (!(Test-Path $pkgJson))   { throw "找不到 profile：$pkgJson" }

$pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
$link = "link:$($pluginDir.Replace('\','/'))"
$changed = $false

if (-not $pkg.dependencies.PSObject.Properties[$pkgName]) {
  $pkg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $link
  $changed = $true
}
if (-not ($pkg.dsh.profile.bundles -contains $pkgName)) {
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $pkgName
  $changed = $true
}

if ($changed) {
  $pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgJson -Encoding utf8
  Write-Host "profile package.json 已更新"
} else {
  Write-Host "profile package.json 已包含 $($pkgName)，跳过"
}

$linkPath = Join-Path $profileDir 'node_modules' | Join-Path -ChildPath $pkgName
if (!(Test-Path $linkPath)) {
  New-Item -ItemType Junction -Path $linkPath -Target $pluginDir | Out-Null
  Write-Host "junction 已创建：$linkPath"
} else {
  Write-Host "junction 已存在，跳过"
}

Write-Host "`n完成。请**完全退出并重启 DSH Desktop** 使插件生效。"
