(function () {
  'use strict';

  /*
   * Progressive lightbox for metadata-driven collections (portrait, large-scale,
   * fresh/healed). The image links and alt text are generated in static HTML.
   * Keep the fresh/healed comparison integration working alongside collection navigation.
   */

  function ensureSpecialityLightbox() {
    const existing = document.getElementById('speciality-image-lightbox');
    if (existing) return existing;

    const overlay = document.createElement('div');
    overlay.id = 'speciality-image-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Tattoo image preview');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1200;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(8,8,10,.97);';
    overlay.innerHTML = `
      <button type="button" data-lightbox-close aria-label="Close image preview" style="position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;z-index:2;width:46px;height:46px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:rgba(255,255,255,.08);color:#fff;font-size:28px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;">×</button>
      <div style="width:100%;height:100%;max-width:1100px;display:flex;align-items:center;justify-content:center;position:relative;">
        <p data-lightbox-status style="margin:0;color:rgba(255,255,255,.7);font:14px/1.4 system-ui,-apple-system,sans-serif;">Loading…</p>
        <img data-lightbox-image alt="" style="display:none;max-width:100%;max-height:calc(100vh - 40px);width:auto;height:auto;object-fit:contain;">
      </div>
      <button type="button" data-gallery-prev aria-label="Previous image" style="display:none;position:absolute;left:max(12px,env(safe-area-inset-left));top:50%;transform:translateY(-50%);z-index:2;width:44px;height:44px;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:28px;cursor:pointer;">‹</button>
      <button type="button" data-gallery-next aria-label="Next image" style="display:none;position:absolute;right:max(12px,env(safe-area-inset-right));top:50%;transform:translateY(-50%);z-index:2;width:44px;height:44px;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.22);border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:28px;cursor:pointer;">›</button>
      <div data-gallery-counter aria-live="polite" style="display:none;position:absolute;bottom:max(18px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);color:rgba(255,255,255,.75);font:500 12px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.12em;"></div>`;

    document.body.appendChild(overlay);

    const image = overlay.querySelector('[data-lightbox-image]');
    const status = overlay.querySelector('[data-lightbox-status]');
    const closeButton = overlay.querySelector('[data-lightbox-close]');
    const previousButton = overlay.querySelector('[data-gallery-prev]');
    const nextButton = overlay.querySelector('[data-gallery-next]');
    const counter = overlay.querySelector('[data-gallery-counter]');
    let galleryItems = [];
    let galleryIndex = 0;
    let zoomed = false;
    let touchX = 0;
    let touchY = 0;
    function resetZoom() {
      zoomed = false;
      if (image) {
        image.style.transform = '';
        image.style.cursor = galleryItems.length ? 'zoom-in' : '';
      }
    }
    function updateNavigation() {
      const show = galleryItems.length > 1;
      if (previousButton) previousButton.style.display = show ? 'flex' : 'none';
      if (nextButton) nextButton.style.display = show ? 'flex' : 'none';
      if (counter) {
        counter.style.display = galleryItems.length ? 'block' : 'none';
        counter.textContent = galleryItems.length ? (galleryIndex + 1) + ' / ' + galleryItems.length : '';
      }
    }
    function showImage(source, alt) {
      resetZoom();
      if (status) {
        status.style.display = 'block';
        status.textContent = 'Loading…';
      }
      if (!image) return;
      image.style.display = 'none';
      image.alt = alt || 'Tattoo image preview';
      image.onload = function () {
        if (status) status.style.display = 'none';
        image.style.display = 'block';
      };
      image.onerror = function () {
        image.style.display = 'none';
        if (status) {
          status.style.display = 'block';
          status.textContent = 'Image could not be loaded.';
        }
      };
      image.src = source;
    }
    function moveGallery(delta) {
      if (!galleryItems.length || overlay.getAttribute('aria-hidden') === 'true') return;
      galleryIndex = (galleryIndex + delta + galleryItems.length) % galleryItems.length;
      const item = galleryItems[galleryIndex];
      showImage(item.source, item.alt);
      updateNavigation();
    }
    let previousFocus = null;
    let previousOverflow = '';

    function closePreview() {
      if (overlay.getAttribute('aria-hidden') === 'true') return;
      overlay.style.display = 'none';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = previousOverflow;
      if (image) {
        image.style.display = 'none';
        image.removeAttribute('src');
      }
      if (status) status.textContent = 'Loading…';
      galleryItems = [];
      resetZoom();
      updateNavigation();
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus();
      }
      previousFocus = null;
    }

    overlay.openPreview = function (source, alt) {
      previousFocus = document.activeElement;
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      overlay.style.display = 'flex';
      overlay.setAttribute('aria-hidden', 'false');

      galleryItems = [];
      updateNavigation();
      showImage(source, alt);
      if (closeButton) closeButton.focus();
    };

    overlay.openGallery = function (links, selected) {
      const items = Array.from(links).map(function (link) {
        const img = link.querySelector('img');
        return {
          source: link.getAttribute('href'),
          alt: link.dataset.lightboxAlt || (img && img.alt) || 'Tattoo image preview'
        };
      });
      const index = Array.from(links).indexOf(selected);
      if (!items.length || index < 0) return;
      overlay.openPreview(items[index].source, items[index].alt);
      galleryItems = items;
      galleryIndex = index;
      resetZoom();
      updateNavigation();
    };
    if (previousButton) previousButton.addEventListener('click', function () { moveGallery(-1); });
    if (nextButton) nextButton.addEventListener('click', function () { moveGallery(1); });
    if (image) {
      image.style.transition = 'transform .2s ease';
      image.addEventListener('click', function () {
        if (!galleryItems.length) return;
        zoomed = !zoomed;
        image.style.transform = zoomed ? 'scale(1.7)' : '';
        image.style.cursor = zoomed ? 'zoom-out' : 'zoom-in';
      });
      image.addEventListener('touchstart', function (event) {
        if (!galleryItems.length || event.touches.length !== 1) return;
        touchX = event.touches[0].clientX;
        touchY = event.touches[0].clientY;
      }, { passive: true });
      image.addEventListener('touchend', function (event) {
        if (!galleryItems.length || event.changedTouches.length !== 1) return;
        const dx = event.changedTouches[0].clientX - touchX;
        const dy = event.changedTouches[0].clientY - touchY;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) moveGallery(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    if (closeButton) closeButton.addEventListener('click', closePreview);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closePreview();
    });
    document.addEventListener('keydown', function (event) {
      if (overlay.getAttribute('aria-hidden') === 'true') return;
      if (event.key === 'Escape') closePreview();
      if (event.key === 'ArrowLeft') moveGallery(-1);
      if (event.key === 'ArrowRight') moveGallery(1);
      if (event.key === 'Tab') {
        const buttons = [closeButton, previousButton, nextButton].filter(function (button) {
          return button && button.style.display !== 'none';
        });
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    });

    return overlay;
  }

  function bindSpecialityLightbox(section) {
    if (!section || section.dataset.specialityLightboxBound === 'true') return;
    section.dataset.specialityLightboxBound = 'true';

    section.addEventListener('click', function (event) {
      const link = event.target.closest('a[data-speciality-lightbox]');
      if (!link || !section.contains(link)) return;

      event.preventDefault();
      const overlay = ensureSpecialityLightbox();
      if (!overlay) return;
      if (section.dataset.specialityGallery === 'healed') {
        overlay.openPreview(link.getAttribute('href'), link.dataset.lightboxAlt || link.getAttribute('aria-label') || '');
      } else {
        overlay.openGallery(section.querySelectorAll('a[data-speciality-lightbox]'), link);
      }
    });
  }

  function initSpecialityGalleries() {
    document.querySelectorAll('[data-speciality-gallery]').forEach(bindSpecialityLightbox);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSpecialityGalleries, { once: true });
  } else {
    initSpecialityGalleries();
  }
})();
