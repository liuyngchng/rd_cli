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

## 许可证

GNU 通用公共许可证 v3.0 - 详见 LICENSE 文件。

该项目为开源软件，在 GPL v3 许可证下可自由使用、修改与分发。
## Windows setup

Windows 上打包便携版 exe

在项目目录下（PowerShell 或 CMD）执行：

```
npm install
npm run build
npm run desktop:stage
# 一个exe，首次需解压，略慢  
npx electron-builder --projectDir .desktop-build/desktop-app --win portable
# 启动速度快
npx electron-builder --projectDir .desktop-build/desktop-app --win dir
```
