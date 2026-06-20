const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, clipboard, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const store = new Store({
  defaults: {
    window: { width: 980, height: 680 },
    appearance: { opacity: 0.96, alwaysOnTop: false },
    translation: {
      source: 'auto',
      target: 'zh-CN',
      detailMode: true,
      timeoutMs: 9000,
      customApiUrl: ''
    },
    shortcuts: {
      toggleWindow: 'CommandOrControl+Alt+T',
      translateClipboard: 'CommandOrControl+Alt+C',
      toggleDetail: 'CommandOrControl+Shift+D'
    },
    history: []
  }
});

let mainWindow = null;
let tray = null;
let initialShown = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.lumi.translate');
}

function getAssetPath(file) {
  return path.join(__dirname, '..', 'assets', file);
}

function createWindow() {
  const size = store.get('window') || {};
  mainWindow = new BrowserWindow({
    width: size.width || 980,
    height: size.height || 680,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    roundedCorners: true,
    backgroundColor: '#00000000',
    title: 'Lumi Translate',
    icon: getAssetPath('icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setHasShadow(false);
  mainWindow.setAlwaysOnTop(!!store.get('appearance.alwaysOnTop'));

  const showInitialWindow = () => {
    if (initialShown) return;
    initialShown = true;
    showWindow();
  };
  mainWindow.webContents.once('dom-ready', showInitialWindow);
  mainWindow.once('ready-to-show', showInitialWindow);

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [width, height] = mainWindow.getSize();
    store.set('window', { width, height });
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideWindow();
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  mainWindow.webContents.send('focus-input');
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(getAssetPath('icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Lumi Translate');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { label: '翻译剪贴板', click: translateClipboardAndShow },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', toggleWindow);
}

function registerShortcut(accelerator, handler) {
  if (!accelerator) return false;
  try {
    return globalShortcut.register(accelerator, handler);
  } catch {
    return false;
  }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const shortcuts = store.get('shortcuts') || {};
  registerShortcut(shortcuts.toggleWindow || 'CommandOrControl+Alt+T', toggleWindow);
  registerShortcut(shortcuts.translateClipboard || 'CommandOrControl+Alt+C', translateClipboardAndShow);
  registerShortcut(shortcuts.toggleDetail || 'CommandOrControl+Shift+D', () => {
    showWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-detail');
    }
  });
}

function translateClipboardAndShow() {
  showWindow();
  const text = clipboard.readText();
  if (text && text.trim() && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('translate-text', text.trim());
  }
}

async function httpGetJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LumiTranslate/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function detectSource(source, text) {
  if (source && source !== 'auto') return normalizeLang(source);
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  return 'en';
}

function normalizeLang(lang) {
  if (!lang) return 'en';
  if (/^zh-CN$/i.test(lang)) return 'zh-CN';
  if (/^zh-TW$/i.test(lang)) return 'zh-TW';
  return String(lang).split('-')[0].toLowerCase();
}

function applyRuntimeConfig(patch = {}) {
  const appearance = patch.appearance || {};
  const alwaysOnTop = Object.prototype.hasOwnProperty.call(patch, 'appearance.alwaysOnTop')
    ? patch['appearance.alwaysOnTop']
    : appearance.alwaysOnTop;
  if (typeof alwaysOnTop !== 'undefined' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(!!alwaysOnTop);
  }
  if (patch.shortcuts) registerShortcuts();
}

ipcMain.handle('config:get', () => store.store);

ipcMain.handle('config:set', (_, patch) => {
  for (const [key, value] of Object.entries(patch || {})) {
    store.set(key, value);
  }
  applyRuntimeConfig(patch);
  return store.store;
});

ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('window:hide', () => hideWindow());
ipcMain.handle('window:close', () => hideWindow());
ipcMain.handle('window:openExternal', (_, url) => shell.openExternal(url));
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_, text) => clipboard.writeText(String(text || '')));

ipcMain.handle('translate', async (_, payload) => {
  const cfg = store.get('translation') || {};
  const text = String(payload.text || '').trim();
  if (!text) return { text: '', source: cfg.source, target: cfg.target };

  const source = detectSource(payload.source || cfg.source, text);
  const target = normalizeLang(payload.target || cfg.target);
  let url;
  if (cfg.customApiUrl) {
    url = cfg.customApiUrl
      .replaceAll('{text}', encodeURIComponent(text))
      .replaceAll('{source}', encodeURIComponent(source))
      .replaceAll('{target}', encodeURIComponent(target));
  } else {
    url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${source}|${target}`)}`;
  }

  const json = await httpGetJson(url, cfg.timeoutMs || 9000);
  const translated = json?.responseData?.translatedText || json?.translatedText || '';
  if (!translated) throw new Error(json?.responseDetails || 'No translation result');
  return { text: translated, source, target };
});

ipcMain.handle('dictionary', async (_, word) => {
  const clean = String(word || '').trim();
  if (!/^[A-Za-z][A-Za-z'-]{0,63}$/.test(clean)) return null;
  const cfg = store.get('translation') || {};
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(clean)}`;
  const data = await httpGetJson(url, cfg.timeoutMs || 9000);
  if (!Array.isArray(data) || !data[0]) return null;
  return data[0];
});

ipcMain.handle('history:set', (_, history) => {
  store.set('history', Array.isArray(history) ? history.slice(0, 30) : []);
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();
});

app.on('second-instance', () => showWindow());
app.on('window-all-closed', () => {
  // Tray app: keep process alive so global shortcuts can show the window again.
});
app.on('will-quit', () => globalShortcut.unregisterAll());
