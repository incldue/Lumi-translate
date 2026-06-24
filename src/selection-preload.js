const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('selection', {
  done: (rect) => ipcRenderer.send('selection:done', rect),
  cancel: () => ipcRenderer.send('selection:cancel')
});
