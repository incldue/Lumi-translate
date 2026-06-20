const languages = [
  ['auto', '自动检测'],
  ['zh-CN', '中文（简体）'],
  ['zh-TW', '中文（繁体）'],
  ['en', '英语'],
  ['ja', '日语'],
  ['ko', '韩语'],
  ['fr', '法语'],
  ['de', '德语'],
  ['es', '西班牙语'],
  ['ru', '俄语'],
  ['it', '意大利语'],
  ['pt', '葡萄牙语'],
  ['ar', '阿拉伯语'],
  ['th', '泰语'],
  ['vi', '越南语'],
  ['id', '印尼语']
];

const $ = (id) => document.getElementById(id);

let config = null;
let history = [];
let detailMode = true;
let debounceTimer = null;
let historyTimer = null;
let requestSerial = 0;
const translationCache = new Map();
const dictionaryCache = new Map();

const el = {
  source: $('sourceLang'),
  target: $('targetLang'),
  input: $('inputText'),
  result: $('resultText'),
  status: $('statusText'),
  inputCount: $('inputCount'),
  detailDock: $('detailDock'),
  detailBtn: $('detailBtn'),
  wordTitle: $('wordTitle'),
  phonetic: $('phoneticText'),
  dictionary: $('dictionaryContent'),
  historyList: $('historyList'),
  alwaysOnTop: $('alwaysOnTop'),
  opacity: $('opacityRange'),
  toggleShortcut: $('toggleShortcut'),
  clipboardShortcut: $('clipboardShortcut'),
  detailShortcut: $('detailShortcut'),
  customApiUrl: $('customApiUrl'),
  timeoutMs: $('timeoutMs')
};

function fillLanguages() {
  el.source.innerHTML = '';
  el.target.innerHTML = '';
  for (const [code, name] of languages) {
    el.source.appendChild(new Option(name, code));
    if (code !== 'auto') el.target.appendChild(new Option(name, code));
  }
}

async function boot() {
  fillLanguages();
  config = await window.lumi.getConfig();
  history = Array.isArray(config.history) ? config.history : [];
  detailMode = !!config.translation?.detailMode;
  hydrateConfig();
  renderHistory();
  bindEvents();
  updateDetailMode();
  applyOpacity();
  el.input.focus();
}

function hydrateConfig() {
  config.translation ||= {};
  config.appearance ||= {};
  config.shortcuts ||= {};
  el.source.value = config.translation.source || 'auto';
  el.target.value = config.translation.target || 'zh-CN';
  el.alwaysOnTop.checked = !!config.appearance.alwaysOnTop;
  el.opacity.value = config.appearance.opacity || 0.96;
  el.toggleShortcut.value = config.shortcuts.toggleWindow || 'CommandOrControl+Alt+T';
  el.clipboardShortcut.value = config.shortcuts.translateClipboard || 'CommandOrControl+Alt+C';
  el.detailShortcut.value = config.shortcuts.toggleDetail || 'CommandOrControl+Shift+D';
  el.customApiUrl.value = config.translation.customApiUrl || '';
  el.timeoutMs.value = config.translation.timeoutMs || 9000;
}

function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });

  $('minimizeBtn').addEventListener('click', window.lumi.minimize);
  $('hideBtn').addEventListener('click', window.lumi.hide);
  $('closeBtn').addEventListener('click', window.lumi.close);
  $('translateBtn').addEventListener('click', () => translateNow(true));
  $('copyBtn').addEventListener('click', copyResult);
  $('clearBtn').addEventListener('click', clearAll);
  $('swapBtn').addEventListener('click', swapLanguages);
  $('clipboardBtn').addEventListener('click', translateClipboardFromRenderer);
  $('detailBtn').addEventListener('click', toggleDetail);
  $('clearHistoryBtn').addEventListener('click', clearHistory);
  $('saveSettingsBtn').addEventListener('click', saveSettings);

  document.querySelectorAll('.shortcut-input').forEach(input => {
    input.addEventListener('keydown', recordShortcut);
    input.addEventListener('focus', () => input.select());
  });

  el.input.addEventListener('input', () => {
    el.inputCount.textContent = `${el.input.value.length} chars`;
    clearTimeout(debounceTimer);
    clearTimeout(historyTimer);
    debounceTimer = setTimeout(() => translateNow(false), 320);
  });

  el.source.addEventListener('change', saveTranslationConfig);
  el.target.addEventListener('change', saveTranslationConfig);
  el.alwaysOnTop.addEventListener('change', () => window.lumi.setConfig({ 'appearance.alwaysOnTop': el.alwaysOnTop.checked }));
  el.opacity.addEventListener('input', () => {
    applyOpacity();
    window.lumi.setConfig({ 'appearance.opacity': Number(el.opacity.value) });
  });

  window.lumi.onFocusInput(() => setTimeout(() => el.input.focus(), 80));
  window.lumi.onTranslateText((text) => {
    el.input.value = text;
    el.inputCount.textContent = `${text.length} chars`;
    switchPage('translate');
    translateNow(true);
  });
  window.lumi.onToggleDetail(() => toggleDetail());
}

