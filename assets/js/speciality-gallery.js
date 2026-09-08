(function () {
  'use strict';

  /*
   * The fresh/healed comparison cards are rendered into the page HTML at build
   * time by scripts/build-static-html.mjs (from assets/healed/metadata.json),
   * so the images, alt text and links are in the raw response. All that is
   * left here is the comparison lightbox the healed page opens on click.
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
      </div>`;

    document.body.appendChild(overlay);

    const image = overlay.querySelector('[data-lightbox-image]');
    const status = overlay.querySelector('[data-lightbox-status]');
    const closeButton = overlay.querySelector('[data-lightbox-close]');
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

      if (status) {
        status.style.display = 'block';
        status.textContent = 'Loading…';
      }
      if (image) {
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
      if (closeButton) closeButton.focus();
    };

    if (closeButton) closeButton.addEventListener('click', closePreview);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) closePreview();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && overlay.getAttribute('aria-hidden') === 'false') {
        closePreview();
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
      if (overlay && typeof overlay.openPreview === 'function') {
        overlay.openPreview(link.getAttribute('href'), link.dataset.lightboxAlt || link.getAttribute('aria-label') || '');
      }
    });
  }

  function initHealedGallery() {
    const section = document.querySelector('[data-speciality-gallery="healed"]');
    if (!section) return;
    bindSpecialityLightbox(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHealedGallery, { once: true });
  } else {
    initHealedGallery();
  }
})();
