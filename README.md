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

> 脚本仅限 Windows 运行；在 Linux/WSL 上执行会直接报错退出，避免误打出 Linux 版。

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

```
npm install
npm run build
npm run desktop:stage
# 文件夹版（启动快，推荐）：产物 release/desktop/win-unpacked/
npx electron-builder --projectDir .desktop-build/desktop-app --win dir
# 单文件便携版（首次启动需解压，略慢）：产物 release/desktop/
npx electron-builder --projectDir .desktop-build/desktop-app --win portable
```

## 许可证

GNU 通用公共许可证 v3.0 - 详见 LICENSE 文件。

该项目为开源软件，在 GPL v3 许可证下可自由使用、修改与分发。