function switchPage(page) {
  const map = {
    translate: 'pageTranslate',
    history: 'pageHistory',
    settings: 'pageSettings'
  };
  if (!map[page]) return;
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.page === page));
  document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
  $(map[page]).classList.add('active');
}

function applyOpacity() {
  document.querySelector('.workspace').style.opacity = el.opacity.value || 0.96;
}

async function saveTranslationConfig() {
  config = await window.lumi.setConfig({
    'translation.source': el.source.value,
    'translation.target': el.target.value
  });
}

async function translateNow(explicit) {
  const text = el.input.value.trim();
  const serial = ++requestSerial;
  if (!text) {
    el.result.value = '';
    setStatus('Ready');
    resetDictionary();
    return;
  }

  setStatus('Translating…');
  try {
    const cacheKey = `${el.source.value}|${el.target.value}|${text}`;
    if (translationCache.has(cacheKey)) {
      const cached = translationCache.get(cacheKey);
      el.result.value = cached;
      setStatus('Done');
      queueHistory(text, cached, explicit);
      if (detailMode || explicit) lookupDictionary(text);
      return;
    }
    const res = await window.lumi.translate({
      text,
      source: el.source.value,
      target: el.target.value
    });
    if (serial !== requestSerial) return;
    translationCache.set(cacheKey, res.text);
    if (translationCache.size > 80) translationCache.delete(translationCache.keys().next().value);
    el.result.value = res.text;
    setStatus('Done');
    queueHistory(text, res.text, explicit);
    if (detailMode || explicit) lookupDictionary(text);
  } catch (err) {
    if (serial !== requestSerial) return;
    setStatus(`Failed: ${friendly(err)}`, true);
  }
}

