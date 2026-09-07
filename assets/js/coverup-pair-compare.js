(function () {
  'use strict';

  const PAIR_COUNT = 6;
  const BASE = '/assets/cover-ups/';
  const DESKTOP_POINTER = '(hover: hover) and (pointer: fine)';
  const SWIPE_THRESHOLD = 45;

  function altText(state, index) {
    return state === 'before'
      ? `Old tattoo before cover-up, comparison ${index} by Vladimir Vishar`
      : `Completed cover-up tattoo, comparison ${index} by Vladimir Vishar`;
  }

  function pairData(index) {
    const stem = String(index).padStart(2, '0');
    return {
      before: {
        source: `${BASE}before-${stem}.webp`,
        alt: altText('before', index),
      },
      after: {
        source: `${BASE}after-${stem}.webp`,
        alt: altText('after', index),
      },
    };
  }

  function imageMarkup(item) {
    return `<img src="${item.source}" loading="lazy" decoding="async" width="900" height="1200" alt="${item.alt}" class="w-full h-full" style="object-fit:contain;background:#000">`;
  }

  function cardMarkup(pair, index) {
    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10" data-coverup-pair="${index}">
        <div class="grid grid-cols-2 gap-2 p-2">
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Before</p>
            <button type="button" data-coverup-state="before" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${pair.before.alt}">
              ${imageMarkup(pair.before)}
            </button>
          </div>
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">After</p>
            <button type="button" data-coverup-state="after" class="group block w-full aspect-[3/4] overflow-hidden rounded-2xl bg-black cursor-zoom-in" aria-label="Open ${pair.after.alt}">
              ${imageMarkup(pair.after)}
            </button>
          </div>
        </div>
      </figure>`;
  }

  function rebuildGallery() {
    const section = document.getElementById('gallery');
    const grid = document.getElementById('coverup-gallery');
    if (!section || !grid) return false;

    section.className = 'py-24 px-4 border-y border-white/5';
    grid.className = 'max-w-[1200px] mx-auto grid grid-cols-1 md:grid-cols-2 gap-6';

    const intro = section.querySelector('.max-w-\\[1200px\\].mx-auto.text-center');
    if (intro) {
      intro.classList.remove('mb-16');
      intro.classList.add('mb-12');
      intro.innerHTML = `
        <p class="text-sm uppercase tracking-[0.3em] text-white/30 mb-4">6 matched cover-up pairs</p>
        <h2 class="text-3xl md:text-5xl font-semibold tracking-tight">Before &amp; After</h2>
        <p class="text-white/50 mt-4 max-w-2xl mx-auto">The original tattoo is shown on the left. The completed cover-up is shown on the right.</p>`;
    }

    const cards = [];
    for (let i = 1; i <= PAIR_COUNT; i += 1) {
      cards.push(cardMarkup(pairData(i), i));
    }
    grid.innerHTML = cards.join('');
    return true;
  }

  function ensureLightbox() {
    let overlay = document.getElementById('coverup-pair-lightbox');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'coverup-pair-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Cover-up comparison preview');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1200;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(8,8,10,.97);';
    overlay.innerHTML = `
      <div data-coverup-state-badge aria-live="polite" style="position:absolute;top:max(16px,env(safe-area-inset-top));left:16px;z-index:2;padding:9px 14px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(0,0,0,.48);backdrop-filter:blur(12px);color:#fff;font:600 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.12em;text-transform:uppercase;pointer-events:none;">Before</div>
      <button type="button" data-coverup-close aria-label="Close image preview" style="position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;z-index:2;width:46px;height:46px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;font-size:28px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;">×</button>
      <div data-coverup-stage style="width:100%;height:100%;max-width:1100px;display:flex;align-items:center;justify-content:center;position:relative;touch-action:pan-y;">
        <p data-coverup-status style="margin:0;color:rgba(255,255,255,.7);font:14px/1.4 system-ui,-apple-system,sans-serif;">Loading...</p>
        <img data-coverup-image alt="" style="display:none;max-width:100%;max-height:calc(100vh - 40px);width:auto;height:auto;object-fit:contain;cursor:pointer;transition:opacity .18s ease;">
      </div>
      <div data-coverup-hint style="position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));z-index:2;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:rgba(0,0,0,.5);backdrop-filter:blur(12px);color:rgba(255,255,255,.72);font:500 12px/1 system-ui,-apple-system,sans-serif;white-space:nowrap;pointer-events:none;"></div>`;

    document.body.appendChild(overlay);

    const image = overlay.querySelector('[data-coverup-image]');
    const stage = overlay.querySelector('[data-coverup-stage]');
    const closeButton = overlay.querySelector('[data-coverup-close]');
    const hint = overlay.querySelector('[data-coverup-hint]');
    let touchStartX = 0;
    let touchStartY = 0;

    if (hint) {
      hint.textContent = window.matchMedia && window.matchMedia(DESKTOP_POINTER).matches
        ? 'Click photo to compare'
        : 'Swipe to compare';
    }

    function close() {
      if (overlay.getAttribute('aria-hidden') === 'true') return;
      overlay.style.display = 'none';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('lightbox-active');
      if (image) {
        image.style.display = 'none';
        image.removeAttribute('src');
      }
      if (overlay.__previousFocus && overlay.__previousFocus.isConnected && typeof overlay.__previousFocus.focus === 'function') {
        overlay.__previousFocus.focus();
      }
      overlay.__previousFocus = null;
      overlay.__pair = null;
      overlay.__state = null;
    }

    function setState(state) {
      const pair = overlay.__pair;
      const status = overlay.querySelector('[data-coverup-status]');
      const badge = overlay.querySelector('[data-coverup-state-badge]');
      if (!pair || !image || !pair[state] || overlay.__state === state) return;

      overlay.__state = state;
      const item = pair[state];
      if (badge) badge.textContent = state === 'before' ? 'Before' : 'After';
      if (status) {
        status.style.display = 'block';
        status.textContent = 'Loading...';
      }

      image.style.opacity = '.18';
      image.style.display = 'none';
      image.alt = item.alt;
      image.onload = function () {
        if (status) status.style.display = 'none';
        image.style.display = 'block';
        window.requestAnimationFrame(function () { image.style.opacity = '1'; });
      };
      image.onerror = function () {
        image.style.display = 'none';
        if (status) {
          status.style.display = 'block';
          status.textContent = 'Image could not be loaded.';
        }
      };
      image.src = item.source;

      const other = state === 'before' ? 'after' : 'before';
      if (pair[other] && pair[other].source) {
        const preload = new Image();
        preload.src = pair[other].source;
      }
    }

    overlay.openPair = function (pair, state, trigger) {
      overlay.__previousFocus = trigger || document.activeElement;
      overlay.__pair = pair;
      overlay.__state = null;
      overlay.style.display = 'flex';
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('lightbox-active');
      setState(state);
      if (closeButton) closeButton.focus();
    };

    overlay.setPairState = setState;

    if (closeButton) closeButton.addEventListener('click', close);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close();
    });

    if (image) {
      image.addEventListener('click', function (event) {
        if (!window.matchMedia || !window.matchMedia(DESKTOP_POINTER).matches) return;
        event.preventDefault();
        event.stopPropagation();
        setState(overlay.__state === 'before' ? 'after' : 'before');
      });
    }

    if (stage) {
      stage.addEventListener('touchstart', function (event) {
        if (!event.touches || event.touches.length !== 1) return;
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
      }, { passive: true });

      stage.addEventListener('touchend', function (event) {
        if (!event.changedTouches || event.changedTouches.length !== 1) return;
        const dx = event.changedTouches[0].clientX - touchStartX;
        const dy = event.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
        if (dx < 0) setState('after');
        else setState('before');
      }, { passive: true });
    }

    document.addEventListener('keydown', function (event) {
      if (overlay.getAttribute('aria-hidden') === 'true') return;
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowLeft') setState('before');
      if (event.key === 'ArrowRight') setState('after');
    });

    return overlay;
  }

  function bindGallery() {
    const grid = document.getElementById('coverup-gallery');
    if (!grid || grid.dataset.coverupPairCompareBound === 'true') return;
    grid.dataset.coverupPairCompareBound = 'true';

    grid.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-coverup-state]');
      if (!button || !grid.contains(button)) return;

      const figure = button.closest('[data-coverup-pair]');
      if (!figure) return;

      const index = Number(figure.getAttribute('data-coverup-pair'));
      if (!Number.isFinite(index) || index < 1 || index > PAIR_COUNT) return;

      event.preventDefault();
      const overlay = ensureLightbox();
      overlay.openPair(pairData(index), button.dataset.coverupState === 'after' ? 'after' : 'before', button);
    });
  }

  function init() {
    if (!rebuildGallery()) return;
    bindGallery();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();