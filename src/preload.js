const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumi', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  translate: (payload) => ipcRenderer.invoke('translate', payload),
  dictionary: (word) => ipcRenderer.invoke('dictionary', word),
  setHistory: (history) => ipcRenderer.invoke('history:set', history),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  close: () => ipcRenderer.invoke('window:close'),
  openExternal: (url) => ipcRenderer.invoke('window:openExternal', url),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', cb),
  onTranslateText: (cb) => ipcRenderer.on('translate-text', (_, text) => cb(text)),
  onToggleDetail: (cb) => ipcRenderer.on('toggle-detail', cb)
});
