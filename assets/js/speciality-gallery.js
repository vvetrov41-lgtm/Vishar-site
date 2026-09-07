(function () {
  'use strict';

  const MAX_IMAGES = 32;
  const WIDTHS = [320, 480, 720, 960];
  const CONFIG = {
    'large-scale': {
      base: '/assets/large-scale/',
      genericAlt: 'Large-scale realism tattoo by Vladimir Vishar, London',
    },
    portrait: {
      base: '/assets/portraits/',
      genericAlt: 'Realism portrait tattoo by Vladimir Vishar, London',
    },
    healed: {
      base: '/assets/healed/',
      genericAlt: 'Confirmed healed realism tattoo by Vladimir Vishar',
    },
  };

  async function loadMetadata(base) {
    try {
      const response = await fetch(base + 'metadata.json', { cache: 'no-store' });
      if (!response.ok) return {};
      const data = await response.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  function galleryState(config, metadata) {
    const stems = Object.keys(metadata)
      .filter((key) => /^\d{2}$/.test(key))
      .sort()
      .slice(0, MAX_IMAGES);

    const manifest = metadata._gallery && typeof metadata._gallery === 'object'
      ? metadata._gallery
      : {};
    const thumbnailWidths = Array.isArray(manifest.thumbnailWidths)
      ? manifest.thumbnailWidths
        .filter((width) => WIDTHS.includes(width))
        .sort((a, b) => a - b)
      : [];
    const sourceExtension = typeof manifest.sourceExtension === 'string'
      && /^\.(?:jpe?g|webp|png)$/i.test(manifest.sourceExtension)
      ? manifest.sourceExtension.toLowerCase()
      : '.jpg';

    return {
      images: stems.map((stem) => ({ stem, source: `${config.base}${stem}${sourceExtension}` })),
      thumbnailWidths,
    };
  }

  function responsiveMedia(source, srcsetBase, stem, alt, thumbnailWidths, sizes, fit) {
    const style = fit === 'contain' ? ' style="object-fit:contain;background:#000"' : '';
    const imageTag = `<img src="${source}" loading="lazy" decoding="async" width="900" height="1200" alt="${escapeHtml(alt)}" class="w-full h-full transition-transform duration-1000 group-hover:scale-105"${style}>`;

    if (!thumbnailWidths.length) return imageTag;

    const srcset = thumbnailWidths
      .map((width) => `${srcsetBase}${stem}-${width}.webp ${width}w`)
      .join(', ');
    return `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}">${imageTag}</picture>`;
  }

  function imageMarkup(config, image, metadata, index, thumbnailWidths) {
    const info = metadata[image.stem] || {};
    const alt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const caption = info.caption || info.healed_for || '';
    const media = responsiveMedia(
      image.source,
      `${config.base}thumbs/`,
      image.stem,
      alt,
      thumbnailWidths,
      '(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw',
      'cover',
    );

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl">
        <a href="${image.source}" target="_blank" rel="noopener" class="group block aspect-[3/4] overflow-hidden" aria-label="Open ${escapeHtml(alt)}">
          ${media}
        </a>
        ${caption ? `<figcaption class="p-4 text-sm text-white/50">${escapeHtml(caption)}</figcaption>` : ''}
      </figure>`;
  }

  function healedPairMarkup(config, image, metadata, index) {
    const info = metadata[image.stem] || {};
    const healedAlt = info.alt || `${config.genericAlt} - image ${index + 1}`;
    const subject = healedAlt
      .replace(/^Confirmed healed\s+/i, '')
      .replace(/\s+by Vladimir Vishar$/i, '');
    const freshAlt = `Fresh-session ${subject} by Vladimir Vishar`;
    const freshSource = `${config.base}fresh/${image.stem}.webp`;
    const healedSource = image.stem === '05'
      ? `${image.source}?v=20260907`
      : image.source;

    // Healed comparisons use the verified original sources directly. This avoids
    // stale or incomplete responsive derivatives leaving black image cards.
    const freshMedia = responsiveMedia(
      freshSource,
      '',
      image.stem,
      freshAlt,
      [],
      '(min-width: 768px) 25vw, 50vw',
      'contain',
    );
    const healedMedia = responsiveMedia(
      healedSource,
      '',
      image.stem,
      healedAlt,
      [],
      '(min-width: 768px) 25vw, 50vw',
      'contain',
    );

    return `
      <figure class="overflow-hidden bg-white/5 rounded-2xl border border-white/10">
        <div class="grid grid-cols-2 gap-2 p-2">
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Fresh</p>
            <a href="${freshSource}" data-speciality-lightbox data-lightbox-alt="${escapeHtml(freshAlt)}" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${escapeHtml(freshAlt)}">
              ${freshMedia}
            </a>
          </div>
          <div>
            <p class="text-xs uppercase tracking-[0.3em] text-white/50 mb-2 text-center">Healed</p>
            <a href="${healedSource}" data-speciality-lightbox data-lightbox-alt="${escapeHtml(healedAlt)}" class="group block aspect-[3/4] overflow-hidden rounded-2xl bg-black" aria-label="Open ${escapeHtml(healedAlt)}">
              ${healedMedia}
            </a>
          </div>
        </div>
      </figure>`;
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value);
    return div.innerHTML;
  }

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

  async function buildGallery() {
    const section = document.querySelector('[data-speciality-gallery]');
    if (!section) return;

    const key = section.getAttribute('data-speciality-gallery');
    const config = CONFIG[key];
    if (!config) return;

    const grid = section.querySelector('[data-speciality-gallery-grid]');
    if (!grid) return;

    const metadata = await loadMetadata(config.base);
    const { images, thumbnailWidths } = galleryState(config, metadata);

    if (!images.length) return;

    const markup = key === 'healed'
      ? images.map((image, index) => healedPairMarkup(config, image, metadata, index))
      : images.map((image, index) => imageMarkup(config, image, metadata, index, thumbnailWidths));

    grid.innerHTML = markup.join('');
    section.classList.remove('hidden');
    section.removeAttribute('aria-hidden');

    if (key === 'healed') bindSpecialityLightbox(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGallery, { once: true });
  } else {
    buildGallery();
  }
})();
