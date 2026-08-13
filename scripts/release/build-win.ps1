# ---------------------------------------------------------------------------
# Windows 打包脚本：打包免安装版 rdCLI 桌面端并压缩为 zip
#
# 用法（项目根目录，PowerShell 5.1+ / PowerShell 7 均可）：
#   powershell -ExecutionPolicy Bypass -File scripts\release\build-win.ps1
#
# 流程：
#   1. 配置国内镜像（electron zip 等自动从 npmmirror 下载并缓存）
#   2. npm install 安装依赖
#   3. npm run desktop:pack（build + stage + electron-builder --dir）
#   4. 将 release\desktop\win-unpacked 压缩为 zip
#
# 产物：release\rdcli-desktop-<version>-win-x64.zip
#       用户解压后双击 rdCLI.exe 即可运行，无需安装
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

if (-not $IsWindows -and $PSVersionTable.PSEdition -ne 'Desktop') {
    throw '本脚本需在 Windows 上运行（在 Linux 上 desktop:pack 会打出 Linux 版）'
}

Set-Location (Join-Path $PSScriptRoot '..\..')

# ---- 1. 国内镜像（electron zip / electron-builder 工具链）-----------------
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# ---- 2. 安装依赖 ----------------------------------------------------------
Write-Host '==> 安装依赖（首次较慢，之后基本秒过）' -ForegroundColor Cyan
npm install --registry=https://registry.npmmirror.com
if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }

# ---- 3. 打包（build + desktop:stage + electron-builder --dir）-------------
# --dir 在 Windows 上默认打 win32，产物为 release\desktop\win-unpacked\
Write-Host '==> 开始打包 win-unpacked（首次会下载 Windows 版 electron，约 130MB）' -ForegroundColor Cyan
npm run desktop:pack
if ($LASTEXITCODE -ne 0) { throw '打包失败' }

# ---- 4. 压缩为 zip ---------------------------------------------------------
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$srcDir = 'release\desktop\win-unpacked'
$outZip = "release\rdcli-desktop-$version-win-x64.zip"

if (-not (Test-Path $srcDir)) { throw "打包产物缺失: $srcDir" }
Remove-Item $outZip -Force -ErrorAction SilentlyContinue

Write-Host '==> 压缩为 zip' -ForegroundColor Cyan
# 用 Windows 自带 bsdtar（Win10 1803+），比 Compress-Archive 快很多；
# -C 使 zip 根目录直接是 rdCLI.exe，解压即用
tar -a -c -f $outZip -C $srcDir .
if ($LASTEXITCODE -ne 0) { throw '压缩失败' }

Write-Host "✅ 完成：$outZip" -ForegroundColor Green
Write-Host '   用户解压后双击 rdCLI.exe 即可运行，无需安装、无需配置。' -ForegroundColor Green
