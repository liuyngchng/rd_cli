<div align="center">
 <img src="public/logo.svg" alt="rdCLI" width="64" height="64">
 <h1>rdCLI</h1>
 <p>AI 工作助手界面，支持本地或远程使用，随时随地进行日常办公文档处理。</p>
</div>

---

## 功能

- **响应式设计** - 在桌面、平板和移动设备上无缝运行
- **交互聊天界面** - 内置聊天 UI，轻松与 AI 助手交流
- **集成 Shell 终端** - 通过内置 shell 功能直接访问 CLI
- **文件浏览器** - 交互式文件树，支持语法高亮与实时编辑
- **会话管理** - 恢复对话、管理多个会话并跟踪历史记录
- **多用户支持** - 支持多用户注册与登录，管理员可管理用户

## 快速开始

```bash
npm install
npm run dev
```

打开 `http://localhost:5173` 即可使用。

## 构建 Pi 二进制（打包前置步骤）

桌面应用打包时会从 `electron/pi/` 目录复制 Pi 的独立二进制文件。该文件**不在 Git 仓库中**（`.gitignore` 已排除），需在打包前手动构建一次。

### 前置条件

- 已安装 [Bun](https://bun.sh/)（`curl -fsSL https://bun.sh/install | bash`）
- Pi 源码已 clone 到本机，且已安装依赖并编译（`npm install && npm run build:offline`）

### Linux

```bash
cd <pi-repo>/packages/coding-agent
bun build --compile --no-compile-autoload-bunfig ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile dist/pi
cp dist/pi dist/package.json dist/photon_rs_bg.wasm <rdcli-repo>/electron/pi/
cp -r dist/theme dist/assets dist/export-html <rdcli-repo>/electron/pi/
```

### Windows（PowerShell）

```powershell
cd <pi-repo>\packages\coding-agent
bun build --compile --no-compile-autoload-bunfig .\dist\bun\cli.js .\src\utils\image-resize-worker.ts --outfile dist\pi.exe
Copy-Item dist\pi.exe,dist\package.json,dist\photon_rs_bg.wasm <rdcli-repo>\electron\pi\
Copy-Item -Recurse dist\theme,dist\assets,dist\export-html <rdcli-repo>\electron\pi\
```

构建完成后，`electron/pi/` 目录应包含 `pi`（或 `pi.exe`）、`package.json`、`photon_rs_bg.wasm`、`theme/`、`assets/`、`export-html/`。

## Windows 打包

在 Windows 机器上打包免安装版 rdCLI 桌面端：用户拿到 zip 解压后双击 `rdCLI.exe` 即可运行，无需安装、无需配置。

### 前置条件

- Windows 10 1803+ / Windows 11
- 已安装 [Node.js](https://nodejs.org/)（建议 22 LTS 或更新）

### 一键打包

在项目根目录执行（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-win.ps1
```

脚本会自动完成：配置国内镜像（electron 等二进制从 npmmirror 下载并缓存，首次约 130MB）→ 安装依赖 → 打包 `win-unpacked` → 压缩为 zip。

产物：`release/rdcli-desktop-<版本号>-win-x64.zip`

> 桌面包已内置 Pi 编码代理（体积约增加 100MB）：目标机器**无需安装 pi**。Pi 的 API 密钥配置在 `~/.pi/agent/auth.json` 中，首次启动时需自行配置（或由打包者注入，见下节）。

> 脚本仅限 Windows 运行；在 Linux/WSL 上执行会直接报错退出，避免误打出 Linux 版。

### 打包注入 Pi 配置（可选）

Pi 使用 `~/.pi/agent/auth.json` 存储 API 密钥（不同于 Claude Code 的环境变量方式）。为了让用户拿到 zip 后**开箱即用**，打包时可以把一份 `.env` 注入 `resources\app\.env`——app 启动时自动加载，中转地址、密钥、默认模型均从此读取。

构建机准备（二选一）：

1. **本地文件（推荐）**：复制模板并填写：
   ```powershell
   Copy-Item scripts\release\desktop.env.template scripts\release\desktop.env
   notepad scripts\release\desktop.env
   ```
   `desktop.env` 已加入 `.gitignore`，不会误提交。
2. **环境变量**：在构建机设置 `RDCLI_DESKTOP_ENV`，值即 `.env` 文件内容（`desktop.env` 文件存在时优先）。

模板中的配置项：

| 键 | 说明 |
|---|---|
| `PI_DEFAULT_PROVIDER` | 大模型 provider（如 `deepseek`、`qwen`、`openai`） |
| `PI_API_KEY` | 对应 provider 的 API Key |
| `PI_BASE_URL` | 可选，API 中转/代理网关地址 |
| `PI_DEFAULT_MODEL` | 可选，默认模型 |

注意：

- zip 内的 `.env` 是**明文**，拿到安装包的人都能看到密钥，请使用共享/有限额密钥；
- 用户升级解压新 zip 会覆盖 `resources\app\.env`（若用户自行改过该文件）；
- 用户自己设置的系统环境变量优先级高于 `.env` 中的同名项。

### 常见问题

- **"此系统上禁止运行脚本"**：PowerShell 默认执行策略拦截 `.ps1` 脚本。执行
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后即可直接运行
  `.\scripts\release\build-win.ps1`（仅影响当前用户，无需管理员权限）。
- **SmartScreen 提示"未知发布者"**：未做代码签名的正常现象，点「更多信息 → 仍要运行」即可。
- **首次打包较慢**：需下载 Windows 版 Electron（约 130MB），之后走本地缓存，很快。
- **报"字符串缺少终止符"或中文乱码**：脚本需以 UTF-8 带 BOM 编码保存（Windows PowerShell 5.1
  会把无 BOM 的 UTF-8 按 GBK 读取）。仓库内的脚本已是正确编码，若自行编辑后出现此错，用以下命令重新保存：

  ```powershell
  $p = "$PWD\scripts\release\build-win.ps1"
  $c = Get-Content -Raw -Encoding UTF8 $p
  [System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding $true))
  ```

### 手动打包（可选）

需要单文件 exe 或手动控制流程时：

```powershell
npm install
npm run build
npm run desktop:stage
# 文件夹版（启动快，推荐）：产物 release/desktop/win-unpacked/
npx electron-builder --projectDir .desktop-build/desktop-app --win dir
# 单文件便携版（首次启动需解压，略慢）：产物 release/desktop/
npx electron-builder --projectDir .desktop-build/desktop-app --win portable
```

## Linux 打包

在 Linux 机器上打包 rdCLI 桌面端（以 Ubuntu 为主），产出 AppImage 与 deb 两种格式。

### 前置条件

- Ubuntu 20.04+（或其他主流 Linux 发行版）
- 已安装 [Node.js](https://nodejs.org/)（建议 22 LTS 或更新）
- 安装系统依赖（deb 打包需要 `fakeroot`）：

  ```bash
  sudo apt-get update
  sudo apt-get install -y fakeroot dpkg
  ```

### 一键打包

在项目根目录执行：

```bash
bash scripts/release/build-linux.sh
```

脚本会自动完成：配置国内镜像（electron 等二进制从 npmmirror 下载并缓存）→ 安装依赖 → 生成 desktop stage → 打包 AppImage + deb。

产物：

- `release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage`
- `release/desktop/rdcli-desktop-<版本号>-linux-x64.deb`

> 桌面包已内置 Pi 编码代理（体积约增加 100MB）：目标机器**无需安装 pi**，只需为 Pi 配置一次 API 密钥（写入 `~/.pi/agent/auth.json`，或运行 `pi auth` 交互式配置）。

> 脚本仅限 Linux 运行；在 Windows/WSL 上执行会直接报错退出，避免误打出 Windows 版。

### 使用方式

- **AppImage**：给文件加执行权限后直接运行，免安装：

  ```bash
  chmod +x release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
  ./release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
  ```

  > **Ubuntu 22.04+ 注意**：系统默认不带 `libfuse2`，首次运行前需安装：
  > ```bash
  > sudo apt install libfuse2
  > ```
  > 不想安装 libfuse2 的话，也可以用 `--appimage-extract-and-run` 直接运行（每次都要加这个参数）。

- **deb**：通过包管理器安装，可自动写入应用菜单与 `.desktop` 启动项：

  ```bash
  sudo apt install ./release/desktop/rdcli-desktop-<版本号>-linux-x64.deb
  ```

### 手动打包（可选）

需要单独控制格式或流程时：

```bash
npm install
npm run build
npm run desktop:stage
# 仅 AppImage（免安装）：产物 release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
npx electron-builder --projectDir .desktop-build/desktop-app --linux AppImage
# 仅 deb（可安装）：产物 release/desktop/rdcli-desktop-<版本号>-linux-x64.deb
npx electron-builder --projectDir .desktop-build/desktop-app --linux deb
```

> 也可用 npm 脚本一键完成 build + stage + 打包：`npm run desktop:dist:linux`

## 许可证

GNU 通用公共许可证 v3.0 - 详见 LICENSE 文件。

该项目为开源软件，在 GPL v3 许可证下可自由使用、修改与分发。
