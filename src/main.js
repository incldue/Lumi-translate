const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  shell,
  desktopCapturer,
  screen: electronScreen
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Store = require('electron-store');

const DEFAULT_SHORTCUTS = Object.freeze({
  toggleWindow: 'CommandOrControl+Alt+T',
  translateClipboard: 'CommandOrControl+Alt+C',
  toggleDetail: 'CommandOrControl+Shift+D',
  captureScreen: 'CommandOrControl+Alt+S',
  realtimeScreen: 'CommandOrControl+Alt+Shift+R'
});
const OLD_DEFAULT_REALTIME_SCREEN_SHORTCUT = 'CommandOrControl+Alt+R';

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
    shortcuts: { ...DEFAULT_SHORTCUTS },
    screen: {
      intervalMs: 1600,
      videoMode: true,
      ocrScale: 1.25,
      stableTicks: 2
    },
    history: []
  }
});

migrateShortcutDefaults();

let mainWindow = null;
let tray = null;
let initialShown = false;
let selectionWindow = null;
let screenResultWindow = null;
let screenResultUserMoved = false;
let screenResultApplyingBounds = false;
let screenResultSelectionKey = '';
let activeSelection = null;
let realtimeSession = null;
let ocrScriptPath = null;
let compactWindowState = null;
const screenTranslationCache = new Map();
const tesseractWorkers = new Map();
const ocrResultCache = new Map();
let paddleOcr = null;
let paddleOcrLoading = null;
let tesseractCreateWorker = null;
let tesseractLoading = null;
let tesseractCleanupTimer = null;
let ocrWarmupStarted = false;

const FRAME_FINGERPRINT_SIZE = { width: 32, height: 18 };

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
    warmupOcrEngine();
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

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function animateWindowBounds(win, targetBounds, duration = 220) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve();
    const startBounds = win.getBounds();
    const startedAt = Date.now();
    const tick = () => {
      if (!win || win.isDestroyed()) return resolve();
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const eased = easeInOutCubic(progress);
      const next = {
        x: Math.round(startBounds.x + (targetBounds.x - startBounds.x) * eased),
        y: Math.round(startBounds.y + (targetBounds.y - startBounds.y) * eased),
        width: Math.round(startBounds.width + (targetBounds.width - startBounds.width) * eased),
        height: Math.round(startBounds.height + (targetBounds.height - startBounds.height) * eased)
      };
      win.setBounds(next, false);
      if (progress < 1) setTimeout(tick, 16);
      else resolve();
    };
    tick();
  });
}

function compactBoundsForWindow() {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? electronScreen.getDisplayMatching(mainWindow.getBounds())
    : electronScreen.getPrimaryDisplay();
  const area = display.workArea || display.bounds;
  const width = 360;
  const height = 124;
  return {
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + 24),
    width,
    height
  };
}

async function compactMainWindowForCapture() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!compactWindowState) {
    compactWindowState = {
      bounds: mainWindow.getBounds(),
      alwaysOnTop: mainWindow.isAlwaysOnTop()
    };
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.showInactive();
  mainWindow.setMinimumSize(320, 96);
  mainWindow.setAlwaysOnTop(true, 'floating');
  sendToRenderer('capture-compact', true);
  await animateWindowBounds(mainWindow, compactBoundsForWindow(), 240);
}

async function restoreMainWindowAfterCapture(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !compactWindowState) return;
  const showAfterRestore = options.show !== false;
  const animate = options.animate !== false;
  const state = compactWindowState;
  compactWindowState = null;
  if (showAfterRestore || animate) mainWindow.showInactive();
  if (animate) {
    await animateWindowBounds(mainWindow, state.bounds, 260);
  } else {
    mainWindow.setBounds(state.bounds, false);
  }
  mainWindow.setMinimumSize(820, 560);
  mainWindow.setAlwaysOnTop(!!store.get('appearance.alwaysOnTop') || !!state.alwaysOnTop);
  sendToRenderer('capture-compact', false);
  if (showAfterRestore) showWindow();
  else hideWindow();
}

