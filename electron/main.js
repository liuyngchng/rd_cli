import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
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
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    title: APP_NAME,
    icon: getWindowIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: getPreloadPath(),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  let revealed = false;
  const reveal = () => {
    if (revealed || !mainWindow || mainWindow.isDestroyed()) return;
    revealed = true;
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    mainWindow.show();
    mainWindow.focus();
  };

  // 等到页面真正加载完成（React 挂载、资源就绪）后再显示主窗口，
  // 避免 splash 消失后出现一段空白深色窗口。
  mainWindow.webContents.once('did-finish-load', reveal);

  mainWindow.on('closed', () => {
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
      mainWindow.show();
      mainWindow.focus();
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
      mainWindow.show();
      mainWindow.focus();
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