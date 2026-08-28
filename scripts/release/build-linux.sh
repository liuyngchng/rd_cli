#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Linux 打包脚本：打包 rdCLI 桌面端（AppImage + deb）
#
# 用法（项目根目录）：
#   bash scripts/release/build-linux.sh            # 打 AppImage + deb
#   bash scripts/release/build-linux.sh appimage   # 只打 AppImage
#   bash scripts/release/build-linux.sh deb        # 只打 deb
#
# 流程：
#   1. 配置国内镜像（electron zip 等自动从 npmmirror 下载并缓存）
#   2. npm install 安装依赖
#   3. npm run desktop:stage（生成 .desktop-build/desktop-app）
#   4. electron-builder 打 Linux 包
#
# 产物：release/desktop/rdcli-desktop-<version>-linux-x64.AppImage
#       release/desktop/rdcli-desktop-<version>-linux-x64.deb
# ---------------------------------------------------------------------------
set -euo pipefail

# 仅限 Linux 运行
if [[ "$(uname -s)" != "Linux" ]]; then
  echo '本脚本需在 Linux 上运行（在 Windows 上 desktop:pack 会打出 Windows 版）' >&2
  exit 1
fi

cd "$(dirname "$0")/../.."

# ---- 1. 国内镜像（electron zip / electron-builder 工具链）-----------------
export ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
export ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'

# ---- 2. 安装依赖 ----------------------------------------------------------
echo '==> 安装依赖（首次较慢，之后基本秒过）'
npm install --registry=https://registry.npmmirror.com

# ---- 3. 生成 desktop stage -------------------------------------------------
echo '==> 生成 desktop stage'
npm run desktop:stage

# ---- 4. 打包 ---------------------------------------------------------------
echo '==> 开始打包 Linux 版（首次会下载 Linux 版 electron）'
if [[ "${1:-}" == "appimage" ]]; then
  npx electron-builder --projectDir .desktop-build/desktop-app --linux AppImage
elif [[ "${1:-}" == "deb" ]]; then
  npx electron-builder --projectDir .desktop-build/desktop-app --linux deb
else
  npx electron-builder --projectDir .desktop-build/desktop-app --linux
fi

# 复制用户手册到产物目录（与 AppImage/deb 并列，供用户查阅）
if [ -f user_manual.md ]; then
  cp user_manual.md "release/desktop/用户手册.md"
  echo '==> 已复制用户手册到 release/desktop/'
fi

version=$(node -p "require('./package.json').version")
echo "✅ 完成：release/desktop/rdcli-desktop-${version}-linux-x86_64.AppImage"