function createTray() {
  const icon = nativeImage.createFromPath(getAssetPath('icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('Lumi Translate');
  refreshTrayMenu();
  tray.on('double-click', toggleWindow);
}

function refreshTrayMenu() {
  if (!tray) return;
  const realtimeActive = !!realtimeSession?.active;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { label: '翻译剪贴板', click: translateClipboardAndShow },
    { label: '截图 OCR 翻译', click: () => startScreenAreaTranslation(false) },
    {
      label: realtimeActive ? '停止屏幕实时翻译' : '屏幕实时翻译',
      click: () => (realtimeActive ? stopScreenRealtime() : startScreenAreaTranslation(true))
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
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
  registerShortcut(shortcuts.toggleWindow || DEFAULT_SHORTCUTS.toggleWindow, toggleWindow);
  registerShortcut(shortcuts.translateClipboard || DEFAULT_SHORTCUTS.translateClipboard, translateClipboardAndShow);
  registerShortcut(shortcuts.captureScreen || DEFAULT_SHORTCUTS.captureScreen, () => startScreenAreaTranslation(false));
  registerShortcut(shortcuts.realtimeScreen || DEFAULT_SHORTCUTS.realtimeScreen, () => {
    if (realtimeSession?.active) stopScreenRealtime();
    else startScreenAreaTranslation(true);
  });
  registerShortcut(shortcuts.toggleDetail || DEFAULT_SHORTCUTS.toggleDetail, () => {
    showWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-detail');
    }
  });
}

function migrateShortcutDefaults() {
  const shortcuts = store.get('shortcuts') || {};
  if (!shortcuts.realtimeScreen || shortcuts.realtimeScreen === OLD_DEFAULT_REALTIME_SCREEN_SHORTCUT) {
    store.set('shortcuts.realtimeScreen', DEFAULT_SHORTCUTS.realtimeScreen);
  }
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

async function httpGetText(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 LumiTranslate/1.0',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
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

function stripHtml(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueList(items) {
  const seen = new Set();
  return items.map(item => String(item || '').trim()).filter(item => {
    if (!item || seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function pickMatches(html, regex, limit = 5) {
  const out = [];
  for (const match of html.matchAll(regex)) {
    const text = stripHtml(match[1] || '');
    if (text) out.push(text);
    if (out.length >= limit) break;
  }
  return uniqueList(out);
}

function dictionaryApiEntryToSource(entry) {
  if (!entry) return null;
  const phonetic = entry.phonetic || entry.phonetics?.find(x => x.text)?.text || '';
  const meanings = [];
  for (const meaning of entry.meanings || []) {
    const definitions = [];
    for (const def of (meaning.definitions || []).slice(0, 3)) {
      definitions.push({
        definition: def.definition || '',
        example: def.example || ''
      });
    }
    if (definitions.length) {
      meanings.push({ partOfSpeech: meaning.partOfSpeech || '', definitions });
    }
  }
  return {
    source: 'DictionaryAPI',
    word: entry.word || '',
    phonetic,
    meanings
  };
}

async function lookupDictionaryApi(word, timeoutMs) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const data = await httpGetJson(url, timeoutMs);
  if (!Array.isArray(data) || !data[0]) return null;
  return dictionaryApiEntryToSource(data[0]);
}

async function lookupYoudao(word, timeoutMs) {
  const url = `https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&q=${encodeURIComponent(word)}`;
  const data = await httpGetJson(url, timeoutMs);
  const entries = data?.data?.entries || [];
  const hit = entries.find(item => String(item.entry || '').toLowerCase() === word.toLowerCase()) || entries[0];
  if (!hit) return null;
  return {
    source: '网易有道',
    word: hit.entry || word,
    phonetic: '',
    meanings: [{
      partOfSpeech: '',
      definitions: uniqueList(String(hit.explain || '').split(/[；;]/)).slice(0, 5).map(x => ({ definition: x }))
    }]
  };
}

async function lookupCambridge(word, timeoutMs) {
  const url = `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(word)}`;
  const html = await httpGetText(url, timeoutMs);
  const phonetic = pickMatches(html, /<span[^>]+class="[^"]*\bipa\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 1)[0] || '';
  const defs = pickMatches(html, /<div[^>]+class="[^"]*\bdef\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, 4);
  const trans = pickMatches(html, /<span[^>]+class="[^"]*\btrans\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 6);
  const examples = pickMatches(html, /<span[^>]+class="[^"]*\beg\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 3);
  const definitions = [];
  const max = Math.max(defs.length, trans.length);
  for (let i = 0; i < max; i += 1) {
    definitions.push({
      definition: [defs[i], trans[i]].filter(Boolean).join(' / '),
      example: examples[i] || ''
    });
  }
  if (!definitions.length) return null;
  return {
    source: '剑桥词典',
    word,
    phonetic,
    meanings: [{ partOfSpeech: '', definitions }]
  };
}

async function lookupOxford(word, timeoutMs) {
  const url = `https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(word)}_1`;
  const html = await httpGetText(url, timeoutMs);
  const phonetic = pickMatches(html, /<span[^>]+class="[^"]*\bphon\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 1)[0] || '';
  const defs = pickMatches(html, /<span[^>]+class="[^"]*\bdef\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 5);
  const examples = pickMatches(html, /<span[^>]+class="[^"]*\bx\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, 4);
  if (!defs.length) return null;
  return {
    source: '牛津词典',
    word,
    phonetic,
    meanings: [{
      partOfSpeech: '',
      definitions: defs.map((definition, index) => ({ definition, example: examples[index] || '' }))
    }]
  };
}

function mergeDictionarySources(word, sources) {
  const available = sources.filter(Boolean);
  if (!available.length) return null;
  return {
    word: available.find(x => x.word)?.word || word,
    phonetic: available.find(x => x.phonetic)?.phonetic || '',
    sources: available
  };
}

async function translateText(payload = {}) {
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
    url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text)
      + '&langpair=' + encodeURIComponent(source + '|' + target);
  }

  const json = await httpGetJson(url, cfg.timeoutMs || 9000);
  const translated = json?.responseData?.translatedText || json?.translatedText || '';
  if (!translated) throw new Error(json?.responseDetails || 'No translation result');
  return { text: translated, source, target };
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendScreenState() {
  sendToRenderer('screen-state', { realtimeActive: !!realtimeSession?.active });
}

function setScreenStatus(text, error = false) {
  sendToRenderer('screen-status', {
    text,
    error: !!error,
    realtimeActive: !!realtimeSession?.active
  });
}

function toErrorMessage(err) {
  const msg = err?.message || String(err || '未知错误');
  if (/abort|timeout/i.test(msg)) return '网络或 OCR 超时';
  if (/traineddata|fetch|download|network/i.test(msg)) return '增强 OCR 模型下载失败，请检查网络后重试';
  return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '').trim();
}

function getVirtualScreenBounds() {
  const displays = electronScreen.getAllDisplays();
  const left = Math.min(...displays.map(display => display.bounds.x));
  const top = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizeSelectionRect(rect, origin) {
  if (!rect) return null;
  const width = Math.round(Math.abs(Number(rect.width) || 0));
  const height = Math.round(Math.abs(Number(rect.height) || 0));
  if (width < 8 || height < 8) return null;
  return {
    x: Math.round(origin.x + Number(rect.x || 0)),
    y: Math.round(origin.y + Number(rect.y || 0)),
    width,
    height
  };
}

function requestScreenSelection(realtime = false) {
  if (activeSelection) activeSelection.finish(null);

  return new Promise((resolve) => {
    const bounds = getVirtualScreenBounds();
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'selection-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    selectionWindow = win;
    let done = false;
    const finish = (rect) => {
      if (done) return;
      done = true;
      const winBounds = win.isDestroyed() ? bounds : win.getBounds();
      const selection = normalizeSelectionRect(rect, winBounds);
      activeSelection = null;
      selectionWindow = null;
      resolve(selection);
      if (!win.isDestroyed()) win.close();
    };

    activeSelection = { webContents: win.webContents, finish };
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, 'selection.html'), {
      query: { mode: realtime ? 'realtime' : 'capture' }
    });
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      if (!done) finish(null);
    });
  });
}

function getDisplayForBounds(bounds) {
  const point = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  };
  return electronScreen.getDisplayNearestPoint(point) || electronScreen.getPrimaryDisplay();
}

