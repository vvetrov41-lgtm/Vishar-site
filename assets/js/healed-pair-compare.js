(function () {
  'use strict';

  const SECTION_SELECTOR = '[data-speciality-gallery="healed"]';
  const LINK_SELECTOR = 'a[data-speciality-lightbox]';
  const DESKTOP_POINTER = '(hover: hover) and (pointer: fine)';
  const SWIPE_THRESHOLD = 45;

  let touchStartX = 0;
  let touchStartY = 0;

  function linkData(link) {
    return {
      source: link.getAttribute('href') || '',
      alt: link.dataset.lightboxAlt || link.getAttribute('aria-label') || 'Tattoo image preview',
    };
  }

  function pairFromLink(link) {
    const figure = link.closest('figure');
    if (!figure) return null;

    const links = Array.from(figure.querySelectorAll(LINK_SELECTOR));
    if (links.length !== 2) return null;

    return {
      fresh: linkData(links[0]),
      healed: linkData(links[1]),
      initialState: link === links[1] ? 'healed' : 'fresh',
    };
  }

  function ensurePairUi(overlay) {
    let badge = overlay.querySelector('[data-pair-state-badge]');
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute('data-pair-state-badge', '');
      badge.setAttribute('aria-live', 'polite');
      badge.style.cssText = 'position:absolute;top:max(16px,env(safe-area-inset-top));left:16px;z-index:2;padding:9px 14px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(0,0,0,.48);backdrop-filter:blur(12px);color:#fff;font:600 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.12em;text-transform:uppercase;pointer-events:none;';
      overlay.appendChild(badge);
    }

    let hint = overlay.querySelector('[data-pair-compare-hint]');
    if (!hint) {
      hint = document.createElement('div');
      hint.setAttribute('data-pair-compare-hint', '');
      hint.style.cssText = 'position:absolute;left:50%;bottom:max(18px,env(safe-area-inset-bottom));z-index:2;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:rgba(0,0,0,.5);backdrop-filter:blur(12px);color:rgba(255,255,255,.72);font:500 12px/1 system-ui,-apple-system,sans-serif;white-space:nowrap;pointer-events:none;';
      overlay.appendChild(hint);
    }

    hint.textContent = window.matchMedia && window.matchMedia(DESKTOP_POINTER).matches
      ? 'Click photo to compare'
      : 'Swipe to compare';

    return { badge, hint };
  }

  function renderPairState(overlay, state) {
    const pair = overlay.__healedPair;
    const image = overlay.querySelector('[data-lightbox-image]');
    const status = overlay.querySelector('[data-lightbox-status]');
    const badge = overlay.querySelector('[data-pair-state-badge]');
    if (!pair || !image || !pair[state]) return;

    const item = pair[state];
    overlay.__healedPairState = state;
    if (badge) badge.textContent = state === 'fresh' ? 'Fresh' : 'Healed';

    if (status) {
      status.style.display = 'block';
      status.textContent = 'Loading…';
    }

    image.style.transition = 'opacity .18s ease';
    image.style.opacity = '.18';
    image.style.display = 'none';
    image.alt = item.alt;
    image.onload = function () {
      if (status) status.style.display = 'none';
      image.style.display = 'block';
      window.requestAnimationFrame(function () {
        image.style.opacity = '1';
      });
    };
    image.onerror = function () {
      image.style.display = 'none';
      if (status) {
        status.style.display = 'block';
        status.textContent = 'Image could not be loaded.';
      }
    };
    image.src = item.source;

    const otherState = state === 'fresh' ? 'healed' : 'fresh';
    if (pair[otherState] && pair[otherState].source) {
      const preload = new Image();
      preload.src = pair[otherState].source;
    }
  }

  function setPairState(overlay, state) {
    if (!overlay || overlay.getAttribute('aria-hidden') === 'true') return;
    if (!overlay.__healedPair || overlay.__healedPairState === state) return;
    renderPairState(overlay, state);
  }

  function togglePairState(overlay) {
    const next = overlay.__healedPairState === 'fresh' ? 'healed' : 'fresh';
    setPairState(overlay, next);
  }

  function bindOverlayInteractions(overlay) {
    if (!overlay || overlay.dataset.pairCompareBound === 'true') return;
    overlay.dataset.pairCompareBound = 'true';

    const image = overlay.querySelector('[data-lightbox-image]');
    const stage = image ? image.parentElement : null;
    if (!image || !stage) return;

    image.style.cursor = 'pointer';
    stage.style.touchAction = 'pan-y';

    image.addEventListener('click', function (event) {
      if (!window.matchMedia || !window.matchMedia(DESKTOP_POINTER).matches) return;
      event.preventDefault();
      event.stopPropagation();
      togglePairState(overlay);
    });

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

      if (dx < 0) setPairState(overlay, 'healed');
      else setPairState(overlay, 'fresh');
    }, { passive: true });

    document.addEventListener('keydown', function (event) {
      if (overlay.getAttribute('aria-hidden') === 'true' || !overlay.__healedPair) return;
      if (event.key === 'ArrowLeft') setPairState(overlay, 'fresh');
      if (event.key === 'ArrowRight') setPairState(overlay, 'healed');
    });
  }

  function activatePair(pair) {
    const overlay = document.getElementById('speciality-image-lightbox');
    if (!overlay || overlay.getAttribute('aria-hidden') === 'true') return;

    overlay.__healedPair = pair;
    ensurePairUi(overlay);
    bindOverlayInteractions(overlay);
    renderPairState(overlay, pair.initialState);
  }

  function bindPairSelection() {
    const section = document.querySelector(SECTION_SELECTOR);
    if (!section || section.dataset.pairCompareSelectionBound === 'true') return;
    section.dataset.pairCompareSelectionBound = 'true';

    section.addEventListener('click', function (event) {
      const link = event.target.closest(LINK_SELECTOR);
      if (!link || !section.contains(link)) return;

      const pair = pairFromLink(link);
      if (!pair) return;

      window.setTimeout(function () {
        activatePair(pair);
      }, 0);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindPairSelection, { once: true });
  } else {
    bindPairSelection();
  }
})();
