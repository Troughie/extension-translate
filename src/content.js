// content.js — Inject vào trang, detect manga images, pipeline xử lý

(function () {
  'use strict';

  // ── Ngưỡng lọc ảnh + pipeline (chỉnh ở đây) ─────────────
  const MIN_NATURAL_WIDTH = 400;   // bề ngang file gốc tối thiểu
  const MIN_RATIO = 1.2;           // cao/rộng tối thiểu (trang truyện thường cao)
  const MIN_DISPLAY_WIDTH = 300;   // bề ngang HIỂN THỊ tối thiểu — lọc thumbnail/bìa nhỏ
  // (để thấp vì nhiều site khác nhau; cổng cụm gánh phần lọc chính)
  const CLUSTER_MIN = 2;           // cần >= số ảnh đạt chuẩn thì mới coi là "trang đọc"
  const MAX_CONCURRENT = 3;        // số ảnh gửi song song lên server

  // ── State ───────────────────────────────────────────────
  const state = {
    enabled: false,
    config: null,
    cache: new Map(),
    mutObserver: null,
    ioObserver: null,
    stats: { pages: 0, bubbles: 0, times: [] },
    overlayVisible: true,
    menuEl: null,
    pageConfirmed: false,   // đã xác nhận đây là trang đọc (qua cổng cụm) chưa
    pendingConfirm: [],     // ảnh đạt chuẩn đang chờ đủ cụm để xác nhận trang
  };

  let globalPageIndex = 0;

  // ── Thứ tự đọc (trên→dưới) ───────────────────────────────
  // Vị trí dọc TUYỆT ĐỐI của ảnh trong tài liệu (px). Dùng để dịch theo thứ tự đọc,
  // KHÔNG theo thứ tự ảnh tải xong qua mạng (nguồn gốc bug "dịch từ dưới lên" khi sang chapter mới).
  function imgTop(img) {
    const rect = img.getBoundingClientRect();
    return rect.top + (window.scrollY || window.pageYOffset || 0);
  }

  // Index phần tử CAO NHẤT trên trang (top-Y nhỏ nhất) trong danh sách → xử lý ảnh trên cùng trước.
  function topmostIndex(items, topOf) {
    let mi = 0;
    for (let k = 1; k < items.length; k++) {
      if (topOf(items[k]) < topOf(items[mi])) mi = k;
    }
    return mi;
  }

  // ── Pipeline: worker-pool gửi tối đa MAX_CONCURRENT ảnh song song ──
  const pipeline = {
    queue: [],
    inFlight: 0,

    get running() {
      return this.inFlight > 0 || this.queue.length > 0;
    },

    push(img) {
      const imageId = getOrAssignId(img);
      if (state.cache.has(imageId)) return;
      state.cache.set(imageId, { status: 'pending' });
      this.queue.push(img);
      this.pump();
    },

    pump() {
      while (this.inFlight < MAX_CONCURRENT && this.queue.length > 0) {
        // Lấy ảnh CAO NHẤT trên trang trước (thứ tự đọc trên→dưới), không phải ảnh nạp vào sớm nhất.
        // → sang chapter mới dù ảnh tải xong loạn thứ tự vẫn dịch từ trên xuống.
        const img = this.queue.splice(topmostIndex(this.queue, imgTop), 1)[0];
        this.inFlight++;
        updateMenuState('running');
        processOne(img).finally(() => {
          this.inFlight--;
          if (this.inFlight === 0 && this.queue.length === 0) {
            updateMenuState('idle');
          }
          this.pump();
        });
      }
    },
  };

  // ── Init ────────────────────────────────────────────────
  async function init() {
    const { config } = await chrome.storage.local.get('config');
    state.config = config || {
      showOverlay: true,
      debugBoxes: false,
    };
    state.enabled = state.config.enabled || false;
    injectStyles();
    createFloatingMenu();
    if (state.enabled) startObserver();
  }

  // ── Floating Menu ───────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('mtv-styles')) return;
    const style = document.createElement('style');
    style.id = 'mtv-styles';
    style.textContent = `
      #mtv-menu {
        position: fixed;
        top: 28px;
        right: 28px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 4px;
        background: #1e1e28;
        border-radius: 999px;
        padding: 8px 10px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3);
        user-select: none;
        transition: opacity 0.2s;
      }
      #mtv-menu:hover { opacity: 1 !important; }

      .mtv-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: none;
        background: transparent;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s, transform 0.1s;
        padding: 0;
        outline: none;
        position: relative;
      }
      .mtv-btn:hover { background: rgba(255,255,255,0.10); }
      .mtv-btn:active { transform: scale(0.91); }
      .mtv-btn svg {
        width: 20px; height: 20px;
        display: block;
        transition: opacity 0.15s;
      }
      .mtv-btn.active svg { opacity: 1; }
      .mtv-btn:not(.active) svg { opacity: 0.45; }

      .mtv-btn .mtv-ring {
        display: none;
        position: absolute;
        inset: 4px;
        border: 2px solid rgba(255,255,255,0.15);
        border-top-color: #a78bfa;
        border-radius: 50%;
        animation: mtv-spin 0.7s linear infinite;
      }
      .mtv-btn.loading .mtv-ring { display: block; }
      .mtv-btn.loading svg { opacity: 0.25; }

      @keyframes mtv-spin { to { transform: rotate(360deg); } }

      .mtv-sep {
        width: 1px; height: 20px;
        background: rgba(255,255,255,0.12);
        flex-shrink: 0;
        border-radius: 1px;
      }

      .mtv-btn::after {
        content: attr(data-tip);
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        background: #111;
        color: #eee;
        font-size: 11px;
        font-family: system-ui, sans-serif;
        white-space: nowrap;
        border-radius: 5px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .mtv-btn:hover::after { opacity: 1; }

      #mtv-btn-power.active svg { filter: drop-shadow(0 0 4px #6c63ff); }

      .mtv-result-img {
        pointer-events: none;
        object-fit: fill;
      }

      .mtv-loading-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 8;
        pointer-events: none;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .mtv-loading-overlay::after {
        content: '';
        width: 36px;
        height: 36px;
        border: 3px solid rgba(167,139,250,0.25);
        border-top-color: #a78bfa;
        border-radius: 50%;
        animation: mtv-spin 0.75s linear infinite;
      }

      .mtv-spinner {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        z-index: 10;
        pointer-events: none;
      }
      .mtv-spin-dot {
        width: 28px; height: 28px;
        border: 3px solid rgba(108,99,255,0.25);
        border-top-color: #6c63ff;
        border-radius: 50%;
        animation: mtv-spin 0.7s linear infinite;
      }
      .mtv-error {
        position: absolute;
        bottom: 4px; right: 4px;
        background: rgba(220,50,50,0.85);
        color: #fff;
        font-size: 10px;
        border-radius: 4px;
        pointer-events: none;
        max-width: 160px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        z-index: 9;
      }
    `;
    document.head.appendChild(style);
  }

  function createFloatingMenu() {
    if (document.getElementById('mtv-menu')) return;

    const menu = document.createElement('div');
    menu.id = 'mtv-menu';
    menu.innerHTML = `
      <button class="mtv-btn ${state.enabled ? 'active' : ''}" id="mtv-btn-power" data-tip="${state.enabled ? 'Tắt dịch tự động' : 'Bật dịch tự động'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="${state.enabled ? '#a78bfa' : '#888'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
          <line x1="12" y1="2" x2="12" y2="12"/>
        </svg>
      </button>
      <div class="mtv-sep"></div>
      <button class="mtv-btn active" id="mtv-btn-translate" data-tip="Dịch ngay trang này">
        <div class="mtv-ring"></div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" color="#a78bfa">
          <polygon points="5 3 19 12 5 21 5 3" fill="#a78bfa" stroke="#a78bfa"/>
        </svg>
      </button>
      <div class="mtv-sep"></div>
      <button class="mtv-btn active" id="mtv-btn-toggle" data-tip="Ẩn bản dịch">
        <svg viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </button>
    `;

    document.body.appendChild(menu);
    state.menuEl = menu;
    makeDraggable(menu);

    document.getElementById('mtv-btn-power').addEventListener('click', async () => {
      state.enabled = !state.enabled;
      if (state.config) state.config.enabled = state.enabled;
      const stored = await chrome.storage.local.get('config');
      const cfg = { ...(stored.config || {}), enabled: state.enabled };
      await chrome.storage.local.set({ config: cfg });
      updatePowerBtn();
      if (state.enabled) startObserver();
      else stopObserver();
    });

    document.getElementById('mtv-btn-translate').addEventListener('click', () => {
      if (pipeline.running) return;
      startTranslate();
    });

    document.getElementById('mtv-btn-toggle').addEventListener('click', () => {
      state.overlayVisible = !state.overlayVisible;
      toggleOverlayVisibility(state.overlayVisible);
      updateToggleBtn();
    });
  }

  function updatePowerBtn() {
    const btn = document.getElementById('mtv-btn-power');
    if (!btn) return;
    if (state.enabled) {
      btn.classList.add('active');
      btn.setAttribute('data-tip', 'Tắt dịch tự động');
      btn.querySelector('svg').setAttribute('stroke', '#a78bfa');
    } else {
      btn.classList.remove('active');
      btn.setAttribute('data-tip', 'Bật dịch tự động');
      btn.querySelector('svg').setAttribute('stroke', '#888');
    }
  }

  function updateToggleBtn() {
    const btn = document.getElementById('mtv-btn-toggle');
    if (!btn) return;
    if (state.overlayVisible) {
      btn.classList.add('active');
      btn.setAttribute('data-tip', 'Ẩn bản dịch');
      btn.querySelector('svg').innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      `;
      btn.querySelector('svg').setAttribute('stroke', '#e2e8f0');
    } else {
      btn.classList.remove('active');
      btn.setAttribute('data-tip', 'Hiện bản dịch');
      btn.querySelector('svg').innerHTML = `
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
        <line x1="1" y1="1" x2="23" y2="23"/>
      `;
      btn.querySelector('svg').setAttribute('stroke', '#888');
    }
  }

  function makeDraggable(el) {
    let dragging = false, ox = 0, oy = 0;
    el.addEventListener('mousedown', e => {
      if (e.target.closest('.mtv-btn')) return;
      dragging = true;
      ox = e.clientX - el.getBoundingClientRect().left;
      oy = e.clientY - el.getBoundingClientRect().top;
      el.style.transition = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function updateMenuState(s) {
    const btn = document.getElementById('mtv-btn-translate');
    if (!btn) return;
    if (s === 'running') {
      btn.classList.add('loading');
      btn.setAttribute('data-tip', 'Đang dịch...');
    } else {
      btn.classList.remove('loading');
      btn.setAttribute('data-tip', 'Dịch ngay trang này');
    }
  }

  function toggleOverlayVisibility(visible) {
    document.querySelectorAll('.mtv-result-img').forEach(el => {
      el.style.setProperty('display', visible ? 'block' : 'none', 'important');
    });
  }

  // ── Trigger translate ────────────────────────────────────
  function startTranslate() {
    for (const [id, val] of state.cache) {
      if (val.status === 'error') state.cache.delete(id);
    }
    // Bấm tay = chủ động dịch trang này → bỏ qua cổng cụm
    state.pageConfirmed = true;
    flushPending();
    if (!state.ioObserver) {
      startObserver();
    } else {
      document.querySelectorAll('img').forEach(img => {
        if (!isMangaCandidate(img)) return;
        const id = img.dataset.mtvId;
        if (id && state.cache.has(id)) return;
        if (img.complete && img.naturalWidth > 0) tryQueue(img);
        else registerImg(img);
      });
    }
  }

  // ── Message handler ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === 'CONFIG_UPDATED') {
      const wasEnabled = state.enabled;
      state.config = msg.config;
      state.enabled = msg.config.enabled;
      if (!wasEnabled && state.enabled) startObserver();
      else if (wasEnabled && !state.enabled) stopObserver();
      updatePowerBtn();
      sendResponse({ ok: true });
    }

    if (msg.type === 'GET_STATS') {
      sendResponse({
        pages: state.stats.pages,
        bubbles: state.stats.bubbles,
        avgTime: state.stats.times.length
          ? state.stats.times.slice(-20).reduce((a, b) => a + b, 0) / Math.min(state.stats.times.length, 20)
          : 0,
        queue: [...state.cache.values()].filter(v => v.status === 'processing').length,
      });
    }

    if (msg.type === 'RESET') {
      resetAll();
      sendResponse({ ok: true });
    }
  });

  // ── Manga Image Detection ───────────────────────────────
  function isMangaCandidate(img) {
    if (!img || img.tagName !== 'IMG') return false;
    if (img.dataset.mtvDone) return false;
    if (img.dataset.mtvId) {
      const cached = state.cache.get(img.dataset.mtvId);
      if (cached && cached.status !== 'error') return false;
    }
    const src = img.src || img.currentSrc || img.dataset.src || img.dataset.lazy || '';
    if (!src || src.startsWith('data:')) return false;
    return true;
  }

  // Phân loại ảnh: 'ok' = ảnh trang truyện, 'skip' = bỏ hẳn, 'defer' = chưa load/layout xong
  function qualify(img) {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    if (!natW || !natH) return 'defer';
    if (natW < MIN_NATURAL_WIDTH) return 'skip';
    if (natH / natW < MIN_RATIO) return 'skip';
    const dispW = img.offsetWidth;
    if (dispW === 0) return 'defer';          // ảnh ẩn/chưa layout — thử lại sau
    if (dispW < MIN_DISPLAY_WIDTH) return 'skip';  // bìa/thumbnail render nhỏ
    return 'ok';
  }

  function tryQueue(img) {
    const imageId = img.dataset.mtvId;
    if (imageId && state.cache.has(imageId)) return;

    const verdict = qualify(img);
    if (verdict === 'skip') { img.dataset.mtvDone = 'skip'; return; }
    if (verdict === 'defer') return;          // chưa sẵn sàng, đừng đánh dấu skip

    // verdict === 'ok'
    if (state.pageConfirmed) {
      pipeline.push(img);                     // đã là trang đọc → gửi ngay (kể cả lazy-load)
    } else {
      addPendingConfirm(img);                 // chờ đủ cụm mới xác nhận
    }
  }

  // ── Cổng cụm: chỉ coi là "trang đọc" khi có >= CLUSTER_MIN ảnh đạt chuẩn ──
  function addPendingConfirm(img) {
    const id = getOrAssignId(img);
    if (state.pendingConfirm.some(x => x.dataset.mtvId === id)) return;
    state.pendingConfirm.push(img);
    if (state.pendingConfirm.length >= CLUSTER_MIN) confirmPage();
  }

  function confirmPage() {
    if (state.pageConfirmed) return;
    state.pageConfirmed = true;
    flushPending();
  }

  function flushPending() {
    const pend = state.pendingConfirm;
    state.pendingConfirm = [];
    for (const img of pend) pipeline.push(img);
  }

  // Ảnh đã có src thật (đang/đã tải) — phân biệt với ảnh lazy mới chỉ có data-src.
  function hasRealSrc(img) {
    const s = img.src || img.currentSrc || '';
    return !!s && !s.startsWith('data:');
  }

  // Queue ngay nếu đã tải xong; chưa xong thì gửi NGAY khi 'load' (không chờ kéo tới).
  function queueWhenReady(img) {
    if (img.complete && img.naturalWidth > 0) tryQueue(img);
    else img.addEventListener('load', () => tryQueue(img), { once: true });
  }

  // ── Observer setup ──────────────────────────────────────
  function startObserver() {
    if (state.ioObserver) return;

    if (state.mutObserver) {
      state.mutObserver.disconnect();
      state.mutObserver = null;
    }

    state.ioObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        state.ioObserver.unobserve(img);
        // Ảnh lazy đã tới gần viewport → gán src từ data-* để kích hoạt tải, rồi gửi khi xong.
        if (!hasRealSrc(img)) {
          if (img.dataset.src) img.src = img.dataset.src;
          else if (img.dataset.lazy) img.src = img.dataset.lazy;
          else if (img.dataset.original) img.src = img.dataset.original;
        }
        img.loading = 'eager';
        queueWhenReady(img);
      }
    }, { rootMargin: '1500px 0px', threshold: 0 });

    document.querySelectorAll('img').forEach(img => {
      if (!isMangaCandidate(img)) return;
      if (hasRealSrc(img)) {
        img.loading = 'eager';        // phá native lazy → tải ngay, không cần kéo tới
        queueWhenReady(img);          // có src thật → gửi liền (xong cái nào trả cái đó)
      } else {
        registerImg(img);             // lazy thật (chỉ data-src) → chờ kéo gần tới mới tải
      }
    });

    state.mutObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          if (node.classList?.contains('mtv-result-img') ||
            node.classList?.contains('mtv-spinner') ||
            node.classList?.contains('mtv-error') ||
            node.id?.startsWith('mtv-')) continue;

          if (node.tagName === 'IMG') checkNewImg(node);
          node.querySelectorAll?.('img').forEach(checkNewImg);
        }

        if (m.type === 'attributes' && m.target.tagName === 'IMG') {
          if (!m.target.dataset.mtvDone) checkNewImg(m.target);
        }
      }
    });

    state.mutObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src', 'data-lazy', 'data-original'],
    });
  }

  function registerImg(img) {
    if (!isMangaCandidate(img)) return;
    const id = img.dataset.mtvId;
    if (id && state.cache.has(id)) return;
    state.ioObserver?.observe(img);
  }

  function checkNewImg(img) {
    if (!isMangaCandidate(img)) return;
    const id = img.dataset.mtvId;
    if (id && state.cache.has(id)) return;
    if (hasRealSrc(img)) {
      img.loading = 'eager';          // có src thật → tải + gửi ngay
      queueWhenReady(img);
    } else {
      registerImg(img);               // lazy thật → chờ kéo tới (IntersectionObserver)
    }
  }

  function stopObserver() {
    state.ioObserver?.disconnect();
    state.mutObserver?.disconnect();
    state.ioObserver = null;
    state.mutObserver = null;
  }

  // ── ID duy nhất cho mỗi ảnh ────────────────────────────
  let idCounter = 0;
  function getOrAssignId(img) {
    if (!img.dataset.mtvId) img.dataset.mtvId = `mtv-${++idCounter}`;
    return img.dataset.mtvId;
  }

  // ── Single-image processing (mỗi ảnh 1 request, chạy song song) ──
  async function processOne(img) {
    const imageId = getOrAssignId(img);
    showLoadingOverlay(img, imageId);
    state.cache.set(imageId, { status: 'processing' });

    try {
      const rawSrc = img.src || img.currentSrc || '';
      console.log('[MangaTrans] rawSrc:', rawSrc?.slice(0, 80));
      console.log('[MangaTrans] img state:', {
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
      if (!rawSrc) throw new Error('No image src');

      // Lấy ảnh: ưu tiên Canvas (đọc pixel trực tiếp từ DOM img, khỏi tải lại).
      // Canvas hỏng — phổ biến là ảnh khác origin làm canvas bị CORS-taint nên
      // toDataURL() ném SecurityError — thì KHÔNG ném lỗi, mà fallback gửi THẲNG
      // URL ảnh: background tự fetch (có host_permissions <all_urls>, không vướng CORS).
      const imageData = await new Promise((resolve) => {
        if (rawSrc.startsWith('data:')) return resolve(rawSrc);

        const fallbackToUrl = (why) => {
          console.warn('[MangaTrans] canvas fail → fallback fetch URL qua background:', why);
          resolve(rawSrc);                 // background sẽ fetch URL này
        };

        const canvas = document.createElement('canvas');
        const tryDraw = () => {
          try {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            if (!canvas.width || !canvas.height) return fallbackToUrl('image not loaded');
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', 0.92));
          } catch (e) {
            fallbackToUrl('Canvas draw failed: ' + e.message);
          }
        };

        if (img.complete && img.naturalWidth > 0) {
          tryDraw();
        } else {
          img.addEventListener('load', tryDraw, { once: true });
          img.addEventListener('error', () => fallbackToUrl('image load error'), { once: true });
        }
      });

      const result = await chrome.runtime.sendMessage({
        type: 'PROCESS_BATCH',
        jobs: [{ imageId, imageSrc: imageData }],
      });

      removeLoadingOverlay(imageId);

      if (!result?.ok) throw new Error(result?.error || 'Request failed');

      const res = result.results[0];
      if (!res) return;

      if (res.error) {
        showError(img, imageId, res.error);
        state.cache.set(imageId, { status: 'error' });
      } else if (res.resultImage) {
        paintResultImage(img, res.resultImage);
        state.cache.set(imageId, { status: 'done' });
        state.stats.pages++;
      }
    } catch (e) {
      removeLoadingOverlay(imageId);
      console.error('[MangaTrans] processOne error:', e.message);
      state.cache.set(imageId, { status: 'error' });
      showError(img, imageId, e.message);
    }
  }

  // ── Result Image Rendering ──────────────────────────────
  function paintResultImage(img, resultImageB64) {
    img.dataset.mtvDone = 'done';
    const wrapper = ensureWrapper(img);

    const imgRect = img.getBoundingClientRect();
    const wrapRect = wrapper.getBoundingClientRect();

    const overlay = document.createElement('img');
    overlay.className = 'mtv-result-img';
    overlay.src = resultImageB64;
    overlay.alt = '';
    overlay.style.cssText = [
      'position:absolute',
      `left:${imgRect.left - wrapRect.left}px`,
      `top:${imgRect.top - wrapRect.top}px`,
      `width:${img.offsetWidth}px`,
      `height:${img.offsetHeight}px`,
      `display:${state.overlayVisible ? 'block' : 'none'}`,
      'z-index:5',
      'pointer-events:none',
      'object-fit:fill',
    ].map(s => s + '!important').join(';') + ';';

    wrapper.appendChild(overlay);
  }

  // ── Loading overlay + Error UI ──────────────────────────
  function showLoadingOverlay(img, imageId) {
    const wrapper = ensureWrapper(img);
    const overlay = document.createElement('div');
    overlay.className = 'mtv-loading-overlay';
    overlay.id = `mtv-loading-${imageId}`;

    // Căn đúng kích thước ảnh (ảnh có thể không full wrapper)
    const imgRect = img.getBoundingClientRect();
    const wrapRect = wrapper.getBoundingClientRect();
    overlay.style.cssText = [
      'position:absolute',
      `left:${imgRect.left - wrapRect.left}px`,
      `top:${imgRect.top - wrapRect.top}px`,
      `width:${img.offsetWidth}px`,
      `height:${img.offsetHeight}px`,
    ].join(';') + ';';

    wrapper.appendChild(overlay);
  }

  function removeLoadingOverlay(imageId) {
    document.getElementById(`mtv-loading-${imageId}`)?.remove();
  }

  function showError(img, imageId, message) {
    removeLoadingOverlay(imageId);
    const wrapper = ensureWrapper(img);
    const err = document.createElement('div');
    err.className = 'mtv-error';
    err.textContent = message;
    err.title = message;
    console.error('[MangaTrans] Error:', message);
    wrapper.appendChild(err);
  }

  function ensureWrapper(img) {
    const wrapper = img.parentElement;
    if (window.getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative';
    }
    return wrapper;
  }

  // ── Reset ───────────────────────────────────────────────
  function resetAll() {
    state.cache.clear();
    state.stats = { pages: 0, bubbles: 0, times: [] };
    state.pageConfirmed = false;
    state.pendingConfirm = [];
    pipeline.queue.length = 0;
    globalPageIndex = 0;
    document.querySelectorAll('.mtv-result-img, .mtv-loading-overlay, .mtv-spinner, .mtv-error').forEach(el => el.remove());
    document.querySelectorAll('[data-mtv-id]').forEach(img => {
      delete img.dataset.mtvId;
      delete img.dataset.mtvDone;
    });
    stopObserver();
    if (state.enabled) startObserver();
  }

  // ── Start ───────────────────────────────────────────────
  init();

})();