import { BrowserWindow, Menu, Tray, clipboard, nativeImage, nativeTheme, session, webContents as electronWebContents } from 'electron';

import { ViewHost } from './viewHost.js';

const TITLEBAR_HEIGHT = 44;
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
function isAllowedPermissionOrigin(sourceUrl, controlPlaneUrl) {
  try {
    const source = new URL(sourceUrl);
    if ((source.hostname === '127.0.0.1' || source.hostname === 'localhost') && source.protocol === 'http:') {
      return true;
    }
    if (source.protocol !== 'https:') {
      return false;
    }
    const controlPlane = new URL(controlPlaneUrl);
    return source.origin === controlPlane.origin || source.hostname.endsWith('.rdcli.ai');
  } catch {
    return false;
  }
}

function getWebContentsProcessId(contents) {
  return {
    osProcessId: typeof contents.getOSProcessId === 'function' ? contents.getOSProcessId() : null,
    processId: typeof contents.getProcessId === 'function' ? contents.getProcessId() : null,
  };
}

export class DesktopWindowManager {
  constructor({
    appName,
    getWindowIconPath,
    getLauncherPath,
    getPreloadPath,
    openExternalUrl,
    getDesktopState,
    getDisplayTargetName,
    getRemoteEnvironmentMenuItems,
    getCloudState,
    getLocalState,
    actions,
    tabs,
  }) {
    this.appName = appName;
    this.getWindowIconPath = getWindowIconPath;
    this.getLauncherPath = getLauncherPath;
    this.getPreloadPath = getPreloadPath;
    this.openExternalUrl = openExternalUrl;
    this.getDesktopState = getDesktopState;
    this.getDisplayTargetName = getDisplayTargetName;
    this.getRemoteEnvironmentMenuItems = getRemoteEnvironmentMenuItems;
    this.getCloudState = getCloudState;
    this.getLocalState = getLocalState;
    this.actions = actions;
    this.tabs = tabs;

    this.mainWindow = null;
    this.settingsWindow = null;
    this.tray = null;
    this.launcherLoaded = false;
    this.viewHost = new ViewHost({
      appName: this.appName,
      getMainWindow: () => this.mainWindow,
      getContentViewBounds: () => this.getContentViewBounds(),
      getPreloadPath: this.getPreloadPath,
      openExternalUrl: this.openExternalUrl,
      showError: this.actions.showError,
    });
  }

  getMainWindow() {
    return this.mainWindow;
  }

  getTrayImage() {
    const image = nativeImage.createFromPath(this.getWindowIconPath());
    return image.resize({ width: 18, height: 18 });
  }

