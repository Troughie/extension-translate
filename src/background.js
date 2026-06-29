// background.js — Service worker, gửi ảnh lên server xử lý, nhận ảnh kết quả

// Nạp config dùng chung (OCR_SERVER_URL). Đổi địa chỉ server ở src/config.js.
importScripts('config.js');

// ── Stats ──────────────────────────────────────────────────
const stats = {
  pages: 0, bubbles: 0, times: [],
  get avgTime() {
    if (!this.times.length) return 0;
    return this.times.slice(-20).reduce((a, b) => a + b, 0) / Math.min(this.times.length, 20);
  }
};

// ── Get config ─────────────────────────────────────────────
async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...(config || {}) };
}

// ── Cache helpers ──────────────────────────────────────────
const CACHE_PREFIX = 'mtv-img-';
const CACHE_MAX = 20;  // tối đa 20 ảnh lưu trong storage

async function cacheKey(url) {
  const enc = new TextEncoder().encode(url);
  const hashBuf = await crypto.subtle.digest('SHA-1', enc);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return CACHE_PREFIX + hashArr.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function cacheGet(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function cacheSet(key, resultImage) {
  // Giữ tối đa CACHE_MAX entries — xoá cũ nhất nếu vượt
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (keys.length >= CACHE_MAX) {
    // Xoá 1/4 cache cũ nhất (theo thứ tự key)
    const toRemove = keys.slice(0, Math.ceil(CACHE_MAX / 4));
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({ [key]: resultImage });
}

// ── Series id (cho glossary xưng hô bền vững toàn truyện) ───
// Gom mọi CHƯƠNG của cùng 1 truyện về 1 id: bỏ phần chapter/số trang khỏi URL.
function seriesIdFromUrl(url) {
  try {
    const u = new URL(url);
    let p = u.pathname.toLowerCase();
    p = p.replace(/\/(chapter|chap|ch|episode|ep|tap|chuong)[-_/]?\d+.*$/i, '');
    p = p.replace(/\/\d+(\.\w+)?$/, '');   // /123 hoặc /123.html ở cuối
    p = p.replace(/[-_]\d+$/, '');         // -5 ở cuối segment
    p = p.replace(/\/+$/, '');
    return (u.hostname + p) || u.hostname;
  } catch {
    return 'default';
  }
}

// ── Main batch processor ───────────────────────────────────
async function processImageBatch(jobs, pageUrl = '') {
  console.log('[BG] processImageBatch:', jobs.map(j => j.imageId));
  const cfg = await getConfig();
  const seriesId = seriesIdFromUrl(pageUrl);
  return await _processImageBatchCore(jobs, cfg, seriesId);
}

async function _processImageBatchCore(jobs, cfg, seriesId = 'default') {
  const t0 = Date.now();
  // Địa chỉ server lấy từ config.js (OCR_SERVER_URL) — không còn nhập ở popup.
  const ocrUrl = (typeof OCR_SERVER_URL !== 'undefined' ? OCR_SERVER_URL
                                                        : 'http://127.0.0.1:7860').replace(/\/$/, '');
  const filterPatterns = cfg.filterPatterns || [];

  const results = await Promise.all(
    jobs.map(async (job) => {
      try {
        // ── Kiểm tra cache ──
        const key = await cacheKey(job.imageSrc);
        const cached = await cacheGet(key);
        if (cached) {
          console.log(`[BG] ${job.imageId} cache hit`);
          stats.pages++;
          return { imageId: job.imageId, resultImage: cached, fromCache: true };
        }

        // ── Fetch + resize + gửi server ──
        const blob = await fetch(job.imageSrc).then(r => r.blob());
        const resizedBlob = await resizeImageBlob(blob, 1200);
        const b64 = await blobToBase64(resizedBlob);

        const resp = await fetch(`${ocrUrl}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: b64,
            conf: 0.30,
            filter_patterns: filterPatterns,
            series_id: seriesId,
            reading_order: cfg.readingOrder || '',
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`Server ${resp.status}: ${errText.slice(0, 120)}`);
        }

        const data = await resp.json();
        stats.pages++;
        console.log(`[BG] ${job.imageId} done in ${data.elapsed}s, ${data.regions} regions`);

        // ── Lưu cache ──
        if (data.result_image) {
          cacheSet(key, data.result_image).catch(() => { });
        }

        return { imageId: job.imageId, resultImage: data.result_image, elapsed: data.elapsed };

      } catch (e) {
        console.error(`[BG] ${job.imageId} failed:`, e.message);
        return { imageId: job.imageId, error: e.message };
      }
    })
  );

  const elapsed = (Date.now() - t0) / 1000;
  stats.times.push(elapsed);
  console.log(`[BG] processImageBatch done in ${elapsed.toFixed(1)}s`);

  return { ok: true, results };
}

// ── Utility: Blob → base64 data URL ──────────────────────
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ── Utility: resize ảnh trước khi gửi ─────────────────────
async function resizeImageBlob(blob, maxWidth = 1200) {
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;

  if (width <= maxWidth) {
    bmp.close();
    return blob;
  }

  const scale = maxWidth / width;
  const canvas = new OffscreenCanvas(maxWidth, Math.round(height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

// ── Message Handler ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PROCESS_BATCH') {
    const pageUrl = msg.pageUrl || sender?.tab?.url || '';
    processImageBatch(msg.jobs, pageUrl)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_STATS') {
    sendResponse({
      pages: stats.pages,
      bubbles: stats.bubbles,
      avgTime: stats.avgTime,
      queue: 0,
    });
    return false;
  }

  if (msg.type === 'RESET_STATS') {
    stats.pages = 0; stats.bubbles = 0; stats.times = [];
    sendResponse({ ok: true });
    return false;
  }
});
