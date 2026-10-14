import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LocalServerController } from './localServer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_NAME = 'rdCLI';
const APP_USER_MODEL_ID = 'ai.rdcli.desktop';

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

let mainWindow = null;
let splashWindow = null;
let localServer = null;
let isQuitting = false;

/**
 * Show a window and bring it to the foreground.
 *
 * On Linux most window managers ignore focus() when the calling process does
 * not own the active focus — toggling alwaysOnTop briefly forces the window
 * to the front so the user sees it immediately on launch.
 */
function showAndFocusWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'linux') {
    win.setAlwaysOnTop(true);
  }
  win.show();
  if (process.platform === 'linux') {
    setTimeout(() => {
      if (!win.isDestroyed()) {
        win.setAlwaysOnTop(false);
      }
    }, 500);
  }
  win.focus();
}

function getAppRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function getPreloadPath() {
  return path.join(__dirname, 'preload.cjs');
}

function getWindowIconPath() {
  if (process.platform === 'darwin') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-macos.png');
  }
  if (process.platform === 'win32') {
    return path.join(getAppRoot(), 'electron', 'assets', 'logo-windows.ico');
  }
  return path.join(getAppRoot(), 'public', 'logo-512.png');
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getDesktopState() {
  const settings = localServer.getSettings();
  return {
    localWebUrl: localServer.getLocalServerUrl(),
    shareableWebUrl: localServer.getShareableWebUrl(),
    localServerRunning: Boolean(localServer.getLocalServerUrl()),
    localStartupLogs: localServer.getStartupLogs(),
    desktopSettings: settings,
    desktopNotifications: { enabled: false, supported: false, connectedCount: 0, targetCount: 0 },
  };
}

function getSplashHtmlPath() {
  return path.join(__dirname, 'splash.html');
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 300,
    frame: false,
    transparent: true,
    // Windows 上不显式声明透明背景时，即使 transparent:true 也可能回退为白底，
    // 这里与 settings 窗口保持一致，强制使用全透明背景。
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: getWindowIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  splashWindow.on('closed', () => {
    splashWindow = null;
  });

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show();
  });

  void splashWindow.loadFile(getSplashHtmlPath());
}

function sendSplashProgress(message) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.executeJavaScript(`
      (function() {
        var el = document.getElementById('progress-text');
        if (el) el.textContent = ${JSON.stringify(message)};
      })();
    `).catch(() => {});
  }
}

async function loadLocalServerUrl() {
  const url = await localServer.ensureLocalServer();
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(url);
  }
  return url;
}

function buildAppMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `关于 ${APP_NAME}`, click: () => void showAboutDialog() },
        { type: 'separator' },
        { label: '复制诊断信息', click: () => copyDiagnostics() },
        { type: 'separator' },
        { label: process.platform === 'darwin' ? `隐藏 ${APP_NAME}` : '隐藏', role: 'hide', visible: process.platform === 'darwin' },
        { label: '隐藏其他', role: 'hideOthers', visible: process.platform === 'darwin' },
        { label: '全部显示', role: 'unhide', visible: process.platform === 'darwin' },
        { type: 'separator', visible: process.platform === 'darwin' },
        { label: `退出 ${APP_NAME}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
        ...(process.platform === 'darwin' ? [{ type: 'separator' }, { label: '前置全部窗口', role: 'front' }] : []),
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: '安装桌面快捷方式', click: () => void installDesktopShortcut() },
        { label: '移除桌面快捷方式', click: () => void removeDesktopShortcut() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '复制诊断信息', click: () => copyDiagnostics() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getDiagnosticsText() {
  return JSON.stringify({
    app: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    appPath: getAppRoot(),
    userDataPath: app.getPath('userData'),
    localServerUrl: localServer.getLocalServerUrl(),
    localServerPort: localServer.localServerPort,
    shareableWebUrl: localServer.getShareableWebUrl(),
    desktopSettings: localServer.getSettings(),
  }, null, 2);
}

async function showAboutDialog() {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: `关于 ${APP_NAME}`,
    message: `${APP_NAME} v${app.getVersion()}`,
    detail: [
      '桌面智能助手',
      '',
      `开发者：richard`,
      `邮箱：liuyngchng@hotmail.com`,
      '',
      `版本：${app.getVersion()}`,
    ].join('\n'),
  });
}

async function copyDiagnostics() {
  clipboard.writeText(getDiagnosticsText());
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '已复制诊断信息',
    message: 'rdCLI 桌面端诊断信息已复制到剪贴板。',
  });
}

// ---- 安装桌面快捷方式 ----

function getDesktopEntryPath() {
  return path.join(app.getPath('home'), '.local', 'share', 'applications', 'ai.rdcli.desktop');
}

function isDesktopEntryInstalled() {
  return fs.existsSync(getDesktopEntryPath());
}

async function installDesktopShortcut() {
  if (process.platform === 'linux') {
    await installLinuxDesktopEntry();
  } else if (process.platform === 'win32') {
    await installWindowsShortcut();
  }
}

async function installLinuxDesktopEntry() {
  const desktopEntryPath = getDesktopEntryPath();
  const appsDir = path.dirname(desktopEntryPath);
  const iconDir = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor');

  // 获取当前 AppImage 或可执行文件的路径
  const execPath = app.isPackaged
    ? process.env.APPIMAGE || process.execPath
    : process.execPath;

  // 获取源图标
  let sourceIcon = path.join(getAppRoot(), 'electron', 'assets', 'logo-linux.png');
  if (!fs.existsSync(sourceIcon)) {
    sourceIcon = path.join(getAppRoot(), 'public', 'logo-512.png');
  }

  try {
    // 1. 安装多尺寸图标
    const sizes = [256, 128, 64, 48, 32];
    for (const size of sizes) {
      const destDir = path.join(iconDir, `${size}x${size}`, 'apps');
      fs.mkdirSync(destDir, { recursive: true });
      const destIcon = path.join(destDir, 'rdcli.png');

      try {
        // 优先用 ImageMagick resize，否则直接复制
        execSync(`convert "${sourceIcon}" -resize "${size}x${size}" "${destIcon}"`, { stdio: 'ignore' });
      } catch {
        fs.copyFileSync(sourceIcon, destIcon);
      }
    }

    // 2. 更新图标缓存
    try { execSync('gtk-update-icon-cache -f -t "' + iconDir + '"', { stdio: 'ignore' }); } catch {}

    // 3. 写入 .desktop 文件
    fs.mkdirSync(appsDir, { recursive: true });
    const desktopEntry = [
      '[Desktop Entry]',
      'Name=rdCLI',
      'Comment=rdCLI Desktop Shell',
      'GenericName=AI Coding Assistant',
      `Exec=${execPath} --no-sandbox %U`,
      'Terminal=false',
      'Type=Application',
      'Icon=rdcli',
      'StartupWMClass=rdCLI',
      'Categories=Development;Utility;',
      'MimeType=x-scheme-handler/rdcli;',
      'Keywords=AI;Claude;Code;Assistant;Terminal;',
      '',
    ].join('\n');
    fs.writeFileSync(desktopEntryPath, desktopEntry, { mode: 0o755 });

    // 4. 更新桌面数据库
    try { execSync(`update-desktop-database "${appsDir}"`, { stdio: 'ignore' }); } catch {}

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '安装成功',
      message: '桌面快捷方式已安装',
      detail: '你可以按 Super 键搜索 "rdCLI" 来启动应用，或在应用菜单中找到它。',
    });
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '安装失败',
      message: '无法安装桌面快捷方式',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function installWindowsShortcut() {
  try {
    const execPath = process.execPath;
    const desktopDir = app.getPath('desktop');
    const shortcutPath = path.join(desktopDir, 'rdCLI.lnk');
    const iconPath = path.join(getAppRoot(), 'electron', 'assets', 'logo-windows.ico');

    // 用 PowerShell 创建快捷方式。
    // 直接把脚本塞进 -Command 会被外层 cmd.exe 破坏嵌套双引号，导致脚本残缺，
    // 因此改为写入临时 .ps1 文件后通过 -File 执行，脚本内一律用单引号。
    const psScript = [
      `$WshShell = New-Object -ComObject WScript.Shell`,
      `$Shortcut = $WshShell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
      `$Shortcut.TargetPath = '${execPath.replace(/'/g, "''")}'`,
      `$Shortcut.Arguments = '--no-sandbox'`,
      `$Shortcut.IconLocation = '${iconPath.replace(/'/g, "''")}'`,
      `$Shortcut.Description = 'rdCLI Desktop Shell'`,
      `$Shortcut.WorkingDirectory = '${path.dirname(execPath).replace(/'/g, "''")}'`,
      `$Shortcut.Save()`,
    ].join('\n');

    const scriptPath = path.join(app.getPath('temp'), 'rdcli-create-shortcut.ps1');
    fs.writeFileSync(scriptPath, psScript, 'utf8');
    try {
      execSync(
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { stdio: 'ignore' },
      );
    } finally {
      try { fs.unlinkSync(scriptPath); } catch {}
    }

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '安装成功',
      message: '桌面快捷方式已创建',
      detail: 'rdCLI 快捷方式已添加到桌面，你可以双击启动。',
    });
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '安装失败',
      message: '无法创建桌面快捷方式',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function removeDesktopShortcut() {
  if (process.platform === 'linux') {
    const desktopEntryPath = getDesktopEntryPath();
    const iconDir = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor');
    const appsDir = path.dirname(desktopEntryPath);

    try {
      if (fs.existsSync(desktopEntryPath)) fs.unlinkSync(desktopEntryPath);
      for (const size of [256, 128, 64, 48, 32]) {
        const iconPath = path.join(iconDir, `${size}x${size}`, 'apps', 'rdcli.png');
        if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath);
      }
      try { execSync(`update-desktop-database "${appsDir}"`, { stdio: 'ignore' }); } catch {}
      try { execSync(`gtk-update-icon-cache -f -t "${iconDir}"`, { stdio: 'ignore' }); } catch {}

      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '已移除',
        message: '桌面快捷方式已移除',
      });
    } catch (err) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '移除失败',
        message: '无法移除桌面快捷方式',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (process.platform === 'win32') {
    const shortcutPath = path.join(app.getPath('desktop'), 'rdCLI.lnk');
    try {
      if (fs.existsSync(shortcutPath)) fs.unlinkSync(shortcutPath);
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '已移除',
        message: '桌面快捷方式已移除',
      });
    } catch (err) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '移除失败',
        message: '无法移除桌面快捷方式',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function registerIpcHandlers() {
  ipcMain.handle('rdcli-desktop:get-state', () => getDesktopState());
  ipcMain.handle('rdcli-desktop:copy-diagnostics', async () => { await copyDiagnostics(); return getDesktopState(); });
  ipcMain.handle('rdcli-desktop:copy-local-web-url', async () => {
    const url = localServer.getShareableWebUrl() || localServer.getLocalServerUrl();
    if (url) clipboard.writeText(url);
    return getDesktopState();
  });
  ipcMain.handle('rdcli-desktop:update-desktop-notifications', async () => getDesktopState());
  ipcMain.handle('rdcli-desktop:update-setting', async (_event, key, value) => {
    await localServer.updateDesktopSetting(key, value);
    return getDesktopState();
  });

  ipcMain.handle('rdcli-desktop:open-path', async (_event, filePath) => {
    const result = await shell.openPath(filePath);
    return { ok: result === '', error: result || null };
  });
}