async function lookupDictionary(text) {
  const word = text.trim();
  if (!/^[A-Za-z][A-Za-z'-]{0,63}$/.test(word)) {
    el.wordTitle.textContent = 'Sentence mode';
    el.phonetic.textContent = '';
    el.dictionary.className = 'dictionary-empty';
    el.dictionary.textContent = '当前输入不是英文单词，短句请查看上方翻译结果。';
    return;
  }

  el.wordTitle.textContent = word;
  el.phonetic.textContent = 'Looking up…';
  el.dictionary.className = 'dictionary-empty';
  el.dictionary.textContent = '';
  try {
    const lower = word.toLowerCase();
    const entry = dictionaryCache.has(lower)
      ? dictionaryCache.get(lower)
      : await window.lumi.dictionary(word);
    if (!dictionaryCache.has(lower)) {
      dictionaryCache.set(lower, entry);
      if (dictionaryCache.size > 80) dictionaryCache.delete(dictionaryCache.keys().next().value);
    }
    if (!entry) {
      el.phonetic.textContent = 'No detail';
      el.dictionary.textContent = '没有查到单词详解。';
      return;
    }
    el.wordTitle.textContent = entry.word || word;
    const phonetic = entry.phonetic || entry.phonetics?.find(x => x.text)?.text || '';
    el.phonetic.textContent = phonetic;
    el.dictionary.className = 'dictionary-content';
    el.dictionary.innerHTML = formatDictionary(entry);
  } catch (err) {
    el.phonetic.textContent = 'Lookup failed';
    el.dictionary.className = 'dictionary-empty';
    el.dictionary.textContent = friendly(err);
  }
}

function formatDictionary(entry) {
  const lines = [];
  for (const meaning of entry.meanings || []) {
    lines.push(`<div><b>${escapeHtml(meaning.partOfSpeech || '')}</b></div>`);
    for (const def of (meaning.definitions || []).slice(0, 3)) {
      lines.push(`<div>• ${escapeHtml(def.definition || '')}</div>`);
      if (def.example) lines.push(`<div style="color:#94a3c7;margin-left:14px">e.g. ${escapeHtml(def.example)}</div>`);
    }
  }
  return lines.join('') || '<div class="dictionary-empty">没有可显示的释义。</div>';
}

function toggleDetail() {
  detailMode = !detailMode;
  updateDetailMode();
  window.lumi.setConfig({ 'translation.detailMode': detailMode });
  if (detailMode && el.input.value.trim()) lookupDictionary(el.input.value.trim());
}

function updateDetailMode() {
  el.detailDock.style.display = detailMode ? 'block' : 'none';
  el.detailBtn.textContent = detailMode ? '隐藏详解' : '单词详解';
}

async function saveSettings() {
  config = await window.lumi.setConfig({
    appearance: {
      alwaysOnTop: el.alwaysOnTop.checked,
      opacity: Number(el.opacity.value)
    },
    translation: {
      source: el.source.value,
      target: el.target.value,
      detailMode,
      timeoutMs: Number(el.timeoutMs.value) || 9000,
      customApiUrl: el.customApiUrl.value.trim()
    },
    shortcuts: {
      toggleWindow: el.toggleShortcut.value.trim() || 'CommandOrControl+Alt+T',
      translateClipboard: el.clipboardShortcut.value.trim() || 'CommandOrControl+Alt+C',
      toggleDetail: el.detailShortcut.value.trim() || 'CommandOrControl+Shift+D'
    }
  });
  setStatus('Settings saved');
  switchPage('translate');
}

function swapLanguages() {
  const s = el.source.value;
  const t = el.target.value;
  el.source.value = t;
  el.target.value = s === 'auto' ? 'en' : s;
  saveTranslationConfig();
  translateNow(true);
}

async function translateClipboardFromRenderer() {
  const text = (await window.lumi.readClipboard()).trim();
  if (!text) {
    setStatus('剪贴板没有可翻译文本', true);
    return;
  }
  el.input.value = text;
  el.inputCount.textContent = `${text.length} chars`;
  switchPage('translate');
  translateNow(true);
}

async function copyResult() {
  const text = el.result.value.trim();
  if (!text) return;
  await window.lumi.writeClipboard(text);
  setStatus('Copied');
}

function clearAll() {
  el.input.value = '';
  el.result.value = '';
  el.inputCount.textContent = '0 chars';
  resetDictionary();
  setStatus('Ready');
}

function resetDictionary() {
  el.wordTitle.textContent = 'Word Detail';
  el.phonetic.textContent = '';
  el.dictionary.className = 'dictionary-empty';
  el.dictionary.textContent = '输入英文单词后显示释义、词性和例句。';
}

function addHistory(source, result) {
  history = history.filter(x => x.source !== source);
  history.unshift({ source, result, time: Date.now() });
  history = history.slice(0, 30);
  window.lumi.setHistory(history);
  renderHistory();
}

function queueHistory(source, result, immediate = false) {
  clearTimeout(historyTimer);
  if (!source || source.length < 2) return;

  if (immediate) {
    addHistory(source, result);
    return;
  }

  historyTimer = setTimeout(() => {
    const currentInput = el.input.value.trim();
    const currentResult = el.result.value.trim();
    if (currentInput === source && currentResult === result) {
      addHistory(source, result);
    }
  }, 1200);
}

function renderHistory() {
  if (!history.length) {
    el.historyList.innerHTML = '<div class="dictionary-empty">暂无历史记录。</div>';
    return;
  }
  el.historyList.innerHTML = history.map((item, index) => `
    <div class="history-item" data-index="${index}">
      <strong>${escapeHtml(short(item.source))}</strong>
      <p>${escapeHtml(short(item.result))}</p>
    </div>
  `).join('');
  el.historyList.querySelectorAll('.history-item').forEach(node => {
    node.addEventListener('click', () => {
      const item = history[Number(node.dataset.index)];
      el.input.value = item.source;
      el.result.value = item.result;
      el.inputCount.textContent = `${item.source.length} chars`;
      switchPage('translate');
    });
  });
}

function clearHistory() {
  history = [];
  window.lumi.setHistory(history);
  renderHistory();
}

function recordShortcut(event) {
  const target = event.currentTarget;
  if (event.key === 'Escape') {
    target.blur();
    return;
  }
  event.preventDefault();
  if (event.key === 'Backspace' || event.key === 'Delete') {
    target.value = '';
    return;
  }

  const key = shortcutKeyName(event);
  if (!key) return;
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) parts.push(key);
  if (parts.length >= 2) target.value = parts.join('+');
}

function shortcutKeyName(event) {
  if (/^F\d{1,2}$/.test(event.key)) return event.key;
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  const map = {
    ' ': 'Space',
    Spacebar: 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    '+': 'Plus',
    '-': '-',
    '=': '=',
    ',': ',',
    '.': '.',
    '/': '/',
    ';': ';',
    '\\': '\\',
    '[': '[',
    ']': ']'
  };
  if (map[event.key]) return map[event.key];
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

function setStatus(text, error = false) {
  el.status.textContent = text;
  el.status.style.color = error ? '#fb7185' : '#94a3c7';
}

function friendly(err) {
  const msg = err?.message || String(err);
  if (/abort|timeout/i.test(msg)) return '网络超时';
  if (/HTTP 429/.test(msg)) return '接口请求过快，请稍后再试';
  return msg.replace(/^Error invoking remote method '[^']+':\s*/i, '');
}

function short(text) {
  return text.length > 80 ? text.slice(0, 78) + '…' : text;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

boot().catch(err => {
  console.error(err);
  setStatus(`启动失败: ${friendly(err)}`, true);
});
