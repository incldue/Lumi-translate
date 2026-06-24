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
  captureTranslate: () => ipcRenderer.invoke('screen:capture-translate'),
  startScreenRealtime: () => ipcRenderer.invoke('screen:realtime-start'),
  stopScreenRealtime: () => ipcRenderer.invoke('screen:realtime-stop'),
  getScreenState: () => ipcRenderer.invoke('screen:state'),
  onFocusInput: (cb) => ipcRenderer.on('focus-input', cb),
  onTranslateText: (cb) => ipcRenderer.on('translate-text', (_, text) => cb(text)),
  onToggleDetail: (cb) => ipcRenderer.on('toggle-detail', cb),
  onScreenStatus: (cb) => ipcRenderer.on('screen-status', (_, payload) => cb(payload)),
  onScreenTranslation: (cb) => ipcRenderer.on('screen-translation', (_, payload) => cb(payload)),
  onScreenState: (cb) => ipcRenderer.on('screen-state', (_, payload) => cb(payload)),
  onCaptureCompact: (cb) => ipcRenderer.on('capture-compact', (_, compact) => cb(compact)),
  onDictionaryUpdate: (cb) => ipcRenderer.on('dictionary-update', (_, payload) => cb(payload))
});