// 主窗口的背景色应与 React 应用的主题背景保持一致（见 src/index.css：
// 浅色 hsl(44 22% 96%) → #f6f4ef，深色 hsl(0 0% 8%) → #141414），
// 这样即便主窗口在 React 内容绘制前闪现一帧，也不会出现深色→浅色的跳变。
function getThemeBackgroundColor() {
  const themeMode = localServer.getSettings().themeMode;
  const useDark = themeMode === 'dark'
    || (themeMode !== 'light' && nativeTheme.shouldUseDarkColors);
  return useDark ? '#141414' : '#f6f4ef';
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: getThemeBackgroundColor(),
    title: APP_NAME,
    icon: getWindowIconPath(),
    // 隐藏窗口时仍持续绘制帧，确保 show() 时第一帧就是已渲染好的登录界面，
    // 而不是先闪一帧深色背景再合成内容。
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: getPreloadPath(),
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  let revealed = false;
  let revealFallbackTimer = null;
  let mainWindowLoadFinished = false;
  let reactAppReady = false;

  function tryReveal() {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindowLoadFinished || !reactAppReady) return;
    revealed = true;
    if (revealFallbackTimer) {
      clearTimeout(revealFallbackTimer);
      revealFallbackTimer = null;
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    // paintWhenInitiallyHidden + backgroundThrottling:false 确保隐藏期间
    // 渲染器持续绘制帧，show() 的第一帧就是已渲染好的登录界面。
    showAndFocusWindow(mainWindow);
  }

  // 两个信号缺一不可，同时满足才切换窗口：
  // 1. did-finish-load — HTML/CSS/JS 已加载
  // 2. rdcli-desktop:ready — React 已渲染出登录/设置界面，关闭 splash 完成切换
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindowLoadFinished = true;
    tryReveal();
  });

  ipcMain.once('rdcli-desktop:ready', () => {
    reactAppReady = true;
    tryReveal();
  });

  // 兜底：5s 后若两路信号还没到齐，强制显示主窗口（避免无限等待）
  revealFallbackTimer = setTimeout(() => {
    mainWindowLoadFinished = true;
    reactAppReady = true;
    tryReveal();
  }, 5000);

  mainWindow.on('closed', () => {
    if (revealFallbackTimer) {
      clearTimeout(revealFallbackTimer);
      revealFallbackTimer = null;
    }
    mainWindow = null;
  });

  buildAppMenu();

  // Start local server and navigate to it
  try {
    const url = await loadLocalServerUrl();
    mainWindow.setTitle(`${APP_NAME} - ${url}`);
  } catch (error) {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    await dialog.showMessageBox({
      type: 'error',
      title: 'rdCLI 启动失败',
      message: '本地 rdCLI 服务启动失败。',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  }
}

function registerAppEvents() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    } else if (mainWindow) {
      showAndFocusWindow(mainWindow);
    }
  });

  app.on('before-quit', (event) => {
    if (isQuitting || !localServer?.hasOwnedServer()) return;
    if (localServer.getSettings().keepLocalServerRunning) {
      localServer.detachOwnedServer();
      return;
    }

    event.preventDefault();
    isQuitting = true;
    void localServer.shutdownOwnedServer().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

function registerSingleInstance() {
  const gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      showAndFocusWindow(mainWindow);
    }
  });

  return true;
}

async function bootstrap() {
  app.name = APP_NAME;
  app.setName(APP_NAME);
  process.title = APP_NAME;

  await app.whenReady();
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'rdCLI',
  });

  createSplashWindow();

  localServer = new LocalServerController({
    appRoot: getAppRoot(),
    settingsPath: getSettingsPath(),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    onChange: () => {},
    onProgress: (message) => sendSplashProgress(message),
  });

  await localServer.loadDesktopSettings();

  registerIpcHandlers();
  registerAppEvents();
  await createWindow();
}

if (registerSingleInstance()) {
  bootstrap().catch(async (error) => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'rdCLI 启动失败',
      message: 'rdCLI 启动失败。',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  });
}