  getContentViewBounds() {
    if (!this.mainWindow) return { x: 0, y: TITLEBAR_HEIGHT, width: 0, height: 0 };
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    };
  }

  detachActiveContentView() {
    this.viewHost.detachAll();
  }

  async showTabPlaceholder(target, message) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showTabPlaceholder(tabId, target, message);
  }

  async showLocalStartupTarget(target, logs) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showLocalStartupTarget(tabId, target, logs);
  }

  async showContentTarget(target) {
    const tabId = this.tabs.getTabIdForTarget(target);
    await this.viewHost.showContentTarget(tabId, target);
  }

  destroyTabView(tabId) {
    this.viewHost.destroyTabView(tabId);
  }

  emitDesktopState() {
    const state = this.getDesktopState();
    if (this.mainWindow && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('rdcli-desktop:state-updated', state);
    }
    if (this.settingsWindow && !this.settingsWindow.webContents.isDestroyed()) {
      this.settingsWindow.webContents.send('rdcli-desktop:state-updated', state);
    }
  }

  emitLauncherCommand(command) {
    if (!this.mainWindow || this.mainWindow.webContents.isDestroyed()) return;
    this.mainWindow.webContents.send('rdcli-desktop:launcher-command', command);
  }

  emitSettingsCommand(command) {
    if (!this.settingsWindow || this.settingsWindow.webContents.isDestroyed()) return;
    this.settingsWindow.webContents.send('rdcli-desktop:launcher-command', command);
  }

  syncSettingsWindowBounds() {
    if (!this.mainWindow || !this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.setBounds(this.mainWindow.getBounds());
  }

  async ensureSettingsWindow(sheet = 'desktop-settings') {
    if (!this.mainWindow) return null;

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.syncSettingsWindowBounds();
      this.emitSettingsCommand({ type: 'open-sheet', sheet });
      this.settingsWindow.focus();
      return this.settingsWindow;
    }

    this.settingsWindow = new BrowserWindow({
      parent: this.mainWindow,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      movable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });
    this.syncSettingsWindowBounds();
    this.viewHost.configureChildWebContents(this.settingsWindow.webContents);
    this.settingsWindow.once('ready-to-show', () => this.settingsWindow?.show());
    this.settingsWindow.on('closed', () => {
      this.settingsWindow = null;
    });
    await this.settingsWindow.loadFile(this.getLauncherPath(), {
      query: { modal: '1', sheet },
    });
    return this.settingsWindow;
  }

  closeSettingsWindow() {
    if (!this.settingsWindow || this.settingsWindow.isDestroyed()) return;
    this.settingsWindow.close();
  }

  async showTarget(target, { trackTab = true } = {}) {
    if (!this.mainWindow) return;
    if (trackTab) {
      this.tabs.upsertTarget(target);
    }
    this.actions.setActiveTarget(target);
    this.buildAppMenu();
    this.mainWindow.setTitle(`${this.appName} - ${target.name}`);
    const finalUrl = await this.showContentTarget(target);
    this.emitDesktopState();
    return finalUrl;
  }

  async showLauncher() {
    if (!this.mainWindow) return;
    const target = { kind: 'launcher', name: this.appName, url: null };
    this.tabs.upsertTarget(target);
    this.actions.setActiveTarget(target);
    this.detachActiveContentView();
    this.buildAppMenu();
    this.mainWindow.setTitle(this.appName);
    this.mainWindow.webContents.focus();
    if (!this.launcherLoaded) {
      await this.mainWindow.loadFile(this.getLauncherPath());
      this.launcherLoaded = true;
    } else {
      this.emitDesktopState();
    }
  }

  async switchDesktopTab(tabId) {
    const tab = this.tabs.activate(tabId);
    if (!tab || !this.mainWindow) return this.getDesktopState();

    if (tab.id === 'home' || tab.kind === 'launcher') {
      await this.showLauncher();
      return this.getDesktopState();
    }

    if (!tab.target?.url) {
      throw new Error('此标签页没有目标地址。');
    }

    await this.showTarget(tab.target, { trackTab: false });
    return this.getDesktopState();
  }

  async reloadActiveTab() {
    const activeTab = this.tabs.getActiveTab();
    if (!activeTab || activeTab.id === 'home' || activeTab.kind === 'launcher') {
      this.emitDesktopState();
      return this.getDesktopState();
    }

    const reloaded = this.viewHost.reloadTab(activeTab.id);
    if (!reloaded && activeTab.target?.url) {
      await this.showTarget(activeTab.target, { trackTab: false });
    }
    this.emitDesktopState();
    return this.getDesktopState();
  }

  async navigateActiveView(url) {
    const navigated = await this.viewHost.navigateActiveView(url);
    this.emitDesktopState();
    return navigated;
  }

  async readAuthTokenForTarget(url) {
    return this.viewHost.readLocalStorageValueForOrigin(url, AUTH_TOKEN_STORAGE_KEY);
  }

  openActiveTabDevTools() {
    if (this.viewHost.openActiveViewDevTools()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before opening active tab DevTools.'));
  }

  reloadActiveBrowserViewForDiagnostics() {
    if (this.viewHost.reloadActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before reloading the active BrowserView.'));
  }

  detachActiveBrowserViewForDiagnostics() {
    if (this.viewHost.detachActiveView()) return;
    void this.actions.showError('No active BrowserView', new Error('Switch to a non-launcher tab before detaching the active BrowserView.'));
  }

  copyWebContentsDiagnostics() {
    const tabViewDiagnostics = this.viewHost.getTabViewDiagnostics();
    const tabViewByContentsId = new Map(
      tabViewDiagnostics
        .filter((item) => item.webContentsId != null)
        .map((item) => [item.webContentsId, item])
    );

    const rows = electronWebContents.getAllWebContents().map((contents) => {
      const destroyed = contents.isDestroyed();
      const processIds = destroyed ? { osProcessId: null, processId: null } : getWebContentsProcessId(contents);
      const tabView = tabViewByContentsId.get(contents.id);
      let owner = 'unknown';
      if (this.mainWindow?.webContents?.id === contents.id) {
        owner = 'main-window';
      } else if (this.settingsWindow?.webContents?.id === contents.id) {
        owner = 'settings-window';
      } else if (tabView) {
        owner = `browser-view:${tabView.tabId}`;
      }

      return {
        id: contents.id,
        owner,
        osProcessId: processIds.osProcessId,
        processId: processIds.processId,
        url: destroyed ? null : contents.getURL(),
        title: destroyed ? null : contents.getTitle(),
        destroyed,
        focused: destroyed || typeof contents.isFocused !== 'function' ? false : contents.isFocused(),
        attached: tabView ? tabView.attached : null,
        active: tabView ? tabView.active : null,
      };
    });

    const activeTab = this.tabs.getActiveTab();
    const diagnostics = {
      generatedAt: new Date().toISOString(),
      activeTabId: this.tabs.activeTabId,
      activeTab: activeTab
        ? {
            id: activeTab.id,
            title: activeTab.title,
            kind: activeTab.kind,
            targetUrl: activeTab.target?.url || null,
          }
        : null,
      tabViews: tabViewDiagnostics,
      webContents: rows,
    };

    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }

  async closeDesktopTab(tabId) {
    const tab = this.tabs.remove(tabId);
    if (!tab) return this.getDesktopState();
    this.destroyTabView(tabId);
    if (this.tabs.activeTabId === 'home') {
      await this.showLauncher();
    } else {
      this.emitDesktopState();
    }
    return this.getDesktopState();
  }

  buildEnvironmentActionsSubmenu(environment) {
    const items = [];
    const statusSuffix = environment.status === 'running' ? '' : ` (${environment.status})`;
    items.push({
      label: '打开环境',
      click: () => void this.actions.openEnvironmentInDesktop(environment)
        .catch((error) => this.actions.showError(`无法打开 ${environment.name || environment.subdomain}${statusSuffix}`, error)),
    });
    items.push({
      label: '在浏览器中打开',
      click: () => void this.actions.openEnvironmentInBrowser(environment)
        .catch((error) => this.actions.showError('无法在浏览器中打开环境', error)),
    });
    items.push({
      label: '在 VS Code 中打开',
      click: () => void this.actions.openEnvironmentInIde(environment, 'vscode')
        .catch((error) => this.actions.showError('无法在 VS Code 中打开环境', error)),
    });
    items.push({
      label: '在 Cursor 中打开',
      click: () => void this.actions.openEnvironmentInIde(environment, 'cursor')
        .catch((error) => this.actions.showError('无法在 Cursor 中打开环境', error)),
    });
    items.push({
      label: '打开 SSH 终端',
      click: () => void this.actions.openEnvironmentInSsh(environment)
        .catch((error) => this.actions.showError('无法打开 SSH 终端', error)),
    });
    items.push({
      label: '复制移动端/网页地址',
      click: () => this.actions.copyText(this.actions.getEnvironmentUrl(environment)),
    });
    if (environment.status !== 'running') {
      items.unshift({
        label: environment.status === 'paused' ? '恢复' : '启动',
        click: () => void this.actions.startEnvironment(environment)
          .catch((error) => this.actions.showError('无法启动环境', error)),
      });
    }
    if (environment.status === 'running') {
      items.push({
        label: '停止',
        click: () => void this.actions.stopEnvironment(environment)
          .catch((error) => this.actions.showError('无法停止环境', error)),
      });
    }
    return items;
  }

  buildTrayEnvironmentSection() {
    const cloudState = this.getCloudState();
    if (!cloudState.account?.apiKey) {
      return [
        {
          label: cloudState.account?.email ? `重新连接 ${cloudState.account.email}` : '登录',
          click: () => void this.actions.connectCloudAccount()
            .catch((error) => this.actions.showError('无法连接 rdCLI 账号', error)),
        },
      ];
    }

    if (!cloudState.environments.length) {
      return [{ label: '未找到环境', enabled: false }];
    }

    return cloudState.environments.map((environment) => ({
      label: `${environment.name || environment.subdomain} - ${environment.status}`,
      submenu: this.buildEnvironmentActionsSubmenu(environment),
    }));
  }

  buildAppMenu() {
    if (!this.mainWindow) return;
    const cloudState = this.getCloudState();
    const localState = this.getLocalState();
    const remoteItems = this.getRemoteEnvironmentMenuItems();
    const cloudAccountLabel = cloudState.account?.apiKey
      ? (cloudState.account?.email ? `已连接：${cloudState.account.email}` : 'rdCLI 已连接')
      : (cloudState.account?.email ? `重新连接：${cloudState.account.email}` : '连接 rdCLI 账号...');

    const template = [
      {
        label: this.appName,
        submenu: [
          { label: `关于 ${this.appName}`, role: 'about' },
          { type: 'separator' },
          {
            label: '显示启动器',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('无法显示启动器', error)),
          },
          {
            label: '切换环境',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('无法切换环境', error)),
          },
          {
            label: '诊断',
            submenu: [
              {
                label: '复制诊断信息',
                click: () => void this.actions.copyDiagnostics(),
              },
            ],
          },
          { type: 'separator' },
          {
            label: process.platform === 'darwin' ? `隐藏 ${this.appName}` : '隐藏',
            role: 'hide',
            visible: process.platform === 'darwin',
          },
          { label: '隐藏其他', role: 'hideOthers', visible: process.platform === 'darwin' },
          { label: '全部显示', role: 'unhide', visible: process.platform === 'darwin' },
          { type: 'separator', visible: process.platform === 'darwin' },
          { label: `退出 ${this.appName}`, accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: '环境',
        submenu: [
          {
            label: '显示启动器',
            accelerator: 'CmdOrCtrl+Shift+L',
            click: () => void this.showLauncher().catch((error) => this.actions.showError('无法显示启动器', error)),
          },
          {
            label: '切换环境',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => void this.actions.showEnvironmentPicker().catch((error) => this.actions.showError('无法切换环境', error)),
          },
          { type: 'separator' },
          {
            label: '打开本地 rdCLI',
            accelerator: 'CmdOrCtrl+L',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('无法打开本地 rdCLI', error)),
          },
          {
            label: '在浏览器中打开本地 Web 界面',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('无法打开本地 Web 界面', error)),
          },
          {
            label: '复制本地 Web 地址',
            accelerator: 'CmdOrCtrl+Shift+U',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('无法复制本地 Web 地址', error)),
          },
          { type: 'separator' },
          {
            label: '退出后保持本地服务运行',
            type: 'checkbox',
            checked: localState.desktopSettings.keepLocalServerRunning,
            click: (menuItem) => void this.actions.updateDesktopSetting('keepLocalServerRunning', menuItem.checked)
              .catch((error) => this.actions.showError('无法更新桌面设置', error)),
          },
          {
            label: '允许局域网访问本地服务',
            type: 'checkbox',
            checked: localState.desktopSettings.exposeLocalServerOnNetwork,
            click: (menuItem) => void this.actions.updateDesktopSetting('exposeLocalServerOnNetwork', menuItem.checked)
              .catch((error) => this.actions.showError('无法更新桌面设置', error)),
          },
        ],
      },
      {
        label: '云端',
        submenu: [
          {
            label: cloudAccountLabel,
            accelerator: 'CmdOrCtrl+Shift+C',
            click: () => void this.actions.connectCloudAccount().catch((error) => this.actions.showError('无法连接 rdCLI 账号', error)),
          },
          {
            label: '刷新云端环境',
            click: () => void this.actions.refreshCloudEnvironments().catch((error) => this.actions.showError('无法加载 rdCLI 环境', error)),
            enabled: Boolean(cloudState.account?.apiKey),
          },
          {
            label: '退出 rdCLI 账号',
            click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('无法退出登录', error)),
            enabled: Boolean(cloudState.account?.apiKey),
          },
          { type: 'separator' },
          {
            label: '远程环境',
            submenu: remoteItems,
          },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          {
            label: '打开当前标签页 DevTools',
            click: () => this.openActiveTabDevTools(),
          },
          {
            label: '复制 WebContents 诊断信息',
            click: () => this.copyWebContentsDiagnostics(),
          },
          {
            label: '重新加载当前 BrowserView',
            click: () => this.reloadActiveBrowserViewForDiagnostics(),
          },
          {
            label: '分离当前 BrowserView',
            click: () => this.detachActiveBrowserViewForDiagnostics(),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
        label: '帮助',
        submenu: [
        {
          label: '打开 rdcli.ai',
          click: () => void this.actions.openCloudDashboard(),
        },
          {
            label: '复制诊断信息',
            click: () => void this.actions.copyDiagnostics(),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.buildTrayMenu();
  }

  buildTrayMenu() {
    if (!this.tray) return;
    const cloudState = this.getCloudState();
    const localState = this.getLocalState();

    const template = [
      {
        label: '本地',
        submenu: [
          {
            label: localState.localServerRunning ? '在 rdCLI 中打开本地' : '在 rdCLI 中启动本地',
            click: () => void this.actions.openLocalInDesktop().catch((error) => this.actions.showError('无法打开本地 rdCLI', error)),
          },
          {
            label: '在浏览器中打开本地',
            click: () => void this.actions.openLocalWebUi().catch((error) => this.actions.showError('无法打开本地 Web 界面', error)),
          },
          {
            label: '复制本地地址',
            click: () => void this.actions.copyLocalWebUrl().catch((error) => this.actions.showError('无法复制本地 Web 地址', error)),
          },
        ],
      },
      {
        label: '云端环境',
        submenu: this.buildTrayEnvironmentSection(),
      },
      { type: 'separator' },
      {
        label: cloudState.account?.email ? `已连接：${cloudState.account.email}` : '登录',
        click: () => void this.actions.connectCloudAccount().catch((error) => this.actions.showError('无法连接 rdCLI 账号', error)),
      },
      {
        label: '退出 rdCLI 账号',
        click: () => void this.actions.clearCloudAccount().catch((error) => this.actions.showError('无法退出登录', error)),
        enabled: Boolean(cloudState.account?.apiKey),
      },
      { type: 'separator' },
      {
        label: `退出 ${this.appName}`,
        role: 'quit',
      },
    ];

    this.tray.setToolTip(`${this.appName}${this.actions.getActiveTarget()?.name ? ` - ${this.actions.getActiveTarget().name}` : ''}`);
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  async showDesktopSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('desktop-settings');
    return this.getDesktopState();
  }

  async showLocalSettings() {
    if (!this.mainWindow) return this.getDesktopState();
    await this.ensureSettingsWindow('local-settings');
    return this.getDesktopState();
  }

  async showActiveEnvironmentActionsMenu() {
    if (!this.mainWindow) return this.getDesktopState();
    const activeTarget = this.actions.getActiveTarget();
    if (activeTarget?.kind !== 'remote') return this.getDesktopState();

    const environment = this.getCloudState().environments.find((item) => item.id === activeTarget.id);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  async showEnvironmentActionsMenu(environmentId) {
    if (!this.mainWindow) return this.getDesktopState();
    const environment = this.getCloudState().environments.find((item) => item.id === environmentId);
    if (!environment) return this.getDesktopState();

    const menu = Menu.buildFromTemplate(this.buildEnvironmentActionsSubmenu(environment));
    menu.popup({ window: this.mainWindow });
    return this.getDesktopState();
  }

  configurePermissions() {
    const isAllowedPermission = (webContents, permission) => {
      const sourceUrl = webContents.getURL();
      const allowedPermissions = new Set(['clipboard-read', 'media', 'notifications']);
      return isAllowedPermissionOrigin(sourceUrl, this.getCloudState().controlPlaneUrl) && allowedPermissions.has(permission);
    };

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(isAllowedPermission(webContents, permission));
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      if (!webContents) return false;
      return isAllowedPermission(webContents, permission);
    });
  }

  createTray() {
    if (this.tray) return;
    this.tray = new Tray(this.getTrayImage());
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      if (this.mainWindow.isVisible()) {
        this.mainWindow.focus();
      } else {
        this.mainWindow.show();
      }
    });
    this.buildTrayMenu();
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      show: false,
      backgroundColor: '#0f172a',
      title: this.appName,
      icon: this.getWindowIconPath(),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 14 } }
        : {
            titleBarOverlay: {
              color: nativeTheme.shouldUseDarkColors ? '#111111' : '#f7f8fa',
              symbolColor: nativeTheme.shouldUseDarkColors ? '#a1a1a1' : '#5b6470',
              height: 44,
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: this.getPreloadPath(),
      },
    });

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
    });

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void this.openExternalUrl(url).catch((error) => this.actions.showError('无法打开外部链接', error));
      return { action: 'deny' };
    });

    this.mainWindow.on('resize', () => {
      this.viewHost.resizeActiveView();
      this.syncSettingsWindowBounds();
    });

    this.mainWindow.on('move', () => {
      this.syncSettingsWindowBounds();
    });

    this.mainWindow.on('closed', () => {
      this.viewHost.clear();
      this.settingsWindow = null;
      this.mainWindow = null;
      this.launcherLoaded = false;
    });

    this.buildAppMenu();
    await this.showLauncher();
  }
}
