const { contextBridge, ipcRenderer } = require('electron');

function isrdCLIAppOrigin(location) {
  if (location.protocol === 'file:') return true;

  if (location.protocol === 'http:') {
    return location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  }

  return location.protocol === 'https:' && (
    location.hostname === 'rdcli.ai' || location.hostname.endsWith('.rdcli.ai')
  );
}

function onDesktopStateUpdated(callback) {
  const listener = (_event, state) => callback(state);
  ipcRenderer.on('rdcli-desktop:state-updated', listener);
  return () => {
    ipcRenderer.removeListener('rdcli-desktop:state-updated', listener);
  };
}

if (isrdCLIAppOrigin(window.location)) {
  contextBridge.exposeInMainWorld('rdcliDesktopNotifications', {
    getState: () => ipcRenderer.invoke('rdcli-desktop:get-state'),
    update: (settings) => ipcRenderer.invoke('rdcli-desktop:update-desktop-notifications', settings),
    onStateUpdated: onDesktopStateUpdated,
  });
}

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('rdcliDesktop', {
    connectCloud: () => ipcRenderer.invoke('rdcli-desktop:connect-cloud'),
    disconnectCloud: () => ipcRenderer.invoke('rdcli-desktop:disconnect-cloud'),
    copyDiagnostics: () => ipcRenderer.invoke('rdcli-desktop:copy-diagnostics'),
    copyLocalWebUrl: () => ipcRenderer.invoke('rdcli-desktop:copy-local-web-url'),
    getState: () => ipcRenderer.invoke('rdcli-desktop:get-state'),
    openCloudDashboard: () => ipcRenderer.invoke('rdcli-desktop:open-cloud-dashboard'),
    openEnvironment: (environmentId) => ipcRenderer.invoke('rdcli-desktop:open-environment', environmentId),
    runActiveEnvironmentAction: (action) => ipcRenderer.invoke('rdcli-desktop:run-active-environment-action', action),
    openLocal: () => ipcRenderer.invoke('rdcli-desktop:open-local'),
    openLocalWebUi: () => ipcRenderer.invoke('rdcli-desktop:open-local-web-ui'),
    refreshEnvironments: () => ipcRenderer.invoke('rdcli-desktop:refresh-environments'),
    refreshActiveTab: () => ipcRenderer.invoke('rdcli-desktop:reload-active-tab'),
    showEnvironmentPicker: () => ipcRenderer.invoke('rdcli-desktop:show-environment-picker'),
    showLauncher: () => ipcRenderer.invoke('rdcli-desktop:show-launcher'),
    showLocalSettings: () => ipcRenderer.invoke('rdcli-desktop:show-local-settings'),
    showDesktopSettings: () => ipcRenderer.invoke('rdcli-desktop:show-desktop-settings'),
    closeSettingsWindow: () => ipcRenderer.invoke('rdcli-desktop:close-settings-window'),
    showActiveEnvironmentActionsMenu: () => ipcRenderer.invoke('rdcli-desktop:show-active-environment-actions-menu'),
    showEnvironmentActionsMenu: (environmentId) => ipcRenderer.invoke('rdcli-desktop:show-environment-actions-menu', environmentId),
    switchTab: (tabId) => ipcRenderer.invoke('rdcli-desktop:switch-tab', tabId),
    closeTab: (tabId) => ipcRenderer.invoke('rdcli-desktop:close-tab', tabId),
    updateSetting: (key, value) => ipcRenderer.invoke('rdcli-desktop:update-setting', key, value),
    onStateUpdated: onDesktopStateUpdated,
    onLauncherCommand: (callback) => {
      ipcRenderer.on('rdcli-desktop:launcher-command', (_event, command) => callback(command));
    },
  });
}
