const statusText = document.getElementById('statusText');
const sourceText = document.getElementById('sourceText');
const translatedText = document.getElementById('translatedText');
const phaseDot = document.getElementById('phaseDot');

const phaseClassNames = ['watching', 'ocr', 'confirming', 'translating', 'done', 'empty', 'error'];

function showText(node, text, fallback = '') {
  node.textContent = text && text.trim() ? text.trim() : fallback;
}

window.screenResult.onUpdate((payload = {}) => {
  statusText.textContent = payload.status || '屏幕实时翻译运行中';
  statusText.classList.toggle('error', !!payload.error);
  const phase = payload.error ? 'error' : (payload.phase || 'watching');
  document.body.classList.toggle('is-waiting', ['watching', 'confirming', 'stable-frame', 'same-text', 'empty-keep'].includes(phase));
  document.body.classList.toggle('is-busy', ['ocr', 'translating'].includes(phase));
  phaseDot.className = `phase-dot ${phaseClassNames.includes(phase) ? phase : 'watching'}`;
  showText(sourceText, payload.sourceText, '等待 OCR 识别文字…');
  showText(translatedText, payload.translatedText, payload.status || '等待翻译结果…');
});
