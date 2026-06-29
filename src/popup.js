// popup.js — UI logic for popup

const DEFAULT_CONFIG = {
  enabled: false,
  preload: true,
  batchTranslate: true,
  showOverlay: true,
  debugBoxes: false,
  filterPatterns: ['LunaToons.org', 'MANGA18FX', 'Read Early', 'Read Manga'],
};

let config = { ...DEFAULT_CONFIG };

// ── Load config ──────────────────────────────────────────
async function loadConfig() {
  const stored = await chrome.storage.local.get('config');
  config = { ...DEFAULT_CONFIG, ...(stored.config || {}) };
  applyToUI();
}

function applyToUI() {
  document.getElementById('opt-preload').checked = config.preload;
  document.getElementById('opt-batch-chk').checked = config.batchTranslate;
  document.getElementById('opt-show-overlay').checked = config.showOverlay;
  document.getElementById('opt-show-debug').checked = config.debugBoxes;
  document.getElementById('filter-patterns').value = (config.filterPatterns || []).join('\n');
  updateOptCards();
}

function updateOptCards() {
  const map = {
    'opt-auto': 'opt-preload',
    'opt-batch': 'opt-batch-chk',
    'opt-overlay': 'opt-show-overlay',
    'opt-debug': 'opt-show-debug',
  };
  for (const [cardId, inputId] of Object.entries(map)) {
    document.getElementById(cardId).classList.toggle(
      'selected',
      document.getElementById(inputId).checked
    );
  }
}

// ── Save config ──────────────────────────────────────────
async function saveConfig() {
  config.preload = document.getElementById('opt-preload').checked;
  config.batchTranslate = document.getElementById('opt-batch-chk').checked;
  config.showOverlay = document.getElementById('opt-show-overlay').checked;
  config.debugBoxes = document.getElementById('opt-show-debug').checked;
  config.filterPatterns = document.getElementById('filter-patterns').value
    .split('\n').map(s => s.trim()).filter(Boolean);

  await chrome.storage.local.set({ config });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config }).catch(() => { });

  const btn = document.getElementById('btn-save');
  btn.textContent = '✅ Đã lưu!';
  setTimeout(() => { btn.textContent = '💾 Lưu cấu hình'; }, 1500);
}

// ── Stats from active tab ─────────────────────────────────
async function loadStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' });
    if (resp) {
      document.getElementById('stat-pages').textContent = resp.pages || 0;
      document.getElementById('stat-bubbles').textContent = resp.bubbles || 0;
      document.getElementById('stat-avg').textContent = resp.avgTime ? resp.avgTime.toFixed(1) : '—';
      document.getElementById('queue-count').textContent = resp.queue || 0;
    }
  } catch (_) { }
}

// ── Reset page ────────────────────────────────────────────
async function resetPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'RESET' }).catch(() => { });
  document.getElementById('stat-pages').textContent = '0';
  document.getElementById('stat-bubbles').textContent = '0';
  document.getElementById('stat-avg').textContent = '—';
}

// ── Cache count ───────────────────────────────────────────
async function loadCacheCount() {
  try {
    const all = await chrome.storage.local.get(null);
    const count = Object.keys(all).filter(k => k.startsWith('mtv-img-')).length;
    const el = document.getElementById('cache-count');
    if (el) el.textContent = count;
  } catch { }
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('mtv-img-'));
  if (keys.length) await chrome.storage.local.remove(keys);
  document.getElementById('cache-count').textContent = '0';
}

// ── Event listeners ───────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', saveConfig);
document.getElementById('btn-reset').addEventListener('click', resetPage);
document.getElementById('btn-clear-cache').addEventListener('click', clearCache);

['opt-preload', 'opt-batch-chk', 'opt-show-overlay', 'opt-show-debug'].forEach(id => {
  document.getElementById(id).addEventListener('change', updateOptCards);
});

// ── Init ──────────────────────────────────────────────────
loadConfig();
loadStats();
loadCacheCount();
setInterval(loadStats, 2000);