function intersectBounds(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1)
  };
}

function makeFrameFingerprint(image) {
  try {
    const small = image.resize({ ...FRAME_FINGERPRINT_SIZE, quality: 'good' });
    const { width, height } = small.getSize();
    const bitmap = small.toBitmap();
    const luma = Buffer.alloc(width * height);
    for (let i = 0, j = 0; j < luma.length && i + 2 < bitmap.length; i += 4, j += 1) {
      const b = bitmap[i] || 0;
      const g = bitmap[i + 1] || 0;
      const r = bitmap[i + 2] || 0;
      luma[j] = Math.round((r * 0.299) + (g * 0.587) + (b * 0.114));
    }
    return {
      width,
      height,
      luma,
      hash: crypto.createHash('sha1').update(luma).digest('hex')
    };
  } catch {
    return null;
  }
}

function frameDifference(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height || !a.luma || !b.luma) {
    return Number.POSITIVE_INFINITY;
  }
  const length = Math.min(a.luma.length, b.luma.length);
  if (!length) return Number.POSITIVE_INFINITY;
  let diff = 0;
  for (let i = 0; i < length; i += 1) {
    diff += Math.abs(a.luma[i] - b.luma[i]);
  }
  return diff / (length * 255);
}

function resizeForOcr(image, scale = 1) {
  const safeScale = clamp(Number(scale) || 1, 1, 3);
  if (safeScale <= 1.01) return image;
  const size = image.getSize();
  let width = Math.round(size.width * safeScale);
  let height = Math.round(size.height * safeScale);
  const maxPixels = 850000;
  const pixels = width * height;
  if (pixels > maxPixels) {
    const ratio = Math.sqrt(maxPixels / pixels);
    width = Math.max(size.width, Math.round(width * ratio));
    height = Math.max(size.height, Math.round(height * ratio));
  }
  if (width <= size.width && height <= size.height) return image;
  return image.resize({ width, height, quality: 'best' });
}

function enhanceForSubtitleOcr(image) {
  try {
    const size = image.getSize();
    const bitmap = Buffer.from(image.toBitmap());
    const pixels = Math.floor(bitmap.length / 4);
    const histogram = new Array(256).fill(0);
    const lumas = new Uint8Array(pixels);

    for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
      const b = bitmap[i] || 0;
      const g = bitmap[i + 1] || 0;
      const r = bitmap[i + 2] || 0;
      const luma = Math.round((r * 0.299) + (g * 0.587) + (b * 0.114));
      lumas[j] = luma;
      histogram[luma] += 1;
    }

    const percentile = (ratio) => {
      const target = Math.max(1, Math.floor(pixels * ratio));
      let seen = 0;
      for (let value = 0; value < histogram.length; value += 1) {
        seen += histogram[value];
        if (seen >= target) return value;
      }
      return 255;
    };

    const low = percentile(0.05);
    const high = Math.max(low + 32, percentile(0.95));

    for (let i = 0, j = 0; j < pixels; i += 4, j += 1) {
      const normalized = clamp((lumas[j] - low) / (high - low), 0, 1);
      let v = Math.round((normalized - 0.5) * 1.9 * 255 + 128);
      v = clamp(v, 0, 255);
      bitmap[i] = v;
      bitmap[i + 1] = v;
      bitmap[i + 2] = v;
      bitmap[i + 3] = 255;
    }

    return nativeImage.createFromBitmap(bitmap, {
      width: size.width,
      height: size.height,
      scaleFactor: 1
    });
  } catch {
    return image;
  }
}

function buildEnhancedSubtitlePng(pngBuffer) {
  try {
    const image = nativeImage.createFromBuffer(pngBuffer);
    if (!image || image.isEmpty()) return pngBuffer;
    return enhanceForSubtitleOcr(image).toPNG();
  } catch {
    return pngBuffer;
  }
}

async function captureRegionAsPng(bounds, options = {}) {
  const display = getDisplayForBounds(bounds);
  const displayBounds = display.bounds;
  const scaleFactor = display.scaleFactor || 1;
  const thumbnailSize = {
    width: Math.max(1, Math.round(displayBounds.width * scaleFactor)),
    height: Math.max(1, Math.round(displayBounds.height * scaleFactor))
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  let source = sources.find(item => String(item.display_id || '') === String(display.id));
  if (!source) source = sources.find(item => item.thumbnail && !item.thumbnail.isEmpty()) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('无法获取屏幕截图');
  }

  const image = source.thumbnail;
  const size = image.getSize();
  const scaleX = size.width / displayBounds.width;
  const scaleY = size.height / displayBounds.height;
  const clipped = intersectBounds(bounds, displayBounds);
  if (clipped.width < 4 || clipped.height < 4) {
    throw new Error('选区不在当前屏幕内');
  }

  const cropRect = {
    x: Math.max(0, Math.round((clipped.x - displayBounds.x) * scaleX)),
    y: Math.max(0, Math.round((clipped.y - displayBounds.y) * scaleY)),
    width: Math.max(1, Math.round(clipped.width * scaleX)),
    height: Math.max(1, Math.round(clipped.height * scaleY))
  };
  cropRect.width = Math.min(cropRect.width, size.width - cropRect.x);
  cropRect.height = Math.min(cropRect.height, size.height - cropRect.y);
  const cropped = image.crop(cropRect);
  const ocrImage = resizeForOcr(cropped, options.ocrScale);
  const result = {
    png: ocrImage.toPNG(),
    fingerprint: makeFrameFingerprint(cropped),
    sourceSize: cropped.getSize(),
    ocrSize: ocrImage.getSize()
  };
  if (options.enhance) {
    result.enhancedPng = enhanceForSubtitleOcr(ocrImage).toPNG();
  }
  return options.withMeta ? result : result.png;
}

function windowsOcrLanguage(lang) {
  if (!lang || lang === 'auto') return 'auto';
  const normalized = normalizeLang(lang);
  const map = {
    'zh-CN': 'zh-Hans-CN',
    'zh-TW': 'zh-Hant-TW',
    en: 'en-US',
    ja: 'ja-JP',
    ko: 'ko-KR',
    fr: 'fr-FR',
    de: 'de-DE',
    es: 'es-ES',
    ru: 'ru-RU',
    it: 'it-IT',
    pt: 'pt-BR',
    ar: 'ar-SA',
    th: 'th-TH',
    vi: 'vi-VN',
    id: 'id-ID'
  };
  return map[normalized] || 'auto';
}

