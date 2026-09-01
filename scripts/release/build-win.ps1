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
#   3.5 注入 Claude 连接配置（scripts\release\desktop.env → resources\app\.env，可选）
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

# ---- 3.5 注入 Claude 连接配置（可选）---------------------------------------
# 把构建机本地的密钥文件写入 app 根目录（resources\app\.env），用户解压后
# Claude 开箱即用。优先级：desktop.env 文件 > RDCLI_DESKTOP_ENV 环境变量；
# 两者都没有则跳过（.env 为可选配置，详见 README「打包注入 Claude 配置」）。
$envSourceFile = 'scripts\release\desktop.env'
$envTargetFile = 'release\desktop\win-unpacked\resources\app\.env'

if (Test-Path $envSourceFile) {
  Copy-Item $envSourceFile $envTargetFile -Force
  Write-Host '==> 已注入 desktop.env 到 resources\app\.env' -ForegroundColor Cyan
} elseif ($env:RDCLI_DESKTOP_ENV) {
  [System.IO.File]::WriteAllText(
    (Join-Path $PWD $envTargetFile),
    $env:RDCLI_DESKTOP_ENV,
    (New-Object System.Text.UTF8Encoding $false)
  )
  Write-Host '==> 已注入 RDCLI_DESKTOP_ENV 到 resources\app\.env' -ForegroundColor Cyan
} else {
  Write-Host '==> 未找到 desktop.env / RDCLI_DESKTOP_ENV，跳过 Claude 配置注入（用户需自行配置）' -ForegroundColor Yellow
}

# ---- 4. 复制用户手册 --------------------------------------------------------
# Copy user manual (user_manual.md → 用户手册.md) to the zip root so users
# can find it alongside rdCLI.exe after unzipping.
$srcDir = 'release\desktop\win-unpacked'
$manualSrc = 'user_manual.md'
if (Test-Path $manualSrc) {
  Copy-Item $manualSrc "$srcDir\用户手册.md" -Force
  Write-Host '==> 已复制用户手册到 zip 根目录' -ForegroundColor Cyan
}

# ---- 5. 压缩为 zip ---------------------------------------------------------
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
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
