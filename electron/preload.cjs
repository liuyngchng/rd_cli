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
    notifyReady: () => ipcRenderer.send('rdcli-desktop:ready'),
  });
}