function fixCommonOcrWordConfusions(word) {
  const raw = String(word || '').trim();
  if (!/^[A-Za-z][A-Za-z'-]{0,63}$/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  const map = {
    heilo: 'hello',
    heiio: 'hello',
    he11o: 'hello',
    heilo: 'hello',
    wor1d: 'world',
    worid: 'world',
    transiation: 'translation',
    transiate: 'translate',
    ianguage: 'language',
    appiication: 'application'
  };
  const normalized = lower.replace(/1/g, 'l').replace(/\|/g, 'l');
  return map[lower] || map[normalized] || raw;
}

async function ensureOcrScript() {
  if (ocrScriptPath) return ocrScriptPath;
  const dir = path.join(app.getPath('userData'), 'ocr');
  await fs.mkdir(dir, { recursive: true });
  ocrScriptPath = path.join(dir, 'win-ocr.ps1');
  const bundledScript = await fs.readFile(path.join(__dirname, 'win-ocr.ps1'), 'utf8');
  await fs.writeFile(ocrScriptPath, bundledScript, 'utf8');
  return ocrScriptPath;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('OCR timeout'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', finish);
    child.on('close', code => {
      if (code === 0) finish(null, stdout);
      else finish(new Error((stderr || stdout || 'OCR failed').trim()));
    });
  });
}

