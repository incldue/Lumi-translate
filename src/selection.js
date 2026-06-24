const params = new URLSearchParams(location.search);
const realtime = params.get('mode') === 'realtime';
const box = document.getElementById('selectionBox');
const sizeLabel = document.getElementById('selectionSize');
const modeLabel = document.getElementById('selectionMode');

modeLabel.textContent = realtime ? '屏幕实时翻译' : '截图 OCR 翻译';

let dragging = false;
let start = null;
let currentRect = null;

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  return { x, y, width, height };
}

function pointFromEvent(event) {
  return {
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY))
  };
}

function renderRect(rect) {
  currentRect = rect;
  box.style.display = rect.width > 1 && rect.height > 1 ? 'block' : 'none';
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  dragging = true;
  start = pointFromEvent(event);
  renderRect({ x: start.x, y: start.y, width: 0, height: 0 });
});

window.addEventListener('mousemove', (event) => {
  if (!dragging || !start) return;
  renderRect(normalizeRect(start, pointFromEvent(event)));
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  if (currentRect && currentRect.width >= 8 && currentRect.height >= 8) {
    window.selection.done(currentRect);
  } else {
    window.selection.cancel();
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.selection.cancel();
  if (event.key === 'Enter' && currentRect) window.selection.done(currentRect);
});
