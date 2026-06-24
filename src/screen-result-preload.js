const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenResult', {
  onUpdate: (cb) => ipcRenderer.on('screen-result:update', (_, payload) => cb(payload))
});