async function runWindowsOcr(pngBuffer) {
  if (process.platform !== 'win32') {
    throw new Error('当前 OCR 实现依赖 Windows 10/11 内置 OCR');
  }
  const imagePath = path.join(os.tmpdir(), 'lumi-screen-ocr-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
  await fs.writeFile(imagePath, pngBuffer);
  try {
    const scriptPath = await ensureOcrScript();
    const cfg = store.get('translation') || {};
    const lang = windowsOcrLanguage(cfg.source || 'auto');
    const timeoutMs = Math.max(12000, Math.min(45000, Number(cfg.timeoutMs || 9000) * 2));
    return await runProcess('powershell.exe', [
      '-NoProfile',
      '-NoLogo',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-ImagePath',
      imagePath,
      '-Language',
      lang
    ], timeoutMs);
  } finally {
    fs.unlink(imagePath).catch(() => {});
  }
}

async function getPaddleOcr() {
  if (paddleOcr) return paddleOcr;
  if (paddleOcrLoading) return paddleOcrLoading;
  paddleOcrLoading = (async () => {
    const mod = await import('@gutenye/ocr-node');
    const Ocr = mod.default || mod;
    const ocr = await Ocr.create({
      onnxOptions: {
        executionProviders: ['cpu']
      }
    });
    paddleOcr = ocr;
    return ocr;
  })().finally(() => {
    paddleOcrLoading = null;
  });
  return paddleOcrLoading;
}

function getOcrItemBox(item) {
  const points = Array.isArray(item?.box) ? item.box : null;
  if (points?.length) {
    const xs = points.map(point => Number(point?.[0] ?? point?.x ?? 0));
    const ys = points.map(point => Number(point?.[1] ?? point?.y ?? 0));
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  const frame = item?.frame || item?.bounds || item?.boundingBox || {};
  const left = Number(frame.left ?? frame.x ?? 0);
  const top = Number(frame.top ?? frame.y ?? 0);
  const width = Number(frame.width ?? 0);
  const height = Number(frame.height ?? 0);
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function shouldJoinWithoutSpace(previous, next) {
  if (!previous || !next) return true;
  if (/[\s([{《“‘]$/.test(previous)) return true;
  if (/^[\s,.;:!?，。！？、；：）\]】》”’]/.test(next)) return true;
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/.test(previous)
    && /^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(next)) return true;
  return false;
}

function joinOcrFragments(fragments) {
  return fragments.reduce((line, fragment) => {
    if (!line) return fragment;
    return line + (shouldJoinWithoutSpace(line, fragment) ? '' : ' ') + fragment;
  }, '');
}

function normalizeDetectedOcrLines(lines) {
  const items = (Array.isArray(lines) ? lines : [])
    .map(line => {
      const text = String(line?.text || '').trim();
      const confidence = Number(line?.confidence ?? line?.score ?? line?.mean ?? line?.probability ?? 1);
      return {
        text,
        confidence,
        box: getOcrItemBox(line)
      };
    })
    .filter(item => item.text && (!Number.isFinite(item.confidence) || item.confidence >= 0.35))
    .sort((a, b) => {
      if (Math.abs(a.box.top - b.box.top) > 12) return a.box.top - b.box.top;
      return a.box.left - b.box.left;
    });

  const groups = [];
  for (const item of items) {
    const mid = item.box.top + (item.box.height || 0) / 2;
    const height = item.box.height || 18;
    let group = groups.find(candidate => Math.abs(candidate.mid - mid) <= Math.max(10, Math.max(candidate.height, height) * 0.72));
    if (!group) {
      group = { mid, height, items: [] };
      groups.push(group);
    }
    group.items.push(item);
    group.height = Math.max(group.height, height);
    group.mid = group.items.reduce((sum, value) => sum + value.box.top + (value.box.height || 0) / 2, 0) / group.items.length;
  }

  return groups
    .sort((a, b) => a.mid - b.mid)
    .map(group => joinOcrFragments(group.items.sort((a, b) => a.box.left - b.box.left).map(item => item.text)))
    .filter(Boolean)
    .join('\n');
}

async function runPaddleOcr(pngBuffer) {
  const imagePath = path.join(os.tmpdir(), 'lumi-paddle-ocr-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
  await fs.writeFile(imagePath, pngBuffer);
  try {
    const ocr = await getPaddleOcr();
    const lines = await ocr.detect(imagePath);
    return normalizeDetectedOcrLines(lines);
  } finally {
    fs.unlink(imagePath).catch(() => {});
  }
}

function tesseractLanguage(lang) {
  const normalized = normalizeLang(lang);
  if (normalized === 'zh-TW') return 'chi_tra+eng';
  if (normalized === 'zh-CN' || lang === 'auto' || !lang) return 'chi_sim+eng';
  const map = {
    en: 'eng',
    ja: 'jpn+eng',
    ko: 'kor+eng',
    ru: 'rus+eng',
    fr: 'fra+eng',
    de: 'deu+eng',
    es: 'spa+eng',
    it: 'ita+eng',
    pt: 'por+eng',
    ar: 'ara+eng',
    th: 'tha+eng',
    vi: 'vie+eng',
    id: 'ind+eng'
  };
  return map[normalized] || 'chi_sim+eng';
}

async function getTesseractWorker(lang) {
  if (tesseractWorkers.has(lang)) return tesseractWorkers.get(lang);
  if (!tesseractCreateWorker) {
    if (!tesseractLoading) {
      tesseractLoading = import('tesseract.js').then(mod => {
        tesseractCreateWorker = mod.createWorker;
        return tesseractCreateWorker;
      }).finally(() => {
        tesseractLoading = null;
      });
    }
    await tesseractLoading;
  }
  const cachePath = path.join(app.getPath('userData'), 'tessdata');
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await tesseractCreateWorker(lang, 1, {
    cachePath,
    logger: (message) => {
      if (!message?.status) return;
      if (!/loading language|recognizing text/i.test(message.status)) return;
      const progress = Math.round((message.progress || 0) * 100);
      setScreenStatus('增强 OCR：' + message.status + (progress ? ' ' + progress + '%' : ''));
    }
  });
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    preserve_interword_spaces: '1'
  });
  tesseractWorkers.set(lang, worker);
  return worker;
}

async function runTesseractOcr(pngBuffer) {
  const cfg = store.get('translation') || {};
  const lang = tesseractLanguage(cfg.source || 'auto');
  const worker = await getTesseractWorker(lang);
  const { data } = await worker.recognize(pngBuffer);
  return data?.text || '';
}

function shouldUseEnhancedOcr(windowsText) {
  const cfg = store.get('translation') || {};
  const source = cfg.source || 'auto';
  const normalized = normalizeLang(source);
  const compact = cleanOcrText(windowsText).replace(/\s/g, '');
  const cjkCount = (compact.match(/[\u4e00-\u9fff]/g) || []).length;
  if (!compact) return true;
  if (normalized === 'zh-CN' || normalized === 'zh-TW') return true;
  if (source === 'auto' && (cjkCount > 0 || compact.length < 8)) return true;
  return false;
}

function isMostlyNoise(text) {
  const clean = cleanOcrText(text);
  if (!clean) return true;
  const signal = (clean.match(/[\p{L}\p{N}\u4e00-\u9fff]/gu) || []).length;
  const replacement = (clean.match(/[�□]/g) || []).length;
  if (signal < 2) return true;
  if (replacement > 0 && replacement >= signal / 2) return true;
  if (clean.length > 8 && signal / clean.length < 0.35) return true;
  return false;
}

function scoreOcrText(text) {
  const clean = cleanOcrText(text);
  if (!clean) return 0;
  const cjk = (clean.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (clean.match(/[A-Za-z]/g) || []).length;
  const digits = (clean.match(/\d/g) || []).length;
  const bad = (clean.match(/[�□]/g) || []).length;
  const punctuation = (clean.match(/[,.!?;:，。！？、；：]/g) || []).length;
  const lines = clean.split('\n').filter(Boolean).length;
  return clean.length + cjk * 6 + latin + digits + punctuation * 0.3 + lines - bad * 12;
}

function chooseBetterOcrText(current, candidate) {
  const a = cleanOcrText(current);
  const b = cleanOcrText(candidate);
  if (!b) return a;
  if (!a) return b;
  return scoreOcrText(b) >= scoreOcrText(a) ? b : a;
}

function makeOcrCacheKey(pngBuffer) {
  const cfg = store.get('translation') || {};
  const source = cfg.source || 'auto';
  return source + '|' + crypto.createHash('sha1').update(pngBuffer).digest('hex');
}

function rememberOcrResult(key, text) {
  ocrResultCache.set(key, text);
  if (ocrResultCache.size > 60) {
    ocrResultCache.delete(ocrResultCache.keys().next().value);
  }
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[|｜]{2,}/g, '|')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map(line => line.trim().replace(/\s+([,.!?;:，。！？、；：])/g, '$1'))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function rememberScreenTranslation(key, value) {
  screenTranslationCache.set(key, value);
  if (screenTranslationCache.size > 100) {
    screenTranslationCache.delete(screenTranslationCache.keys().next().value);
  }
}

async function translateOcrText(text) {
  const cfg = store.get('translation') || {};
  const cacheKey = (cfg.source || 'auto') + '|' + (cfg.target || 'zh-CN') + '|' + text;
  if (screenTranslationCache.has(cacheKey)) return screenTranslationCache.get(cacheKey);
  const result = await translateText({ text, source: cfg.source, target: cfg.target });
  rememberScreenTranslation(cacheKey, result.text);
  return result.text;
}

function normalizeSubtitleTextForCompare(text) {
  return cleanOcrText(text)
    .toLowerCase()
    .replace(/[“”‘’]/g, '"')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, '');
}

function similarityRatio(a, b) {
  const left = normalizeSubtitleTextForCompare(a);
  const right = normalizeSubtitleTextForCompare(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLen = Math.max(left.length, right.length);
  const minLen = Math.min(left.length, right.length);
  if (minLen / maxLen < 0.55) return 0;
  const grams = (value) => {
    if (value.length < 2) return new Map([[value, 1]]);
    const map = new Map();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const aGrams = grams(left);
  const bGrams = grams(right);
  let intersection = 0;
  let total = 0;
  for (const count of aGrams.values()) total += count;
  for (const count of bGrams.values()) total += count;
  for (const [gram, count] of aGrams) {
    intersection += Math.min(count, bGrams.get(gram) || 0);
  }
  return total ? (2 * intersection) / total : 0;
}

function isSameSubtitle(a, b) {
  const left = normalizeSubtitleTextForCompare(a);
  const right = normalizeSubtitleTextForCompare(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return similarityRatio(left, right) >= 0.88;
}

function buildScreenPayload(bounds, sourceText, translatedText, status, realtime, extra = {}) {
  return {
    bounds,
    sourceText: sourceText || '',
    translatedText: translatedText || '',
    status,
    realtime: !!realtime,
    ...extra
  };
}

function updateRealtimeLastResult(session, payload) {
  if (!session || !payload?.sourceText) return;
  session.lastSourceText = payload.sourceText;
  session.lastTranslatedText = payload.translatedText || session.lastTranslatedText || '';
  session.lastStatus = payload.status || session.lastStatus || '';
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getScreenResultBounds(selectionBounds) {
  const display = getDisplayForBounds(selectionBounds);
  const area = display.workArea || display.bounds;
  const width = Math.round(Math.min(Math.max(selectionBounds.width, 360), Math.min(720, area.width - 32)));
  const height = 188;
  const x = Math.round(clamp(selectionBounds.x, area.x + 16, area.x + area.width - width - 16));
  let y = Math.round(selectionBounds.y + selectionBounds.height + 12);
  if (y + height > area.y + area.height - 16) y = Math.round(selectionBounds.y - height - 12);
  y = Math.round(clamp(y, area.y + 16, area.y + area.height - height - 16));
  return { x, y, width, height };
}

function screenBoundsKey(bounds) {
  if (!bounds) return '';
  return [bounds.x, bounds.y, bounds.width, bounds.height].map((value) => Math.round(Number(value) || 0)).join(',');
}

function applyScreenResultBounds(bounds) {
  if (!screenResultWindow || screenResultWindow.isDestroyed()) return;
  screenResultApplyingBounds = true;
  screenResultWindow.setBounds(bounds, false);
  setTimeout(() => {
    screenResultApplyingBounds = false;
  }, 80);
}

function updateScreenResultWindow(payload) {
  if (!payload?.bounds) return;
  const bounds = getScreenResultBounds(payload.bounds);
  const selectionKey = screenBoundsKey(payload.bounds);
  if (!screenResultWindow || screenResultWindow.isDestroyed()) {
    screenResultSelectionKey = selectionKey;
    screenResultUserMoved = false;
    screenResultApplyingBounds = true;
    screenResultWindow = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'screen-result-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    screenResultWindow.setAlwaysOnTop(true, 'screen-saver');
    screenResultWindow.loadFile(path.join(__dirname, 'screen-result.html'));
    screenResultWindow.once('ready-to-show', () => {
      if (screenResultWindow && !screenResultWindow.isDestroyed()) screenResultWindow.showInactive();
    });
    const markUserMoved = () => {
      if (!screenResultApplyingBounds) screenResultUserMoved = true;
    };
    screenResultWindow.on('move', markUserMoved);
    screenResultWindow.on('moved', markUserMoved);
    screenResultWindow.on('closed', () => {
      screenResultWindow = null;
      screenResultUserMoved = false;
      screenResultApplyingBounds = false;
      screenResultSelectionKey = '';
    });
    setTimeout(() => {
      screenResultApplyingBounds = false;
    }, 120);
  } else {
    if (selectionKey !== screenResultSelectionKey) {
      screenResultSelectionKey = selectionKey;
      screenResultUserMoved = false;
    }
    if (!screenResultUserMoved) {
      applyScreenResultBounds(bounds);
    }
  }

  const send = () => {
    if (screenResultWindow && !screenResultWindow.isDestroyed()) {
      screenResultWindow.webContents.send('screen-result:update', payload);
    }
  };
  if (screenResultWindow.webContents.isLoading()) {
    screenResultWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function closeScreenResultWindow() {
  if (screenResultWindow && !screenResultWindow.isDestroyed()) {
    screenResultWindow.close();
  }
  screenResultWindow = null;
  screenResultUserMoved = false;
  screenResultApplyingBounds = false;
  screenResultSelectionKey = '';
}

async function processScreenTranslation(bounds, options = {}) {
  const realtime = !!options.realtime;
  const session = options.session || null;
  const screenCfg = store.get('screen') || {};
  const videoMode = realtime && screenCfg.videoMode !== false;
  const ocrScale = videoMode ? (Number(screenCfg.ocrScale) || 1.25) : 1;
  const stableTicksRequired = videoMode ? Math.max(1, Math.min(4, Number(screenCfg.stableTicks) || 2)) : 1;

  if (realtime) {
    updateScreenResultWindow(buildScreenPayload(
      bounds,
      session?.lastSourceText || '',
      session?.lastTranslatedText || '',
      '正在观察字幕变化…',
      true,
      { phase: 'watching' }
    ));
  }
  setScreenStatus(realtime ? '屏幕实时 OCR 识别中…' : '截图 OCR 识别中…');

  const capture = await captureRegionAsPng(bounds, {
    withMeta: true,
    ocrScale,
    enhance: false
  });
  const png = capture.png;
  let enhancedPng = null;
  const getEnhancedPng = () => {
    if (!enhancedPng) enhancedPng = buildEnhancedSubtitlePng(png);
    return enhancedPng;
  };

  if (session && videoMode) {
    const diff = frameDifference(session.lastFingerprint, capture.fingerprint);
    if (Number.isFinite(diff)) session.lastFrameDiff = diff;

    if (!session.pendingSourceText && session.lastFrameHash === capture.fingerprint?.hash && session.lastSourceText) {
      session.stableFrameCount = (session.stableFrameCount || 0) + 1;
      session.lastFingerprint = capture.fingerprint;
      const payload = buildScreenPayload(
        bounds,
        session.lastSourceText,
        session.lastTranslatedText,
        '字幕未变化，沿用上一条翻译',
        true,
        { skipped: true, phase: 'stable-frame' }
      );
      updateScreenResultWindow(payload);
      setScreenStatus(payload.status);
      sendToRenderer('screen-translation', payload);
      return payload;
    }

    session.lastFingerprint = capture.fingerprint;
    session.lastFrameHash = capture.fingerprint?.hash || '';
  }

  const ocrKey = makeOcrCacheKey(png);
  let sourceText = ocrResultCache.has(ocrKey) ? ocrResultCache.get(ocrKey) : '';
  if (!sourceText) {
    try {
      const status = videoMode ? '视频字幕增强识别中…' : 'PaddleOCR 高精度识别中…';
      setScreenStatus(status);
      if (realtime) {
        updateScreenResultWindow(buildScreenPayload(
          bounds,
          session?.lastSourceText || '',
          session?.lastTranslatedText || '',
          status,
          true,
          { phase: 'ocr' }
        ));
      }
      sourceText = cleanOcrText(await runPaddleOcr(png));
    } catch (paddleErr) {
      setScreenStatus('PaddleOCR 不可用，回退到 Windows OCR…');
    }

    if (videoMode && (!sourceText || isMostlyNoise(sourceText) || scoreOcrText(sourceText) < 12)) {
      try {
        const enhancedPaddleText = cleanOcrText(await runPaddleOcr(getEnhancedPng()));
        sourceText = chooseBetterOcrText(sourceText, enhancedPaddleText);
      } catch {
        // Enhanced image is an optional quality pass; keep the first OCR result.
      }
    }

    if (!sourceText || isMostlyNoise(sourceText)) {
      try {
        sourceText = chooseBetterOcrText(sourceText, await runWindowsOcr(png));
      } catch (windowsErr) {
        if (!sourceText) throw windowsErr;
      }
    }

    const needTesseractFallback = videoMode ? false : shouldUseEnhancedOcr(sourceText);
    if (needTesseractFallback) {
      try {
        setScreenStatus('正在启用 Tesseract OCR 兜底识别…');
        const enhancedText = cleanOcrText(await runTesseractOcr(png));
        scheduleTesseractCleanup();
        sourceText = chooseBetterOcrText(sourceText, enhancedText);
      } catch (tesseractErr) {
        if (!sourceText) throw tesseractErr;
      }
    }

    rememberOcrResult(ocrKey, sourceText);
  }

  sourceText = cleanOcrText(sourceText);
  if (!sourceText || isMostlyNoise(sourceText)) {
    if (session) {
      session.emptyTicks = (session.emptyTicks || 0) + 1;
      if (session.lastSourceText && session.emptyTicks <= 3) {
        const payload = buildScreenPayload(
          bounds,
          session.lastSourceText,
          session.lastTranslatedText,
          '暂未识别到新字幕，保留上一条翻译',
          realtime,
          { skipped: true, phase: 'empty-keep' }
        );
        if (realtime) updateScreenResultWindow(payload);
        setScreenStatus(payload.status);
        sendToRenderer('screen-translation', payload);
        return payload;
      }
    }

    const emptyPayload = buildScreenPayload(bounds, '', '', '未识别到文字', realtime, { phase: 'empty' });
    if (realtime) updateScreenResultWindow(emptyPayload);
    setScreenStatus('未识别到文字', true);
    sendToRenderer('screen-translation', emptyPayload);
    return null;
  }

  if (session) session.emptyTicks = 0;

  if (session && session.lastSourceText && isSameSubtitle(sourceText, session.lastSourceText)) {
    session.stableTextCount = (session.stableTextCount || 0) + 1;
    const keepPayload = buildScreenPayload(
      bounds,
      session.lastSourceText,
      session.lastTranslatedText,
      '字幕未变化，沿用上一条翻译',
      true,
      { skipped: true, phase: 'same-text' }
    );
    updateScreenResultWindow(keepPayload);
    setScreenStatus(keepPayload.status);
    sendToRenderer('screen-translation', keepPayload);
    return keepPayload;
  }

  if (session && sourceText !== session.pendingSourceText) {
    session.pendingSourceText = sourceText;
    session.pendingStableTicks = 1;
    if (session.lastTranslatedText) {
      const payload = buildScreenPayload(
        bounds,
        sourceText,
        session.lastTranslatedText,
        '检测到新字幕，正在确认…',
        true,
        { phase: 'confirming', tentative: true }
      );
      updateScreenResultWindow(payload);
      setScreenStatus(payload.status);
      sendToRenderer('screen-translation', payload);
      return payload;
    }
  } else if (session) {
    session.pendingStableTicks = (session.pendingStableTicks || 0) + 1;
  }

  if (session && session.pendingStableTicks < stableTicksRequired) {
    const payload = buildScreenPayload(
      bounds,
      sourceText,
      session.lastTranslatedText,
      '检测到新字幕，正在确认…',
      true,
      { phase: 'confirming', tentative: true }
    );
    updateScreenResultWindow(payload);
    setScreenStatus(payload.status);
    sendToRenderer('screen-translation', payload);
    return payload;
  }

  if (realtime) {
    updateScreenResultWindow(buildScreenPayload(
      bounds,
      sourceText,
      session?.lastTranslatedText || '',
      '翻译中…',
      true,
      { phase: 'translating' }
    ));
  }
  setScreenStatus(realtime ? '屏幕实时翻译中…' : '截图翻译中…');
  const translatedText = await translateOcrText(sourceText);
  const payload = buildScreenPayload(
    bounds,
    sourceText,
    translatedText,
    realtime ? '屏幕实时翻译运行中' : '截图 OCR 翻译完成',
    realtime,
    { phase: 'done' }
  );

  if (session) {
    session.pendingSourceText = '';
    session.pendingStableTicks = 0;
    session.stableTextCount = 0;
    updateRealtimeLastResult(session, payload);
  }

  sendToRenderer('screen-translation', payload);
  if (realtime) updateScreenResultWindow(payload);
  setScreenStatus(payload.status);
  return payload;
}

async function startScreenAreaTranslation(realtime = false) {
  if (realtime && realtimeSession?.active) {
    stopScreenRealtime();
    return;
  }
  setScreenStatus(realtime ? '拖拽选择屏幕实时翻译区域…' : '拖拽选择截图 OCR 翻译区域…');
  await compactMainWindowForCapture();
  const bounds = await requestScreenSelection(realtime);
  if (!bounds) {
    setScreenStatus('已取消屏幕选区');
    await restoreMainWindowAfterCapture();
    return;
  }

  if (realtime) {
    startScreenRealtime(bounds);
    await restoreMainWindowAfterCapture({ show: false, animate: false });
    return;
  }

  try {
    await processScreenTranslation(bounds, { realtime: false });
  } catch (err) {
    setScreenStatus('截图 OCR 翻译失败：' + toErrorMessage(err), true);
  } finally {
    await restoreMainWindowAfterCapture();
  }
}

function startScreenRealtime(bounds) {
  stopScreenRealtime(false);
  realtimeSession = {
    active: true,
    bounds,
    timer: null,
    running: false,
    lastSourceText: '',
    lastTranslatedText: '',
    lastStatus: '',
    lastFingerprint: null,
    lastFrameHash: '',
    lastFrameDiff: Number.POSITIVE_INFINITY,
    stableFrameCount: 0,
    stableTextCount: 0,
    emptyTicks: 0,
    pendingSourceText: '',
    pendingStableTicks: 0
  };
  refreshTrayMenu();
  sendScreenState();
  updateScreenResultWindow({ bounds, sourceText: '', translatedText: '', status: '准备屏幕实时翻译…', realtime: true });
  runScreenRealtimeTick();
}

function getRealtimeInterval(session, payload) {
  const base = Math.max(800, Number(store.get('screen.intervalMs')) || 1600);
  let interval = base;
  if (payload?.phase === 'confirming') interval = Math.min(base, 850);
  if (payload?.phase === 'translating' || payload?.phase === 'ocr') interval = Math.min(base, 1000);
  if (session?.emptyTicks > 0 && session.emptyTicks <= 3) interval = Math.min(base, 1000);
  if (session?.lastProcessingMs > 1200) {
    interval = Math.max(interval, Math.min(2600, Math.round(session.lastProcessingMs * 0.8)));
  }
  return interval;
}

async function runScreenRealtimeTick() {
  const session = realtimeSession;
  if (!session?.active || session.running) return;
  session.running = true;
  const startedAt = Date.now();
  let payload = null;
  try {
    payload = await processScreenTranslation(session.bounds, { realtime: true, session });
  } catch (err) {
    const message = toErrorMessage(err);
    setScreenStatus('屏幕实时翻译失败：' + message, true);
    updateScreenResultWindow({
      bounds: session.bounds,
      sourceText: session.lastSourceText,
      translatedText: session.lastTranslatedText,
      status: '识别失败：' + message,
      realtime: true,
      error: true
    });
  } finally {
    session.lastProcessingMs = Date.now() - startedAt;
    session.running = false;
    if (session.active) {
      const interval = getRealtimeInterval(session, payload);
      session.timer = setTimeout(runScreenRealtimeTick, interval);
    }
  }
}

function stopScreenRealtime(notify = true) {
  if (realtimeSession?.timer) clearTimeout(realtimeSession.timer);
  realtimeSession = null;
  closeScreenResultWindow();
  refreshTrayMenu();
  sendScreenState();
  if (notify) setScreenStatus('屏幕实时翻译已停止');
}

function stopTesseractWorkers() {
  if (tesseractCleanupTimer) {
    clearTimeout(tesseractCleanupTimer);
    tesseractCleanupTimer = null;
  }
  for (const worker of tesseractWorkers.values()) {
    worker.terminate().catch(() => {});
  }
  tesseractWorkers.clear();
}

function scheduleTesseractCleanup(delayMs = 45000) {
  if (tesseractCleanupTimer) clearTimeout(tesseractCleanupTimer);
  tesseractCleanupTimer = setTimeout(() => {
    tesseractCleanupTimer = null;
    stopTesseractWorkers();
  }, delayMs);
  if (typeof tesseractCleanupTimer.unref === 'function') tesseractCleanupTimer.unref();
}

function warmupOcrEngine() {
  if (ocrWarmupStarted) return;
  ocrWarmupStarted = true;
  setTimeout(() => {
    getPaddleOcr()
      .catch(() => {
        // Keep startup quiet if the optional OCR warmup fails; capture will still
        // fall back to Windows OCR/Tesseract on demand.
      });
  }, 1200);
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
  if (patch.screen && realtimeSession?.active) {
    realtimeSession.pendingStableTicks = 0;
  }
}

ipcMain.on('selection:done', (event, rect) => {
  if (activeSelection && event.sender === activeSelection.webContents) {
    activeSelection.finish(rect);
  }
});

ipcMain.on('selection:cancel', (event) => {
  if (activeSelection && event.sender === activeSelection.webContents) {
    activeSelection.finish(null);
  }
});

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
ipcMain.handle('screen:capture-translate', () => startScreenAreaTranslation(false));
ipcMain.handle('screen:realtime-start', () => startScreenAreaTranslation(true));
ipcMain.handle('screen:realtime-stop', () => stopScreenRealtime());
ipcMain.handle('screen:state', () => ({ realtimeActive: !!realtimeSession?.active }));

ipcMain.handle('translate', (_, payload) => translateText(payload));

ipcMain.handle('dictionary', async (_, word) => {
  const clean = fixCommonOcrWordConfusions(String(word || '').trim());
  if (!/^[A-Za-z][A-Za-z'-]{0,63}$/.test(clean)) return null;
  const cfg = store.get('translation') || {};
  const timeoutMs = Math.min(cfg.timeoutMs || 9000, 4500);
  const fast = await Promise.allSettled([
    lookupYoudao(clean, timeoutMs),
    lookupDictionaryApi(clean, timeoutMs)
  ]);
  const fastResult = mergeDictionarySources(clean, fast.map(item => item.status === 'fulfilled' ? item.value : null));
  if (fastResult) {
    Promise.allSettled([
      lookupCambridge(clean, timeoutMs),
      lookupOxford(clean, timeoutMs)
    ]).then(extra => {
      const merged = mergeDictionarySources(clean, [
        ...(fastResult.sources || []),
        ...extra.map(item => item.status === 'fulfilled' ? item.value : null)
      ]);
      if (merged) sendToRenderer('dictionary-update', { word: clean, entry: merged });
    }).catch(() => {});
    return fastResult;
  }

  const full = await Promise.allSettled([
    lookupCambridge(clean, timeoutMs),
    lookupOxford(clean, timeoutMs)
  ]);
  return mergeDictionarySources(clean, full.map(item => item.status === 'fulfilled' ? item.value : null));
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
app.on('will-quit', () => {
  stopScreenRealtime(false);
  stopTesseractWorkers();
  globalShortcut.unregisterAll();
});
